// Dashboard date windows: study sessions are stored with the browser's
// LOCAL date (native date inputs) while the DB clock is UTC, so after
// ~20:00 local (UTC-4) CURRENT_DATE already pointed at tomorrow and the
// minutes tiles summed to 0. `?today=` anchors every window on the client
// day; the param keeps the old UTC fallback when absent.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const pool = require('../src/config/db');
const controller = require('../src/controllers/dashboardController');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const LOCAL_TODAY = '2026-10-04';

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

function shiftDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

test('GET /api/dashboard anchors all windows on ?today (local client date)', async () => {
  const calls = [];
  await withPoolQuery(async (sql, params = []) => {
    calls.push({ sql, params });
    // Strict driver-like binding check: every ? gets exactly one param.
    // (Two V6.0 outages came from misaligned params that stubs ignored.)
    assert.equal(params.length, (sql.match(/\?/g) || []).length, 'params match placeholders');
    return [[{
      minutes_today: 30,
      minutes_week: 60,
      vocabulary_count: 0,
      kanji_count: 0,
      grammar_count: 0,
      recent_sessions: [],
      weekly_activity: [],
      study_distribution: []
    }]];
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getDashboard({ user: { id: USER_ID }, query: { today: LOCAL_TODAY } }, res);
    assert.equal(status(), 200);
    assert.equal(body().minutesToday, 30);
    assert.equal(body().minutesThisWeek, 60);
    assert.equal(calls.length, 1, 'single bounded query');
    const params = calls[0].params;
    assert.deepEqual(params.slice(0, 4), [USER_ID, USER_ID, USER_ID, USER_ID], 'CTE stays user-scoped');
    assert.deepEqual(
      params.slice(4, 7),
      [LOCAL_TODAY, LOCAL_TODAY, LOCAL_TODAY],
      'reading-minutes CTE uses the client date'
    );
    assert.equal(params[7], USER_ID, 'reading CTE stays user-scoped');
    assert.deepEqual(
      params.slice(8, 12),
      [LOCAL_TODAY, LOCAL_TODAY, LOCAL_TODAY, USER_ID],
      'review-minutes CTE uses the client date and stays user-scoped'
    );
    assert.deepEqual(
      params.slice(12),
      [LOCAL_TODAY, LOCAL_TODAY, LOCAL_TODAY, LOCAL_TODAY, LOCAL_TODAY],
      'today / week / rolling windows all use the client date'
    );
    assert.ok(/COALESCE\(\?::date, CURRENT_DATE\)/.test(calls[0].sql), 'UTC fallback kept for param-less callers');
  });
});

test('GET /api/dashboard rejects a malformed today', async () => {
  const { res, status, body } = mockRes();
  await controller.getDashboard({ user: { id: USER_ID }, query: { today: '04/10/2026' } }, res);
  assert.equal(status(), 400);
  assert.match(body().error, /today must be a YYYY-MM-DD date/);
});

test('GET /api/dashboard/activity anchors streak and calendar on ?today', async () => {
  const calls = [];
  await withPoolQuery(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM reading_study_days/i.test(sql) && /BETWEEN/i.test(sql)) {
      // Reading-only day with minutes: merges into the calendar.
      return [[{ date: LOCAL_TODAY, minutes: 5 }]];
    }
    if (/FROM reading_study_days/i.test(sql)) {
      // Today qualifies via reading (>= 300s); yesterday via sessions.
      return [[{ date: LOCAL_TODAY }]];
    }
    if (/FROM review_sessions/i.test(sql)) {
      // No completed reviews in this fixture: review days/minutes merge
      // nothing and the streak math below is sessions+reading only.
      return [[]];
    }
    if (/FROM review_sessions/i.test(sql)) {
      // No completed reviews in this fixture: review days/minutes merge
      // nothing and the streak math below is sessions+reading only.
      return [[]];
    }
    if (/BETWEEN \?::date AND \?::date/.test(sql)) {
      return [[{ date: '2026-10-03', minutes: 30 }]];
    }
    return [[{ date: '2026-10-03' }]];
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getActivity({ user: { id: USER_ID }, query: { today: LOCAL_TODAY } }, res);
    assert.equal(status(), 200);
    const data = body();
    assert.equal(data.currentStreak, 2, 'reading day keeps today active next to session days');
    assert.equal(calls.length, 6, 'sessions + reading + review queries, still bounded');
    assert.ok(!calls.some(({ sql }) => /to_char\(CURRENT_DATE/.test(sql)), 'client today replaces the UTC anchor');
    const calendarCall = calls.find(({ sql }) => /BETWEEN/.test(sql) && !/reading_study_days/i.test(sql));
    assert.deepEqual(calendarCall.params, [USER_ID, shiftDays(LOCAL_TODAY, -34), LOCAL_TODAY], '35-day window anchored on client today');
    const dates = data.calendar.map((entry) => entry.date);
    assert.ok(dates.includes(LOCAL_TODAY), 'reading-only day appears in the calendar');
    assert.equal(data.calendar.find((entry) => entry.date === LOCAL_TODAY).minutes, 5);
    assert.ok(calls.every(({ params }) => params.includes(USER_ID)), 'every query stays user-scoped');
  });
});

test('GET /api/dashboard/activity counts a review-only day toward the streak', async () => {
  await withPoolQuery(async (sql) => {
    if (/FROM study_sessions/i.test(sql)) return [[]];
    if (/FROM reading_study_days/i.test(sql)) return [[]];
    if (/FROM review_sessions/i.test(sql) && /BETWEEN/i.test(sql)) {
      return [[{ date: shiftDays(LOCAL_TODAY, -1), minutes: 12 }]];
    }
    if (/FROM review_sessions/i.test(sql)) {
      return [[{ date: shiftDays(LOCAL_TODAY, -1) }, { date: LOCAL_TODAY }]];
    }
    return [[]];
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getActivity({ user: { id: USER_ID }, query: { today: LOCAL_TODAY } }, res);
    assert.equal(status(), 200);
    assert.equal(body().currentStreak, 2, 'completed reviews keep the streak without manual sessions');
    assert.equal(body().calendar.find((entry) => entry.date === shiftDays(LOCAL_TODAY, -1)).minutes, 12);
  });
});

test('GET /api/dashboard/activity without ?today keeps the UTC fallback', async () => {  const calls = [];
  await withPoolQuery(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/to_char\(CURRENT_DATE/.test(sql)) return [[{ today: '2026-10-05' }]];
    if (/BETWEEN \?::date AND \?::date/.test(sql)) return [[]];
    return [[]];
  }, async () => {
    const { res, status } = mockRes();
    await controller.getActivity({ user: { id: USER_ID }, query: {} }, res);
    assert.equal(status(), 200);
    assert.ok(calls.some(({ sql }) => /to_char\(CURRENT_DATE/.test(sql)), 'legacy UTC anchor still available');
    const calendarCall = calls.find(({ sql }) => /BETWEEN/.test(sql) && !/reading_study_days/i.test(sql));
    assert.deepEqual(calendarCall.params, [USER_ID, shiftDays('2026-10-05', -34), '2026-10-05']);
  });
});
