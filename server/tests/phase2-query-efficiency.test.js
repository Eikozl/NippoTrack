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

async function requestJson(server, route, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

test.after(async () => {
  await pool.end();
});

function goalRow(overrides) {
  return {
    id_goal: 1,
    title: 'Study',
    goal_type: 'study_minutes',
    target_value: 60,
    period_type: 'cumulative',
    target_jlpt_level: null,
    target_status: null,
    start_date: '2026-08-01',
    due_date: null,
    is_active: 1,
    progress: '45',
    ...overrides
  };
}

test('GET /api/goals computes progress for N goals in a constant 2 queries', async () => {
  const calls = [];
  const goals = [
    goalRow({ id_goal: 1, goal_type: 'study_minutes', period_type: 'weekly', progress: '120', target_value: 60 }),
    goalRow({ id_goal: 2, goal_type: 'study_minutes', period_type: 'cumulative', progress: '30', target_value: 60 }),
    goalRow({ id_goal: 3, goal_type: 'vocabulary_count', target_jlpt_level: 'N5', progress: '10', target_value: 20 }),
    goalRow({ id_goal: 4, goal_type: 'kanji_count', target_status: 'Learning', progress: '5', target_value: 5 }),
    goalRow({ id_goal: 5, goal_type: 'grammar_count', progress: '0', target_value: 3 }),
    goalRow({ id_goal: 6, goal_type: 'vocabulary_count', progress: '25', target_value: 20 })
  ];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\) AS total FROM goals/i.test(sql)) return [[{ total: goals.length }]];
      if (/FROM goals g/i.test(sql)) {
        assert.match(sql, /CASE/i);
        assert.match(sql, /study_sessions/i);
        assert.match(sql, /LIMIT \? OFFSET \?/i);
        return [goals];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/goals');
      assert.equal(response.status, 200);
      assert.equal(calls.length, 2);
      assert.equal(data.items.length, 6);
      assert.deepEqual(data.items.map((item) => [item.progress, item.isComplete]), [
        [120, true], [30, false], [10, false], [5, true], [0, false], [25, true]
      ]);
      assert.deepEqual(data.pagination, { page: 1, limit: 50, total: 6, totalPages: 1 });
    } finally {
      await stopServer(server);
    }
  });
});

test('GET /api/goals returns an empty page without progress queries', async () => {
  const calls = [];
  await withPoolStubs({
    execute: async (sql) => {
      calls.push(sql);
      if (/SELECT COUNT\(\*\) AS total FROM goals/i.test(sql)) return [[{ total: 0 }]];
      if (/FROM goals g/i.test(sql)) return [[]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/goals');
      assert.equal(response.status, 200);
      assert.equal(calls.length, 2);
      assert.deepEqual(data.items, []);
      assert.deepEqual(data.pagination, { page: 1, limit: 50, total: 0, totalPages: 0 });
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/kanji creates without review_items writes (R-B: no auto-enrollment)', async () => {
  let committed = false;
  let rolledBack = false;
  let released = false;
  let postCommitRead = false;
  const order = [];
  const connection = {
    async beginTransaction() { order.push('BEGIN'); },
    async execute(sql) {
      order.push(sql.split(' ')[0] + ':' + (sql.includes('INTO kanji ') ? 'kanji' : sql.includes('INTO review_items') ? 'review' : 'other'));
      if (/INSERT INTO kanji /i.test(sql)) return [{ insertId: 77 }];
      if (/INSERT INTO review_items/i.test(sql)) throw new Error('review_items must not be written on create (R-B cutover)');
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    release() { released = true; }
  };
  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql) => {
      if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) return [[]];
      if (/FROM kanji_reference/i.test(sql)) return [[{ reference_id: 12 }]];
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) {
        postCommitRead = true;
        return [[{ id_kanji: 77, character_kanji: '食', meaning: 'eat', reference_id: 12 }]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/kanji', {
        method: 'POST',
        body: { character_kanji: '食', meaning: 'eat' }
      });
      assert.equal(response.status, 201);
      assert.equal(committed, true);
      assert.equal(rolledBack, false);
      assert.equal(released, true);
      assert.equal(postCommitRead, true);
      assert.deepEqual(order, ['BEGIN', 'INSERT:kanji']);
      assert.ok(!order.some((entry) => entry === 'INSERT:review'), 'zero review_items writes on create');
      assert.equal(data.character_kanji, '食');
      assert.equal(data.meaning, 'eat');
    } finally {
      await stopServer(server);
    }
  });
});

test('POST /api/kanji commits insert without review setup in one transaction (R-B)', async () => {
  const order = [];
  const connection = {
    async beginTransaction() { order.push('BEGIN'); },
    async execute(sql) {
      if (/INSERT INTO kanji /i.test(sql)) { order.push('INSERT-kanji'); return [{ insertId: 78 }]; }
      if (/INSERT INTO review_items/i.test(sql)) { order.push('INSERT-review'); return [{ affectedRows: 1 }]; }
      order.push('other');
      return [{ affectedRows: 1 }];
    },
    async commit() { order.push('COMMIT'); },
    async rollback() { order.push('ROLLBACK'); },
    release() {}
  };
  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql) => {
      if (/FROM kanji WHERE user_id = \? AND character_kanji = \?/i.test(sql)) return [[]];
      if (/FROM kanji_reference/i.test(sql)) return [[{ reference_id: 12 }]];
      if (/FROM kanji WHERE id_kanji = \? AND user_id = \?/i.test(sql)) {
        return [[{ id_kanji: 78, character_kanji: '食', meaning: 'eat', reference_id: 12 }]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/kanji', {
        method: 'POST',
        body: { character_kanji: '食', meaning: 'eat' }
      });
      assert.equal(response.status, 201);
      assert.deepEqual(order, ['BEGIN', 'INSERT-kanji', 'COMMIT']);
      assert.ok(!order.includes('INSERT-review'), 'zero review_items writes on create');
      assert.equal(data.character_kanji, '食');
    } finally {
      await stopServer(server);
    }
  });
});

test('PUT /api/notes/:id/links batches inserts and rejects foreign ids', async () => {
  const statements = [];
  let committed = false;
  let rolledBack = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params) {
      statements.push({ sql, params });
      if (/FROM study_sessions WHERE user_id/i.test(sql)) return [[{ id_session: 1 }, { id_session: 2 }]];
      if (/FROM vocabulary WHERE user_id/i.test(sql)) return [[{ id_vocabulary: 3 }]];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    release() {}
  };
  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql) => {
      if (/FROM notes WHERE id_note/i.test(sql)) return [[{ id_note: 5 }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response, data } = await requestJson(server, '/api/notes/5/links', {
        method: 'PUT',
        body: { sessions: [1, 2], vocabulary: [3] }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(data, { success: true });
      assert.equal(committed, true);
      assert.equal(rolledBack, false);
      const sessionInserts = statements.filter(({ sql }) => sql.startsWith('INSERT INTO note_study_sessions'));
      const vocabInserts = statements.filter(({ sql }) => sql.startsWith('INSERT INTO note_vocabulary'));
      assert.equal(sessionInserts.length, 1);
      assert.deepEqual(sessionInserts[0].params, [5, 1, 5, 2]);
      assert.equal(vocabInserts.length, 1);
      assert.deepEqual(vocabInserts[0].params, [5, 3]);
      assert.equal(statements.some(({ sql }) => sql.startsWith('INSERT INTO note_kanji')), false);
    } finally {
      await stopServer(server);
    }
  });
});

test('PUT /api/notes/:id/links rejects ids owned by another user without writing', async () => {
  const statements = [];
  let committed = false;
  let rolledBack = false;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params) {
      statements.push({ sql, params });
      if (/FROM study_sessions WHERE user_id/i.test(sql)) return [[{ id_session: 1 }]];
      return [{ affectedRows: 1 }];
    },
    async commit() { committed = true; },
    async rollback() { rolledBack = true; },
    release() {}
  };
  await withPoolStubs({
    getConnection: async () => connection,
    execute: async (sql) => {
      if (/FROM notes WHERE id_note/i.test(sql)) return [[{ id_note: 5 }]];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  }, async () => {
    const server = await startServer();
    try {
      const { response } = await requestJson(server, '/api/notes/5/links', {
        method: 'PUT',
        body: { sessions: [1, 999] }
      });
      assert.equal(response.status, 400);
      assert.equal(committed, false);
      assert.equal(rolledBack, true);
      assert.equal(statements.some(({ sql }) => sql.startsWith('INSERT INTO note_study_sessions')), false);
    } finally {
      await stopServer(server);
    }
  });
});
