const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CODE_POINTS,
  MAX_EXAMPLES,
  analyzeGrammarExamples,
  analyzeVocabularyInGrammarExample
} = require('../src/services/grammarExampleContext');
const vocabularyController = require('../src/controllers/vocabularyController');
const pool = require('../src/config/db');

test('grammar context bounds examples and delegates only selected sentences to reference hydration', async () => {
  const hydrated = [];
  const result = await analyzeGrammarExamples({
    userId: '11111111-1111-4111-8111-111111111111',
    examples: Array.from({ length: MAX_EXAMPLES + 1 }, (_, index) => ({ id_usage_example: index + 1, sentence: '日本語を勉強している。' })),
    hydrate: async (_userId, matches) => {
      hydrated.push(matches);
      return [{ ruleId: 'te-iru', status: 'DETERMINATE' }];
    }
  });

  assert.equal(result.analyzedExamples, MAX_EXAMPLES);
  assert.equal(result.totalExamples, MAX_EXAMPLES + 1);
  assert.equal(result.truncated, true);
  assert.equal(hydrated.length, MAX_EXAMPLES);
  assert.equal(result.examples[0].matches[0].ruleId, 'te-iru');
  assert.equal((await analyzeGrammarExamples({
    userId: '11111111-1111-4111-8111-111111111111',
    examples: [{ id_usage_example: 99, sentence: 'あ'.repeat(MAX_CODE_POINTS + 1) }],
    hydrate: async () => { throw new Error('must not run'); }
  })).analyzedExamples, 0);
});

test('vocabulary context returns only normalized owned candidates and fails closed on matcher errors', async () => {
  const calls = [];
  const matched = await analyzeVocabularyInGrammarExample({
    userId: '11111111-1111-4111-8111-111111111111',
    sentence: '日本語を勉強している。',
    pool: {
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return [sql.includes('word IN') ? [{ word: '日本語', reading: 'にほんご' }] : []];
      }
    }
  });
  assert.ok(matched.items.some((item) => item.canonical === '日本語' && item.inVocabulary));
  assert.ok(calls.every((call) => call.params[0] === '11111111-1111-4111-8111-111111111111'));

  const unavailable = await analyzeVocabularyInGrammarExample({
    userId: '11111111-1111-4111-8111-111111111111',
    sentence: '日本語を勉強している。',
    pool: { execute: async () => { throw new Error('database unavailable'); } }
  });
  assert.deepEqual(unavailable, { items: [], unavailable: true });
});

test('vocabulary grammar context returns an ownership-safe 404 before loading examples', async () => {
  const originalExecute = pool.execute;
  const calls = [];
  pool.execute = async (sql, params) => {
    calls.push({ sql, params });
    return [[]];
  };
  const response = {
    code: null,
    payload: null,
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  try {
    await vocabularyController.getVocabularyGrammarContext({ params: { id: '44' }, user: { id: '11111111-1111-4111-8111-111111111111' } }, response);
  } finally {
    pool.execute = originalExecute;
  }
  assert.equal(response.code, 404);
  assert.deepEqual(response.payload, { error: 'vocabulary entry not found' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM vocabulary WHERE id_vocabulary = \? AND user_id = \?/);
  assert.deepEqual(calls[0].params, [44, '11111111-1111-4111-8111-111111111111']);
});
