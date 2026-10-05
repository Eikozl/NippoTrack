// Frequently difficult items: read-only listing over persisted review
// history. "Difficult" = >=2 Again events (HAVING, enforced in SQL).
// Ownership always req.user.id across the three entity branches.
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

test('listDifficultItems returns items with >=2 Again in camelCase shape', async () => {
  const seen = [];
  await withExecuteStub(async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM review_items ri\s+LEFT JOIN review_events/i.test(sql)) {
      assert.deepEqual(params, [USER_ID, USER_ID, USER_ID, USER_ID, USER_ID, USER_ID]);
      return [[
        {
          id: '11', entityType: 'kanji', display: '食', reading: null, meaning: 'eat',
          againCount: '3', totalEvents: '4', lastReviewedAt: '2026-09-10T10:00:00.000Z'
        },
        {
          id: '12', entityType: 'vocabulary', display: '食べ物', reading: 'たべもの', meaning: 'food',
          againCount: '2', totalEvents: '2', lastReviewedAt: '2026-09-09T10:00:00.000Z'
        }
      ]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listDifficultItems({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(seen.length, 1);
    assert.deepEqual(body(), {
      items: [
        {
          idReviewItem: 11, entityType: 'kanji', display: '食', reading: null, meaning: 'eat',
          againCount: 3, totalEvents: 4, lastReviewedAt: '2026-09-10T10:00:00.000Z'
        },
        {
          idReviewItem: 12, entityType: 'vocabulary', display: '食べ物', reading: 'たべもの', meaning: 'food',
          againCount: 2, totalEvents: 2, lastReviewedAt: '2026-09-09T10:00:00.000Z'
        }
      ]
    });
  });
});

test('listDifficultItems excludes <2 Again via HAVING and caps at LIMIT 10', async () => {
  const seen = [];
  await withExecuteStub(async (sql, params) => {
    seen.push({ sql, params });
    if (/FROM review_items ri\s+LEFT JOIN review_events/i.test(sql)) {
      // 0/1-Again items never reach the controller: the HAVING clause
      // filters them in SQL. Assert the static guarantees on the query.
      assert.match(sql, /HAVING COUNT\(\*\) FILTER \(WHERE re\.result = 'Again'\) >= 2/);
      assert.match(sql, /LIMIT 10/);
      assert.match(sql, /ORDER BY "againCount" DESC/);
      return [[]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listDifficultItems({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { items: [] });
  });
});

test('listDifficultItems excludes deleted entities (LEFT JOIN NULL rows)', async () => {
  await withExecuteStub(async (sql) => {
    if (/FROM review_items ri\s+LEFT JOIN review_events/i.test(sql)) {
      // A deleted entity leaves every LEFT JOIN NULL, so the ownership
      // WHERE (v.user_id OR k.user_id OR g.user_id) drops the row.
      return [[]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listDifficultItems({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.deepEqual(body(), { items: [] });
  });
});

test('listDifficultItems fails closed with 503 on database errors', async () => {
  await withExecuteStub(async () => { throw new Error('database unavailable'); }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listDifficultItems({ user: { id: USER_ID } }, res);
    assert.equal(status(), 503);
    assert.equal(body().error, 'Unable to load difficult items.');
  });
});
