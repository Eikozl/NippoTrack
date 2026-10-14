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
  const execute = async (sql, params) => {
    if (sql.startsWith('SELECT id_review_session')) {
      return [[store.completedAt ? { id_review_session: 1, completed_at: store.completedAt } : { id_review_session: 1, completed_at: null }]];
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
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  await withPoolStubs({ execute }, async () => {
    const first = mockRes();
    const second = mockRes();
    await reviewController.completeReviewSession({ params: { id: '1' }, user: { id: USER_ID } }, first.res);
    await reviewController.completeReviewSession({ params: { id: '1' }, user: { id: USER_ID } }, second.res);
    assert.equal(first.status(), 200);
    assert.equal(second.status(), 200);
    assert.equal(first.body().completedAt, '2026-10-13T10:00:00.000Z');
    assert.equal(second.body().completedAt, first.body().completedAt);
    // First call performs the guarded UPDATE; the second sees completed_at
    // set and takes the idempotent early return without a second UPDATE.
    assert.deepEqual(updates, [1]);
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
