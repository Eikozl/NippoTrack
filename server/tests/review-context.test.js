// V5.6 Completion Pass: where-seen aggregation + batched review context.
// All stubbed: read-only, user-scoped, bounded. No DB needed.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';

const pool = require('../src/config/db');
const { getWhereSeen } = require('../src/services/whereSeen');
const { getReviewItemContext } = require('../src/services/reviewItemContext');
const vocabularyController = require('../src/controllers/vocabularyController');
const grammarController = require('../src/controllers/grammarController');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test('where-seen returns examples, sessions and immersion from existing relations', async () => {
  const seen = [];
  const stub = async (sql, params = []) => {
    seen.push({ sql, params });
    if (/FROM usage_examples/i.test(sql)) {
      return [[{ sentence: '犬がいる。', translation: 'There is a dog.', createdAt: '2026-09-01' }]];
    }
    if (/FROM session_vocabulary/i.test(sql)) {
      return [[{ date: '2026-09-02', category: 'Reading', minutes: 20 }]];
    }
    if (/FROM immersion_session_items/i.test(sql)) {
      return [[{ createdAt: '2026-09-03', level: 'N4' }]];
    }
    throw new Error(`Unexpected where-seen SQL: ${sql.slice(0, 70)}`);
  };
  await withPoolExecute(stub, async () => {
    const result = await getWhereSeen(pool, USER_ID, 'vocabulary', 5);
    assert.deepEqual(result.examples, [{ sentence: '犬がいる。', translation: 'There is a dog.', createdAt: '2026-09-01' }]);
    assert.deepEqual(result.sessions, [{ date: '2026-09-02', category: 'Reading', minutes: 20 }]);
    assert.deepEqual(result.immersion, [{ createdAt: '2026-09-03', level: 'N4' }]);
    for (const { params } of seen) {
      assert.ok(params.includes(USER_ID), 'every branch carries the requesting user');
      assert.ok(!params.includes(OTHER_ID), 'no foreign user leaks in');
    }
    assert.equal(seen.length, 3, 'exactly three bounded queries, no N+1');
  });
});

test('where-seen is empty (never fabricated) when nothing exists', async () => {
  await withPoolExecute(async () => [[]], async () => {
    assert.deepEqual(await getWhereSeen(pool, USER_ID, 'grammar', 9), { examples: [], sessions: [], immersion: [] });
  });
});

test('where-seen rejects unknown types and bad ids without querying', async () => {
  let queried = false;
  await withPoolExecute(async () => { queried = true; return [[]]; }, async () => {
    await assert.rejects(getWhereSeen(pool, USER_ID, 'kanji', 3), /Unsupported/);
    await assert.rejects(getWhereSeen(pool, USER_ID, 'vocabulary', 0), /positive integer/);
    await assert.rejects(getWhereSeen(pool, USER_ID, 'vocabulary', 'abc'), /positive integer/);
  });
  assert.equal(queried, false, 'validation precedes any database access');
});

test('vocabulary/grammar encounters endpoints are owner-gated', async () => {
  // Foreign id → 404, service never reached.
  await withPoolExecute(async (sql) => {
    if (/FROM vocabulary WHERE/i.test(sql)) return [[]];
    if (/FROM grammar_points WHERE/i.test(sql)) return [[]];
    throw new Error(`Unexpected gate SQL: ${sql.slice(0, 60)}`);
  }, async () => {
    const v = mockRes();
    await vocabularyController.getVocabularyEncounters({ params: { id: '99' }, user: { id: USER_ID } }, v.res);
    assert.equal(v.status(), 404);
    const g = mockRes();
    await grammarController.getGrammarEncounters({ params: { id: '99' }, user: { id: USER_ID } }, g.res);
    assert.equal(g.status(), 404);
  });
});

test('review context batches aggregates, examples and encounters per queue', async () => {
  const seen = [];
  const stub = async (sql, params = []) => {
    seen.push(sql);
    if (/FROM review_events re/i.test(sql) && /id_vocabulary IN/i.test(sql)) {
      return [[{ entity_type: 'vocabulary', entity_id: 11, last_reviewed_at: '2026-09-28', last_failed_at: '2026-09-20', again_count: 3 }]];
    }
    if (/FROM review_events re/i.test(sql)) return [[]];
    if (/FROM usage_examples/i.test(sql)) {
      return [[{ entity_id: 11, sentence: '犬がいる。', translation: 'There is a dog.' }]];
    }
    if (/FROM grammar_examples/i.test(sql)) return [[]];
    if (/FROM kanji_encounters/i.test(sql)) {
      return [[{ entity_id: 22, count: 4, last_at: '2026-09-27' }]];
    }
    throw new Error(`Unexpected context SQL: ${sql.slice(0, 70)}`);
  };
  await withPoolExecute(stub, async () => {
    const context = await getReviewItemContext(pool, USER_ID, [
      { entityType: 'vocabulary', entityId: 11 },
      { entityType: 'kanji', entityId: 22 },
      { entityType: 'grammar', entityId: 33 }
    ]);
    const vocab = context.get('vocabulary:11');
    assert.equal(vocab.againCount, 3);
    assert.equal(vocab.lastFailedAt, '2026-09-20');
    assert.deepEqual(vocab.example, { sentence: '犬がいる。', translation: 'There is a dog.' });
    assert.equal(vocab.encounters, null);
    const kanji = context.get('kanji:22');
    assert.deepEqual(kanji.encounters, { count: 4, lastAt: '2026-09-27' });
    assert.equal(kanji.example, null);
    const grammar = context.get('grammar:33');
    assert.equal(grammar.againCount, 0);
    assert.equal(grammar.example, null);
    assert.equal(grammar.encounters, null);
    assert.ok(seen.length <= 5, `fixed small query count, got ${seen.length}`);
    for (const sql of seen) assert.ok(!/FOR UPDATE/i.test(sql), 'context reads never lock rows');
  });
});

test('review context ignores malformed items and stays empty without data', async () => {
  let queried = 0;
  await withPoolExecute(async () => { queried += 1; return [[]]; }, async () => {
    const context = await getReviewItemContext(pool, USER_ID, [
      null, {}, { entityType: 'vocabulary', entityId: -2 }, { entityType: 'bogus', entityId: 1 }
    ]);
    assert.equal(context.size, 0, 'nothing valid, nothing returned');
  });
  assert.ok(queried <= 1, 'degenerate input issues no fan-out');
});
