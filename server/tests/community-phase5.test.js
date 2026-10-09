// V6.1 Phase 5-backend: verified study-progress snapshots.
// - GET /api/community/share-stats returns the caller's OWN real aggregates
//   (every number from an existing dashboard/study predicate, never client
//   input, never another learner's rows).
// - POST /api/community/posts with postType:'progress' + includeStats:true
//   mints a server-computed snapshot into snapshot_json (client numbers
//   ignored); responses expose it additively as `stats`.
// Stubbed executor throughout (no live DB); SQL-shape assertions pin the
// user scoping, behavioral pins cover the snapshot honesty.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const pool = require('../src/config/db');
const service = require('../src/services/community');
const controller = require('../src/controllers/communityController');

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    return await callback();
  } finally {
    pool.execute = original;
  }
}

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

function placeholders(sql) {
  return (sql.match(/\?/g) || []).length;
}

// Canned aggregates for 2026-10-06: sessions on 10-04 + 10-05, reading day
// on 10-06 (>= 300s) → streak 3 back from 10-06.
function shareStatsStub(seen) {
  return async (sql, params = []) => {
    if (seen) seen.push({ sql, params });
    assert.equal(params.length, placeholders(sql), `params bind every placeholder: ${sql.slice(0, 90)}`);
    if (/SELECT to_char\(CURRENT_DATE/i.test(sql)) return [[{ today: '2026-10-06' }]];
    if (/due_vocabulary/i.test(sql)) return [[{ due_vocabulary: 4, due_kanji: 2, due_grammar: 1 }]];
    if (/AS vocab/i.test(sql)) return [[{ vocab: '12', kanji: 5, grammar: 3 }]];
    if (/SUM\(duration_minutes\)/i.test(sql)) return [[{ minutes: 90 }]];
    if (/SUM\(seconds\)/i.test(sql)) return [[{ minutes: 7.5 }]];
    if (/seconds >= 300/i.test(sql)) return [[{ date: '2026-10-06' }]];
    if (/GROUP BY session_date/i.test(sql)) return [[{ date: '2026-10-05' }, { date: '2026-10-04' }]];
    if (/FROM user_reading_progress/i.test(sql)) return [[{ total: 6 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
}

test('share-stats returns own real aggregates in one bounded round', async () => {
  const seen = [];
  await withPoolExecute(shareStatsStub(seen), async () => {
    const stats = await service.getShareStats(pool, USER_ID, { today: '2026-10-06' });
    assert.equal(stats.streakDays, 3, 'sessions 10-04/10-05 + reading day 10-06 count back 3');
    assert.equal(stats.vocabCount, 12);
    assert.equal(stats.kanjiCount, 5);
    assert.equal(stats.grammarCount, 3);
    assert.equal(stats.studiedMinutesMonth, 98, '90 session + 7.5 reading minutes, rounded');
    assert.ok(String(stats.studiedMinutesWindow).includes('2026-09-07..2026-10-06'), 'exact 30-day window documented');
    assert.equal(stats.reviewsDue, 7, '4 vocab + 2 kanji + 1 grammar via the Study Now due predicate');
    assert.equal(stats.readingsFinished, 6);
    assert.equal(stats.asOf, '2026-10-06');
  });
  assert.ok(seen.length <= 7, `bounded single round, got ${seen.length}`);
  for (const { sql, params } of seen) {
    assert.ok(params.includes(USER_ID), `every query stays user-scoped: ${sql.slice(0, 60)}`);
    assert.ok(!params.includes(OTHER_ID), 'never another learner\'s id');
  }
  const dueQuery = seen.find(({ sql }) => /due_vocabulary/i.test(sql));
  assert.ok(/due_on <= CURRENT_DATE/i.test(dueQuery.sql), 'due predicate reuses the Study Now rule');
  assert.ok(/interval_days = 0 AND ri\.last_reviewed_at IS NULL/i.test(dueQuery.sql), 'placeholder rows excluded like Study Now');
  assert.ok(/seconds >= 300/i.test(seen.find(({ sql }) => /reading_study_days/i.test(sql) && /GROUP BY/i.test(sql)).sql), 'streak reading threshold matches activity (5+ min)');
});

test('share-stats falls back to CURRENT_DATE without ?today', async () => {
  const seen = [];
  await withPoolExecute(shareStatsStub(seen), async () => {
    const stats = await service.getShareStats(pool, USER_ID, {});
    assert.equal(stats.asOf, '2026-10-06', 'DB clock fallback');
  });
  assert.ok(seen.some(({ sql }) => /SELECT to_char\(CURRENT_DATE/i.test(sql)), 'today resolved from the DB clock');
});

test('share-stats rejects a malformed today (service + controller)', async () => {
  await assert.rejects(service.getShareStats(pool, USER_ID, { today: '06/10/2026' }), /today must be a YYYY-MM-DD date/);
  await withPoolExecute(shareStatsStub(), async () => {
    const { res, status, body } = mockRes();
    await controller.getShareStats({ user: { id: USER_ID }, query: { today: 'tomorrow' } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /today must be a YYYY-MM-DD date/);
  });
});

test('share-stats controller accepts no user param (always own data)', async () => {
  const seen = [];
  await withPoolExecute(shareStatsStub(seen), async () => {
    const { res, status, body } = mockRes();
    await controller.getShareStats({ user: { id: USER_ID }, query: { userId: OTHER_ID, today: '2026-10-06' } }, res);
    assert.equal(status(), 200);
    const payload = body();
    assert.equal(payload.vocabCount, 12);
    assert.equal(payload.streakDays, 3);
  });
  for (const { params } of seen) {
    assert.ok(!params.includes(OTHER_ID), 'query userId never reaches SQL');
  }
  assert.ok(seen.every(({ params }) => params.length === 0 || params.includes(USER_ID)), 'every param query binds the caller');
});

function progressPostRow(snapshotJson) {
  return {
    id: 55, author_id: USER_ID, post_type: 'progress', title: null, body: 'ran 5k in the park',
    japanese_text: null, translation: null, entity_type: null, entity_id: null,
    deck_id: null, reading_id: null, snapshot_json: snapshotJson,
    like_count: 0, comment_count: 0, liked: false,
    author_username: 'yuki', author_display: null, author_avatar: null,
    created_at: '2026-10-06', updated_at: null
  };
}

test('progress includeStats:true snapshots server values; client fakes ignored', async () => {
  let capturedSnapshot = null;
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/INSERT INTO community_posts/i.test(sql)) {
      capturedSnapshot = JSON.parse(params[params.length - 1]);
      return [{ insertId: 55 }];
    }
    if (/p\.id_community_post = \?/i.test(sql)) return [[progressPostRow(capturedSnapshot)]];
    return shareStatsStub()(sql, params);
  }, async () => {
    const post = await service.createPost(pool, USER_ID, {
      postType: 'progress',
      body: 'ran 5k in the park',
      includeStats: true,
      // Forged numbers: accepted-but-ignored, must never reach the snapshot.
      stats: { streakDays: 9999, vocabCount: 9999, hacker: true },
      snapshot: { streakDays: 8888 },
      snapshot_json: { streakDays: 7777 }
    });
    assert.deepEqual(capturedSnapshot, {
      streakDays: 3,
      vocabCount: 12,
      kanjiCount: 5,
      grammarCount: 3,
      studiedMinutesMonth: 98,
      studiedMinutesWindow: capturedSnapshot.studiedMinutesWindow,
      reviewsDue: 7,
      readingsFinished: 6,
      asOf: '2026-10-06'
    }, 'stored snapshot is server-computed, fakes nowhere in it');
    assert.ok(!('hacker' in capturedSnapshot), 'injected keys dropped');
    assert.deepEqual(post.stats, capturedSnapshot, 'response exposes the snapshot as stats');
    assert.deepEqual(post.snapshot, capturedSnapshot, 'legacy snapshot key intact');
    assert.equal(post.body, 'ran 5k in the park', 'manual message still allowed alongside');
    assert.equal(post.mine, true);
    const insert = seen.find(({ sql }) => /INSERT INTO community_posts/i.test(sql));
    assert.ok(insert.params.includes(USER_ID), 'insert stays author-scoped');
  });
});

test('progress without includeStats has no stats; feed maps stats too', async () => {
  let capturedSnapshot = 'unset';
  await withPoolExecute(async (sql, params = []) => {
    if (/INSERT INTO community_posts/i.test(sql)) {
      capturedSnapshot = JSON.parse(params[params.length - 1]);
      return [{ insertId: 56 }];
    }
    if (/SELECT COUNT\(\*\) AS total FROM community_posts/i.test(sql)) return [[{ total: '1' }]];
    if (/FROM community_posts p/i.test(sql)) {
      if (/LIMIT \? OFFSET \?/i.test(sql)) return [[progressPostRow(capturedSnapshot)]];
      return [[progressPostRow(capturedSnapshot)]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  }, async () => {
    const post = await service.createPost(pool, USER_ID, { postType: 'progress', body: 'just a note' });
    assert.deepEqual(capturedSnapshot, {}, 'no stats query, empty link snapshot stored');
    assert.equal(post.snapshot, null);
    assert.equal(post.stats, null, 'no verified snapshot → stats null');
    const feed = await service.listFeed(pool, USER_ID, { tab: 'latest' });
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].stats, null, 'feed maps the additive stats key too');
  });
});

test('includeStats validation: non-progress and non-boolean rejected', async () => {
  await assert.rejects(
    service.createPost(pool, USER_ID, { postType: 'text', body: 'hi', includeStats: true }),
    /includeStats is only allowed on progress posts/
  );
  await assert.rejects(
    service.createPost(pool, USER_ID, { postType: 'progress', body: 'hi', includeStats: 'yes' }),
    /includeStats must be true or omitted/
  );
  await withPoolExecute(async () => { throw new Error('no DB on validation failure'); }, async () => {
    const { res, status, body } = mockRes();
    await controller.createPost({ user: { id: USER_ID }, body: { postType: 'progress', body: 'hi', hacker: 1 } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /Unexpected field/);
  });
  await assert.rejects(service.updatePost(pool, USER_ID, 55, { stats: { streakDays: 1 } }), /Unexpected field/);
  await assert.rejects(service.updatePost(pool, USER_ID, 55, { includeStats: true }), /Unexpected field/, 'snapshots frozen: no stats edits via update');
});

test('progress with stats needs no message; stat-less progress still requires one', async () => {
  await withPoolExecute(async (sql, params = []) => {
    if (/INSERT INTO community_posts/i.test(sql)) return [{ insertId: 57 }];
    if (/p\.id_community_post = \?/i.test(sql)) {
      return [[{ ...progressPostRow({ streakDays: 3 }), id: 57, body: null }]];
    }
    return shareStatsStub()(sql, params);
  }, async () => {
    const post = await service.createPost(pool, USER_ID, { postType: 'progress', includeStats: true });
    assert.equal(post.stats.streakDays, 3, 'stats-only milestone publishes');
    assert.equal(post.body, null, 'no message required when the snapshot carries the post');
  });
  await assert.rejects(
    service.createPost(pool, USER_ID, { postType: 'progress' }),
    /body is required/,
    'stat-less progress without a message still rejected'
  );
});

test('every phase-5 query binds exactly its placeholders like Postgres would', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params = []) => {
    calls.push({ sql, params });
    assert.equal(params.length, placeholders(sql), `param count must match placeholders: ${sql.slice(0, 100)}`);
    return shareStatsStub()(sql, params);
  }, async () => {
    await service.getShareStats(pool, USER_ID, { today: '2026-10-06' });
    await service.getShareStats(pool, USER_ID, {});
  });
  assert.ok(calls.length > 10, `touched a realistic query count, got ${calls.length}`);
});
