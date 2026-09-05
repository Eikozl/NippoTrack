const assert = require('node:assert');
const test = require('node:test').test;
const reviewController = require('../src/controllers/reviewController');
const pool = require('../src/config/db');

function captureExecute(rows) {
  const calls = [];
  const original = pool.execute;
  pool.execute = async (sql, params) => { calls.push({ sql, params }); return [rows]; };
  return { calls, restore: () => { pool.execute = original; } };
}

test('GET /api/review lists due items from all three owned branches in due order', async () => {
  const rows = [
    { id_review_item: 2, due_on: '2026-09-01', interval_days: 3, last_reviewed_at: null, last_result: null, item_type: 'Kanji', title: '日', meaning: 'day', reading: null },
    { id_review_item: 1, due_on: '2026-09-02', interval_days: 1, last_reviewed_at: null, last_result: null, item_type: 'Vocabulary', title: '水', meaning: 'water', reading: 'みず' },
    { id_review_item: 3, due_on: '2026-09-03', interval_days: 7, last_reviewed_at: null, last_result: null, item_type: 'Grammar', title: '〜ても', meaning: 'even if', reading: null }
  ];
  const { calls, restore } = captureExecute(rows);
  try {
    let body;
    await reviewController.listDueReviews({ user: { id: 'user-1' } }, { json: (value) => { body = value; } });
    assert.deepEqual(body, { items: rows });
    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.deepEqual(params, ['user-1', 'user-1', 'user-1']);
    assert.match(sql, /UNION ALL.*UNION ALL/s);
    assert.match(sql, /JOIN vocabulary v ON/);
    assert.match(sql, /JOIN kanji k ON/);
    assert.match(sql, /JOIN grammar_points g ON/);
    assert.ok(!/LEFT JOIN/i.test(sql), 'must not use LEFT JOIN');
    assert.ok(!/v\.user_id = \? OR/i.test(sql), 'must not use OR ownership filter');
    assert.match(sql, /ORDER BY due_on ASC, id_review_item ASC/);
  } finally { restore(); }
});

test('GET /api/review scopes every branch to the requesting user', async () => {
  const { calls, restore } = captureExecute([]);
  try {
    let body;
    await reviewController.listDueReviews({ user: { id: 'user-9' } }, { json: (value) => { body = value; } });
    assert.deepEqual(body, { items: [] });
    const { sql } = calls[0];
    assert.match(sql, /v\.user_id = \?/);
    assert.match(sql, /k\.user_id = \?/);
    assert.match(sql, /g\.user_id = \?/);
  } finally { restore(); }
});
