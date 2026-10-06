// V5.6 Study Now — deterministic next action reusing existing signals.
// Read-only, bounded, user-scoped. No new tables.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const pool = require('../src/config/db');
const controller = require('../src/controllers/dashboardController');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TODAY = '2026-10-04';

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withPoolQuery(stub, callback) {
  const original = pool.query;
  pool.query = stub;
  try {
    await callback();
  } finally {
    pool.query = original;
  }
}

function stubPool({ due = 0, difficult = 0, minutes = 0, vocab = 0, kanji = 0, grammar = 0, reading = null }) {
  return async (sql) => {
    if (/review_events/.test(sql)) {
      return [Array.from({ length: difficult }, (_, i) => ({ id_review_item: i + 1 }))];
    }
    if (/user_reading_progress/.test(sql)) {
      return [reading ? [reading] : []];
    }
    return [[{
      due_count: due,
      minutes_today: minutes,
      vocabulary_count: vocab,
      kanji_count: kanji,
      grammar_count: grammar
    }]];
  };
}

test('Study Now prioritizes due reviews with difficult context', async () => {
  await withPoolQuery(stubPool({ due: 18, difficult: 4, minutes: 10, vocab: 5 }), async () => {
    const { res, status, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(status(), 200);
    const data = body();
    assert.equal(data.primary.kind, 'review');
    assert.equal(data.primary.href, '#review');
    assert.match(data.primary.title, /18 reviews? due/);
    assert.match(data.primary.reason, /4.*struggled/);
    assert.equal(data.signals.dueCount, 18);
    assert.equal(data.signals.difficultCount, 4);
  });
});

test('Study Now surfaces incomplete reading when reviews are clear', async () => {
  await withPoolQuery(stubPool({ due: 0, vocab: 10, reading: { id: 7, title: 'Aozora story' } }), async () => {
    const { res, status, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(status(), 200);
    assert.equal(body().primary.kind, 'reading');
    assert.equal(body().primary.href, '#reading?id=7');
  });
});

test('Study Now guides empty collections to the Analyzer', async () => {
  await withPoolQuery(stubPool({ due: 0, vocab: 0, kanji: 0, grammar: 0 }), async () => {
    const { res, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(body().primary.kind, 'analyze');
    assert.equal(body().primary.href, '#analyzer');
  });
});

test('Study Now nudges session logging when today is empty', async () => {
  await withPoolQuery(stubPool({ due: 0, vocab: 3, minutes: 0 }), async () => {
    const { res, body } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    assert.equal(body().primary.kind, 'session');
    assert.equal(body().primary.href, '#sessions');
  });
});

test('Study Now rejects malformed today', async () => {
  const { res, status, body } = mockRes();
  await controller.getStudyNow({ user: { id: USER_ID }, query: { today: 'not-a-date' } }, res);
  assert.equal(status(), 400);
  assert.match(body().error, /today must be a YYYY-MM-DD date/);
});

test('Study Now stays user-scoped (no cross-user params)', async () => {
  const seen = [];
  const stub = stubPool({ due: 1 });
  await withPoolQuery(async (sql, params) => {
    seen.push(params || []);
    return stub(sql, params);
  }, async () => {
    const { res } = mockRes();
    await controller.getStudyNow({ user: { id: USER_ID }, query: { today: TODAY } }, res);
    for (const params of seen) {
      for (const value of params) {
        if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) {
          assert.equal(value, USER_ID);
        }
      }
    }
    assert.ok(seen.length >= 2, 'due + parallel signals queried');
  });
});
