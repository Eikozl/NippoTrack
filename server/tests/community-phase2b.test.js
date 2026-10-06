// V6.1 Phase 2b: block/privacy gates on the alternate content paths
// (deck + reading publications), search correctness (real OFFSET paging,
// LIKE-wildcard escaping, owner-publicity on deck/reading hits), owner-only
// study counts, duplicate-report 409, and block gates on linked content +
// notifications. Stubbed executor throughout (no live DB needed); SQL-shape
// assertions pin the gates the way earlier phases do, plus behavioral pins
// where the stub rows carry the new projected columns.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const BLOCKED_ID = '00000000-0000-4000-8000-000000000003';

const pool = require('../src/config/db');
const community = require('../src/services/community');
const decks = require('../src/services/deckPublications');
const reading = require('../src/services/readingPublications');
const deckController = require('../src/controllers/deckPublicationsController');
const readingController = require('../src/controllers/readingPublicationsController');
const communityController = require('../src/controllers/communityController');

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

const VISIBLE_POST = {
  id: 7, author_id: OTHER_ID, post_type: 'text', title: null, body: 'hi',
  japanese_text: null, translation: null, entity_type: null, entity_id: null,
  deck_id: null, reading_id: null, like_count: 1, comment_count: 0, liked: false,
  author_username: 'yuki', author_display: null, author_avatar: null,
  created_at: '2026-10-07', updated_at: null
};

function deckRow(overrides = {}) {
  return [{
    id: 7, owner_id: OTHER_ID, title: 'Open', description: '', entity_type: 'vocabulary',
    is_public: 1, created_at: '2026-01-01', owner_username: 'yuki', owner_display: null,
    owner_is_public: 1, viewer_blocked: 0, viewer_following: 0, followers: 0,
    ...overrides
  }];
}

function readingRow(overrides = {}) {
  return [{
    id: 11, owner_id: OTHER_ID, title: 'T1', description: '', level: null, text: '犬。',
    translations_json: {}, is_public: true, created_at: '2026-01-01',
    owner_username: null, owner_display: null, owner_is_public: true, viewer_blocked: false,
    ...overrides
  }];
}

test('blocked deck fetches resolve to the same 404-shape null as missing', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM deck_publications d/i.test(sql)) return [deckRow({ viewer_blocked: 1 })];
    if (/FROM deck_publication_items/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await decks.getDeckPublication(pool, 7, USER_ID), null);
  });
  const main = seen.find(({ sql }) => /FROM deck_publications d/i.test(sql));
  assert.ok(/user_blocks/i.test(main.sql), 'block NOT EXISTS in the deck read');
  assert.ok(/p\.is_public/i.test(main.sql), 'owner publicity in the deck read');
  assert.ok(main.params.filter((p) => p === USER_ID).length >= 3, 'viewer binds every gate position');
  // Missing decks resolve identically (no oracle between gone/blocked/private).
  await withPoolExecute(async (sql) => {
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await decks.getDeckPublication(pool, 777, USER_ID), null);
  });
});

test('private-owner decks stay invisible; owners keep their own private rows', async () => {
  const run = async (row, viewer) => withPoolExecute(async (sql) => {
    if (/FROM deck_publications d/i.test(sql)) return [row];
    if (/FROM deck_publication_items/i.test(sql)) return [[{ position: 0, item_json: { word: '水' } }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => decks.getDeckPublication(pool, 7, viewer));
  assert.equal(await run(deckRow({ owner_is_public: 0 }), USER_ID), null, 'public deck, private owner hides from strangers');
  const own = await run(deckRow({ owner_id: USER_ID, is_public: 0, owner_is_public: 0 }), USER_ID);
  assert.equal(own.title, 'Open', 'owner still reads the private row');
  assert.equal(own.items.length, 1);
});

test('deck follows gate on owner publicity and blocks, 404-shape on gated', async () => {
  const run = async (row) => withPoolExecute(async (sql, params = []) => {
    if (/FROM deck_publications WHERE/i.test(sql)) return [row];
    if (/INSERT INTO deck_follows/i.test(sql)) return [{ affectedRows: 1 }];
    if (/COUNT\(\*\) AS followers/i.test(sql)) return [[{ followers: 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => decks.setDeckFollow(pool, 7, USER_ID, true));
  const base = { id: 7, owner_id: OTHER_ID, is_public: 1 };
  assert.equal(await run([{ ...base, owner_is_public: 0, viewer_blocked: 0 }]), null, 'private owner blocks follows');
  assert.equal(await run([{ ...base, owner_is_public: 1, viewer_blocked: 1 }]), null, 'blocked owner blocks follows');
  assert.deepEqual(
    await run([{ ...base, owner_is_public: 1, viewer_blocked: 0 }]),
    { following: true, followers: 1 }
  );
  // Self bypass: the owner follows despite hostile projected flags.
  assert.deepEqual(
    await withPoolExecute(async (sql) => {
      if (/FROM deck_publications WHERE/i.test(sql)) return [[{ ...base, owner_id: USER_ID, owner_is_public: 0, viewer_blocked: 1 }]];
      if (/INSERT INTO deck_follows/i.test(sql)) return [{ affectedRows: 1 }];
      if (/COUNT\(\*\) AS followers/i.test(sql)) return [[{ followers: 1 }]];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
    }, async () => decks.setDeckFollow(pool, 7, USER_ID, true)),
    { following: true, followers: 1 }
  );
});

test('deck public profiles gate private and blocked owners; self bypasses', async () => {
  const profileRow = (isPublic) => [[{
    user_id: OTHER_ID, display_name: 'Yuki', bio: null, avatar_url: null, is_public: isPublic
  }]];
  const run = async (rows, blocks, viewer) => withPoolExecute(async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return rows;
    if (/FROM user_blocks/i.test(sql)) return blocks;
    if (/COUNT\(\*\) AS total FROM deck_publications WHERE owner_id/i.test(sql)) return [[{ total: 1 }]];
    if (/JOIN deck_publications d ON/i.test(sql)) return [[{ total: 2 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => decks.getPublicProfile(pool, 'yuki', viewer));
  assert.equal(await run(profileRow(false), [[]], USER_ID), null, 'private owner hides from strangers');
  assert.equal(await run(profileRow(true), [[{ 1: 1 }]], USER_ID), null, 'blocked owner hides both ways');
  const selfRow = [[{ user_id: USER_ID, display_name: 'Me', bio: null, avatar_url: null, is_public: false }]];
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile WHERE username/i.test(sql)) return selfRow;
    if (/COUNT\(\*\) AS total FROM deck_publications WHERE owner_id/i.test(sql)) return [[{ total: 1 }]];
    if (/JOIN deck_publications d ON/i.test(sql)) return [[{ total: 0 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const self = await decks.getPublicProfile(pool, 'me', USER_ID);
    assert.equal(self.displayName, 'Me', 'owners read their own private profile');
  });
  assert.ok(!seen.some(({ sql }) => /FROM user_blocks/i.test(sql)), 'self scope issues no block check');
  assert.equal(await run([[]], [[]], USER_ID), null, 'missing user stays null');
});

test('deck listings filter to public, unblocked owners except the self scope', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await decks.listPublicDecks(pool, { viewerId: USER_ID });
    await decks.listPublicDecks(pool, { ownerId: USER_ID, viewerId: USER_ID });
    await decks.listPublicDecks(pool, { ownerId: OTHER_ID, viewerId: USER_ID });
  });
  assert.equal(seen.length, 3);
  const [feed, self, stranger] = seen;
  for (const query of [feed, stranger]) {
    assert.ok(/NOT EXISTS/i.test(query.sql) && /user_blocks/i.test(query.sql), 'non-self scopes exclude blocked pairs');
    assert.ok(/p\.is_public/i.test(query.sql), 'non-self scopes require a public owner');
    assert.ok(query.params.filter((p) => p === USER_ID).length >= 3, 'viewer binds every gate position');
  }
  assert.ok(/d\.is_public = TRUE/.test(feed.sql), 'public feed hides private rows');
  assert.ok(/d\.is_public = TRUE/.test(stranger.sql), 'stranger owner scope hides private rows');
  assert.ok(!/user_blocks/i.test(self.sql), 'self scope keeps private rows without block filter');
  assert.ok(!/d\.is_public = TRUE/.test(self.sql), 'self scope keeps private rows');
});

test('blocked/private-owner reading fetches and imports resolve to 404-shape null', async () => {
  const runGet = async (row) => withPoolExecute(async (sql) => {
    if (/FROM reading_publications r/i.test(sql)) return [row];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => reading.getReadingPublication(pool, 11, USER_ID));
  assert.equal(await runGet(readingRow({ viewer_blocked: true })), null, 'blocked owner hides the text');
  assert.equal(await runGet(readingRow({ owner_is_public: false })), null, 'private owner hides the text');
  const own = await runGet(readingRow({ owner_id: USER_ID, is_public: false, owner_is_public: false }));
  assert.equal(own.text, '犬。', 'owner still reads the private text');
  // Import inherits the gates through getReadingPublication (no separate path).
  await withPoolExecute(async (sql) => {
    if (/FROM reading_publications r/i.test(sql)) return [readingRow({ viewer_blocked: true })];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    assert.equal(await reading.importReadingPublication(pool, USER_ID, 11), null);
  });
});

test('reading listings filter to public, unblocked owners except the self scope', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await reading.listReadingPublications(pool, { viewerId: USER_ID });
    await reading.listReadingPublications(pool, { ownerId: USER_ID, viewerId: USER_ID });
  });
  assert.equal(seen.length, 2);
  const [feed, self] = seen;
  assert.ok(/NOT EXISTS/i.test(feed.sql) && /user_blocks/i.test(feed.sql), 'public feed excludes blocked pairs');
  assert.ok(/p\.is_public/i.test(feed.sql), 'public feed requires a public owner');
  assert.ok(!/user_blocks/i.test(self.sql), 'self scope keeps private rows');
});

test('community profile counts are owner-only; shape keeps every key', async () => {
  const profile = [[{
    user_id: OTHER_ID, username: 'yuki', display_name: 'Yuki', bio: null, avatar_url: null,
    is_public: true, jlpt_level: null, target_jlpt: null, interests: null
  }]];
  const stub = async (sql) => {
    if (/FROM user_profile WHERE username/i.test(sql)) return profile;
    if (/FROM user_blocks/i.test(sql)) return [[]];
    if (/FROM vocabulary/i.test(sql)) {
      return [[{ posts: 2, followers: 3, following: 1, vocabulary: 10, kanji: 4, grammar: 2 }]];
    }
    if (/SELECT 1 AS following FROM user_follows/i.test(sql)) return [[{ following: 1 }]];
    if (/FROM community_posts WHERE author_id/i.test(sql)) return [[{ posts: 2, followers: 3, following: 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  };
  await withPoolExecute(stub, async () => {
    const self = await community.getCommunityProfile(pool, OTHER_ID, 'yuki');
    assert.deepEqual(
      self.counts,
      { posts: 2, followers: 3, following: 1, vocabulary: 10, kanji: 4, grammar: 2 },
      'owners see full study sizes'
    );
    const stranger = await community.getCommunityProfile(pool, USER_ID, 'yuki');
    assert.equal(stranger.counts.posts, 2, 'public post count stays');
    assert.equal(stranger.counts.followers, 3, 'public follower count stays');
    assert.equal(stranger.counts.following, 1, 'public following count stays');
    assert.equal(stranger.counts.vocabulary, null, 'study sizes undisclosed (null, never zero)');
    assert.equal(stranger.counts.kanji, null);
    assert.equal(stranger.counts.grammar, null);
    assert.deepEqual(
      Object.keys(stranger.counts).sort(),
      ['followers', 'following', 'grammar', 'kanji', 'posts', 'vocabulary'],
      'no response-shape break: every key present'
    );
  });
});

test('search pages with real OFFSET and escapes LIKE wildcards', async () => {
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/FROM community_posts p/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) return [[]];
    if (/FROM reading_publications r/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const page3 = await community.searchCommunity(pool, USER_ID, 'nichi', { type: 'posts', page: 3, limit: 5 });
    assert.equal(page3.page, 3);
    assert.deepEqual(page3.posts, []);
    await community.searchCommunity(pool, USER_ID, '100%_\\', { type: 'all' });
  });
  const posts = seen.find(({ sql }) => /FROM community_posts p/i.test(sql));
  assert.deepEqual(posts.params.slice(-2), [5, 10], 'page 3, limit 5 binds OFFSET 10');
  assert.ok(/OFFSET \?/.test(posts.sql), 'posts page with OFFSET');
  for (const { sql, params } of seen) {
    assert.ok(/ESCAPE/.test(sql), 'every search class carries an ESCAPE clause');
  }
  const people = seen.find(({ sql }) => /FROM user_profile up/i.test(sql));
  assert.ok(
    people.params.some((p) => typeof p === 'string' && p.includes('\\%') && p.includes('\\_') && p.includes('\\\\')),
    'wildcards arrive escaped so q="%" cannot enumerate'
  );
  const decksHit = seen.find(({ sql }) => /FROM deck_publications d/i.test(sql));
  assert.ok(/\(d\.owner_id = \? OR up\.is_public\)/.test(decksHit.sql), 'deck hits require a public owner unless self');
  const readingHit = seen.find(({ sql }) => /FROM reading_publications r/i.test(sql));
  assert.ok(/\(r\.owner_id = \? OR p\.is_public\)/.test(readingHit.sql), 'reading hits require a public owner unless self');
});

test('duplicate reports from the same reporter are a 409 with a stable code', async () => {
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[{ 1: 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      community.createReport(pool, USER_ID, { targetType: 'post', targetId: 7, reason: 'spam' }),
      (error) => error.code === 'REPORT_ALREADY_EXISTS'
    );
  });
  // Through the controller the conflict surfaces as HTTP 409 (never silent).
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[{ 1: 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await communityController.createReport(
      { body: { targetType: 'post', targetId: 7, reason: 'spam' }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 409);
    assert.equal(body().code, 'REPORT_ALREADY_EXISTS');
  });
  // First-time reports still create (201).
  await withPoolExecute(async (sql) => {
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await communityController.createReport(
      { body: { targetType: 'post', targetId: 7, reason: 'spam' }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().id, 21);
  });
});

test('linking a blocked user content is rejected; notifications skip blocked pairs', async () => {
  // Blocked deck link: same 404-style message as a missing deck (no oracle).
  await withPoolExecute(async (sql) => {
    if (/FROM deck_publications d WHERE/i.test(sql)) {
      return [[{ title: 'T', entity_type: 'vocabulary', owner_id: BLOCKED_ID, items: 3 }]];
    }
    if (/FROM user_blocks/i.test(sql)) return [[{ 1: 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      community.createPost(pool, USER_ID, { postType: 'share_deck', body: 'hi', deckId: 3 }),
      /Linked deck not found/
    );
  });
  // Blocked reading link: same treatment.
  await withPoolExecute(async (sql) => {
    if (/FROM reading_publications/i.test(sql) && /WHERE id_reading_publication/i.test(sql)) {
      return [[{ title: 'T', level: 'N5', owner_id: BLOCKED_ID, chars: 10 }]];
    }
    if (/FROM user_blocks/i.test(sql)) return [[{ 1: 1 }]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    await assert.rejects(
      community.createPost(pool, USER_ID, { postType: 'share_reading', body: 'hi', readingId: 11 }),
      /Linked reading text not found/
    );
  });
  // Commenting still works across a block on the post itself, but the inbox
  // write is skipped (no notification row for blocked pairs).
  const seen = [];
  await withPoolExecute(async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM community_posts p/i.test(sql)) return [[VISIBLE_POST]];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 11 }];
    if (/FROM user_blocks/i.test(sql)) return [[{ 1: 1 }]];
    if (/FROM post_comments c/i.test(sql) && !/INSERT/i.test(sql)) {
      return [[{ id: 11, author_id: USER_ID, body: 'nice', created_at: '2026-10-07', updated_at: null, author_username: 'me', author_display: null, author_avatar: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const comment = await community.createComment(pool, USER_ID, 7, 'nice');
    assert.equal(comment.id, 11, 'the comment itself still lands');
  });
  assert.ok(
    seen.some(({ sql }) => /FROM user_blocks/i.test(sql)),
    'notify path checks the block first'
  );
  assert.ok(
    !seen.some(({ sql }) => /INSERT INTO notifications/i.test(sql)),
    'no inbox row is written across a block'
  );
});

test('deck and reading controllers map gated rows to identical 404 bodies', async () => {
  const deckBodies = [];
  for (const row of [[], deckRow({ viewer_blocked: 1 })]) {
    await withPoolExecute(async (sql) => {
      if (/FROM deck_publications d/i.test(sql)) return [row];
      if (/FROM deck_publication_items/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
    }, async () => {
      const { res, status, body } = mockRes();
      await deckController.getDeck({ params: { id: '7' }, user: { id: USER_ID } }, res);
      assert.equal(status(), 404);
      deckBodies.push(body());
    });
  }
  assert.deepEqual(deckBodies[0], deckBodies[1], 'missing and blocked decks share one 404 body');
  const readingBodies = [];
  for (const row of [[], readingRow({ viewer_blocked: true })]) {
    await withPoolExecute(async (sql) => {
      if (/FROM reading_publications r/i.test(sql)) return [row];
      throw new Error(`Unexpected SQL: ${sql.slice(0, 60)}`);
    }, async () => {
      const { res, status, body } = mockRes();
      await readingController.getPublication({ params: { id: '11' }, user: { id: USER_ID } }, res);
      assert.equal(status(), 404);
      readingBodies.push(body());
    });
  }
  assert.deepEqual(readingBodies[0], readingBodies[1], 'missing and blocked texts share one 404 body');
});

test('every touched phase-2b query binds exactly its placeholders', async () => {
  const calls = [];
  const strict = async (sql, params = []) => {
    calls.push({ sql, params });
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(params.length, placeholders, `param count must match placeholders: ${sql.slice(0, 100)}`);
    if (/INSERT INTO community_posts/i.test(sql)) return [{ insertId: 7 }];
    if (/INSERT INTO post_comments/i.test(sql)) return [{ insertId: 11 }];
    if (/INSERT INTO content_reports/i.test(sql)) return [{ insertId: 21 }];
    if (/SELECT 1 FROM content_reports/i.test(sql)) return [[]];
    if (/INSERT INTO notifications/i.test(sql)) return [{ insertId: 4 }];
    if (/FROM community_posts p/i.test(sql)) {
      if (/ILIKE/i.test(sql)) return [[]];
      return [[VISIBLE_POST]];
    }
    if (/FROM vocabulary/i.test(sql)) {
      return [[{ posts: 1, followers: 0, following: 0, vocabulary: 5, kanji: 2, grammar: 1 }]];
    }
    if (/FROM community_posts WHERE author_id/i.test(sql)) {
      return [[{ posts: 1, followers: 0, following: 0 }]];
    }
    if (/SELECT id_community_post AS id FROM post_comments/i.test(sql)) return [[{ id: 7 }]];
    if (/SELECT author_id FROM post_comments/i.test(sql)) return [[{ author_id: OTHER_ID }]];
    if (/FROM post_comments c/i.test(sql)) {
      if (/COUNT\(\*\)/i.test(sql)) return [[{ total: '0' }]];
      return [[]];
    }
    if (/^\s*SELECT 1 FROM user_blocks/i.test(sql)) return [[]];
    if (/SELECT 1 AS following FROM user_follows/i.test(sql)) return [[]];
    if (/FROM user_profile WHERE username/i.test(sql)) {
      return [[{ user_id: OTHER_ID, username: 'yuki', display_name: null, bio: null, avatar_url: null, is_public: true, jlpt_level: null, target_jlpt: null, interests: null }]];
    }
    if (/FROM user_profile up/i.test(sql)) return [[]];
    if (/FROM deck_publications d/i.test(sql)) {
      if (/d\.id_deck_publication = \?/i.test(sql) && /LEFT JOIN user_profile/i.test(sql)) return [deckRow()];
      if (/d\.id_deck_publication = \?/i.test(sql)) {
        return [[{ title: 'T', entity_type: 'vocabulary', owner_id: OTHER_ID, items: 2 }]];
      }
      return [[]];
    }
    if (/FROM deck_publications WHERE/i.test(sql)) {
      return [[{ id: 7, owner_id: OTHER_ID, is_public: 1, owner_is_public: 1, viewer_blocked: 0 }]];
    }
    if (/FROM deck_publication_items/i.test(sql)) return [[]];
    if (/COUNT\(\*\) AS followers/i.test(sql)) return [[{ followers: 0 }]];
    if (/INSERT INTO deck_follows/i.test(sql)) return [{ affectedRows: 1 }];
    if (/DELETE FROM deck_follows/i.test(sql)) return [{ affectedRows: 1 }];
    if (/COUNT\(\*\) AS total FROM deck_publications WHERE owner_id/i.test(sql)) return [[{ total: '0' }]];
    if (/JOIN deck_publications d ON/i.test(sql)) return [[{ total: '0' }]];
    if (/FROM reading_publications r/i.test(sql)) {
      if (/WHERE r\.id_reading_publication/i.test(sql)) return [readingRow()];
      return [[]];
    }
    if (/WHERE id_reading_publication/i.test(sql) && /FROM reading_publications/i.test(sql)) {
      return [[{ title: 'T', level: null, owner_id: OTHER_ID, chars: 5 }]];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  };
  await withPoolExecute(strict, async () => {
    await decks.getDeckPublication(pool, 7, USER_ID);
    await decks.setDeckFollow(pool, 7, USER_ID, true);
    await decks.getPublicProfile(pool, 'yuki', USER_ID);
    await decks.listPublicDecks(pool, { viewerId: USER_ID });
    await decks.listPublicDecks(pool, { ownerId: USER_ID, viewerId: USER_ID });
    await decks.listPublicDecks(pool, { ownerId: OTHER_ID, viewerId: USER_ID });
    await reading.getReadingPublication(pool, 11, USER_ID);
    await reading.listReadingPublications(pool, { viewerId: USER_ID });
    await community.searchCommunity(pool, USER_ID, 'nichi %_', { type: 'all', page: 2, limit: 5 });
    await community.searchCommunity(pool, USER_ID, 'nichi', { type: 'decks' });
    await community.searchCommunity(pool, USER_ID, 'nichi', { type: 'reading' });
    await community.getCommunityProfile(pool, USER_ID, 'yuki');
    await community.getCommunityProfile(pool, OTHER_ID, 'yuki');
    await community.createReport(pool, USER_ID, { targetType: 'post', targetId: 7, reason: 'spam' });
    await community.createReport(pool, USER_ID, { targetType: 'comment', targetId: 11, reason: 'spam' });
    await community.createComment(pool, USER_ID, 7, 'nice');
  });
  assert.ok(calls.length > 30, `touched a realistic query count, got ${calls.length}`);
});
