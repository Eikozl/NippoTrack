// Review Reminder feed: never-reviewed + overdue owned items, Mastered
// excluded, bounded 50. Stubbed pool throughout (no live DB).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const reviewController = require('../src/controllers/reviewController');
const pool = require('../src/config/db');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withExecuteStub(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test('listReviewReminders maps never/overdue rows and stays user-scoped', async () => {
  const seen = [];
  await withExecuteStub(async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM review_items ri/.test(sql)) {
      assert.deepEqual(params, [USER_ID, USER_ID, USER_ID, USER_ID, USER_ID, USER_ID]);
      return [[
        {
          entityType: 'vocabulary', entityId: '3', display: '食べる', reading: 'たべる',
          meaning: 'to eat', status: 'Learning', reason: 'never', dueOn: null, lastResult: null
        },
        {
          entityType: 'kanji', entityId: '7', display: '食', reading: null,
          meaning: 'eat', status: 'Familiar', reason: 'overdue', dueOn: '2026-10-01', lastResult: 'Good'
        }
      ]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listReviewReminders({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), {
      items: [
        {
          entityType: 'vocabulary', entityId: 3, display: '食べる', reading: 'たべる',
          meaning: 'to eat', status: 'Learning', reason: 'never', dueOn: null, lastResult: null
        },
        {
          entityType: 'kanji', entityId: 7, display: '食', reading: null,
          meaning: 'eat', status: 'Familiar', reason: 'overdue', dueOn: '2026-10-01', lastResult: 'Good'
        }
      ]
    });
  });
});

test('listReviewReminders SQL excludes Mastered and caps at LIMIT 50', async () => {
  await withExecuteStub(async (sql) => {
    if (/FROM review_items ri/.test(sql)) {
      assert.match(sql, /<> 'Mastered'/, 'mastered items rest');
      assert.match(sql, /LIMIT 50/, 'bounded feed');
      assert.match(sql, /last_reviewed_at IS NULL OR ri\.due_on < CURRENT_DATE/, 'never-reviewed or overdue only');
      return [[]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listReviewReminders({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { items: [] });
  });
});

test('listReviewReminders fails closed with 503 on database errors', async () => {
  await withExecuteStub(async () => { throw new Error('database unavailable'); }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listReviewReminders({ user: { id: USER_ID } }, res);
    assert.equal(status(), 503);
    assert.equal(body().error, 'Unable to load review reminders.');
  });
});
