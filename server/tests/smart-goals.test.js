// V5.3a Smart Goals: heuristics + endpoints, all local and deterministic.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const USER_ID = '00000000-0000-4000-8000-000000000001';

const pool = require('../src/config/db');
const controller = require('../src/controllers/smartGoalsController');
const service = require('../src/services/smartGoals');

function mockRes() {
  let statusCode = 200;
  let body;
  const res = {
    status(code) { statusCode = code; return res; },
    json(value) { body = value; return res; }
  };
  return { res, status: () => statusCode, body: () => body };
}

async function withPoolExecute(stub, callback) {
  const original = pool.execute;
  pool.execute = stub;
  try {
    await callback();
  } finally {
    pool.execute = original;
  }
}

test('adjustWeeklyGoal nudges +-20% and leaves empty history untouched', () => {
  assert.equal(service.adjustWeeklyGoal(20, []), 20);
  assert.equal(service.adjustWeeklyGoal(20, [0, 0, 0, 0]), 20);
  assert.equal(service.adjustWeeklyGoal(20, [21, 20, 25, 20]), 24);
  assert.equal(service.adjustWeeklyGoal(20, [10, 5, 3, 8]), 16);
  assert.equal(service.adjustWeeklyGoal(900, [950, 960, 940, 950]), 1000, 'clamped to schema maximum');
  assert.equal(service.adjustWeeklyGoal(1, [0, 0, 1, 0]), 1, 'clamped to schema minimum');
});

test('checkStreak counts consecutive days and forgives grace per ISO week', () => {
  const deep = service.checkStreak(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'], 1);
  assert.equal(deep.streak, 5);
  assert.equal(deep.graceUsed, 0);

  // One missed day mid-run is forgiven (grace 1); the run continues.
  const forgiven = service.checkStreak(['2026-09-28', '2026-09-29', '2026-10-01', '2026-10-02'], 1);
  assert.equal(forgiven.streak, 5);
  assert.equal(forgiven.graceUsed, 1);

  // A second missed day in the same week breaks the run at the gap.
  const broken = service.checkStreak(['2026-09-28', '2026-10-02'], 1);
  assert.ok(broken.streak < 5, `run breaks on a double gap (got ${broken.streak})`);

  assert.deepEqual(service.checkStreak([], 1), { streak: 0, graceUsed: 0 });
  assert.deepEqual(service.checkStreak(['not-a-date'], 1), { streak: 0, graceUsed: 0 });
});

test('predictJlpt scales weeks by the weekly rate and confidence by evidence', () => {
  const start = service.predictJlpt(0, 'N4', { weeklyGoal: 20 });
  assert.equal(start.level, 'N4');
  assert.equal(start.remainingKanji, 300);
  assert.equal(start.weeks, 15);
  assert.equal(start.confidence, 0);

  const mid = service.predictJlpt(100, 'N4', { weeklyGoal: 30 });
  assert.equal(mid.remainingKanji, 200);
  assert.equal(mid.weeks, 7);
  assert.ok(mid.confidence > 0 && mid.confidence < 1);

  const done = service.predictJlpt(400, 'N4', { weeklyGoal: 20 });
  assert.equal(done.weeks, 0);
  assert.equal(done.confidence, 1);

  const floor = service.predictJlpt(50, 'N1', { weeklyGoal: 0 });
  assert.equal(floor.weeklyRate, 5, 'rate floor applies');
  assert.throws(() => service.predictJlpt(10, 'N9'), /targetJlpt/);
});

test('generateMicroGoals is deterministic for a fixed today and targets the goal band', () => {
  const goals = service.generateMicroGoals('N3', 'N5', { today: '2026-10-02T12:00:00Z' });
  assert.deepEqual(goals.map((goal) => [goal.type, goal.count, goal.level]), [
    ['kanji', 5, 'N3'],
    ['vocabulary', 10, 'N3'],
    ['grammar', 2, 'N3']
  ]);
  // 2026-10-02 is a Friday -> coming Sunday is 2026-10-04.
  assert.equal(goals[0].deadline, '2026-10-04');
  const sunday = service.generateMicroGoals('N3', 'N5', { today: '2026-10-04T09:00:00Z' });
  assert.equal(sunday[0].deadline, '2026-10-04', 'Sunday keeps itself as the deadline');
  const fallback = service.generateMicroGoals(null, 'N4', { today: '2026-10-02T12:00:00Z' });
  assert.equal(fallback[0].level, 'N4', 'falls back to the current level');
});

test('GET /api/goals/smart computes the full view user-scoped', async () => {
  const calls = [];
  await withPoolExecute(async (sql, params = []) => {
    calls.push({ sql, params });
    if (/FROM user_smart_goals WHERE user_id = \?/i.test(sql)) {
      assert.deepEqual(params, [USER_ID]);
      return [[{ weekly_goal: 25, target_jlpt: 'N3', auto_adjust: true, grace_days: 1, preferences_json: {} }]];
    }
    if (/FROM review_events re/i.test(sql)) {
      assert.equal(params.filter((value) => value === USER_ID).length, 6);
      const today = new Date();
      const iso = (offset) => new Date(today.getTime() - offset * 86400000).toISOString();
      return [[{ reviewed_at: iso(0) }, { reviewed_at: iso(1) }, { reviewed_at: iso(3) }]];
    }
    if (/FROM kanji WHERE user_id = \?/i.test(sql)) {
      return [[{ total: '120' }]];
    }
    throw new Error(`Unexpected smart SQL: ${sql}`);
  }, async () => {
    const { res, status, body } = mockRes();
    await controller.getSmart({ user: { id: USER_ID } }, res);
    assert.equal(status(), 200);
    const data = body();
    assert.equal(data.weeklyGoal, 25);
    assert.equal(data.preferences.targetJlpt, 'N3');
    assert.equal(data.streak, 4, 'one grace day bridges the single gap');
    assert.equal(data.prediction.level, 'N3');
    assert.equal(data.prediction.remainingKanji, 530);
    assert.equal(data.microGoals.length, 3);
    assert.equal(data.microGoals[0].level, 'N3');
    assert.ok(calls.length >= 3, 'row + activity + kanji queries issued');
  });
});

test('PUT preferences validates and POST adjust recalculates from activity', async () => {
  const invalid = mockRes();
  await controller.putPreferences({ user: { id: USER_ID }, body: { graceDays: 5 } }, invalid.res);
  assert.equal(invalid.status(), 400);
  const badTarget = mockRes();
  await controller.putPreferences({ user: { id: USER_ID }, body: { targetJlpt: 'N9' } }, badTarget.res);
  assert.equal(badTarget.status(), 400);
  const unknown = mockRes();
  await controller.putPreferences({ user: { id: USER_ID }, body: { weeklyGoal: 99 } }, unknown.res);
  assert.equal(unknown.status(), 400, 'weeklyGoal is adjusted by the engine, not hand-set');

  const upserts = [];
  await withPoolExecute(async (sql, params = []) => {
    if (/FROM user_smart_goals WHERE user_id = \?/i.test(sql)) {
      return [[{ weekly_goal: 20, target_jlpt: null, auto_adjust: true, grace_days: 1, preferences_json: {} }]];
    }
    if (/INSERT INTO user_smart_goals/i.test(sql)) {
      upserts.push({ sql, params });
      return [{ affectedRows: 1 }];
    }
    if (/FROM review_events re/i.test(sql)) return [[]];
    if (/FROM kanji WHERE user_id = \?/i.test(sql)) return [[{ total: '0' }]];
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async () => {
    const saved = mockRes();
    await controller.putPreferences({ user: { id: USER_ID }, body: { targetJlpt: 'N4', graceDays: 2, autoAdjust: false } }, saved.res);
    assert.equal(saved.status(), 200);
    assert.deepEqual(saved.body().preferences, { autoAdjust: false, graceDays: 2, targetJlpt: 'N4' });

    const adjusted = mockRes();
    await controller.postAdjust({ user: { id: USER_ID } }, adjusted.res);
    assert.equal(adjusted.status(), 200);
    assert.equal(adjusted.body().previousGoal, 20);
    assert.equal(adjusted.body().weeklyGoal, 20, 'no recent activity keeps the goal unchanged');
    for (const upsert of upserts) {
      assert.equal(upsert.params[0], USER_ID, 'upserts are user-scoped');
    }
  });
});
