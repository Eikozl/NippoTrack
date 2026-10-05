// Weekly insights engine: one honest document per user per ISO week built
// from the user's own review evidence. Week ranges are UTC Monday-to-Sunday;
// accuracy uses Good/total per entity type; weaknesses need a minimum sample
// so tiny weeks stay quiet instead of alarming. Reuses the smart-goals math
// (streak with grace, JLPT prediction, micro-goals) instead of reinventing it.
const {
  adjustWeeklyGoal,
  checkStreak,
  generateMicroGoals,
  getActivitySnapshot,
  getSmartGoalRow,
  predictJlpt
} = require('./smartGoals');

const WEAKNESS_ACCURACY = 0.6;
const MIN_SAMPLE = 5;
const STRENGTH_ACCURACY = 0.8;
const ANOMALY_DROP_RATIO = 0.5;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

// Monday (UTC) of ISO week 1 is the Monday of the week containing Jan 4.
function mondayOfIsoWeek(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4.getTime() + ((week - 1) * 7 - jan4Dow) * 86400000);
  return monday;
}

function parseWeekKey(value) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(value || '').trim());
  if (!match) throw new Error(`Invalid week key (expected YYYY-Www): ${value}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new Error(`Invalid week key (expected YYYY-Www): ${value}`);
  const start = mondayOfIsoWeek(year, week);
  // Reject phantom week 53 when the year only has 52 (round-trip check).
  const roundTrip = mondayOfIsoWeek(year, week);
  const thursday = new Date(roundTrip.getTime() + 3 * 86400000);
  const thursdayYear = thursday.getUTCFullYear();
  if (thursdayYear !== year) throw new Error(`Invalid week key (expected YYYY-Www): ${value}`);
  const end = new Date(start.getTime() + 6 * 86400000);
  return { key: `${year}-W${String(week).padStart(2, '0')}`, weekStart: isoDate(start), weekEnd: isoDate(end) };
}

function currentWeekKey(now = new Date()) {
  const moment = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  moment.setUTCDate(moment.getUTCDate() + 4 - (moment.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(moment.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((moment - yearStart) / 86400000 + 1) / 7);
  return parseWeekKey(`${moment.getUTCFullYear()}-W${String(week).padStart(2, '0')}`).key;
}

function dayAfter(isoDay) {
  return isoDate(new Date(new Date(`${isoDay}T00:00:00Z`).getTime() + 86400000));
}

function weekBefore(weekStart) {
  const start = new Date(`${weekStart}T00:00:00Z`).getTime() - 7 * 86400000;
  const prevStart = isoDate(new Date(start));
  return { prevStart, prevEndExclusive: weekStart };
}

// A DATE string for `session_date` columns stays a bare date; timestamps
// (review_events.reviewed_at, review_sessions.started_at) need the CLIENT's
// local midnights as UTC instants. tzOffsetMinutes is browser
// getTimezoneOffset() (UTC - local, e.g. 240 for UTC-4). Falsy/0 keeps the
// legacy bare-date params (UTC midnight), byte-identical for API consumers
// and tests that don't send an offset.
function boundaryDate(isoDay, tzOffsetMinutes) {
  if (!tzOffsetMinutes) return isoDay;
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + tzOffsetMinutes * 60000).toISOString();
}

// One bounded user-scoped event pull, same ownership joins as the smart
// activity snapshot. [fromInclusive, toExclusive) are UTC ISO dates.
const WEEK_EVENTS_SQL = `SELECT re.reviewed_at, re.result,
    CASE WHEN ri.id_vocabulary IS NOT NULL THEN 'vocabulary'
      WHEN ri.id_kanji IS NOT NULL THEN 'kanji' ELSE 'grammar' END AS entity_type
  FROM review_events re
  JOIN review_items ri ON ri.id_review_item = re.id_review_item
  LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
  LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
  LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
  WHERE (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)
    AND re.reviewed_at >= ? AND re.reviewed_at < ?`;

async function fetchWeekEvents(executor, userId, fromInclusive, toExclusive) {
  const [rows] = await executor.execute(WEEK_EVENTS_SQL, [userId, userId, userId, userId, userId, userId, fromInclusive, toExclusive]);
  return Array.isArray(rows) ? rows : [];
}

function accuracyByType(events) {
  const kinds = ['vocabulary', 'kanji', 'grammar'];
  const stats = {};
  for (const kind of kinds) stats[kind] = { total: 0, good: 0 };
  for (const event of events) {
    const kind = kinds.includes(event?.entity_type) ? event.entity_type : null;
    if (!kind) continue;
    stats[kind].total += 1;
    if (String(event?.result || '').toLowerCase() === 'good') stats[kind].good += 1;
  }
  for (const kind of kinds) {
    stats[kind].accuracy = stats[kind].total ? stats[kind].good / stats[kind].total : null;
  }
  return stats;
}

async function generateWeeklyInsights(executor, userId, { weekStart, weekEnd, now = new Date(), tzOffsetMinutes = 0, today = null }) {
  if (!userId) throw new Error('generateWeeklyInsights requires a userId.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd || '')) {
    throw new Error('generateWeeklyInsights requires ISO weekStart/weekEnd dates.');
  }
  const fromInstant = boundaryDate(weekStart, tzOffsetMinutes);
  const toInstant = boundaryDate(dayAfter(weekEnd), tzOffsetMinutes);
  const toExclusive = dayAfter(weekEnd);
  const [events, prev, minutesRows, sessionsRows, snapshot, goals] = await Promise.all([
    fetchWeekEvents(executor, userId, fromInstant, toInstant),
    (() => {
      const { prevStart } = weekBefore(weekStart);
      return fetchWeekEvents(executor, userId, boundaryDate(prevStart, tzOffsetMinutes), fromInstant);
    })(),
    executor.execute(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS minutes FROM study_sessions WHERE user_id = ? AND session_date >= ? AND session_date <= ?',
      [userId, weekStart, weekEnd]
    ).then(([rows]) => rows),
    executor.execute(
      'SELECT COUNT(*) AS completed FROM review_sessions WHERE user_id = ? AND started_at >= ? AND started_at < ? AND completed_at IS NOT NULL',
      [userId, fromInstant, toInstant]
    ).then(([rows]) => rows),
    getActivitySnapshot(executor, userId),
    getSmartGoalRow(executor, userId)
  ]);

  const totalReviews = events.length;
  const prevTotal = prev.length;
  const totalMinutes = Number(minutesRows?.[0]?.minutes || 0);
  const completedSessions = Number(sessionsRows?.[0]?.completed || 0);
  const streak = checkStreak(snapshot.dates, goals.graceDays);

  const byType = accuracyByType(events);
  const strengths = [];
  const weaknesses = [];
  for (const [kind, stat] of Object.entries(byType)) {
    if (stat.total < MIN_SAMPLE || stat.accuracy === null) continue;
    const value = Math.round(stat.accuracy * 100) / 100;
    if (stat.accuracy >= STRENGTH_ACCURACY) {
      strengths.push({ metric: `${kind}_accuracy`, value, label: `${stat.total} ${kind} reviews at ${Math.round(stat.accuracy * 100)}%` });
    } else if (stat.accuracy < WEAKNESS_ACCURACY) {
      weaknesses.push({
        metric: `${kind}_accuracy`,
        value,
        label: `${kind} accuracy is ${Math.round(stat.accuracy * 100)}% over ${stat.total} reviews`,
        suggestion: `Add focused ${kind} reviews to this week's practice.`
      });
    }
  }

  const anomalies = [];
  // Only compare settled weeks: a fresh Monday (or a week that just rolled
  // over) against a full previous week always looks like a collapse
  // (44 → 3 hours into the new week). In-progress weeks stay quiet.
  // `today` is the client's local date when provided (local week model);
  // without it the UTC date of `now` decides.
  const referenceDay = today || isoDate(new Date(now));
  const weekComplete = weekEnd < referenceDay;
  if (weekComplete && prevTotal >= MIN_SAMPLE && totalReviews < prevTotal * ANOMALY_DROP_RATIO) {
    anomalies.push({
      type: 'review_drop',
      severity: totalReviews === 0 ? 'high' : 'medium',
      message: `Reviews fell from ${prevTotal} to ${totalReviews} vs last week (over 50% down).`
    });
  }
  if (prevTotal >= MIN_SAMPLE && totalReviews > 0 && streak.streak === 0) {
    anomalies.push({ type: 'streak_stalled', severity: 'medium', message: 'No active study streak despite recent activity last week.' });
  }

  const prediction = predictJlpt(snapshot.kanjiTotal, goals.targetJlpt, { weeklyGoal: goals.weeklyGoal });
  const microGoals = generateMicroGoals(goals.targetJlpt, prediction.level);
  const weeklyGoal = {
    current: goals.weeklyGoal,
    progress: snapshot.weeklyCounts[snapshot.weeklyCounts.length - 1] || 0,
    last4Weeks: snapshot.weeklyCounts,
    suggested: adjustWeeklyGoal(goals.weeklyGoal, snapshot.weeklyCounts)
  };

  let weekKey = null;
  try {
    weekKey = weekKeyFor(weekStart);
  } catch { /* week label is best-effort */ }

  return {
    week: weekKey,
    weekStart,
    weekEnd,
    summary: {
      totalMinutes,
      totalReviews,
      completedSessions,
      streak: streak.streak,
      graceUsed: streak.graceUsed
    },
    strengths,
    weaknesses,
    predictions: { jlpt: prediction, weeklyGoal },
    microGoals,
    anomalies
  };
}

// ISO week key for a Monday date (the stored week_start is always a Monday).
function weekKeyFor(mondayIso) {
  const monday = new Date(`${mondayIso}T00:00:00Z`);
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4.getTime() - jan4Dow * 86400000);
  const week = Math.round((monday - week1Monday) / (7 * 86400000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

async function getCachedInsight(executor, userId, weekStart) {
  const [rows] = await executor.execute(
    'SELECT insights_json, generated_at FROM weekly_insights WHERE user_id = ? AND week_start = ?',
    [userId, weekStart]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return { insights: row.insights_json, generatedAt: row.generated_at };
}

// A cached week is stale when the user graded anything inside that week
// AFTER the doc was generated (reviewed_at is CURRENT_TIMESTAMP, so only
// the in-progress week can ever go stale; completed weeks stay cached).
// Same ownership joins as WEEK_EVENTS_SQL — strictly user-scoped.
const REVIEWS_SINCE_SQL = `SELECT MAX(re.reviewed_at) AS last_at
  FROM review_events re
  JOIN review_items ri ON ri.id_review_item = re.id_review_item
  LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
  LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
  LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
  WHERE (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)
    AND re.reviewed_at >= ? AND re.reviewed_at < ? AND re.reviewed_at > ?`;

async function hasReviewsSince(executor, userId, { weekStart, weekEnd, since, tzOffsetMinutes = 0 }) {
  const [rows] = await executor.execute(
    REVIEWS_SINCE_SQL,
    [
      userId, userId, userId, userId, userId, userId,
      boundaryDate(weekStart, tzOffsetMinutes),
      boundaryDate(dayAfter(weekEnd), tzOffsetMinutes),
      since
    ]
  );
  return Boolean(rows?.[0]?.last_at);
}

async function saveCachedInsight(executor, userId, weekStart, insights) {
  await executor.execute(
    `INSERT INTO weekly_insights (user_id, week_start, insights_json)
     VALUES (?, ?, ?::jsonb)
     ON CONFLICT (user_id, week_start) DO UPDATE SET insights_json = EXCLUDED.insights_json, generated_at = CURRENT_TIMESTAMP`,
    [userId, weekStart, JSON.stringify(insights)]
  );
}

module.exports = {
  ANOMALY_DROP_RATIO,
  MIN_SAMPLE,
  STRENGTH_ACCURACY,
  WEAKNESS_ACCURACY,
  boundaryDate,
  currentWeekKey,
  dayAfter,
  generateWeeklyInsights,
  getCachedInsight,
  hasReviewsSince,
  parseWeekKey,
  saveCachedInsight,
  weekKeyFor
};
