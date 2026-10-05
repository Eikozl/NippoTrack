const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const reviewController = require('../src/controllers/reviewController');
const pool = require('../src/config/db');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
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

function makeConnection() {
  const seen = [];
  const connection = {
    seen,
    released: false,
    async beginTransaction() { seen.push({ phase: 'BEGIN' }); },
    async commit() { seen.push({ phase: 'COMMIT' }); },
    async rollback() { seen.push({ phase: 'ROLLBACK' }); },
    release() { connection.released = true; },
    async execute(sql, params = []) {
      seen.push({ sql, params });
      if (/INSERT INTO review_sessions/i.test(sql)) return [{ insertId: 61 }];
      if (/INSERT INTO review_session_items/i.test(sql)) return [{ affectedRows: params.length / 4 }];
      throw new Error(`Unexpected transactional SQL: ${sql}`);
    }
  };
  return connection;
}

// Owned-entity lookup shared by the create-with-items tests.
async function entityExecute(sql, params = []) {
  if (/SELECT 1 FROM (vocabulary|kanji|grammar_points)/i.test(sql)) return [[{ '?column?': 1 }]];
  throw new Error(`Unexpected pool SQL: ${sql}`);
}

test('createReviewSession persists an exact ordered queue when items are supplied', async () => {
  const connection = makeConnection();
  await withPoolStubs({ execute: entityExecute, getConnection: async () => connection }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.createReviewSession({
      body: {
        sourceFrom: daysAgo(3),
        sourceTo: isoToday(),
        items: [
          { entityType: 'kanji', entityId: 7 },
          { entityType: 'vocabulary', entityId: 9 },
          { entityType: 'grammar', entityId: 11 }
        ]
      },
      user: { id: USER_ID }
    }, res);
    assert.equal(status(), 201);
    assert.equal(body().id, 61);
    assert.equal(body().itemCount, 3);
    const phases = connection.seen.filter((entry) => entry.phase).map((entry) => entry.phase);
    assert.deepEqual(phases, ['BEGIN', 'COMMIT']);
    const queueInsert = connection.seen.find((entry) => entry.sql && /INSERT INTO review_session_items/i.test(entry.sql));
    assert.ok(queueInsert, 'queue insert recorded');
    assert.deepEqual(queueInsert.params, [61, 'kanji', 7, 0, 61, 'vocabulary', 9, 1, 61, 'grammar', 11, 2]);
    assert.equal(connection.released, true);
  });
});

test('createReviewSession rejects bad queues and foreign entities before writing', async () => {
  const bodies = [
    { items: 'nope' },
    { items: [] },
    { items: new Array(501).fill({ entityType: 'kanji', entityId: 1 }) },
    { items: [{ entityType: 'emoji', entityId: 1 }] },
    { items: [{ entityType: 'kanji', entityId: 0 }] },
    { items: [{ entityType: 'kanji' }] },
    { items: [{ entityType: 'kanji', entityId: 1 }, { entityType: 'kanji', entityId: 1 }] }
  ];
  for (const extra of bodies) {
    const { res, status } = mockRes();
    await reviewController.createReviewSession({
      body: { sourceFrom: daysAgo(3), sourceTo: isoToday(), ...extra },
      user: { id: USER_ID }
    }, res);
    assert.equal(status(), 400, `rejected: ${JSON.stringify(extra.items)?.slice(0, 40)}`);
  }

  // Foreign entity: ownership check fails before any session row exists.
  const wrote = [];
  await withPoolStubs({
    execute: async (sql) => {
      wrote.push(sql);
      if (/SELECT 1 FROM vocabulary/i.test(sql)) return [[]];
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
    getConnection: async () => { throw new Error('must not open a transaction'); }
  }, async () => {
    const { res, status } = mockRes();
    await reviewController.createReviewSession({
      body: { sourceFrom: daysAgo(3), sourceTo: isoToday(), items: [{ entityType: 'vocabulary', entityId: 999 }] },
      user: { id: USER_ID }
    }, res);
    assert.equal(status(), 404);
    assert.ok(!wrote.some((sql) => /INSERT INTO review_sessions/i.test(sql)), 'no session row on foreign entity');
  });
});

test('createReviewSession without items keeps the legacy single-INSERT path', async () => {
  const calls = [];
  await withPoolStubs({
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO review_sessions/i.test(sql)) return [{ insertId: 62 }];
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
    getConnection: async () => { throw new Error('must not open a transaction'); }
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.createReviewSession({
      body: { sourceFrom: daysAgo(3), sourceTo: isoToday() },
      user: { id: USER_ID }
    }, res);
    assert.equal(status(), 201);
    assert.equal(body().id, 62);
    assert.equal(body().itemCount, undefined);
    assert.ok(!calls.some(({ sql }) => /review_session_items/i.test(sql)));
  });
});

test('getReviewSessionItems returns the ordered queue with per-item last results', async () => {
  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql)) {
      assert.deepEqual(params, [77, USER_ID]);
      return [[{ id_review_session: 77, completed_at: null }]];
    }
    if (/FROM review_session_items si/i.test(sql)) {
      assert.ok(/LEFT JOIN LATERAL/i.test(sql), 'latest-per-item grade via lateral');
      assert.deepEqual(params, [USER_ID, USER_ID, USER_ID, 77, USER_ID]);
      return [[
        { position: '0', entityType: 'kanji', entityId: '7', display: '学', reading: 'ガク', meaning: 'study', lastResult: 'Good' },
        { position: '1', entityType: 'vocabulary', entityId: '9', display: '学生', reading: 'がくせい', meaning: 'student', lastResult: null }
      ]];
    }
    throw new Error(`Unexpected items SQL: ${sql}`);
  } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '77' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().id, 77);
    assert.deepEqual(body().items, [
      { position: 0, entityType: 'kanji', entityId: 7, display: '学', reading: 'ガク', meaning: 'study', lastResult: 'Good' },
      { position: 1, entityType: 'vocabulary', entityId: 9, display: '学生', reading: 'がくせい', meaning: 'student', lastResult: null }
    ]);
  });
});

test('getReviewSessionItems 404s foreign sessions and refuses completed ones', async () => {
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql)) return [[]];
    throw new Error(`Unexpected foreign SQL: ${sql}`);
  } }, async () => {
    const { res, status } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '78' }, user: { id: OTHER_USER_ID } }, res);
    assert.equal(status(), 404);
  });

  await withPoolStubs({ execute: async (sql) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql)) {
      return [[{ id_review_session: 79, completed_at: '2026-09-01T10:00:00Z' }]];
    }
    throw new Error(`Unexpected completed SQL: ${sql}`);
  } }, async () => {
    const { res, status } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '79' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 400);
  });

  const invalid = mockRes();
  await reviewController.getReviewSessionItems({ params: { id: 'nope' }, user: { id: USER_ID } }, invalid.res);
  assert.equal(invalid.status(), 400);
});

test('getReviewSessionItems marks persisted queues as not reconstructed', async () => {
  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql)) {
      return [[{ id_review_session: 81, completed_at: null }]];
    }
    if (/FROM review_session_items si/i.test(sql)) {
      return [[
        { position: '0', entityType: 'vocabulary', entityId: '9', display: '学生', reading: 'がくせい', meaning: 'student', lastResult: null }
      ]];
    }
    throw new Error(`Unexpected persisted-flag SQL: ${sql}`);
  } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '81' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().reconstructed, false);
    assert.equal(body().items.length, 1);
    assert.equal(body().sourceFrom, undefined, 'persisted path echoes no source range');
  });
});

test('getReviewSessionItems reconstructs a resume set when the persisted queue is empty', async () => {
  const from = daysAgo(3);
  const to = isoToday();
  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql) && !/source_from/i.test(sql)) {
      assert.deepEqual(params, [80, USER_ID]);
      return [[{ id_review_session: 80, completed_at: null }]];
    }
    if (/FROM review_session_items si/i.test(sql)) {
      assert.deepEqual(params, [USER_ID, USER_ID, USER_ID, 80, USER_ID]);
      return [[]];
    }
    if (/source_from/i.test(sql)) {
      assert.deepEqual(params, [80, USER_ID]);
      return [[{ sourceFrom: from, sourceTo: to }]];
    }
    if (/FROM review_events re/i.test(sql)) {
      assert.deepEqual(params, [80, USER_ID]);
      // Kanji 7 already graded inside this session: must be excluded.
      return [[{ kanjiId: 7, vocabularyId: null, grammarId: null }]];
    }
    if (/PARTITION BY entity_type/i.test(sql)) {
      assert.ok(params.includes(USER_ID), 'candidate discovery must carry req.user.id');
      return [[
        { entity_type: 'kanji', entity_id: 7, display: '学', reading: 'ガク', meaning: 'study', jlpt: null, source_date: daysAgo(1) },
        { entity_type: 'vocabulary', entity_id: 9, display: '学生', reading: 'がくせい', meaning: 'student', jlpt: null, source_date: daysAgo(1) },
        { entity_type: 'grammar', entity_id: 11, display: 'TEMO', reading: null, meaning: 'even if', jlpt: null, source_date: daysAgo(2) }
      ]];
    }
    throw new Error(`Unexpected reconstructed SQL: ${sql}`);
  } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '80' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().id, 80);
    assert.equal(body().reconstructed, true);
    assert.equal(body().sourceFrom, from);
    assert.equal(body().sourceTo, to);
    assert.deepEqual(body().items, [
      { position: 0, entityType: 'vocabulary', entityId: 9, display: '学生', reading: 'がくせい', meaning: 'student', lastResult: null },
      { position: 1, entityType: 'grammar', entityId: 11, display: 'TEMO', reading: null, meaning: 'even if', lastResult: null }
    ]);
  });
});

test('getReviewSessionItems reconstructed fallback caps at 100 in deterministic order', async () => {
  const from = daysAgo(3);
  const to = isoToday();
  await withPoolStubs({ execute: async (sql, params = []) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql) && !/source_from/i.test(sql)) {
      return [[{ id_review_session: 82, completed_at: null }]];
    }
    if (/FROM review_session_items si/i.test(sql)) return [[]];
    if (/source_from/i.test(sql)) return [[{ sourceFrom: from, sourceTo: to }]];
    if (/FROM review_events re/i.test(sql)) return [[{ kanjiId: null, vocabularyId: null, grammarId: null }]];
    if (/PARTITION BY entity_type/i.test(sql)) {
      const rows = [];
      for (let entityId = 1; entityId <= 120; entityId += 1) {
        rows.push({ entity_type: 'vocabulary', entity_id: entityId, display: `W${entityId}`, reading: `r${entityId}`, meaning: `m${entityId}`, jlpt: null, source_date: daysAgo(1) });
      }
      return [rows];
    }
    throw new Error(`Unexpected capped SQL: ${sql}`);
  } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '82' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().reconstructed, true);
    assert.equal(body().items.length, 100);
    assert.deepEqual(body().items[0], { position: 0, entityType: 'vocabulary', entityId: 1, display: 'W1', reading: 'r1', meaning: 'm1', lastResult: null });
    assert.deepEqual(body().items[99], { position: 99, entityType: 'vocabulary', entityId: 100, display: 'W100', reading: 'r100', meaning: 'm100', lastResult: null });
  });
});

test('getReviewSessionItems reconstructed fallback returns an honest empty set when nothing is discoverable', async () => {
  const from = daysAgo(3);
  const to = isoToday();
  await withPoolStubs({ execute: async (sql) => {
    if (/FROM review_sessions WHERE id_review_session/i.test(sql) && !/source_from/i.test(sql)) {
      return [[{ id_review_session: 83, completed_at: null }]];
    }
    if (/FROM review_session_items si/i.test(sql)) return [[]];
    if (/source_from/i.test(sql)) return [[{ sourceFrom: from, sourceTo: to }]];
    if (/FROM review_events re/i.test(sql)) return [[]];
    if (/PARTITION BY entity_type/i.test(sql)) return [[]];
    throw new Error(`Unexpected empty-fallback SQL: ${sql}`);
  } }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSessionItems({ params: { id: '83' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { id: 83, reconstructed: true, sourceFrom: from, sourceTo: to, items: [] });
  });
});

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});
