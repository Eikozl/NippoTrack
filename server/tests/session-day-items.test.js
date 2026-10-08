const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || '127.0.0.1';
process.env.POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
process.env.POSTGRES_USER = process.env.POSTGRES_USER || 'jlt_test';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'test-only';
process.env.POSTGRES_DB = process.env.POSTGRES_DB || 'jlt';

const sessionsController = require('../src/controllers/sessionsController');
const pool = require('../src/config/db');
const app = require('../src/app');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const DAY = '2026-09-05';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

function reviewRow({ type = 'vocabulary', id = 11, display = '水', reading = 'みず', meaning = 'water', jlpt = 'N5', date = DAY } = {}) {
  return { entity_type: type, entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date, source_result: 'Good' };
}

function sessionRow({ type = 'kanji', id = 2, display = '本', reading = null, meaning = 'book', jlpt = 'N5', date = DAY } = {}) {
  return { entity_type: type, entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date, source_category: 'Reading', source_duration: 30 };
}

function addedRow({ type = 'grammar', id = 21, display = '〜ても', reading = null, meaning = 'even if', jlpt = 'N5', date = DAY } = {}) {
  return { entity_type: type, entity_id: id, display, reading, meaning, jlpt, source_date: date, source_ts: date };
}

function stubDayItemsExecute({ reviewRows = [], sessionRows = [], encounterRows = [], addedRows = [], contentRows = [], seen = [] } = {}) {
  return async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM content_entries/i.test(sql)) return [contentRows];
    if (/kanji_encounters/i.test(sql)) return [encounterRows];
    if (/review_events/i.test(sql)) return [reviewRows];
    if (/study_sessions/i.test(sql)) return [sessionRows];
    if (/created_at/i.test(sql)) return [addedRows];
    return [[]];
  };
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

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

test('day-items returns own records with id+label shapes and exact keys', async () => {
  const seen = [];
  const contentRows = [{ id_content_entry: 7, title: 'Attack on Titan' }];
  await withPoolStubs({
    execute: stubDayItemsExecute({
      reviewRows: [reviewRow({ type: 'vocabulary', id: 11, display: '水' })],
      sessionRows: [sessionRow({ type: 'kanji', id: 2, display: '本' })],
      addedRows: [addedRow({ type: 'grammar', id: 21, display: '〜ても' })],
      contentRows,
      seen
    })
  }, async () => {
    const { res, status, body } = mockRes();
    await sessionsController.getDayItems({ user: { id: USER_ID }, query: { date: DAY } }, res);
    assert.equal(status(), 200);
    const payload = body();
    assert.equal(payload.date, DAY);
    assert.deepEqual(Object.keys(payload).sort(), ['content', 'date', 'grammar', 'kanji', 'vocabulary']);
    assert.deepEqual(payload.vocabulary, [{ id: 11, label: '水' }]);
    assert.deepEqual(payload.kanji, [{ id: 2, label: '本' }]);
    assert.deepEqual(payload.grammar, [{ id: 21, label: '〜ても' }]);
    assert.deepEqual(payload.content, [{ id: 7, label: 'Attack on Titan' }]);
    // No reading-text key: reading progress is aggregate-only, never item-level.
    assert.ok(!('reading' in payload));
    // Every statement carries the requesting user id (explicit scoping, never RLS-only).
    assert.ok(seen.length >= 5, `expected 5 statements (4 evidence + content), got ${seen.length}`);
    for (const entry of seen) {
      assert.ok(entry.params.includes(USER_ID), `params ${JSON.stringify(entry.params)} must include requesting user id`);
      assert.ok(!entry.params.includes(OTHER_USER));
    }
    const contentQuery = seen.find((entry) => /FROM content_entries/i.test(entry.sql));
    assert.ok(contentQuery);
    assert.deepEqual(contentQuery.params, [USER_ID, DAY]);
    assert.match(contentQuery.sql, /content_date = \?/);
    assert.match(contentQuery.sql, /ORDER BY content_date DESC, id_content_entry DESC/);
    assert.match(contentQuery.sql, /LIMIT 50/);
    for (const entry of seen) assert.doesNotMatch(entry.sql, /^\s*(INSERT|UPDATE|DELETE)/i);
  });
});

test('day-items rejects missing/malformed/impossible dates with 400 and no DB hit', async () => {
  for (const date of [undefined, '', 'not-a-date', '2026-13-01', '2026-02-30', '09/05/2026']) {
    await withPoolStubs({
      execute: async () => { throw new Error('DB must not be hit on invalid date'); }
    }, async () => {
      const { res, status, body } = mockRes();
      const query = date === undefined ? {} : { date };
      await sessionsController.getDayItems({ user: { id: USER_ID }, query }, res);
      assert.equal(status(), 400, `date=${String(date)} must 400`);
      assert.match(body().error, /YYYY-MM-DD/);
    });
  }
});

test('day-items caps each kind at 50 (newest/studied-most-recent bounded slice)', async () => {
  const many = Array.from({ length: 60 }, (_, index) => reviewRow({ type: 'vocabulary', id: index + 1, display: `語${index + 1}` }));
  const manyContent = Array.from({ length: 60 }, (_, index) => ({ id_content_entry: index + 1, title: `Title ${index + 1}` }));
  await withPoolStubs({
    execute: stubDayItemsExecute({ reviewRows: many, contentRows: manyContent })
  }, async () => {
    const { res, status, body } = mockRes();
    await sessionsController.getDayItems({ user: { id: USER_ID }, query: { date: DAY } }, res);
    assert.equal(status(), 200);
    const payload = body();
    assert.equal(payload.vocabulary.length, 50);
    assert.equal(payload.content.length, 50);
    // Empty kinds stay empty arrays, never null/500.
    assert.deepEqual(payload.kanji, []);
    assert.deepEqual(payload.grammar, []);
  });
});

test('day-items with no evidence returns empty arrays with 200 (never 500)', async () => {
  await withPoolStubs({ execute: stubDayItemsExecute({}) }, async () => {
    const { res, status, body } = mockRes();
    await sessionsController.getDayItems({ user: { id: USER_ID }, query: { date: DAY } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { date: DAY, vocabulary: [], kanji: [], grammar: [], content: [] });
  });
});

test('HTTP GET /api/sessions/day-items is routed before /:id and validates date', async () => {
  const previous = process.env.JLT_TEST_USER_ID;
  process.env.JLT_TEST_USER_ID = USER_ID;
  try {
    const seen = [];
    await withPoolStubs({
      execute: stubDayItemsExecute({
        reviewRows: [reviewRow({ type: 'vocabulary', id: 11, display: '水' })],
        contentRows: [{ id_content_entry: 7, title: 'Attack on Titan' }],
        seen
      })
    }, async () => {
      const server = await startServer();
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const ok = await fetch(`${base}/api/sessions/day-items?date=${DAY}`);
        assert.equal(ok.status, 200);
        const data = await ok.json();
        assert.equal(data.date, DAY);
        assert.deepEqual(data.vocabulary, [{ id: 11, label: '水' }]);
        assert.deepEqual(data.content, [{ id: 7, label: 'Attack on Titan' }]);
        assert.ok(seen.every((entry) => entry.params.includes(USER_ID)));

        const missing = await fetch(`${base}/api/sessions/day-items`);
        assert.equal(missing.status, 400);

        const bad = await fetch(`${base}/api/sessions/day-items?date=bogus`);
        assert.equal(bad.status, 400);
        const badBody = await bad.json();
        assert.match(badBody.error, /YYYY-MM-DD/);
      } finally { await stopServer(server); }
    });
  } finally {
    if (previous === undefined) delete process.env.JLT_TEST_USER_ID;
    else process.env.JLT_TEST_USER_ID = previous;
  }
});
