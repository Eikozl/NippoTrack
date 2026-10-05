// Weekly insights engine tests: pure service logic against a fake executor
// (no database). Routing matches the query shape, like other service tests.
// Controller cases stub pool.execute the same way smart-goals does.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const {
  generateWeeklyInsights,
  hasReviewsSince,
  parseWeekKey
} = require('../src/services/weeklyInsights');

function event(day, entityType, result) {
  return { reviewed_at: `${day}T10:00:00Z`, entity_type: entityType, result };
}

function fakeExecutor({ events = [], prevEvents = [], dates = [], kanjiTotal = 300, goals = null, minutes = 120, completed = 3 } = {}) {
  return {
    async execute(sql, params) {
      if (/re\.result/.test(sql)) {
        const from = params[params.length - 2];
        const isPrev = from < '2026-09-28';
        return [isPrev ? prevEvents : events];
      }
      if (/LIMIT 500/.test(sql)) return [dates.map((day) => ({ reviewed_at: `${day}T10:00:00Z` }))];
      if (/FROM kanji WHERE/.test(sql)) return [[{ total: kanjiTotal }]];
      if (/user_smart_goals/.test(sql)) return [goals === null ? [] : [goals]];
      if (/study_sessions/.test(sql)) return [[{ minutes }]];
      if (/FROM review_sessions/.test(sql)) return [[{ completed }]];
      throw new Error(`unexpected SQL in insights test: ${sql.slice(0, 60)}`);
    }
  };
}

const RANGE = { weekStart: '2026-09-28', weekEnd: '2026-10-04' };

test('parseWeekKey resolves 2026-W40 to Sep 28 – Oct 4', () => {
  assert.deepEqual(parseWeekKey('2026-W40'), { key: '2026-W40', weekStart: '2026-09-28', weekEnd: '2026-10-04' });
});

test('parseWeekKey rejects malformed and phantom weeks', () => {
  for (const bad of ['nope', '', '2026-W99', '2026-W00', '2026-40']) {
    assert.throws(() => parseWeekKey(bad), /Invalid week key/);
  }
  // 2025 has 52 ISO weeks (Jan 1 is a Wednesday): W53 is a phantom.
  // (2026 genuinely has a W53 — Jan 1 is a Thursday.)
  assert.throws(() => parseWeekKey('2025-W53'), /Invalid week key/);
});

test('weakness below 60% and strength above 80% detected; tiny samples ignored', async () => {
  const events = [];
  for (let i = 0; i < 10; i += 1) events.push(event('2026-09-29', 'vocabulary', i < 3 ? 'Good' : 'Again'));
  for (let i = 0; i < 10; i += 1) events.push(event('2026-09-30', 'kanji', i < 9 ? 'Good' : 'Again'));
  for (let i = 0; i < 4; i += 1) events.push(event('2026-10-01', 'grammar', 'Good'));
  const executor = fakeExecutor({ events, prevEvents: events.slice(), dates: ['2026-09-28', '2026-09-29', '2026-09-30'] });
  const insights = await generateWeeklyInsights(executor, 'user-1', RANGE);
  assert.equal(insights.week, '2026-W40');
  assert.equal(insights.summary.totalReviews, 24);
  assert.equal(insights.summary.totalMinutes, 120);
  assert.equal(insights.summary.completedSessions, 3);
  const weakness = insights.weaknesses.find((w) => w.metric === 'vocabulary_accuracy');
  assert.ok(weakness, 'vocabulary weakness present');
  assert.equal(weakness.value, 0.3);
  assert.ok(weakness.suggestion, 'weakness carries a suggestion');
  const strength = insights.strengths.find((s) => s.metric === 'kanji_accuracy');
  assert.ok(strength, 'kanji strength present');
  assert.equal(strength.value, 0.9);
  assert.ok(!insights.weaknesses.some((w) => w.metric === 'grammar_accuracy'), '4-sample grammar stays quiet');
  assert.ok(!insights.strengths.some((s) => s.metric === 'grammar_accuracy'), '4-sample grammar stays quiet');
  assert.deepEqual(insights.anomalies, [], 'stable week raises no anomaly');
});

test('over-50% drop vs last week raises an anomaly', async () => {
  const prevEvents = [];
  for (let i = 0; i < 30; i += 1) prevEvents.push(event('2026-09-21', 'vocabulary', 'Good'));
  const events = [];
  for (let i = 0; i < 10; i += 1) events.push(event('2026-09-29', 'vocabulary', 'Good'));
  const executor = fakeExecutor({ events, prevEvents, dates: ['2026-09-29'] });
  const insights = await generateWeeklyInsights(executor, 'user-1', { ...RANGE, now: new Date('2026-10-05T12:00:00Z') });
  const drop = insights.anomalies.find((a) => a.type === 'review_drop');
  assert.ok(drop, 'drop anomaly present');
  assert.ok(['high', 'medium'].includes(drop.severity), 'drop carries severity');
  assert.match(drop.message, /30.*10|10.*30/, 'drop message cites both totals');
});

test('in-progress week never raises a review_drop anomaly', async () => {
  const prevEvents = [];
  for (let i = 0; i < 30; i += 1) prevEvents.push(event('2026-09-21', 'vocabulary', 'Good'));
  const events = [];
  for (let i = 0; i < 10; i += 1) events.push(event('2026-09-29', 'vocabulary', 'Good'));
  const executor = fakeExecutor({ events, prevEvents, dates: ['2026-09-29'] });
  const insights = await generateWeeklyInsights(executor, 'user-1', { ...RANGE, now: new Date('2026-10-01T12:00:00Z') });
  assert.ok(
    !insights.anomalies.some((a) => a.type === 'review_drop'),
    'a full week vs a days-old week is noise, not a drop'
  );
});

test('tzOffset boundaries put the week on client-local midnights', async () => {
  const windows = [];
  let minutesParams = null;
  const executor = {
    async execute(sql, params) {
      if (/re\.result/.test(sql)) { windows.push(params.slice(-2)); return [[]]; }
      if (/LIMIT 500/.test(sql)) return [[]];
      if (/FROM kanji WHERE/.test(sql)) return [[{ total: 0 }]];
      if (/user_smart_goals/.test(sql)) return [[]];
      if (/study_sessions/.test(sql)) { minutesParams = params; return [[{ minutes: 60 }]]; }
      if (/FROM review_sessions/.test(sql)) return [[{ completed: 1 }]];
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    }
  };
  const insights = await generateWeeklyInsights(executor, 'user-1', { ...RANGE, tzOffsetMinutes: 240 });
  assert.deepEqual(
    windows[0],
    ['2026-09-28T04:00:00.000Z', '2026-10-05T04:00:00.000Z'],
    'current week = client Monday 00:00 to next Monday 00:00 (UTC-4 instants)'
  );
  assert.deepEqual(
    windows[1],
    ['2026-09-21T04:00:00.000Z', '2026-09-28T04:00:00.000Z'],
    'previous week shifts with the same offset'
  );
  assert.deepEqual(minutesParams, ['user-1', '2026-09-28', '2026-10-04'], 'session_date stays a local DATE window');
  assert.equal(insights.summary.totalMinutes, 60, 'minutes counted on the local week');
});

test('shape carries streak, JLPT prediction and micro-goals', async () => {
  const events = [];
  for (let i = 0; i < 6; i += 1) events.push(event('2026-09-29', 'vocabulary', 'Good'));
  const executor = fakeExecutor({
    events,
    prevEvents: events.slice(),
    dates: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'],
    kanjiTotal: 300
  });
  const insights = await generateWeeklyInsights(executor, 'user-1', RANGE);
  assert.equal(insights.summary.streak, 4);
  assert.equal(insights.summary.graceUsed, 0);
  assert.ok(insights.predictions?.jlpt, 'jlpt prediction present');
  assert.equal(insights.predictions.jlpt.level, 'N5');
  assert.ok(insights.predictions?.weeklyGoal, 'weekly goal prediction present');
  assert.equal(insights.microGoals.length, 3, 'kanji + vocabulary + grammar micro-goals');
  assert.deepEqual(insights.microGoals.map((g) => g.type), ['kanji', 'vocabulary', 'grammar']);
});

test('hasReviewsSince checks only the user events inside the week window', async () => {
  const seen = [];
  const dirtyExecutor = {
    async execute(sql, params) {
      seen.push({ sql, params });
      return [[{ last_at: new Date('2026-10-02T10:00:00Z') }]];
    }
  };
  const since = new Date('2026-10-01T00:00:00Z');
  const dirty = await hasReviewsSince(dirtyExecutor, 'user-1', { weekStart: '2026-09-28', weekEnd: '2026-10-04', since });
  assert.equal(dirty, true, 'a review after generated_at marks the week stale');
  assert.deepEqual(
    seen[0].params.slice(0, 6),
    ['user-1', 'user-1', 'user-1', 'user-1', 'user-1', 'user-1'],
    'every join and filter is user-scoped'
  );
  assert.equal(seen[0].params[6], '2026-09-28', 'window opens at weekStart');
  assert.equal(seen[0].params[7], '2026-10-05', 'window closes the day after weekEnd');
  assert.equal(seen[0].params[8], since, 'compares against the cached generated_at');
  const freshExecutor = { async execute() { return [[{ last_at: null }]]; } };
  const fresh = await hasReviewsSince(freshExecutor, 'user-1', { weekStart: '2026-09-28', weekEnd: '2026-10-04', since });
  assert.equal(fresh, false, 'no newer reviews means the cache still holds');
});

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

function controllerStub({ cached, lastAt, events = [], dates = [], queries, saves }) {
  return async (sql, params = []) => {
    queries.push(sql);
    if (/FROM weekly_insights WHERE/.test(sql)) return [cached ? [cached] : []];
    if (/MAX\(re\.reviewed_at\)/.test(sql)) return [[{ last_at: lastAt }]];
    if (/INSERT INTO weekly_insights/i.test(sql)) { saves.push(params); return [{ affectedRows: 1 }]; }
    if (/re\.result/.test(sql)) return [events];
    if (/LIMIT 500/.test(sql)) return [dates.map((day) => ({ reviewed_at: `${day}T10:00:00Z` }))];
    if (/FROM kanji WHERE/.test(sql)) return [[{ total: 300 }]];
    if (/user_smart_goals/.test(sql)) return [[]];
    if (/study_sessions/.test(sql)) return [[{ minutes: 60 }]];
    if (/FROM review_sessions/.test(sql)) return [[{ completed: 1 }]];
    throw new Error(`unexpected SQL in insights controller test: ${sql.slice(0, 70)}`);
  };
}

async function withPoolExecute(stub, callback) {
  const pool = require('../src/config/db');
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test('cached insight regenerates when reviews landed after generation', async () => {
  const controller = require('../src/controllers/insightsController');
  const queries = [];
  const saves = [];
  const cached = {
    insights_json: { week: '2026-W40', summary: { totalReviews: 99 } },
    generated_at: new Date('2026-10-01T00:00:00Z')
  };
  const events = [event('2026-09-29', 'vocabulary', 'Good'), event('2026-09-30', 'kanji', 'Good')];
  await withPoolExecute(
    controllerStub({ cached, lastAt: new Date('2026-10-02T10:00:00Z'), events, dates: ['2026-09-29'], queries, saves }),
    async () => {
      const { res, status, body } = mockRes();
      await controller.getWeekly({ user: { id: 'user-1' }, query: { week: '2026-W40' } }, res);
      assert.equal(status(), 200);
      const data = body();
      assert.equal(data.cached, false, 'stale cache must regenerate');
      assert.equal(data.summary.totalReviews, 2, 'fresh review numbers replace the stale 99');
      assert.equal(saves.length, 1, 'fresh doc written back to the cache');
    }
  );
});

test('cached insight is served untouched when no reviews landed', async () => {
  const controller = require('../src/controllers/insightsController');
  const queries = [];
  const saves = [];
  const cached = {
    insights_json: { week: '2026-W40', summary: { totalReviews: 99 } },
    generated_at: new Date('2026-10-01T00:00:00Z')
  };
  await withPoolExecute(
    controllerStub({ cached, lastAt: null, events: [], dates: [], queries, saves }),
    async () => {
      const { res, status, body } = mockRes();
      await controller.getWeekly({ user: { id: 'user-1' }, query: { week: '2026-W40' } }, res);
      assert.equal(status(), 200);
      const data = body();
      assert.equal(data.cached, true, 'fresh cache is served as-is');
      assert.equal(data.summary.totalReviews, 99, 'untouched cached numbers');
      assert.equal(saves.length, 0, 'no rewrite when nothing changed');
      assert.ok(!queries.some((sql) => /re\.result/.test(sql)), 'no regeneration queries issued');
    }
  );
});

test('GET weekly with client today/tzOffset resolves the local week', async () => {
  const controller = require('../src/controllers/insightsController');
  const saves = [];
  const windows = [];
  const stub = async (sql, params = []) => {
    if (/FROM weekly_insights WHERE/.test(sql)) return [[]];
    if (/MAX\(re\.reviewed_at\)/.test(sql)) return [[{ last_at: null }]];
    if (/INSERT INTO weekly_insights/i.test(sql)) { saves.push(params); return [{ affectedRows: 1 }]; }
    if (/re\.result/.test(sql)) { windows.push(params.slice(-2)); return [[]]; }
    if (/LIMIT 500/.test(sql)) return [[]];
    if (/FROM kanji WHERE/.test(sql)) return [[{ total: 0 }]];
    if (/user_smart_goals/.test(sql)) return [[]];
    if (/study_sessions/.test(sql)) return [[{ minutes: 60 }]];
    if (/FROM review_sessions/.test(sql)) return [[{ completed: 1 }]];
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  await withPoolExecute(stub, async () => {
    const { res, status, body } = mockRes();
    await controller.getWeekly({ user: { id: 'user-1' }, query: { today: '2026-10-04', tzOffset: '240' } }, res);
    assert.equal(status(), 200);
    const data = body();
    assert.equal(data.week, '2026-W40', 'Sunday Oct 4 belongs to the Mon Sep 28 local week');
    assert.equal(data.summary.totalMinutes, 60, 'local-week sessions counted');
    assert.equal(saves[0][1], '2026-09-28', 'cache keyed on the local Monday');
    assert.deepEqual(
      windows[0],
      ['2026-09-28T04:00:00.000Z', '2026-10-05T04:00:00.000Z'],
      'event window uses client local midnights as UTC instants'
    );
  });
});

test('GET weekly rejects a malformed tzOffset', async () => {
  const controller = require('../src/controllers/insightsController');
  const { res, status, body } = mockRes();
  await controller.getWeekly({ user: { id: 'user-1' }, query: { tzOffset: 'afternoon' } }, res);
  assert.equal(status(), 400);
  assert.match(body().error, /tzOffset must be an integer/);
});
