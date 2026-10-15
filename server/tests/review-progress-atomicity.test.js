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
const { upsertReadingProgress } = require('../src/services/gradedReader');
const pool = require('../src/config/db');

const USER_ID = '00000000-0000-4000-8000-0000000000a1';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
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

test.after(async () => {
  try { await pool.end(); } catch { /* already ended */ }
});

// ------------------------------------------------- completeReviewSession
test('concurrent completes converge on one timestamp without double effects', async () => {
  const store = { completedAt: null };
  const updates = [];
  const studyInserts = [];
  const execute = async (sql, params) => {
    if (sql.startsWith('SELECT id_review_session')) {
      return [[store.completedAt
        ? { id_review_session: 1, completed_at: store.completedAt, started_at: '2026-10-13T09:35:00.000Z' }
        : { id_review_session: 1, completed_at: null, started_at: '2026-10-13T09:35:00.000Z' }]];
    }
    if (sql.startsWith('UPDATE review_sessions')) {
      assert.ok(sql.includes('completed_at IS NULL'), 'complete guards against re-completing');
      // Emulate the guard: only the first concurrent UPDATE matches.
      const matched = store.completedAt === null ? 1 : 0;
      if (matched) store.completedAt = '2026-10-13T10:00:00.000Z';
      updates.push(matched);
      return [{ affectedRows: matched }];
    }
    if (sql.includes('FROM review_events re')) {
      return [[{ total: 0, kanji: 0, vocabulary: 0, grammar: 0, again: 0, hard: 0, good: 0 }]];
    }
    if (sql.startsWith('SELECT completed_at FROM review_sessions')) {
      return [[{ completed_at: store.completedAt }]];
    }
    if (sql.startsWith('INSERT INTO study_sessions')) {
      studyInserts.push(params);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  await withPoolStubs({ execute }, async () => {
    const first = mockRes();
    const second = mockRes();
    await reviewController.completeReviewSession({ params: { id: '1' }, body: { today: '2026-10-13' }, user: { id: USER_ID } }, first.res);
    await reviewController.completeReviewSession({ params: { id: '1' }, user: { id: USER_ID } }, second.res);
    assert.equal(first.status(), 200);
    assert.equal(second.status(), 200);
    assert.equal(first.body().completedAt, '2026-10-13T10:00:00.000Z');
    assert.equal(second.body().completedAt, first.body().completedAt);
    // First call performs the guarded UPDATE; the second sees completed_at
    // set and takes the idempotent early return without a second UPDATE.
    assert.deepEqual(updates, [1]);
    // 25 elapsed minutes logged once as a Mixed study session on the
    // requester's day; the repeat logs nothing.
    assert.equal(studyInserts.length, 1);
    assert.deepEqual(studyInserts[0].slice(0, 3), [USER_ID, '2026-10-13', 25]);
    assert.match(studyInserts[0][3], /Review session/);
    assert.equal(first.body().minutesLogged, 25);
    assert.equal(second.body().minutesLogged, 0);
  });
});

test('completeReviewSession rejects a malformed today without writing', async () => {
  const execute = async () => { throw new Error('DB must not be hit on validation failure'); };
  await withPoolStubs({ execute }, async () => {
    const { res, status } = mockRes();
    await reviewController.completeReviewSession({ params: { id: '1' }, body: { today: 'yesterday' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 400);
  });
});

// ------------------------------------------- upsertReadingProgress locking
test('progress upsert locks the previous total and runs inside a transaction', async () => {
  const seen = [];
  let begins = 0;
  let commits = 0;
  const state = { total: 100 };
  const executor = {
    async execute(sql) {
      if (String(sql).includes('FROM reading_texts WHERE')) {
        return [[{ id_reading_text: 9, text: '0123456789' }]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async getConnection() {
      return {
        async execute(sql, params) {
          seen.push(String(sql));
          if (sql.includes('FROM user_reading_progress WHERE user_id = ? AND text_id = ? FOR UPDATE')) {
            return [[{ time_spent_seconds: state.total }]];
          }
          if (sql.startsWith('INSERT INTO user_reading_progress')) {
            state.total = params[2];
            return [[{ insertId: 1 }]];
          }
          if (sql.startsWith('SELECT position FROM user_reading_progress')) {
            return [[{ position: 5 }]];
          }
          if (sql.startsWith('INSERT INTO reading_study_days')) {
            state.credited = (state.credited || 0) + params[2];
            return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
        async beginTransaction() { begins += 1; },
        async commit() { commits += 1; },
        async rollback() {},
        release() {}
      };
    }
  };
  const first = await upsertReadingProgress(executor, USER_ID, 9, { position: 5, timeSpentSeconds: 150 });
  assert.equal(first.timeSpentSeconds, 150);
  assert.equal(state.credited, 50);
  const retry = await upsertReadingProgress(executor, USER_ID, 9, { position: 5, timeSpentSeconds: 150 });
  assert.equal(retry.timeSpentSeconds, 150);
  assert.equal(state.credited, 50);
  assert.equal(begins, 2);
  assert.equal(commits, 2);
  assert.ok(seen.some((sql) => sql.includes('FOR UPDATE')), 'previous total is row-locked');
});

// ------------------------------------------------------- graded-today box
test('listGradedToday returns owned items graded on the requested day', async () => {
  const execute = async (sql, params) => {
    assert.ok(sql.includes('v.user_id = ? OR k.user_id = ? OR g.user_id = ?'), 'ownership JOIN present');
    assert.ok(params.includes(USER_ID));
    assert.ok(params.includes('2026-10-13'));
    return [[
      { id: 11, entityType: 'vocabulary', title: 'taberu', result: 'Good', reviewedAt: '2026-10-13T10:00:00.000Z' },
      { id: 12, entityType: 'kanji', title: '食', result: 'Again', reviewedAt: '2026-10-13T09:00:00.000Z' }
    ]];
  };
  await withPoolStubs({ execute }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listGradedToday({ query: { today: '2026-10-13' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().items.length, 2);
    assert.equal(body().items[0].title, 'taberu');
  });
});

test('listGradedToday is empty without rows and rejects a bad today', async () => {
  await withPoolStubs({ execute: async () => [[]] }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listGradedToday({ query: {}, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body().items, []);
  });
  await withPoolStubs({ execute: async () => { throw new Error('DB must not be hit'); } }, async () => {
    const { res, status } = mockRes();
    await reviewController.listGradedToday({ query: { today: 'tomorrow' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 400);
  });
});
