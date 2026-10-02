// V5.3a Smart Goals — 100% local heuristics (no ML, no network).
//
// adjustWeeklyGoal: ±20% nudge. Meeting-or-beating the current goal for the
// last 4 weeks stretches it; falling short eases it. Empty history keeps the
// goal untouched. Clamped to [1, 1000] (schema bounds).
//
// checkStreak: consecutive study days walking back from the most recent day;
// within one ISO week at most `graceDays` missing days are forgiven (the
// spec default is one). Deterministic given the date list.
//
// predictJLPT: kanji-volume heuristic over documented cumulative targets
// (N5~100, N4~300, N3~650, N2~1200, N1~2000); weeks = remaining kanji at the
// user's weekly rate (>= 5/week floor), confidence scales with how much
// evidence exists (0 below 25 kanji, growing to 1 at 150).
//
// generateMicroGoals: fixed weekly shape (5 kanji + 10 vocabulary + 2 grammar
// of the target band) with the coming Sunday as the deadline; `today` is
// injectable so tests stay deterministic.

const { ValidationError } = require('../errors/http');

const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const JLPT_KANJI_TARGETS = { N5: 100, N4: 300, N3: 650, N2: 1200, N1: 2000 };
const WEEKLY_RATE_FLOOR = 5;
const DEFAULT_WEEKLY_GOAL = 20;

function normalizeWeeklyGoal(value) {
  const goal = Number(value);
  if (!Number.isInteger(goal) || goal < 1 || goal > 1000) {
    throw new ValidationError('weeklyGoal must be an integer between 1 and 1000.');
  }
  return goal;
}

function normalizeTargetJlpt(value) {
  if (value === undefined || value === null || value === '') return null;
  const target = String(value);
  if (!JLPT_LEVELS.includes(target)) {
    throw new ValidationError(`targetJlpt must be one of: ${JLPT_LEVELS.join(', ')}.`);
  }
  return target;
}

function normalizeGraceDays(value) {
  if (value === undefined || value === null || value === '') return 1;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 2) {
    throw new ValidationError('graceDays must be 0, 1, or 2.');
  }
  return days;
}

function normalizeAutoAdjust(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'boolean') throw new ValidationError('autoAdjust must be a boolean.');
  return value;
}

function clampGoal(value) {
  return Math.min(1000, Math.max(1, Math.round(value)));
}

function adjustWeeklyGoal(current, last4Weeks) {
  const goal = clampGoal(Number(current) || DEFAULT_WEEKLY_GOAL);
  const weeks = Array.isArray(last4Weeks) ? last4Weeks.map((count) => Number(count) || 0) : [];
  if (!weeks.length) return goal;
  const average = weeks.reduce((sum, count) => sum + count, 0) / weeks.length;
  if (average <= 0) return goal;
  return clampGoal(average >= goal ? goal * 1.2 : goal * 0.8);
}

function toIsoWeekKey(date) {
  const moment = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO week: Thursday of the current week decides the year/week number.
  moment.setUTCDate(moment.getUTCDate() + 4 - (moment.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(moment.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((moment - yearStart) / 86400000 + 1) / 7);
  return `${moment.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function checkStreak(dates, graceDays = 1) {
  const grace = Number.isInteger(graceDays) ? Math.max(0, Math.min(2, graceDays)) : 1;
  const unique = [...new Set((Array.isArray(dates) ? dates : [])
    .map((value) => String(value || '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)))]
    .sort();
  if (!unique.length) return { streak: 0, graceUsed: 0 };
  const daySet = new Set(unique);
  let streak = 0;
  let graceUsed = 0;
  const graceByWeek = new Map();
  let cursor = new Date(`${unique[unique.length - 1]}T00:00:00Z`);
  const newest = new Date(cursor);
  while (cursor >= new Date(`${unique[0]}T00:00:00Z`)) {
    const iso = cursor.toISOString().slice(0, 10);
    if (daySet.has(iso)) {
      streak += 1;
    } else if (cursor < newest) {
      const weekKey = toIsoWeekKey(cursor);
      const used = graceByWeek.get(weekKey) || 0;
      if (used < grace) {
        graceByWeek.set(weekKey, used + 1);
        graceUsed += 1;
        // Forgiven days count toward the streak: the streak measures
        // calendar continuity, not just study days.
        streak += 1;
      } else {
        break;
      }
    }
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return { streak, graceUsed };
}

function predictJlpt(reviewedKanji, target, { weeklyGoal = DEFAULT_WEEKLY_GOAL } = {}) {
  const known = Math.max(0, Math.round(Number(reviewedKanji) || 0));
  const level = normalizeTargetJlpt(target) || 'N5';
  const needed = JLPT_KANJI_TARGETS[level];
  const rawRate = Number(weeklyGoal);
  const rate = Math.max(WEEKLY_RATE_FLOOR, Number.isFinite(rawRate) ? rawRate : DEFAULT_WEEKLY_GOAL);
  const remaining = Math.max(0, needed - known);
  const weeks = Math.ceil(remaining / rate);
  const confidence = Math.max(0, Math.min(1, (known - 25) / 125));
  return { level, weeks, confidence, remainingKanji: remaining, weeklyRate: rate };
}

function generateMicroGoals(targetJlpt, currentLevel, { today } = {}) {
  const target = normalizeTargetJlpt(targetJlpt) || (JLPT_LEVELS.includes(currentLevel) ? currentLevel : 'N5');
  const reference = today ? new Date(today) : new Date();
  // Coming Sunday (or today when it already is Sunday), ISO date.
  const daysUntilSunday = (7 - (reference.getUTCDay() || 7)) % 7;
  const deadline = new Date(reference.getTime() + daysUntilSunday * 86400000).toISOString().slice(0, 10);
  return [
    { type: 'kanji', count: 5, level: target, deadline },
    { type: 'vocabulary', count: 10, level: target, deadline },
    { type: 'grammar', count: 2, level: target, deadline }
  ];
}

// ---------------------------------------------------------------- storage

const DEFAULT_ROW = {
  weeklyGoal: DEFAULT_WEEKLY_GOAL,
  targetJlpt: null,
  autoAdjust: true,
  graceDays: 1,
  preferences: {}
};

function rowToState(row) {
  if (!row) return { ...DEFAULT_ROW, preferences: {} };
  return {
    weeklyGoal: Number(row.weekly_goal) || DEFAULT_WEEKLY_GOAL,
    targetJlpt: row.target_jlpt || null,
    autoAdjust: row.auto_adjust !== false && row.auto_adjust !== 0,
    graceDays: Number.isInteger(Number(row.grace_days)) ? Number(row.grace_days) : 1,
    preferences: row.preferences_json && typeof row.preferences_json === 'object' && !Array.isArray(row.preferences_json)
      ? { ...row.preferences_json }
      : {}
  };
}

async function getSmartGoalRow(executor, userId) {
  const [rows] = await executor.execute(
    'SELECT weekly_goal, target_jlpt, auto_adjust, grace_days, preferences_json FROM user_smart_goals WHERE user_id = ?',
    [userId]
  );
  return rowToState(rows && rows[0]);
}

async function upsertSmartGoalRow(executor, userId, { weeklyGoal, targetJlpt, autoAdjust, graceDays, preferences }) {
  const state = {
    weeklyGoal: weeklyGoal === undefined ? undefined : normalizeWeeklyGoal(weeklyGoal),
    targetJlpt: targetJlpt === undefined ? undefined : normalizeTargetJlpt(targetJlpt),
    autoAdjust: autoAdjust === undefined ? undefined : normalizeAutoAdjust(autoAdjust),
    graceDays: graceDays === undefined ? undefined : normalizeGraceDays(graceDays)
  };
  const current = await getSmartGoalRow(executor, userId);
  const merged = {
    weeklyGoal: state.weeklyGoal === undefined ? current.weeklyGoal : state.weeklyGoal,
    targetJlpt: state.targetJlpt === undefined ? current.targetJlpt : state.targetJlpt,
    autoAdjust: state.autoAdjust === undefined ? current.autoAdjust : state.autoAdjust,
    graceDays: state.graceDays === undefined ? current.graceDays : state.graceDays,
    preferences: preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? { ...current.preferences, ...preferences }
      : current.preferences
  };
  await executor.execute(
    `INSERT INTO user_smart_goals (user_id, weekly_goal, target_jlpt, auto_adjust, grace_days, preferences_json)
     VALUES (?, ?, ?, ?, ?, ?::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       weekly_goal = EXCLUDED.weekly_goal,
       target_jlpt = EXCLUDED.target_jlpt,
       auto_adjust = EXCLUDED.auto_adjust,
       grace_days = EXCLUDED.grace_days,
       preferences_json = EXCLUDED.preferences_json,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, merged.weeklyGoal, merged.targetJlpt, merged.autoAdjust, merged.graceDays, JSON.stringify(merged.preferences)]
  );
  return merged;
}

// Activity data for the smart view: study-day dates (review events on the
// user's own items), weekly event counts for the last 4 ISO weeks, this
// week's count, and the user's kanji collection size. One bounded set of
// user-scoped queries, same ownership joins as listDifficultItems.
const ACTIVITY_EVENTS_SQL = `SELECT re.reviewed_at
  FROM review_events re
  JOIN review_items ri ON ri.id_review_item = re.id_review_item
  LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
  LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
  LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
  WHERE (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)`;

async function getActivitySnapshot(executor, userId) {
  const [eventRows] = await executor.execute(
    `${ACTIVITY_EVENTS_SQL} ORDER BY re.reviewed_at DESC LIMIT 500`,
    [userId, userId, userId, userId, userId, userId]
  );
  const dates = (eventRows || []).map((row) => String(row.reviewed_at || '').slice(0, 10));
  const [kanjiRows] = await executor.execute('SELECT COUNT(*) AS total FROM kanji WHERE user_id = ?', [userId]);
  return {
    dates,
    kanjiTotal: Number(kanjiRows?.[0]?.total || 0),
    weeklyCounts: weeklyBuckets(dates, 4)
  };
}

function weeklyBuckets(dates, weeks) {
  const buckets = Array.from({ length: weeks }, () => 0);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const date of dates) {
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const ageWeeks = Math.floor((todayUtc - time) / (7 * 86400000));
    if (ageWeeks >= 0 && ageWeeks < weeks) buckets[weeks - 1 - ageWeeks] += 1;
  }
  return buckets;
}

module.exports = {
  DEFAULT_WEEKLY_GOAL,
  JLPT_KANJI_TARGETS,
  adjustWeeklyGoal,
  checkStreak,
  generateMicroGoals,
  getActivitySnapshot,
  getSmartGoalRow,
  predictJlpt,
  upsertSmartGoalRow,
  weeklyBuckets
};
