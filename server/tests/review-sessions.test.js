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

const reviewController = require('../src/controllers/reviewController');
const pool = require('../src/config/db');
const app = require('../src/app');

const USER_ID = '00000000-0000-4000-8000-000000000001';

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

async function postJson(server, route, body) {
  return fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

// ---------------------------------------------------------------- migration
test('Migration 009 creates review_sessions grouping without item table', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations-postgres/009_review_sessions.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE.*review_sessions/i);
  assert.match(migration, /id_review_session/);
  assert.match(migration, /ALTER TABLE review_events/i);
  assert.match(migration, /ADD COLUMN.*id_review_session/i);
  assert.match(migration, /ON DELETE SET NULL/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /GRANT.*TO jlt_runtime/i);
  assert.match(migration, /jlt_runtime_crud/);
  assert.match(migration, /idx_review_sessions_user_started/);
  assert.match(migration, /idx_review_events_session/);
  assert.doesNotMatch(migration, /review_session_items/i);
});

// ---------------------------------------------------------------- create
test('createReviewSession valid returns 201 shape with null completedAt', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[{ insertId: 42 }]]; };
  try {
    const { res, status, body } = mockRes();
    const sourceFrom = daysAgo(30);
    const sourceTo = daysAgo(1);
    await reviewController.createReviewSession({ user: { id: USER_ID }, body: { sourceFrom, sourceTo } }, res);
    assert.equal(status(), 201);
    assert.deepEqual(body(), { id: 42, sourceFrom, sourceTo, completedAt: null });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO review_sessions/i);
    assert.ok(calls[0].params.includes(USER_ID), 'create must carry req.user.id');
    assert.deepEqual(calls[0].params, [USER_ID, sourceFrom, sourceTo]);
  } finally { pool.execute = original; }
});

test('createReviewSession invalid date format returns 400', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[{ insertId: 1 }]]; };
  try {
    const { res, status, body } = mockRes();
    await reviewController.createReviewSession({ user: { id: USER_ID }, body: { sourceFrom: 'not-a-date', sourceTo: daysAgo(1) } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /YYYY-MM-DD/);
    assert.equal(calls.length, 0, 'validation failure must not hit DB');
  } finally { pool.execute = original; }
});

test('createReviewSession from after to returns 400', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[{ insertId: 1 }]]; };
  try {
    const { res, status, body } = mockRes();
    await reviewController.createReviewSession({ user: { id: USER_ID }, body: { sourceFrom: daysAgo(1), sourceTo: daysAgo(30) } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /must not be after/);
    assert.equal(calls.length, 0);
  } finally { pool.execute = original; }
});

test('createReviewSession future sourceTo returns 400', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[{ insertId: 1 }]]; };
  try {
    const { res, status, body } = mockRes();
    await reviewController.createReviewSession({ user: { id: USER_ID }, body: { sourceFrom: daysAgo(10), sourceTo: '2999-01-01' } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /must not be in the future/);
    assert.equal(calls.length, 0);
  } finally { pool.execute = original; }
});

test('createReviewSession range over 366 days returns 400', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[{ insertId: 1 }]]; };
  try {
    const { res, status, body } = mockRes();
    await reviewController.createReviewSession({ user: { id: USER_ID }, body: { sourceFrom: daysAgo(500), sourceTo: daysAgo(1) } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /must not exceed 366/);
    assert.equal(calls.length, 0);
  } finally { pool.execute = original; }
});

// ---------------------------------------------------------------- complete
test('completeReviewSession success returns summary with correct math', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return [[{ id_review_session: 7, completed_at: null, started_at: '2026-09-06T09:50:00.000Z' }]];
    if (calls.length === 2) return [{ affectedRows: 1 }];
    if (calls.length === 3) return [[{ completed_at: '2026-09-06T10:00:00.000Z' }]];
    if (/AS active FROM review_sessions/i.test(sql)) return [[{ active: 9 }]];
    return [[{ total: '4', kanji: '1', vocabulary: '2', grammar: '1', again: '1', hard: '1', good: '2' }]];
  };
  try {
    const { res, status, body } = mockRes();
    await reviewController.completeReviewSession({ user: { id: USER_ID }, params: { id: '7' } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), {
      id: 7,
      completedAt: '2026-09-06T10:00:00.000Z',
      minutesLogged: 9,
      total: 4,
      byType: { kanji: 1, vocabulary: 2, grammar: 1 },
      byResult: { Again: 1, Hard: 1, Good: 2 }
    });
    assert.equal(calls.length, 5);
    assert.match(calls[1].sql, /UPDATE review_sessions/i);
    // Ownership-scoped statements carry the requesting user id, including the
    // defense-in-depth session-ownership predicate inside the summary aggregate.
    assert.deepEqual(calls[0].params, [7, USER_ID]);
    assert.deepEqual(calls[1].params, [7, USER_ID]);
    assert.deepEqual(calls[2].params, [7, USER_ID]);
    assert.deepEqual(calls[3].params, [7, USER_ID]);
    assert.deepEqual(calls[4].params, [7, USER_ID]);
  } finally { pool.execute = original; }
});

test('completeReviewSession idempotent re-complete does not issue UPDATE', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return [[{ id_review_session: 7, completed_at: '2026-09-05T10:00:00.000Z' }]];
    return [[{ total: '2', kanji: '1', vocabulary: '1', grammar: '0', again: '0', hard: '1', good: '1' }]];
  };
  try {
    const { res, status, body } = mockRes();
    await reviewController.completeReviewSession({ user: { id: USER_ID }, params: { id: '7' } }, res);
    assert.equal(status(), 200);
    assert.equal(body().completedAt, '2026-09-05T10:00:00.000Z');
    assert.equal(body().total, 2);
    assert.ok(!calls.some((c) => /UPDATE review_sessions/i.test(c.sql)), 're-complete must not UPDATE');
    assert.equal(calls.length, 2);
  } finally { pool.execute = original; }
});

test('completeReviewSession foreign or missing session returns 404 without leak', async () => {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[]]; };
  try {
    const { res, status, body } = mockRes();
    await reviewController.completeReviewSession({ user: { id: USER_ID }, params: { id: '999' } }, res);
    assert.equal(status(), 404);
    assert.deepEqual(body(), { error: 'review session not found' });
    assert.ok(calls[0].params.includes(USER_ID), 'ownership check must carry req.user.id');
  } finally { pool.execute = original; }
});

// ------------------------------------------------------- gradeEntity helpers
function makeGradeConnection({ calls, entityTable = 'kanji', entityId = 5, sessionId = 9, reviewItemId = 55, intervalDays = 3, fkColumn = 'id_kanji', tracker = {}, goodCount = 0, currentStatus = 'New' }) {
  let step = 0;
  return {
    async beginTransaction() { tracker.begin = (tracker.begin || 0) + 1; },
    async execute(sql, params = []) {
      calls.push({ sql, params });
      step += 1;
      if (step === 1) {
        assert.match(sql, new RegExp(`FROM ${entityTable} WHERE`));
        return [[{ 1: 1 }]];
      }
      if (step === 2) {
        assert.match(sql, /FROM review_sessions WHERE/);
        return [[{ id_review_session: sessionId, completed_at: null }]];
      }
      if (step === 3) {
        assert.match(sql, /INSERT INTO review_items/i);
        return [{ affectedRows: 1 }];
      }
      if (step === 4) {
        assert.match(sql, /FROM review_items WHERE/);
        return [[{ id_review_item: reviewItemId }]];
      }
      if (step === 5) {
        // V5.3a: interval resolution reads preferences first; empty row keeps
        // engine_mode='fixed' (frozen 1/3/7 curve).
        assert.match(sql, /FROM user_review_preferences WHERE user_id = \?/);
        return [[]];
      }
      if (step === 6) {
        assert.match(sql, /FROM review_items ri/);
        const row = { id_review_item: reviewItemId, interval_days: intervalDays, id_vocabulary: null, id_kanji: null, id_grammar: null };
        row[fkColumn] = entityId;
        return [[row]];
      }
      if (step === 7) {
        assert.match(sql, /AND user_id = \?/);
        return [[{ 1: 1 }]];
      }
      if (step === 8) {
        assert.match(sql, /INSERT INTO review_events/i);
        return [{ affectedRows: 1 }];
      }
      if (step === 9) {
        assert.match(sql, /UPDATE review_items/i);
        return [{ affectedRows: 1 }];
      }
      // Assimilation ladder (Good grades only): Good-count read, current
      // status read, then a single upward promotion UPDATE at most.
      if (step === 10) {
        assert.match(sql, /FROM review_events WHERE id_review_item = \? AND result = 'Good'/);
        return [[{ good: goodCount }]];
      }
      if (step === 11) {
        assert.match(sql, new RegExp(`SELECT status FROM ${entityTable} WHERE`));
        return [[{ status: currentStatus }]];
      }
      if (step === 12) {
        assert.match(sql, new RegExp(`UPDATE ${entityTable} SET status`));
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected grade step ${step}: ${sql}`);
    },
    async commit() { tracker.commit = (tracker.commit || 0) + 1; },
    async rollback() { tracker.rollback = (tracker.rollback || 0) + 1; },
    release() { tracker.release = (tracker.release || 0) + 1; }
  };
}

test('gradeEntity first grade enrolls review item then records event with session id', async () => {
  const calls = [];
  const tracker = {};
  const connection = makeGradeConnection({ calls, tracker });
  const original = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    const { res, status, body } = mockRes();
    await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result: 'Good', reviewSessionId: 9 } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { success: true, result: 'Good', nextIntervalDays: 7, idReviewItem: 55, idReviewSession: 9 });
    const enroll = calls.find((c) => /INSERT INTO review_items/i.test(c.sql));
    assert.ok(enroll, 'lazy enroll must INSERT INTO review_items');
    assert.match(enroll.sql, /ON CONFLICT/);
    const event = calls.find((c) => /INSERT INTO review_events/i.test(c.sql));
    assert.ok(event);
    assert.equal(event.params[0], 55);
    assert.equal(event.params[1], 'Good');
    assert.equal(event.params[4], 9);
    // Ownership checks carry the requesting user id.
    assert.ok(calls[0].params.includes(USER_ID));
    assert.ok(calls[1].params.includes(USER_ID));
    assert.ok(calls[6].params.includes(USER_ID));
  } finally { pool.getConnection = original; }
});

test('gradeEntity second grade reuses enrolled item via idempotent enroll', async () => {
  // Implementation always issues the lazy-enroll INSERT with
  // ON CONFLICT DO NOTHING, so each grade contributes one enroll INSERT
  // (idempotent) while the SELECT reuses the same id_review_item.
  const allCalls = [];
  async function runOnce() {
    const calls = [];
    const tracker = {};
    const connection = makeGradeConnection({ calls, tracker });
    const original = pool.getConnection;
    pool.getConnection = async () => connection;
    try {
      const { res, status, body } = mockRes();
      await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result: 'Hard', reviewSessionId: 9 } }, res);
      assert.equal(status(), 200);
      assert.equal(body().idReviewItem, 55);
      assert.equal(body().nextIntervalDays, 3);
      const enrolls = calls.filter((c) => /INSERT INTO review_items/i.test(c.sql));
      assert.equal(enrolls.length, 1, 'each grade issues exactly one idempotent enroll INSERT');
      allCalls.push(...calls);
      return body();
    } finally { pool.getConnection = original; }
  }
  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first.idReviewItem, second.idReviewItem);
  const totalEnrolls = allCalls.filter((c) => /INSERT INTO review_items/i.test(c.sql));
  assert.equal(totalEnrolls.length, 2, 'across both grades there is one enroll INSERT per call (ON CONFLICT DO NOTHING makes the second a no-op)');
});

test('gradeEntity foreign entity returns 404 review entity not found', async () => {
  const calls = [];
  const tracker = {};
  const connection = {
    async beginTransaction() { tracker.begin = true; },
    async execute(sql, params = []) { calls.push({ sql, params }); return [[]]; },
    async commit() { tracker.commit = true; },
    async rollback() { tracker.rollback = true; },
    release() {}
  };
  const original = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    const { res, status, body } = mockRes();
    await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'vocabulary', entityId: 999, result: 'Good', reviewSessionId: 9 } }, res);
    assert.equal(status(), 404);
    assert.deepEqual(body(), { error: 'review entity not found' });
    assert.equal(tracker.rollback, true);
    assert.ok(calls[0].params.includes(USER_ID));
    assert.ok(!calls.some((c) => /INSERT INTO review_events/i.test(c.sql)));
  } finally { pool.getConnection = original; }
});

test('gradeEntity completed session returns 400 session is not open', async () => {
  const calls = [];
  const tracker = {};
  let step = 0;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      step += 1;
      if (step === 1) return [[{ 1: 1 }]];
      if (step === 2) return [[{ id_review_session: 9, completed_at: '2026-09-05T10:00:00.000Z' }]];
      throw new Error(`should not reach step ${step}`);
    },
    async commit() { tracker.commit = true; },
    async rollback() { tracker.rollback = true; },
    release() {}
  };
  const original = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    const { res, status, body } = mockRes();
    await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result: 'Good', reviewSessionId: 9 } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /not open/);
    assert.equal(tracker.rollback, true);
    assert.ok(!calls.some((c) => /INSERT INTO review_events/i.test(c.sql)));
  } finally { pool.getConnection = original; }
});

test('gradeEntity missing session returns 404 without leak', async () => {
  const calls = [];
  const tracker = {};
  let step = 0;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      step += 1;
      if (step === 1) return [[{ 1: 1 }]];
      if (step === 2) return [[]];
      throw new Error(`should not reach step ${step}`);
    },
    async commit() { tracker.commit = true; },
    async rollback() { tracker.rollback = true; },
    release() {}
  };
  const original = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    const { res, status, body } = mockRes();
    await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result: 'Good', reviewSessionId: 999 } }, res);
    assert.equal(status(), 404);
    assert.deepEqual(body(), { error: 'review session not found' });
    assert.equal(tracker.rollback, true);
  } finally { pool.getConnection = original; }
});

test('legacy recordReview still works with NULL session id', async () => {
  const calls = [];
  let step = 0;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      step += 1;
      if (step === 1) return [[]];
      if (step === 2) return [[{ id_review_item: 99, interval_days: 2, id_vocabulary: null, id_kanji: 11, id_grammar: null }]];
      if (step === 3) return [[{ 1: 1 }]];
      if (step === 4) return [{ affectedRows: 1 }];
      if (step === 5) return [{ affectedRows: 1 }];
      // Assimilation ladder: zero Goods → no promotion, response unchanged.
      if (step === 6) return [[{ good: 0 }]];
      throw new Error(`Unexpected step ${step}`);
    },
    async commit() {},
    async rollback() { throw new Error('rollback should not be called'); },
    release() {}
  };
  const original = pool.getConnection;
  pool.getConnection = async () => connection;
  try {
    const { res, status, body } = mockRes();
    await reviewController.recordReview({ user: { id: USER_ID }, params: { id: '99' }, body: { result: 'Good' } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { success: true, result: 'Good', nextIntervalDays: 7 });
    const event = calls.find((c) => /INSERT INTO review_events/i.test(c.sql));
    assert.ok(event);
    assert.ok(event.params[4] == null, 'legacy event insert must carry NULL session id');
  } finally { pool.getConnection = original; }
});

test('interval mapping Again 1 Hard 3 Good 7 via stubbed flows', async () => {
  const cases = [['Again', 1], ['Hard', 3], ['Good', 7]];
  for (const [result, expected] of cases) {
    const calls = [];
    let step = 0;
    const connection = {
      async beginTransaction() {},
      async execute(sql, params = []) {
        calls.push({ sql, params });
        step += 1;
        if (step === 1) return [[]];
        if (step === 2) return [[{ id_review_item: 99, interval_days: 0, id_vocabulary: 8, id_kanji: null, id_grammar: null }]];
        if (step === 3) return [[{ 1: 1 }]];
        if (step === 4) return [{ affectedRows: 1 }];
        if (step === 5) return [{ affectedRows: 1 }];
        // Good grades read the ladder count; zero Goods → no promotion.
        if (step === 6) return [[{ good: 0 }]];
        throw new Error('unexpected');
      },
      async commit() {},
      async rollback() {},
      release() {}
    };
    const original = pool.getConnection;
    pool.getConnection = async () => connection;
    try {
      const { res, status, body } = mockRes();
      await reviewController.recordReview({ user: { id: USER_ID }, params: { id: '99' }, body: { result } }, res);
      assert.equal(status(), 200);
      assert.equal(body().nextIntervalDays, expected);
      const event = calls.find((c) => /INSERT INTO review_events/i.test(c.sql));
      assert.equal(event.params[3], expected);
      const update = calls.find((c) => /UPDATE review_items/i.test(c.sql));
      assert.equal(update.params[0], expected);
      assert.equal(update.params[1], expected);
    } finally { pool.getConnection = original; }
  }
});

test('security ownership queries carry requesting user id and cross-user yields 404', async () => {
  // Create path carries user id.
  {
    const calls = [];
    const original = pool.execute;
    pool.execute = async (sql, params) => { calls.push({ sql, params }); return [[{ insertId: 1 }]]; };
    try {
      const { res } = mockRes();
      await reviewController.createReviewSession({ user: { id: USER_ID }, body: { sourceFrom: daysAgo(5), sourceTo: daysAgo(1) } }, res);
      assert.ok(calls[0].params.includes(USER_ID));
    } finally { pool.execute = original; }
  }
  // Grade ownership checks carry user id; internal enroll/summary statements
  // are scoped via those prior ownership checks (they carry FK/session ids,
  // not user_id directly) — verified by code inspection of reviewController
  // applyGrade/createReviewItem/getSessionSummary.
  {
    const calls = [];
    const tracker = {};
    const connection = makeGradeConnection({ calls, tracker });
    const original = pool.getConnection;
    pool.getConnection = async () => connection;
    try {
      const { res } = mockRes();
      await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result: 'Good', reviewSessionId: 9 } }, res);
      const ownershipSql = calls.filter((c) => /user_id = \?/i.test(c.sql));
      assert.ok(ownershipSql.length >= 3, 'expected entity, session, and applyGrade ownership checks');
      for (const entry of ownershipSql) assert.ok(entry.params.includes(USER_ID));
    } finally { pool.getConnection = original; }
  }
  // Cross-user: zero rows must surface as 404, never leak existence.
  {
    const original = pool.execute;
    pool.execute = async () => [[]];
    try {
      const { res, status, body } = mockRes();
      await reviewController.completeReviewSession({ user: { id: USER_ID }, params: { id: '12345' } }, res);
      assert.equal(status(), 404);
      assert.deepEqual(body(), { error: 'review session not found' });
    } finally { pool.execute = original; }
  }
});

// ---------------------------------------------------------------- HTTP
test('HTTP POST /api/review/sessions creates session with 201 payload', async () => {
  const seen = [];
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = USER_ID;
  try {
    await withPoolStubs({
      execute: async (sql, params) => { seen.push({ sql, params }); return [[{ insertId: 11 }]]; }
    }, async () => {
      const server = await startServer();
      try {
        const sourceFrom = daysAgo(10);
        const sourceTo = daysAgo(1);
        const response = await postJson(server, '/api/review/sessions', { sourceFrom, sourceTo });
        assert.equal(response.status, 201);
        const data = await response.json();
        assert.deepEqual(data, { id: 11, sourceFrom, sourceTo, completedAt: null });
        assert.ok(seen[0].params.includes(USER_ID));
      } finally { await stopServer(server); }
    });
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
  }
});

test('HTTP POST /api/review/grade records entity grade with session', async () => {
  const calls = [];
  let step = 0;
  const connection = {
    async beginTransaction() {},
    async execute(sql, params = []) {
      calls.push({ sql, params });
      step += 1;
      if (step === 1) return [[{ 1: 1 }]];
      if (step === 2) return [[{ id_review_session: 9, completed_at: null }]];
      if (step === 3) return [{ affectedRows: 1 }];
      if (step === 4) return [[{ id_review_item: 55 }]];
      if (step === 5) return [[]];
      if (step === 6) return [[{ id_review_item: 55, interval_days: 1, id_vocabulary: null, id_kanji: 5, id_grammar: null }]];
      if (step === 7) return [[{ 1: 1 }]];
      if (step === 8) return [{ affectedRows: 1 }];
      if (step === 9) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected ${sql}`);
    },
    async commit() {},
    async rollback() {},
    release() {}
  };
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = USER_ID;
  try {
    await withPoolStubs({ getConnection: async () => connection }, async () => {
      const server = await startServer();
      try {
        const response = await postJson(server, '/api/review/grade', { entityType: 'kanji', entityId: 5, result: 'Good', reviewSessionId: 9 });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.deepEqual(data, { success: true, result: 'Good', nextIntervalDays: 7, idReviewItem: 55, idReviewSession: 9 });
        const event = calls.find((c) => /INSERT INTO review_events/i.test(c.sql));
        assert.equal(event.params[4], 9);
      } finally { await stopServer(server); }
    });
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
  }
});

test('HTTP POST /api/review/sessions rejects from after to with 400', async () => {
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = USER_ID;
  try {
    await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit on validation failure'); } }, async () => {
      const server = await startServer();
      try {
        const response = await postJson(server, '/api/review/sessions', { sourceFrom: daysAgo(1), sourceTo: daysAgo(10) });
        assert.equal(response.status, 400);
        const data = await response.json();
        assert.match(data.error, /must not be after/);
      } finally { await stopServer(server); }
    });
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
  }
});

test('assimilation ladder promotes upward only on Good counts (1/3/8)', async () => {
  const cases = [
    { goodCount: 1, currentStatus: 'New', promotedTo: 'Learning', updates: 1 },
    { goodCount: 3, currentStatus: 'Learning', promotedTo: 'Familiar', updates: 1 },
    { goodCount: 8, currentStatus: 'Familiar', promotedTo: 'Mastered', updates: 1 },
    { goodCount: 8, currentStatus: 'New', promotedTo: 'Mastered', updates: 1 },
    { goodCount: 1, currentStatus: 'Mastered', promotedTo: undefined, updates: 0 },
    { goodCount: 0, currentStatus: 'New', promotedTo: undefined, updates: 0 }
  ];
  for (const { goodCount, currentStatus, promotedTo, updates } of cases) {
    const calls = [];
    const tracker = {};
    const connection = makeGradeConnection({ calls, tracker, goodCount, currentStatus });
    const original = pool.getConnection;
    pool.getConnection = async () => connection;
    try {
      const { res, status, body } = mockRes();
      await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result: 'Good', reviewSessionId: 9 } }, res);
      assert.equal(status(), 200);
      assert.equal(body().promotedTo, promotedTo, `${goodCount} Good(s) from ${currentStatus}`);
      const promotionUpdates = calls.filter((c) => /UPDATE kanji SET status/.test(c.sql));
      assert.equal(promotionUpdates.length, updates, 'single upward UPDATE at most');
      if (updates) assert.deepEqual(promotionUpdates[0].params, [promotedTo, 5]);
    } finally { pool.getConnection = original; }
  }
});

test('assimilation never runs on Again/Hard (no ladder queries)', async () => {
  for (const result of ['Again', 'Hard']) {
    const calls = [];
    const tracker = {};
    const connection = makeGradeConnection({ calls, tracker });
    const original = pool.getConnection;
    pool.getConnection = async () => connection;
    try {
      const { res, status, body } = mockRes();
      await reviewController.gradeEntity({ user: { id: USER_ID }, body: { entityType: 'kanji', entityId: 5, result, reviewSessionId: 9 } }, res);
      assert.equal(status(), 200);
      assert.equal(body().promotedTo, undefined);
      assert.ok(!calls.some((c) => /FROM review_events WHERE id_review_item/.test(c.sql)), `no Good-count read for ${result}`);
      assert.ok(!calls.some((c) => /UPDATE kanji SET status/.test(c.sql)), `no promotion UPDATE for ${result}`);
    } finally { pool.getConnection = original; }
  }
});
