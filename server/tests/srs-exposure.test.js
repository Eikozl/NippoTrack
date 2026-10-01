// SRS exposure parity: vocabulary and grammar details return the same owned
// `review` shape as kanji detail (or null), without lazy enrollment.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const vocabularyController = require('../src/controllers/vocabularyController');
const grammarController = require('../src/controllers/grammarController');
const pool = require('../src/config/db');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withExecuteStub(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test('GET vocabulary detail exposes the owned SRS review row', async () => {
  const seen = [];
  await withExecuteStub(async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM vocabulary WHERE id_vocabulary = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_vocabulary: 7, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'Learning', notes: null }]];
    }
    if (/FROM kanji_vocabulary kv JOIN kanji k/i.test(sql)) return [[]];
    if (/FROM usage_examples WHERE id_vocabulary/i.test(sql)) return [[]];
    if (/FROM review_items ri\s+JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary/i.test(sql)) {
      assert.deepEqual(params, [7, USER_ID]);
      return [[{ id_review_item: 31, due_on: '2026-09-10', interval_days: 3, last_reviewed_at: '2026-09-01T10:00:00.000Z', last_result: 'Hard' }]];
    }
    if (/FROM kanji k WHERE k.user_id/i.test(sql)) return [[]];
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await vocabularyController.getVocabulary({ params: { id: '7' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body().review, {
      idReviewItem: 31,
      dueOn: '2026-09-10',
      intervalDays: 3,
      lastReviewedAt: '2026-09-01T10:00:00.000Z',
      lastResult: 'Hard'
    });
  });
});

test('GET vocabulary detail returns review null when never graded', async () => {
  await withExecuteStub(async (sql) => {
    if (/FROM vocabulary WHERE id_vocabulary = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_vocabulary: 8, word: 'ひらがな', reading: 'ひらがな', meaning: 'hiragana', jlpt_level: null, status: 'New', notes: null }]];
    }
    if (/FROM kanji_vocabulary kv JOIN kanji k/i.test(sql)) return [[]];
    if (/FROM usage_examples WHERE id_vocabulary/i.test(sql)) return [[]];
    if (/FROM review_items ri\s+JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary/i.test(sql)) return [[]];
    if (/FROM kanji k WHERE k.user_id/i.test(sql)) return [[]];
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await vocabularyController.getVocabulary({ params: { id: '8' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().review, null);
  });
});

test('GET grammar detail exposes the owned SRS review row', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 9, grammar_point: '〜ば〜ほど', meaning: 'the more', structure: null, example: null, jlpt_level: 'N4', status: 'Learning', notes: null, reference_id: null }]];
    }
    if (/FROM review_items ri\s+JOIN grammar_points g ON g.id_grammar = ri.id_grammar/i.test(sql)) {
      assert.deepEqual(params, [9, USER_ID]);
      return [[{ id_review_item: 44, due_on: '2026-09-12', interval_days: 7, last_reviewed_at: '2026-09-05T10:00:00.000Z', last_result: 'Good' }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await grammarController.getGrammar({ params: { id: '9' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body().review, {
      idReviewItem: 44,
      dueOn: '2026-09-12',
      intervalDays: 7,
      lastReviewedAt: '2026-09-05T10:00:00.000Z',
      lastResult: 'Good'
    });
  });
});

test('GET grammar detail returns review null when never graded', async () => {
  await withExecuteStub(async (sql) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 10, grammar_point: 'ないわけではない', meaning: 'it is not that', structure: null, example: null, jlpt_level: null, status: 'New', notes: null, reference_id: null }]];
    }
    if (/FROM review_items ri\s+JOIN grammar_points g ON g.id_grammar = ri.id_grammar/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await grammarController.getGrammar({ params: { id: '10' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().review, null);
  });
});
