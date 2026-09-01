const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');
const {
  importKanjiReferences,
  isSingleHanCodePoint
} = require('../src/services/kanjiReference');

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withPoolStub(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test.after(async () => {
  await pool.end();
});

test('validates one Han Unicode code point rather than UTF-16 string length', () => {
  assert.equal(isSingleHanCodePoint('日'), true);
  assert.equal(isSingleHanCodePoint('𠮟'), true);
  assert.equal(isSingleHanCodePoint('日本'), false);
  assert.equal(isSingleHanCodePoint('あ'), false);
});

test('GET /api/kanji/lookup/:character returns shared reference metadata only', async () => {
  const calls = [];
  await withPoolStub(async (sql, params) => {
    calls.push({ sql, params });
    return [[{
      reference_id: 12,
      character: '日',
      jlpt_level: 'N5',
      onyomi: ['ニチ', 'ジツ'],
      kunyomi: ['ひ', 'か'],
      meanings: ['day', 'sun'],
      stroke_count: 4
    }]];
  }, async () => {
    const server = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji/lookup/%E6%97%A5`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        referenceId: 12,
        character: '日',
        jlptLevel: 'N5',
        onyomi: ['ニチ', 'ジツ'],
        kunyomi: ['ひ', 'か'],
        meanings: ['day', 'sun'],
        strokeCount: 4
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /FROM kanji_reference/i);
      assert.doesNotMatch(calls[0].sql, /\bFROM kanji\b|user_id/i);
      assert.deepEqual(calls[0].params, ['日']);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/lookup/:character rejects anything other than one Han code point before querying', async () => {
  let queried = false;
  await withPoolStub(async () => {
    queried = true;
    return [[]];
  }, async () => {
    const server = await startServer();
    try {
      for (const character of ['%E6%97%A5%E6%9C%AC', '%E3%81%82']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji/lookup/${character}`);
        assert.equal(response.status, 400);
      }
      assert.equal(queried, false);
    } finally {
      await stopServer(server);
    }
  });
});

test('creating a known kanji stores its canonical reference relationship', async () => {
  const calls = [];
  await withPoolStub(async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id_kanji_reference AS reference_id FROM kanji_reference/i.test(sql)) return [[{ reference_id: 12 }]];
    if (/INSERT INTO kanji /i.test(sql)) return [{ insertId: 9 }];
    if (/INSERT INTO review_items/i.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) {
      return [[{ id_kanji: 9, character_kanji: '日', meaning: 'day', reference_id: 12 }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const server = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kanji`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_kanji: '日', meaning: 'day' })
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json()).reference_id, 12);
      const insert = calls.find(({ sql }) => /INSERT INTO kanji /i.test(sql));
      assert.equal(insert.params.at(-1), 12);
    } finally {
      await stopServer(server);
    }
  });
});

test('importer uses upsert plus a backfill and remains repeatable', async () => {
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }
  };
  const references = [{
    character: '日',
    jlpt_level: 'N5',
    onyomi: ['ニチ'],
    kunyomi: ['ひ'],
    meanings: ['day'],
    stroke_count: 4,
    source_metadata: { source: 'fixture' }
  }];

  await importKanjiReferences(client, references);
  await importKanjiReferences(client, references);

  const upserts = statements.filter(({ sql }) => /INSERT INTO kanji_reference/i.test(sql));
  const backfills = statements.filter(({ sql }) => /UPDATE kanji AS k/i.test(sql));
  assert.equal(upserts.length, 2);
  assert.equal(backfills.length, 2);
  upserts.forEach(({ sql, params }) => {
    assert.match(sql, /ON CONFLICT \(character\) DO UPDATE/i);
    assert.equal(params[0], '日');
  });
});

test('migration and runtime verifier preserve read-only access to shared references', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations-postgres/006_kanji_reference_engine.sql'), 'utf8');
  const verifier = fs.readFileSync(path.join(__dirname, '../scripts/verify-postgres-runtime-security.js'), 'utf8');

  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /GRANT SELECT ON TABLE kanji_reference TO jlt_runtime/i);
  assert.doesNotMatch(migration, /GRANT (?:SELECT, )?INSERT.*kanji_reference.*jlt_runtime/i);
  assert.match(verifier, /kanji_reference/);
});
