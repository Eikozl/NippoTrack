// Weekly insights engine tests: pure service logic against a fake executor
// (no database). Routing matches the query shape, like other service tests.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateWeeklyInsights,
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
  const insights = await generateWeeklyInsights(executor, 'user-1', RANGE);
  const drop = insights.anomalies.find((a) => a.type === 'review_drop');
  assert.ok(drop, 'drop anomaly present');
  assert.ok(['high', 'medium'].includes(drop.severity), 'drop carries severity');
  assert.match(drop.message, /30.*10|10.*30/, 'drop message cites both totals');
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
