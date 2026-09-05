const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');
const { findUserKanjiByCharacter } = require('../src/services/kanjiLearning');

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withPoolStub(stub, callback) {
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  pool.execute = stub;
  pool.getConnection = async () => ({ beginTransaction: async () => {}, execute: stub, commit: async () => {}, rollback: async () => {}, release: () => {} });
  try {
    await callback();
  } finally {
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
}

test.after(async () => {
  await pool.end();
});

test('findUserKanjiByCharacter returns only the requesting user\'s existing kanji', async () => {
  const calls = [];
  const database = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[{
        id_kanji: 31,
        character_kanji: '食',
        meaning: 'eat',
        jlpt_level: 'N5',
        status: 'Learning'
      }]];
    }
  };

  const existing = await findUserKanjiByCharacter('user-a', '食', database);

  assert.deepEqual(existing, {
    idKanji: 31,
    character: '食',
    meaning: 'eat',
    jlptLevel: 'N5',
    status: 'Learning'
  });
  assert.match(calls[0].sql, /FROM kanji WHERE user_id = \? AND character_kanji = \?/i);
  assert.deepEqual(calls[0].params, ['user-a', '食']);
  assert.equal(calls[0].params.includes('user-b'), false);
});

test('POST /api/kanji returns friendly same-user duplicate metadata before insert', async () => {
  const statements = [];
  await withPoolStub(async (sql, params) => {
    statements.push({ sql, params });
    if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) {
      return [[{
        id_kanji: 31,
        character_kanji: '食',
        meaning: 'eat',
        jlpt_level: 'N5',
        status: 'Learning'
      }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const server = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_kanji: '食', meaning: 'eat' })
      });

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: 'Already learning this kanji.',
        existingKanji: { idKanji: 31, character: '食', meaning: 'eat', jlptLevel: 'N5', status: 'Learning' }
      });
      assert.equal(statements.some(({ sql }) => /INSERT INTO kanji /i.test(sql)), false);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/kanji turns a unique-constraint race into the same friendly duplicate response', async () => {
  let lookupCount = 0;
  await withPoolStub(async (sql) => {
    if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) {
      lookupCount += 1;
      return lookupCount === 1 ? [[]] : [[{
        id_kanji: 31,
        character_kanji: '食',
        meaning: 'eat',
        jlpt_level: 'N5',
        status: 'Learning'
      }]];
    }
    if (/FROM kanji_reference/i.test(sql)) return [[{ reference_id: 12 }]];
    if (/INSERT INTO kanji /i.test(sql)) {
      const error = new Error('duplicate');
      error.code = '23505';
      throw error;
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const server = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_kanji: '食', meaning: 'eat' })
      });

      assert.equal(response.status, 409);
      assert.equal((await response.json()).existingKanji.idKanji, 31);
      assert.equal(lookupCount, 2);
    } finally {
      await stopServer(server);
    }
  });
});
