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
const { extractUniqueKanji, syncVocabularyKanjiLinks } = require('../src/services/kanjiVocabularyLinks');

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function withPoolStubs(stubs, callback) {
  const originals = {};
  for (const [method, replacement] of Object.entries(stubs)) {
    originals[method] = pool[method];
    pool[method] = replacement;
  }
  try {
    await callback();
  } finally {
    for (const [method, original] of Object.entries(originals)) pool[method] = original;
  }
}

async function requestJson(server, path, payload, method = 'POST') {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

test.after(async () => {
  await pool.end();
});

test('extractUniqueKanji keeps first-seen Han characters only', () => {
  assert.deepEqual(extractUniqueKanji('食べ物、食べます。A日'), ['食', '物', '日']);
  assert.deepEqual(extractUniqueKanji('かなカナ romaji 123'), []);
});

test('syncVocabularyKanjiLinks is set-based, idempotent, and scoped to one user', async () => {
  const statements = [];
  const executor = {
    async execute(sql, params) {
      statements.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
  };

  const characters = await syncVocabularyKanjiLinks(executor, {
    userId: 'user-a',
    vocabularyId: 44,
    word: '食べ物食'
  });

  assert.deepEqual(characters, ['食', '物']);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /DELETE FROM kanji_vocabulary/i);
  assert.match(statements[0].sql, /k\.user_id = \?/i);
  assert.match(statements[0].sql, /v\.user_id = \?/i);
  assert.deepEqual(statements[0].params, [44, 'user-a', 'user-a', '食', '物']);
  assert.match(statements[1].sql, /INSERT INTO kanji_vocabulary/i);
  assert.match(statements[1].sql, /SELECT k\.id_kanji/i);
  assert.match(statements[1].sql, /k\.user_id = \?/i);
  assert.match(statements[1].sql, /v\.user_id = \?/i);
  assert.match(statements[1].sql, /ON CONFLICT \(id_kanji, id_vocabulary\) DO NOTHING/i);
  assert.deepEqual(statements[1].params, [44, 44, 'user-a', 'user-a', '食', '物']);
  assert.equal(statements.flatMap((statement) => statement.params).includes('user-b'), false);
});

test('POST /api/vocabulary creates review and derived kanji links in one transaction', async () => {
  const statements = [];
  let committed = false;
  let released = false;
  const connection = {
    async beginTransaction() { statements.push({ sql: 'BEGIN', params: [] }); },
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/^INSERT INTO vocabulary /i.test(sql)) return [{ insertId: 51 }];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { throw new Error('rollback should not be called'); },
    release() { released = true; }
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql, params) => {
      assert.match(sql, /FROM vocabulary WHERE id_vocabulary = \? AND user_id = \?/i);
      assert.deepEqual(params, [51, '00000000-0000-4000-8000-000000000001']);
      return [[{ id_vocabulary: 51, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'New', notes: null }]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/vocabulary', { word: '食べ物', reading: 'たべもの', meaning: 'food' });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).id_vocabulary, 51);
      assert.equal(committed, true);
      assert.equal(released, true);
      assert.equal(statements.filter(({ sql }) => /^INSERT INTO kanji_vocabulary/i.test(sql)).length, 1);
      const linkInsert = statements.find(({ sql }) => /^INSERT INTO kanji_vocabulary/i.test(sql));
      assert.deepEqual(linkInsert.params, [51, 51, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '食', '物']);
      assert.equal(statements.some(({ sql }) => /INSERT INTO review_items/i.test(sql)), true);
    } finally {
      await stopServer(server);
    }
  });
});

test('PUT /api/vocabulary reconciles stale and new user-owned kanji links atomically', async () => {
  const statements = [];
  let committed = false;
  let released = false;
  const connection = {
    async beginTransaction() { statements.push({ sql: 'BEGIN', params: [] }); },
    async execute(sql, params = []) { statements.push({ sql, params }); return [{ affectedRows: 1 }]; },
    async commit() { committed = true; },
    async rollback() { throw new Error('rollback should not be called'); },
    release() { released = true; }
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql, params) => {
      assert.match(sql, /FROM vocabulary WHERE id_vocabulary = \? AND user_id = \?/i);
      assert.deepEqual(params, [52, '00000000-0000-4000-8000-000000000001']);
      return [[{ id_vocabulary: 52, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: 'N5', status: 'New', notes: null }]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/vocabulary/52', { word: '飲み物' }, 'PUT');
      assert.equal(response.status, 200);
      assert.equal(committed, true);
      assert.equal(released, true);
      const deleteLinks = statements.find(({ sql }) => /DELETE FROM kanji_vocabulary/i.test(sql));
      const insertLinks = statements.find(({ sql }) => /^INSERT INTO kanji_vocabulary/i.test(sql));
      assert.deepEqual(deleteLinks.params, [52, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '飲', '物']);
      assert.deepEqual(insertLinks.params, [52, 52, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '飲', '物']);
      assert.equal(statements.some(({ sql }) => /^UPDATE vocabulary/i.test(sql)), true);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/vocabulary rolls back when derived linking fails', async () => {
  let committed = false;
  let rolledBack = false;
  let released = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql) {
      if (/^INSERT INTO vocabulary /i.test(sql)) return [{ insertId: 53 }];
      if (/INSERT INTO kanji_vocabulary/i.test(sql)) throw new Error('database details must not be exposed');
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    release() { released = true; }
  };

  await withPoolStubs({ getConnection: async () => connection }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/vocabulary', { word: '食べ物', meaning: 'food' });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Unable to create vocabulary entry.' });
      assert.equal(committed, false);
      assert.equal(rolledBack, true);
      assert.equal(released, true);
    } finally {
      await stopServer(server);
    }
  });
});
