// Grammar multiple examples: managed grammar_examples table mirroring
// vocabulary usage_examples. Legacy example column stays compatible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

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

test('Migration 020 creates grammar_examples with legacy backfill and runtime grants', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations-postgres/020_grammar_examples.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS grammar_examples/i);
  assert.match(migration, /REFERENCES grammar_points \(id_grammar\) ON DELETE CASCADE/i);
  assert.match(migration, /FROM grammar_points/);
  assert.match(migration, /idx_grammar_examples_grammar/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /GRANT.*TO jlt_runtime/i);
  assert.match(migration, /jlt_runtime_crud/);
  assert.match(migration, /trg_grammar_examples_updated_at/);
  assert.doesNotMatch(migration, /DROP COLUMN/i);
});

test('GET grammar detail returns managed examples alongside the legacy column', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 9, grammar_point: '〜ば〜ほど', meaning: 'the more', structure: null, example: 'legacy', jlpt_level: 'N4', status: 'Learning', notes: null, reference_id: null }]];
    }
    if (/FROM review_items ri\s+JOIN grammar_points/i.test(sql)) return [[]];
    if (/FROM grammar_examples WHERE id_grammar = \? ORDER BY/i.test(sql)) {
      assert.deepEqual(params, [9]);
      return [[{ id_grammar_example: 1, sentence: '読めば読むほど面白い。', translation: 'The more I read, the more interesting.', notes: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await grammarController.getGrammar({ params: { id: '9' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().example, 'legacy');
    assert.equal(body().examples.length, 1);
    assert.equal(body().examples[0].sentence, '読めば読むほど面白い。');
  });
});

test('POST grammar example creates a row scoped to the owned grammar point', async () => {
  const seen = [];
  await withExecuteStub(async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 9, grammar_point: '〜ば〜ほど' }]];
    }
    if (/INSERT INTO grammar_examples/i.test(sql)) {
      assert.deepEqual(params, [9, '読めば読むほど面白い。', undefined, undefined]);
      return [{ insertId: 5 }];
    }
    if (/FROM grammar_examples WHERE id_grammar_example = \? AND id_grammar = \?/i.test(sql)) {
      return [[{ id_grammar_example: 5, sentence: '読めば読むほど面白い。', translation: null, notes: null }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await grammarController.createGrammarExample(
      { params: { id: '9' }, body: { sentence: '読めば読むほど面白い。' }, user: { id: USER_ID } },
      res
    );
    assert.equal(status(), 201);
    assert.equal(body().id_grammar_example, 5);
  });
});

test('POST grammar example rejects missing sentences and foreign grammar points', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      // Only grammar 9 belongs to the requesting user.
      return params[0] === 9 ? [[{ id_grammar: 9, grammar_point: '〜ば〜ほど' }]] : [[]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const foreign = mockRes();
    await grammarController.createGrammarExample(
      { params: { id: '99' }, body: { sentence: '文。' }, user: { id: USER_ID } },
      foreign.res
    );
    assert.equal(foreign.status(), 404);

    const missing = mockRes();
    await grammarController.createGrammarExample(
      { params: { id: '9' }, body: {}, user: { id: USER_ID } },
      missing.res
    );
    assert.equal(missing.status(), 400);
  });
});

test('PUT and DELETE grammar examples stay scoped to the parent grammar point', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 9, grammar_point: '〜ば〜ほど' }]];
    }
    // Write statements first: DELETE contains a FROM ... WHERE clause that
    // would otherwise match the row-lookup branch below.
    if (/UPDATE grammar_examples SET/i.test(sql)) {
      // Partial update falls back to the current row (mirrors vocabulary).
      assert.deepEqual(params, ['new', null, null, 7, 9]);
      return [{ affectedRows: 1 }];
    }
    if (/DELETE FROM grammar_examples WHERE/i.test(sql)) {
      assert.deepEqual(params, [7, 9]);
      return [{ affectedRows: 1 }];
    }
    if (/FROM grammar_examples WHERE id_grammar_example = \? AND id_grammar = \?/i.test(sql)) {
      if (params[0] === 7) return [[{ id_grammar_example: 7, sentence: 'old', translation: null, notes: null }]];
      return [[]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const updated = mockRes();
    await grammarController.updateGrammarExample(
      { params: { id: '9', exampleId: '7' }, body: { sentence: 'new' }, user: { id: USER_ID } },
      updated.res
    );
    assert.equal(updated.status(), 200);

    const foreignExample = mockRes();
    await grammarController.updateGrammarExample(
      { params: { id: '9', exampleId: '8' }, body: { sentence: 'new' }, user: { id: USER_ID } },
      foreignExample.res
    );
    assert.equal(foreignExample.status(), 404);

    const deleted = mockRes();
    await grammarController.deleteGrammarExample(
      { params: { id: '9', exampleId: '7' }, user: { id: USER_ID } },
      deleted.res
    );
    assert.equal(deleted.status(), 200);
    assert.deepEqual(deleted.body(), { success: true, deletedId: 7 });

    const badId = mockRes();
    await grammarController.deleteGrammarExample(
      { params: { id: '9', exampleId: 'nope' }, user: { id: USER_ID } },
      badId.res
    );
    assert.equal(badId.status(), 400);
  });
});

test('Grammar vocabulary context merges candidates across every managed example', async () => {
  const matchCalls = [];
  await withExecuteStub(async (sql, params) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      assert.deepEqual(params, [9, USER_ID]);
      return [[{ id_grammar: 9, grammar_point: '〜ば〜ほど', example: 'legacy' }]];
    }
    if (/FROM grammar_examples WHERE id_grammar = \? ORDER BY/i.test(sql)) {
      return [[
        { sentence: '日本語を勉強している。' },
        { sentence: '本を読む。' }
      ]];
    }
    // Owned-vocabulary matching and any other parser support query.
    if (/\bIN \(/i.test(sql)) matchCalls.push(params);
    return [[]];
  }, async () => {
    const { res, status, body } = mockRes();
    await grammarController.getGrammarVocabularyContext({ params: { id: '9' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.ok(matchCalls.length > 0, 'ownership matching ran for the examples');
    assert.ok(matchCalls.every((params) => params[0] === USER_ID), 'every match query carries the requesting user');
    const canonicals = new Set((body().items || []).map((item) => item.canonical));
    assert.ok(canonicals.has('日本語'), 'first example candidates are kept');
    assert.ok(canonicals.has('本'), 'second example candidates are merged');
  });
});

test('Grammar vocabulary context falls back to the legacy column without managed rows', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM grammar_points WHERE id_grammar = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_grammar: 10, grammar_point: 'X', example: '日本語を勉強している。' }]];
    }
    if (/FROM grammar_examples WHERE id_grammar = \? ORDER BY/i.test(sql)) return [[]];
    // Owned-vocabulary matching and any other parser support query.
    return [[]];
  }, async () => {
    const { res, status, body } = mockRes();
    await grammarController.getGrammarVocabularyContext({ params: { id: '10' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.ok((body().items || []).some((item) => item.canonical === '日本語'));
  });
});
