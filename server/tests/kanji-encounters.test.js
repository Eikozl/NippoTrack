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
const { ENCOUNTER_SOURCE_TYPES, getKanjiEncounterSummary, recordKanjiEncounters } = require('../src/services/kanjiEncounters');

const USER_ID = '00000000-0000-4000-8000-000000000001';

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

async function requestJson(server, route, body, method = 'POST') {
  return fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test.after(async () => {
  await pool.end();
});

test('recordKanjiEncounters stores one stable event per owned kanji and source', async () => {
  const statements = [];
  const executor = {
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) {
        return [[{ id_kanji: 11, character_kanji: '食' }, { id_kanji: 12, character_kanji: '物' }]];
      }
      return [{ affectedRows: 2 }];
    }
  };

  const recorded = await recordKanjiEncounters(executor, USER_ID, '食べ物食', {
    type: ENCOUNTER_SOURCE_TYPES.VOCABULARY,
    sourceId: 41
  });

  assert.deepEqual(recorded, [{ idKanji: 11, character: '食' }, { idKanji: 12, character: '物' }]);
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[0].params, [USER_ID, ['食', '物']]);
  assert.match(statements[1].sql, /INSERT INTO kanji_encounters/i);
  assert.match(statements[1].sql, /ON CONFLICT \(user_id, dedupe_key\) DO NOTHING/i);
  assert.deepEqual(statements[1].params, [
    USER_ID, 11, 'vocabulary', 41, 'v1:vocabulary:41:11',
    USER_ID, 12, 'vocabulary', 41, 'v1:vocabulary:41:12'
  ]);
});

test('recordKanjiEncounters ignores kanji the user does not own', async () => {
  const statements = [];
  const executor = {
    async execute(sql, params = []) {
      statements.push({ sql, params });
      return [[]];
    }
  };

  const recorded = await recordKanjiEncounters(executor, USER_ID, '食', {
    type: ENCOUNTER_SOURCE_TYPES.VOCABULARY,
    sourceId: 42
  });

  assert.deepEqual(recorded, []);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /user_id = \?/i);
});

test('getKanjiEncounterSummary returns bounded aggregate data scoped to one user', async () => {
  const executor = {
    async execute(sql, params) {
      assert.deepEqual(params, [USER_ID, 11]);
      if (/GROUP BY source_type/i.test(sql)) {
        return [[{ source_type: 'session_writing', count: '2' }, { source_type: 'vocabulary', count: '1' }]];
      }
      return [[{ count: '3', first_encountered_at: '2026-09-01T10:00:00.000Z', last_encountered_at: '2026-09-02T10:00:00.000Z' }]];
    }
  };

  assert.deepEqual(await getKanjiEncounterSummary(executor, USER_ID, 11), {
    count: 3,
    firstEncounteredAt: '2026-09-01T10:00:00.000Z',
    lastEncounteredAt: '2026-09-02T10:00:00.000Z',
    bySource: [
      { sourceType: 'session_writing', count: 2 },
      { sourceType: 'vocabulary', count: 1 }
    ]
  });
});

test('POST /api/vocabulary records encounters transactionally for the saved word', async () => {
  const statements = [];
  let committed = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/^INSERT INTO vocabulary /i.test(sql)) return [{ insertId: 51 }];
      if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食' }]];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => [[{ id_vocabulary: 51, word: '食べ物', reading: 'たべもの', meaning: 'food', jlpt_level: null, status: 'New', notes: null }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/vocabulary', { word: '食べ物', meaning: 'food' });
      assert.equal(response.status, 201);
      assert.equal(committed, true);
      const encounterWrite = statements.find(({ sql }) => /INSERT INTO kanji_encounters/i.test(sql));
      assert.ok(encounterWrite);
      assert.deepEqual(encounterWrite.params, [USER_ID, 11, 'vocabulary', 51, 'v1:vocabulary:51:11']);
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/sessions records writing encounters using the session as a stable source', async () => {
  const statements = [];
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      statements.push({ sql, params });
      if (/^INSERT INTO study_sessions/i.test(sql)) return [{ insertId: 61 }];
      if (/FROM kanji WHERE user_id = \? AND character_kanji = ANY\(\?\)/i.test(sql)) return [[{ id_kanji: 12, character_kanji: '書' }]];
      return [{ affectedRows: 1 }];
    },
    async commit() {},
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };

  await withPoolStubs({
    getConnection: async () => connection,
    execute: async () => [[{ id_session: 61, session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', resource: null, notes: null }]]
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/sessions', {
        session_date: '2026-09-01', duration_minutes: 30, category: 'Writing', writing_content: '日本語を書きます。'
      });
      assert.equal(response.status, 201);
      const encounterWrite = statements.find(({ sql }) => /INSERT INTO kanji_encounters/i.test(sql));
      assert.ok(encounterWrite);
      assert.deepEqual(encounterWrite.params, [USER_ID, 12, 'session_writing', 61, 'v1:session_writing:61:12']);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/kanji/:id includes the authenticated user encounter summary only', async () => {
  let summaryQueryCount = 0;
  await withPoolStubs({
    execute: async (sql, params) => {
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) return [[{ id_kanji: 11, character_kanji: '食', meaning: 'eat', onyomi: null, kunyomi: null, jlpt_level: 'N5', status: 'Learning', notes: null, reference_id: 1 }]];
      if (/FROM kanji_vocabulary/i.test(sql)) return [[]];
      if (/FROM kanji_encounters/i.test(sql)) {
        summaryQueryCount += 1;
        assert.deepEqual(params, [USER_ID, 11]);
        return /GROUP BY source_type/i.test(sql)
          ? [[{ source_type: 'vocabulary', count: '1' }]]
          : [[{ count: '1', first_encountered_at: '2026-09-01T10:00:00.000Z', last_encountered_at: '2026-09-01T10:00:00.000Z' }]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const response = await requestJson(server, '/api/kanji/11', undefined, 'GET');
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).encounters, {
        count: 1,
        firstEncounteredAt: '2026-09-01T10:00:00.000Z',
        lastEncounteredAt: '2026-09-01T10:00:00.000Z',
        bySource: [{ sourceType: 'vocabulary', count: 1 }]
      });
      assert.equal(summaryQueryCount, 2);
    } finally {
      await stopServer(server);
    }
  });
});

test('Phase 3 migration keeps encounters append-only and runtime-only', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations-postgres/007_kanji_encounters.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS kanji_encounters/i);
  assert.match(migration, /UNIQUE \(user_id, dedupe_key\)/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /GRANT SELECT, INSERT ON TABLE kanji_encounters TO jlt_runtime/i);
  assert.match(migration, /FOR INSERT/i);
  assert.doesNotMatch(migration, /GRANT UPDATE|GRANT DELETE/i);
});
