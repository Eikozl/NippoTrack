// Review history: read-only listing over persisted review_sessions +
// review_events. No analytics, no new writes; ownership always req.user.id.
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

test('listReviewSessions returns paginated summaries with per-type and per-result counts', async () => {
  const seen = [];
  await withExecuteStub(async (sql, params) => {
    seen.push({ sql, params });
    if (/SELECT COUNT\(\*\) AS total FROM review_sessions WHERE user_id = \?/i.test(sql)) {
      assert.deepEqual(params, [USER_ID]);
      return [[{ total: '2' }]];
    }
    if (/FROM review_sessions rs\s+LEFT JOIN review_events/i.test(sql)) {
      assert.deepEqual(params, [USER_ID, 10, 0]);
      return [[{
        id: '7',
        sourceFrom: '2026-09-01',
        sourceTo: '2026-09-03',
        startedAt: '2026-09-03T10:00:00.000Z',
        completedAt: '2026-09-03T10:05:00.000Z',
        total: '3',
        kanji: '1',
        vocabulary: '1',
        grammar: '1',
        again: '1',
        hard: '1',
        good: '1'
      }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listReviewSessions({ query: { limit: '10' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().pagination.total, 2);
    assert.equal(body().pagination.page, 1);
    assert.equal(body().items.length, 1);
    assert.deepEqual(body().items[0], {
      id: 7,
      sourceFrom: '2026-09-01',
      sourceTo: '2026-09-03',
      startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:05:00.000Z',
      total: 3,
      byType: { kanji: 1, vocabulary: 1, grammar: 1 },
      byResult: { Again: 1, Hard: 1, Good: 1 }
    });
  });
});

test('listReviewSessions rejects invalid pagination with 400', async () => {
  await withExecuteStub(async () => { throw new Error('must not query'); }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.listReviewSessions({ query: { page: 'nope' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 400);
    assert.match(body().error, /page must be a positive integer/);
  });
});

test('getReviewSession returns 404 for missing-or-foreign sessions', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM review_sessions WHERE id_review_session = \? AND user_id = \?/i.test(sql)) {
      assert.deepEqual(params, [99, USER_ID]);
      return [[]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSession({ params: { id: '99' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 404);
    assert.equal(body().error, 'review session not found');
  });
});

test('getReviewSession returns the session, bounded items, and summary', async () => {
  await withExecuteStub(async (sql, params) => {
    if (/FROM review_sessions WHERE id_review_session = \? AND user_id = \?/i.test(sql)) {
      return [[{
        id: '7',
        sourceFrom: '2026-09-01',
        sourceTo: '2026-09-03',
        startedAt: '2026-09-03T10:00:00.000Z',
        completedAt: '2026-09-03T10:05:00.000Z'
      }]];
    }
    if (/FROM review_events re\s+JOIN review_items ri/i.test(sql) && /LEFT JOIN vocabulary/i.test(sql)) {
      assert.deepEqual(params, [USER_ID, USER_ID, USER_ID, 7, USER_ID]);
      assert.match(sql, /LIMIT 500/);
      return [[{
        reviewedAt: '2026-09-03T10:01:00.000Z',
        result: 'Again',
        entityType: 'kanji',
        display: '食',
        reading: null,
        meaning: 'eat'
      }]];
    }
    if (/WHERE re.id_review_session = \?/i.test(sql)) {
      assert.deepEqual(params, [7, USER_ID]);
      return [[{ total: '1', kanji: '1', vocabulary: '0', grammar: '0', again: '1', hard: '0', good: '0' }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await reviewController.getReviewSession({ params: { id: '7' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    assert.equal(body().session.id, 7);
    assert.equal(body().items.length, 1);
    assert.equal(body().items[0].display, '食');
    assert.equal(body().total, 1);
    assert.equal(body().byResult.Again, 1);
  });
});

test('getReviewSession rejects non-integer ids with 400', async () => {
  await withExecuteStub(async () => { throw new Error('must not query'); }, async () => {
    const { res, status } = mockRes();
    await reviewController.getReviewSession({ params: { id: 'abc' }, user: { id: USER_ID } }, res);
    assert.equal(status(), 400);
  });
});
