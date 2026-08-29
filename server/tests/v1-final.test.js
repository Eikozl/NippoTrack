const test = require('node:test');
const assert = require('node:assert/strict');

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
    for (const [method, original] of Object.entries(originals)) pool[method] = original;
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

test('paginated lists bind validated LIMIT/OFFSET and expose records beyond the first 100', async () => {
  const calls = [];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 151 }]];
      return [[{ id_vocabulary: 151, word: '百五十一', reading: 'ひゃくごじゅういち', meaning: '151' }]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/vocabulary?page=4&limit=50');
      assert.equal(response.status, 200);
      assert.equal(data.items[0].id_vocabulary, 151);
      assert.deepEqual(data.pagination, { page: 4, limit: 50, total: 151, totalPages: 4 });

      const listCall = calls.find(({ sql }) => /ORDER BY/.test(sql));
      assert.deepEqual(listCall.params, [50, 150]);
      assert.match(listCall.sql, /LIMIT \? OFFSET \?/);
      assert.doesNotMatch(listCall.sql, /LIMIT 50|OFFSET 150/);
    } finally {
      await stopServer(server);
    }
  });
});

test('pagination rejects invalid values and accepts the server maximum without querying on errors', async () => {
  let queryCount = 0;
  await withPoolStubs({
    execute: async (sql, params) => {
      queryCount += 1;
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 0 }]];
      return [[]];
    }
  }, async () => {
    const server = await startServer();
    try {
      for (const route of [
        '/api/vocabulary?page=0',
        '/api/kanji?page=one',
        '/api/grammar?limit=0',
        '/api/sessions?limit=101'
      ]) {
        const { response } = await requestJson(server, route);
        assert.equal(response.status, 400, route);
      }
      assert.equal(queryCount, 0);

      const { response, data } = await requestJson(server, '/api/vocabulary?page=2&limit=100');
      assert.equal(response.status, 200);
      assert.equal(data.pagination.limit, 100);
      assert.equal(queryCount, 2);
    } finally {
      await stopServer(server);
    }
  });
});

test('relationship option searches reach records beyond 100 and keep search values parameterized', async () => {
  const injection = "target-151%' OR 1=1 --";
  const calls = [];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM vocabulary')) return [[{ id_vocabulary: 151, word: '語彙151', reading: null, meaning: 'target' }]];
      if (sql.includes('FROM kanji')) return [[{ id_kanji: 151, character_kanji: '試', meaning: 'target' }]];
      return [[{ id_grammar: 151, grammar_point: '〜ながら', meaning: 'target' }]];
    }
  }, async () => {
    const server = await startServer();
    try {
      for (const route of ['/api/vocabulary/options', '/api/kanji/options', '/api/grammar/options']) {
        const { response, data } = await requestJson(server, `${route}?search=target&limit=20`);
        assert.equal(response.status, 200, route);
        assert.equal(Object.values(data.items[0])[0], 151);

        const hostile = await requestJson(server, `${route}?search=${encodeURIComponent(injection)}&limit=20`);
        assert.equal(hostile.response.status, 200, route);
        assert.deepEqual(hostile.data.items, []);
      }
      calls.forEach(({ sql, params }) => {
        assert.doesNotMatch(sql, /target-151|OR 1=1/);
        assert.equal(Number.isInteger(params.at(-1)), true);
        assert.equal(params.at(-1) >= 20 && params.at(-1) <= 200, true);
      });
      assert.equal(calls.some(({ params }) => params.some((value) => String(value).includes('target-151'))), true);
    } finally {
      await stopServer(server);
    }
  });
});

test('dashboard weekly activity uses today plus the previous six calendar dates', async () => {
  const queries = [];
  await withPoolStubs({
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('minutes_today')) return [[{ minutes_today: 0 }]];
      if (sql.includes('minutes_week')) return [[{ minutes_week: 0 }]];
      if (sql.includes('COUNT(*)')) return [[{ total: 0 }]];
      return [[]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response } = await requestJson(server, '/api/dashboard');
      assert.equal(response.status, 200);
      const weeklyQuery = queries.find((sql) => sql.includes('session_date AS date'));
      assert.match(weeklyQuery, /BETWEEN DATE_SUB\(CURDATE\(\), INTERVAL 6 DAY\) AND CURDATE\(\)/);
      assert.doesNotMatch(weeklyQuery, /INTERVAL 7 DAY/);
    } finally {
      await stopServer(server);
    }
  });
});

test('text fields reject objects and arrays before any database write', async () => {
  let databaseCalled = false;
  await withPoolStubs({
    execute: async () => {
      databaseCalled = true;
      return [[]];
    },
    getConnection: async () => {
      databaseCalled = true;
      throw new Error('Database must not be called for invalid text');
    }
  }, async () => {
    const server = await startServer();
    const cases = [
      ['/api/vocabulary', { word: {}, meaning: 'meaning' }],
      ['/api/vocabulary', { word: '語彙', meaning: [], reading: 'ごい' }],
      ['/api/vocabulary', { word: '語彙', meaning: 'meaning', notes: {} }],
      ['/api/vocabulary', { word: '語彙', meaning: 'meaning', jlpt_level: {} }],
      ['/api/vocabulary', { word: '語彙', meaning: 'meaning', status: [] }],
      ['/api/kanji', { character_kanji: {}, meaning: 'test' }],
      ['/api/kanji', { character_kanji: '試', meaning: [], onyomi: 'シ' }],
      ['/api/kanji', { character_kanji: '試', meaning: 'test', kunyomi: {} }],
      ['/api/grammar', { grammar_point: [], meaning: 'while' }],
      ['/api/grammar', { grammar_point: '〜ながら', meaning: 'while', structure: {} }],
      ['/api/grammar', { grammar_point: '〜ながら', meaning: 'while', example: [] }],
      ['/api/sessions', { session_date: {}, duration_minutes: 10, category: 'Grammar' }],
      ['/api/sessions', { session_date: '2026-08-29', duration_minutes: 10, category: [] }],
      ['/api/sessions', { session_date: '2026-08-29', duration_minutes: 10, category: 'Grammar', resource: {} }],
      ['/api/sessions', { session_date: '2026-08-29', duration_minutes: 10, category: 'Grammar', notes: [] }]
    ];

    try {
      for (const [route, body] of cases) {
        const { response, data } = await requestJson(server, route, { method: 'POST', body });
        assert.equal(response.status, 400, `${route}: ${JSON.stringify(body)}`);
        assert.match(data.error, /must be a string/i);
        assert.doesNotMatch(JSON.stringify(data), /\[object Object\]/);
      }
      assert.equal(databaseCalled, false);
    } finally {
      await stopServer(server);
    }
  });
});

test('valid Japanese text remains accepted', async () => {
  await withPoolStubs({
    execute: async (sql) => {
      if (sql.startsWith('INSERT INTO vocabulary')) return [{ insertId: 151 }];
      return [[{ id_vocabulary: 151, word: '勉強', reading: 'べんきょう', meaning: 'study', status: 'New' }]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/vocabulary', {
        method: 'POST',
        body: { word: '勉強', reading: 'べんきょう', meaning: 'study', notes: '毎日、日本語を勉強する。' }
      });
      assert.equal(response.status, 201);
      assert.equal(data.word, '勉強');
    } finally {
      await stopServer(server);
    }
  });
});

test('PUT rejects explicitly empty required fields before starting a write', async () => {
  let writeStarted = false;
  const records = {
    vocabulary: { id_vocabulary: 1, word: '語彙', reading: 'ごい', meaning: 'vocabulary', jlpt_level: 'N4', status: 'Learning', notes: null },
    kanji: { id_kanji: 1, character_kanji: '語', meaning: 'language', onyomi: 'ゴ', kunyomi: 'かた.る', jlpt_level: 'N5', status: 'Learning', notes: null },
    grammar_points: { id_grammar: 1, grammar_point: '〜ながら', meaning: 'while', structure: null, example: null, jlpt_level: 'N4', status: 'Learning', notes: null },
    study_sessions: { id_session: 1, session_date: '2026-08-29', duration_minutes: 30, category: 'Grammar', resource: null, notes: null }
  };

  await withPoolStubs({
    execute: async (sql) => {
      const table = Object.keys(records).find((name) => sql.includes(`FROM ${name}`));
      if (table) return [[records[table]]];
      if (/^(?:INSERT|UPDATE|DELETE)/.test(sql)) writeStarted = true;
      return [{ affectedRows: 1 }];
    },
    getConnection: async () => {
      writeStarted = true;
      throw new Error('Transaction must not start');
    }
  }, async () => {
    const server = await startServer();
    const cases = [
      ['/api/vocabulary/1', { word: '' }],
      ['/api/vocabulary/1', { meaning: '   ' }],
      ['/api/kanji/1', { character_kanji: '' }],
      ['/api/kanji/1', { meaning: '' }],
      ['/api/grammar/1', { grammar_point: '' }],
      ['/api/grammar/1', { meaning: '' }],
      ['/api/sessions/1', { session_date: '' }],
      ['/api/sessions/1', { duration_minutes: '' }],
      ['/api/sessions/1', { category: '' }]
    ];

    try {
      for (const [route, body] of cases) {
        const { response } = await requestJson(server, route, { method: 'PUT', body });
        assert.equal(response.status, 400, `${route}: ${JSON.stringify(body)}`);
      }
      assert.equal(writeStarted, false);
    } finally {
      await stopServer(server);
    }
  });
});

test('PUT preserves omitted required fields and normalizes optional empty text to null', async () => {
  const current = {
    id_vocabulary: 7,
    word: '日本語',
    reading: 'にほんご',
    meaning: 'Japanese language',
    jlpt_level: 'N5',
    status: 'Learning',
    notes: 'Current note'
  };
  let updateParams;

  await withPoolStubs({
    execute: async (sql, params) => {
      if (sql.startsWith('SELECT')) return [[current]];
      if (sql.startsWith('UPDATE vocabulary')) updateParams = params;
      return [{ affectedRows: 1 }];
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response } = await requestJson(server, '/api/vocabulary/7', {
        method: 'PUT',
        body: { reading: '', notes: '' }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(updateParams, ['日本語', null, 'Japanese language', 'N5', 'Learning', null, 7]);
    } finally {
      await stopServer(server);
    }
  });
});
