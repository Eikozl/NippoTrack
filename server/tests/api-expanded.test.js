const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'jlt_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'test-only';
process.env.DB_NAME = process.env.DB_NAME || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');

test.after(async () => {
  await pool.end();
});

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
    for (const [method, original] of Object.entries(originals)) {
      pool[method] = original;
    }
  }
}

async function requestJson(server, route, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

test('GET /api/health reports an unavailable database without exposing its error', async () => {
  await withPoolStubs({
    query: async () => {
      throw new Error('Access denied for root@private-db');
    }
  }, async () => {
    const server = await startServer();

    try {
      const { response, data } = await requestJson(server, '/api/health');
      assert.equal(response.status, 200);
      assert.deepEqual(data, {
        ok: false,
        status: 'database_unavailable',
        database: 'unavailable'
      });
      assert.doesNotMatch(JSON.stringify(data), /root|private-db|access denied/i);
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/dashboard returns the exact compact contract for an empty database', async () => {
  await withPoolStubs({
    query: async (sql) => {
      if (sql.includes('minutes_today')) return [[{ minutes_today: null }]];
      if (sql.includes('minutes_week')) return [[{ minutes_week: null }]];
      if (sql.includes('COUNT(*)')) return [[{ total: 0 }]];
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const { response, data } = await requestJson(server, '/api/dashboard');
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(data), [
        'minutesToday',
        'minutesThisWeek',
        'vocabularyCount',
        'kanjiCount',
        'grammarCount',
        'recentSessions',
        'weeklyActivity',
        'studyDistribution'
      ]);
      assert.deepEqual(data, {
        minutesToday: 0,
        minutesThisWeek: 0,
        vocabularyCount: 0,
        kanjiCount: 0,
        grammarCount: 0,
        recentSessions: [],
        weeklyActivity: [],
        studyDistribution: []
      });
    } finally {
      await stopServer(server);
    }
  });
});

test('vocabulary, kanji and grammar filters use bound parameters', async () => {
  const calls = [];

  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const routes = [
        '/api/vocabulary?search=study&jlpt=n4&status=Learning',
        '/api/kanji?search=day&jlpt=n5&status=New',
        '/api/grammar?search=ongoing&jlpt=n3&status=Familiar'
      ];

      for (const route of routes) {
        const { response } = await requestJson(server, route);
        assert.equal(response.status, 200);
      }

      const countCalls = calls.filter(({ sql }) => /SELECT COUNT\(\*\)/.test(sql));
      const listCalls = calls.filter(({ sql }) => /ORDER BY/.test(sql));
      const expected = [
        { search: '%study%', jlpt: 'N4', status: 'Learning' },
        { search: '%day%', jlpt: 'N5', status: 'New' },
        { search: '%ongoing%', jlpt: 'N3', status: 'Familiar' }
      ];
      expected.forEach(({ search, jlpt, status }, index) => {
        const countParams = countCalls[index].params;
        const listParams = listCalls[index].params;
        assert.equal(countParams.includes(search), true);
        assert.equal(countParams.includes(jlpt), true);
        assert.equal(countParams.includes(status), true);
        assert.deepEqual(listParams.slice(0, countParams.length), countParams);
        assert.deepEqual(listParams.slice(-2), [50, 0]);
        assert.match(listCalls[index].sql, /ORDER BY CASE/);
      });
      calls.forEach(({ sql }) => assert.doesNotMatch(sql, /study|ongoing/));
    } finally {
      await stopServer(server);
    }
  });
});

test('invalid list filters return 400 without querying MariaDB', async () => {
  let queryCount = 0;

  await withPoolStubs({
    execute: async () => {
      queryCount += 1;
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const routes = [
        '/api/vocabulary?jlpt=N0',
        '/api/kanji?status=Archived',
        '/api/grammar?jlpt=N6',
        '/api/sessions?category=Gaming',
        '/api/sessions?date=2026-02-30',
        '/api/sessions?from=2026-13-01'
      ];

      for (const route of routes) {
        const { response } = await requestJson(server, route);
        assert.equal(response.status, 400, route);
      }

      assert.equal(queryCount, 0);
    } finally {
      await stopServer(server);
    }
  });
});

test('canonical /api/sessions supports category, exact-date and date-range filters', async () => {
  const calls = [];

  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const routes = [
        '/api/sessions?category=Reading&date=2026-08-29',
        '/api/sessions?from=2026-08-01&to=2026-08-29'
      ];

      for (const route of routes) {
        const { response } = await requestJson(server, route);
        assert.equal(response.status, 200);
      }

      const listCalls = calls.filter(({ sql }) => /ORDER BY/.test(sql));
      assert.deepEqual(listCalls[0].params, ['Reading', '2026-08-29', '00000000-0000-4000-8000-000000000001', 50, 0]);
      assert.deepEqual(listCalls[1].params, ['2026-08-01', '2026-08-29', '00000000-0000-4000-8000-000000000001', 50, 0]);
      assert.match(listCalls[0].sql, /category = \?.*session_date = \?/);
      assert.match(listCalls[1].sql, /session_date >= \?.*session_date <= \?/);
    } finally {
      await stopServer(server);
    }
  });
});

test('SQL-injection strings stay in parameter arrays and never alter SQL text', async () => {
  const injection = "x%' OR 1=1; DROP TABLE vocabulary; --";
  const calls = [];
  const execute = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO vocabulary')) return [{ insertId: 7 }];
    if (sql.includes('WHERE id_vocabulary = ?')) {
      return [[{ id_vocabulary: 7, word: injection, meaning: injection }]];
    }
    return [[]];
  };

  await withPoolStubs({
    execute,
    getConnection: async () => ({ beginTransaction: async () => {}, execute, commit: async () => {}, rollback: async () => {}, release: () => {} })
  }, async () => {
    const server = await startServer();

    try {
      const searchResult = await requestJson(server, `/api/vocabulary?search=${encodeURIComponent(injection)}`);
      assert.equal(searchResult.response.status, 200);

      const writeResult = await requestJson(server, '/api/vocabulary', {
        method: 'POST',
        body: { word: injection, meaning: injection }
      });
      assert.equal(writeResult.response.status, 201);

      assert.equal(calls.some(({ params }) => params.some((value) => String(value).includes('DROP TABLE'))), true);
      calls.forEach(({ sql }) => assert.doesNotMatch(sql, /DROP TABLE|OR 1=1/));
    } finally {
      await stopServer(server);
    }
  });
});

test('protected-field tampering is rejected for every writable entity', async () => {
  let databaseCalled = false;

  await withPoolStubs({
    execute: async () => {
      databaseCalled = true;
      return [[]];
    },
    getConnection: async () => {
      databaseCalled = true;
      throw new Error('Unexpected transaction');
    }
  }, async () => {
    const server = await startServer();

    try {
      const cases = [
        ['/api/vocabulary', { word: '語', meaning: 'word', id_vocabulary: 9 }],
        ['/api/kanji', { character_kanji: '語', meaning: 'language', created_at: '2000-01-01' }],
        ['/api/grammar', { grammar_point: '〜です', meaning: 'is', updated_at: '2000-01-01' }],
        ['/api/sessions', { session_date: '2026-08-29', duration_minutes: 10, category: 'Grammar', id_session: 9 }]
      ];

      for (const [route, body] of cases) {
        const { response, data } = await requestJson(server, route, { method: 'POST', body });
        assert.equal(response.status, 400, route);
        assert.match(data.error, /Unauthorized fields/i);
      }

      assert.equal(databaseCalled, false);
    } finally {
      await stopServer(server);
    }
  });
});

test('oversized values are rejected instead of silently truncated', async () => {
  let databaseCalled = false;

  await withPoolStubs({
    execute: async () => {
      databaseCalled = true;
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const { response, data } = await requestJson(server, '/api/vocabulary', {
        method: 'POST',
        body: { word: '語'.repeat(101), meaning: 'word' }
      });
      assert.equal(response.status, 400);
      assert.match(data.error, /maximum length of 100/i);
      assert.equal(databaseCalled, false);
    } finally {
      await stopServer(server);
    }
  });
});

test('nonexistent entity IDs return 404 and invalid IDs return 400', async () => {
  await withPoolStubs({
    execute: async () => [[]]
  }, async () => {
    const server = await startServer();

    try {
      for (const route of ['/api/vocabulary/999', '/api/kanji/999', '/api/grammar/999', '/api/sessions/999']) {
        const { response } = await requestJson(server, route);
        assert.equal(response.status, 404, route);
      }

      for (const route of ['/api/vocabulary/nope', '/api/kanji/-1', '/api/grammar/0', '/api/sessions/1.5']) {
        const { response } = await requestJson(server, route);
        assert.equal(response.status, 400, route);
      }
    } finally {
      await stopServer(server);
    }
  });
});

test('PUT /api/sessions replaces supplied relationship sets in one transaction', async () => {
  const statements = [];
  let committed = false;

  const current = {
    id_session: 8,
    session_date: '2026-08-20',
    duration_minutes: 25,
    category: 'Grammar',
    resource: null,
    notes: null
  };
  const connection = {
    async beginTransaction() {},
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT id_')) return [params[1].map((id) => ({ id }))];
      return [{ affectedRows: 1 }];
    },
    async commit() {
      committed = true;
    },
    async rollback() {},
    release() {}
  };

  await withPoolStubs({
    execute: async () => [[current]],
    getConnection: async () => connection
  }, async () => {
    const server = await startServer();

    try {
      const { response } = await requestJson(server, '/api/sessions/8', {
        method: 'PUT',
        body: {
          vocabulary_ids: [2, 2, 3],
          kanji_ids: [],
          grammar_ids: [4]
        }
      });

      assert.equal(response.status, 200);
      assert.equal(committed, true);
      assert.equal(statements.filter(({ sql }) => sql.startsWith('DELETE FROM session_')).length, 3);
      assert.deepEqual(
        statements
          .filter(({ sql }) => sql.startsWith('INSERT INTO session_vocabulary'))
          .map(({ params }) => params),
        [[8, 2], [8, 3]]
      );
      assert.deepEqual(
        statements
          .filter(({ sql }) => sql.startsWith('INSERT INTO session_grammar'))
          .map(({ params }) => params),
        [[8, 4]]
      );
      assert.equal(statements.some(({ sql }) => sql.startsWith('INSERT INTO session_kanji')), false);
    } finally {
      await stopServer(server);
    }
  });
});

test('database configuration fails closed when runtime credentials are missing', () => {
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    JLT_AUTH_BYPASS_FOR_TESTS: 'false',
    POSTGRES_ENV_FILE: path.join(__dirname, 'missing-postgres.env'),
    POSTGRES_RUNTIME_USER: ''
  };
  const result = spawnSync(process.execPath, ['-e', "require('./src/config/db')"], {
    cwd: path.join(__dirname, '..'),
    env: environment,
    encoding: 'utf8'
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /Missing required (runtime )?environment variable: POSTGRES_RUNTIME_(PORT|USER)/);
  assert.doesNotMatch(output, /using root|fallback to root/i);
});

test('GET /api/export returns a complete read-only JSON backup contract', async () => {
  const queries = [];

  await withPoolStubs({
    query: async (sql) => {
      queries.push(sql);
      return [[]];
    }
  }, async () => {
    const server = await startServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/export`);
      const data = await response.json();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition') || '', /^attachment; filename="jlt-backup-\d{4}-\d{2}-\d{2}\.json"$/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(data.version, 1);
      assert.equal(data.database, 'jlt');
      assert.deepEqual(Object.keys(data.data), [
        'studySessions',
        'vocabulary',
        'kanji',
        'grammarPoints',
        'kanjiVocabulary',
        'sessionVocabulary',
        'sessionKanji',
        'sessionGrammar'
      ]);
      assert.equal(queries.length, 8);
      queries.forEach((sql) => assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/i));
    } finally {
      await stopServer(server);
    }
  });
});
