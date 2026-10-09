// Sentence lookup for tap-to-define: owned meanings win, shapes are fresh
// ({surface, reading, meaning, owned, kind}), validation fails closed.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const pool = require('../src/config/db');
const controller = require('../src/controllers/lookupController');

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

test('define-sentence prefers owned meanings and flags them', async () => {
  await withExecuteStub(async (sql, params = []) => {
    if (/FROM kanji_reference WHERE character IN/i.test(sql)) {
      return [[{ character: '行', onyomi: ['コウ'], kunyomi: ['いく'], meanings: ['go'], jlpt_level: 'N5' }]];
    }
    if (/FROM kanji WHERE user_id = \? AND character_kanji IN/i.test(sql)) {
      assert.equal(params[0], USER_ID);
      return [[{ character_kanji: '行', meaning: 'my kanji note' }]];
    }
    if (/FROM vocabulary WHERE user_id = \? AND word IN/i.test(sql)) {
      assert.equal(params[0], USER_ID);
      return [[{ word: '行く', reading: 'いく', meaning: 'my word note' }]];
    }
    if (/FROM vocabulary WHERE user_id = \? AND reading IN/i.test(sql)) return [[], []];
    if (/gloss/i.test(sql)) return [[{ surface: '行く', gloss: 'to go' }]];
    if (/grammar_reference/i.test(sql)) return [[]];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.defineSentence({ user: { id: USER_ID }, body: { sentence: 'よく行く' } }, res);
    assert.equal(status(), 200);
    const payload = body();
    assert.equal(payload.sentence, 'よく行く');
    const word = (payload.vocabulary || []).find((item) => item.surface === '行く');
    assert.ok(word, 'word candidate present');
    assert.equal(word.meaning, 'my word note', 'owned meaning beats the dictionary gloss');
    assert.equal(word.owned, true);
    assert.equal(word.kind, 'vocabulary');
    const character = (payload.kanji || []).find((item) => item.surface === '行');
    assert.ok(character, 'kanji candidate present');
    assert.equal(character.meaning, 'my kanji note', 'owned kanji meaning beats the reference');
    assert.equal(character.owned, true);
    assert.equal(character.kind, 'kanji');
  });
});

test('define-sentence validation fails closed without touching the DB', async () => {
  await withExecuteStub(async () => { throw new Error('DB must not be hit on validation failure'); }, async () => {
    for (const body of [{}, { sentence: '' }, { sentence: 42 }, { sentence: 'あ'.repeat(2001) }, { sentence: '行く', hacker: 1 }]) {
      const { res, status } = mockRes();
      await controller.defineSentence({ user: { id: USER_ID }, body }, res);
      assert.equal(status(), 400, `rejected: ${JSON.stringify(body).slice(0, 40)}`);
    }
  });
});

test('define-sentence degrades to 503 when analysis is unavailable', async () => {
  await withExecuteStub(async () => { throw new Error('database unavailable'); }, async () => {
    const { res, status, body } = mockRes();
    await controller.defineSentence({ user: { id: USER_ID }, body: { sentence: '行く' } }, res);
    assert.equal(status(), 503);
    assert.equal(body().error, 'Unable to define this sentence.');
  });
});
