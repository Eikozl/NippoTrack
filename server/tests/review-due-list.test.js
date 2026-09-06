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
    // R-B: inert rows (interval_days=0 AND last_reviewed_at IS NULL) excluded in all 3 branches.
    const inertMatches = sql.match(/NOT\s*\(\s*ri\.interval_days\s*=\s*0\s+AND\s+ri\.last_reviewed_at\s+IS\s+NULL\s*\)/gi) || [];
    assert.equal(inertMatches.length, 3, 'inert exclusion predicate must appear once per UNION branch');
  } finally { restore(); }
});

test('GET /api/review scopes every branch to the requesting user', async () => {
  const { calls, restore } = captureExecute([]);
  try {
    let body;
    await reviewController.listDueReviews({ user: { id: 'user-9' } }, { json: (value) => { body = value; } });
    assert.deepEqual(body, { items: [] });
    const { sql, params } = calls[0];
    assert.match(sql, /v\.user_id = \?/);
    assert.match(sql, /k\.user_id = \?/);
    assert.match(sql, /g\.user_id = \?/);
    assert.deepEqual(params, ['user-9', 'user-9', 'user-9']);
    const inertMatches = sql.match(/NOT\s*\(\s*ri\.interval_days\s*=\s*0\s+AND\s+ri\.last_reviewed_at\s+IS\s+NULL\s*\)/gi) || [];
    assert.equal(inertMatches.length, 3, 'inert exclusion predicate must appear once per UNION branch');
  } finally { restore(); }
});

test('GET /api/review SQL excludes inert rows while keeping reviewed/enrolled rows (R-B)', async () => {
  // Exclusion lives in SQL WHERE, so the stubbed pool returns whatever rows
  // we give it. Assert the SQL carries the predicate 3x with unchanged params,
  // and document the row-level semantics the predicate implements.
  const mixed = [
    { id_review_item: 10, due_on: '2026-09-01', interval_days: 0, last_reviewed_at: null, last_result: null, item_type: 'Kanji', title: 'inert-kanji' },
    { id_review_item: 11, due_on: '2026-09-01', interval_days: 3, last_reviewed_at: '2026-08-01T00:00:00.000Z', last_result: 'Good', item_type: 'Kanji', title: 'reviewed-kanji' },
    { id_review_item: 12, due_on: '2026-09-01', interval_days: 0, last_reviewed_at: '2026-08-02T00:00:00.000Z', last_result: 'Again', item_type: 'Vocabulary', title: 'zero-interval-reviewed' },
    { id_review_item: 13, due_on: '2026-09-01', interval_days: 1, last_reviewed_at: null, last_result: null, item_type: 'Grammar', title: 'nonzero-never-reviewed' }
  ];
  const { calls, restore } = captureExecute(mixed);
  try {
    let body;
    await reviewController.listDueReviews({ user: { id: 'user-1' } }, { json: (value) => { body = value; } });
    // Stub echoes; the real DB would have filtered id 10 via the WHERE clause.
    assert.deepEqual(body, { items: mixed });
    const { sql, params } = calls[0];
    assert.deepEqual(params, ['user-1', 'user-1', 'user-1']);
    const inertMatches = sql.match(/NOT\s*\(\s*ri\.interval_days\s*=\s*0\s+AND\s+ri\.last_reviewed_at\s+IS\s+NULL\s*\)/gi) || [];
    assert.equal(inertMatches.length, 3);
  } finally { restore(); }
});

test('inert-row predicate logic: only interval 0 + never reviewed is inert', () => {
  // Mirrors `NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)` per branch.
  const isInert = (row) => Number(row.interval_days) === 0 && row.last_reviewed_at == null;
  assert.equal(isInert({ interval_days: 0, last_reviewed_at: null }), true, 'auto-enrolled never reviewed is inert');
  assert.equal(isInert({ interval_days: '0', last_reviewed_at: null }), true, 'string zero still inert');
  assert.equal(isInert({ interval_days: 0, last_reviewed_at: '2026-08-01T00:00:00.000Z' }), false, 'reviewed even once is not inert');
  assert.equal(isInert({ interval_days: 1, last_reviewed_at: null }), false, 'non-zero interval is not inert');
  assert.equal(isInert({ interval_days: 3, last_reviewed_at: '2026-08-01T00:00:00.000Z' }), false, 'reviewed row is not inert');
  assert.equal(isInert({ interval_days: 7, last_reviewed_at: null }), false, 'scheduled row is not inert');
});
