// V5.6 Study Now — deterministic next action reusing existing signals.
// Read-only, bounded, user-scoped. No new tables.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const pool = require('../src/config/db');
const controller = require('../src/controllers/dashboardController');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TODAY = '2026-10-04';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withPoolQuery(stub, callback) {
  const original = pool.query;
  pool.query = stub;
  try {
    await callback();
  } finally {
    pool.query = original;
  }
}

function stubPool({ due = null, difficult = 0, minutes = 0, vocab = 0, kanji = 0, grammar = 0, reading = null, sample = [], gradedToday = 0, newToday = 0, openSessions = [] } = {}) {
  const dueParts = due || { vocabulary: vocab, kanji, grammar };
  return async (sql) => {
    if (/FROM review_sessions rs/i.test(sql)) {
      return [openSessions];
    }
    if (/review_events/i.test(sql) && /GROUP BY ri\.id_review_item/i.test(sql)) {
      return [Array.from({ length: difficult }, (_, i) => ({ id_review_item: i + 1 }))];
    }
    if (/FROM review_events re/i.test(sql)) {
      return [[{ graded_today: gradedToday }]];
    }
    if (/user_reading_progress/i.test(sql)) {
      return [reading ? [reading] : []];
    }
    if (/due_sample/i.test(sql)) {
      return [sample.map((title) => ({ title }))];
    }
    return [[{
      due_vocabulary: dueParts.vocabulary || 0,
      due_kanji: dueParts.kanji || 0,
      due_grammar: dueParts.grammar || 0,
      minutes_today: minutes,
      vocabulary_count: vocab,
      kanji_count: kanji,
      grammar_count: grammar,
      new_items_today: newToday
    }]];
  };
}

test('Study Now prioritizes due reviews with difficult context', async () => {
  await withPoolQuery(stubPool({ due: { vocabulary: 12, kanji: 5, grammar: 1 }, difficult: 4, minutes: 10, vocab: 5, sample: ['食べる', '行く', '大きい'] }), async () => {
    const { res, status, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(status(), 200);
    const data = body();
    assert.equal(data.primary.kind, 'review');
    assert.equal(data.primary.href, '#review');
    assert.equal(data.primary.auto, 'due');
    assert.match(data.primary.title, /18 reviews? due/);
    assert.match(data.primary.reason, /12 words · 5 kanji · 1 pattern/);
    assert.match(data.primary.reason, /4.*marked Again more than once/);
    assert.match(data.primary.reason, /Up first: /);
    assert.match(data.primary.cta, /Start now/);
    assert.equal(data.signals.dueCount, 18);
    assert.equal(data.signals.difficultCount, 4);
    assert.deepEqual(data.signals.dueBreakdown, { vocabulary: 12, kanji: 5, grammar: 1 });
    assert.deepEqual(data.signals.dueSample, ['食べる', '行く', '大きい']);
  });
});

test('Study Now surfaces incomplete reading when reviews are clear', async () => {
  await withPoolQuery(stubPool({ due: { vocabulary: 0, kanji: 0, grammar: 0 }, vocab: 10, reading: { id: 7, title: 'Aozora story' } }), async () => {
    const { res, status, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(status(), 200);
    assert.equal(body().primary.kind, 'reading');
    assert.equal(body().primary.href, '#reading?id=7');
  });
});

test('Study Now guides empty collections to the Analyzer', async () => {
  await withPoolQuery(stubPool({ due: { vocabulary: 0, kanji: 0, grammar: 0 }, vocab: 0, kanji: 0, grammar: 0 }), async () => {
    const { res, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(body().primary.kind, 'analyze');
    assert.equal(body().primary.href, '#analyzer');
  });
});

test('Study Now nudges session logging when today is empty', async () => {
  await withPoolQuery(stubPool({ due: { vocabulary: 0, kanji: 0, grammar: 0 }, vocab: 3, minutes: 0 }), async () => {
    const { res, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(body().primary.kind, 'session');
    assert.equal(body().primary.href, '#sessions?new=1');
  });
});

test('Study Now rejects malformed today', async () => {
  const { res, status, body } = mockRes();
  await controller.getStudyNow({ user: { id: USER_ID }, query: { today: 'not-a-date' } }, res);
  assert.equal(status(), 400);
  assert.match(body().error, /today must be a YYYY-MM-DD date/);
});

test('Study Now stays user-scoped (no cross-user params)', async () => {
  const seen = [];
  const stub = stubPool({ due: { vocabulary: 1, kanji: 0, grammar: 0 } });
  await withPoolQuery(async (sql, params) => {
    seen.push(params || []);
    return stub(sql, params);
  }, async () => {
    const { res } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    for (const params of seen) {
      for (const value of params) {
        if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) {
          assert.equal(value, USER_ID);
        }
      }
    }
    assert.ok(seen.length >= 2, 'due + parallel signals queried');
  });
});

test('Study Now reports real today progress and resumable work', async () => {
  await withPoolQuery(stubPool({
    due: { vocabulary: 2, kanji: 0, grammar: 0 },
    minutes: 10,
    vocab: 4,
    gradedToday: 23,
    newToday: 6,
    reading: { id: 7, title: 'Aozora story', position: 120, timeSpentSeconds: 300 },
    openSessions: [{ id: 9, sourceFrom: '2026-10-01', sourceTo: '2026-10-04', startedAt: '2026-10-04', total: 30, graded: 7 }]
  }), async () => {
    const { res, status, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(status(), 200);
    const data = body();
    assert.deepEqual(data.todayProgress, { reviewsDone: 23, reviewsDue: 2, readingMinutes: 10, newItems: 6 });
    assert.deepEqual(data.continueStudying.reading, { id: 7, title: 'Aozora story', position: 120, timeSpentSeconds: 300 });
    assert.deepEqual(data.continueStudying.reviewSession, { id: 9, remaining: 23, total: 30, sourceFrom: '2026-10-01', sourceTo: '2026-10-04' });
  });
});

test('Continue Studying hides finished sessions and empty reading', async () => {
  await withPoolQuery(stubPool({
    due: { vocabulary: 0, kanji: 0, grammar: 0 },
    vocab: 4,
    minutes: 5,
    gradedToday: 30,
    openSessions: [{ id: 9, sourceFrom: '2026-10-01', sourceTo: '2026-10-04', startedAt: '2026-10-04', total: 30, graded: 30 }]
  }), async () => {
    const { res, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(body().continueStudying.reading, null);
    assert.equal(body().continueStudying.reviewSession, null, 'fully graded sessions are not resumable');
    assert.deepEqual(body().todayProgress, { reviewsDone: 30, reviewsDue: 0, readingMinutes: 5, newItems: 0 });
  });
});

test('GET /api/review/due exposes entityId for the auto-session queue', async () => {
  const reviewController = require('../src/controllers/reviewController');
  const original = pool.execute;
  pool.execute = async () => [[
    { id_review_item: 1, due_on: '2026-09-01', item_type: 'Vocabulary', entity_id: 11, title: '水', meaning: 'water', reading: 'みず' },
    { id_review_item: 2, due_on: '2026-09-02', item_type: 'Kanji', entity_id: 22, title: '日', meaning: 'day', reading: null },
    { id_review_item: 3, due_on: '2026-09-03', item_type: 'Grammar', entity_id: null, title: '〜ても', meaning: 'even if', reading: null }
  ]];
  try {
    const { res, status, body } = mockRes();
    await reviewController.listDueReviewCards({ user: { id: USER_ID }, query: {} }, res);
    assert.equal(status(), 200);
    const items = body().items;
    assert.equal(items[0].entityType, 'vocabulary');
    assert.equal(items[0].entityId, 11);
    assert.equal(items[1].entityType, 'kanji');
    assert.equal(items[1].entityId, 22);
    // Legacy rows without entity_id stay null-safe instead of failing.
    assert.equal(items[2].entityType, 'grammar');
    assert.equal(items[2].entityId, null);
  } finally {
    pool.execute = original;
  }
});
