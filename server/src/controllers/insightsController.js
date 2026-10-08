// Weekly insights endpoints: cached per (user, ISO week), generated on
// demand from the user's own review evidence. Regeneration overwrites.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { validateTodayField } = require('../validation');
const {
  currentWeekKey,
  generateWeeklyInsights,
  getCachedInsight,
  hasReviewsSince,
  parseWeekKey,
  saveCachedInsight,
  weekKeyFor
} = require('../services/weeklyInsights');

// Local-week anchoring: the browser sends its calendar day (`today`) and
// getTimezoneOffset() (`tzOffset`, UTC - local). Without them the legacy
// UTC week applies. Sessions carry LOCAL dates, so the UTC week showed 0
// minutes from Sunday 20:00 local onward.
function resolveTodayLocal(query) {
  return validateTodayField(query?.today);
}

function resolveTzOffset(query) {
  const raw = query?.tzOffset;
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -840 || value > 840) {
    throw new ValidationError('tzOffset must be an integer between -840 and 840 minutes.');
  }
  return value;
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function mondayOf(iso) {
  const dow = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

function resolveWeek(query) {
  const today = resolveTodayLocal(query);
  const tzOffsetMinutes = resolveTzOffset(query);
  const raw = query?.week;
  if (raw !== undefined && raw !== null && raw !== '') {
    try {
      return { ...parseWeekKey(raw), today, tzOffsetMinutes };
    } catch {
      throw new ValidationError(`Invalid week (expected YYYY-Www): ${raw}.`);
    }
  }
  if (today) {
    const weekStart = mondayOf(today);
    return { key: weekKeyFor(weekStart), weekStart, weekEnd: addDays(weekStart, 6), today, tzOffsetMinutes };
  }
  return { ...parseWeekKey(currentWeekKey()), today, tzOffsetMinutes };
}

async function loadWeek(userId, range, { force = false } = {}) {
  if (!force) {
    const cached = await getCachedInsight(pool, userId, range.weekStart);
    // Cached docs go stale the moment a review lands after generation;
    // without this check the widget kept showing pre-review numbers forever.
    const stale = !cached?.generatedAt || await hasReviewsSince(pool, userId, {
      weekStart: range.weekStart,
      weekEnd: range.weekEnd,
      since: cached.generatedAt,
      tzOffsetMinutes: range.tzOffsetMinutes
    });
    if (cached && !stale) return { ...cached.insights, cached: true, generatedAt: cached.generatedAt };
  }
  const insights = await generateWeeklyInsights(pool, userId, range);
  await saveCachedInsight(pool, userId, range.weekStart, insights);
  return { ...insights, cached: false };
}

async function getWeekly(req, res) {
  try {
    const range = resolveWeek(req.query);
    const insights = await loadWeek(req.user.id, range);
    return res.json(insights);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load weekly insights.' });
  }
}

async function getHistory(req, res) {
  try {
    const weeks = Math.max(1, Math.min(12, Number(req.query?.weeks) || 8));
    const [rows] = await pool.execute(
      `SELECT week_start, insights_json, generated_at FROM weekly_insights
       WHERE user_id = ? ORDER BY week_start DESC LIMIT ?`,
      [req.user.id, weeks]
    );
    return res.json({
      weeks: (Array.isArray(rows) ? rows : []).map((row) => ({
        weekStart: row.week_start,
        insights: row.insights_json,
        generatedAt: row.generated_at
      }))
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load insights history.' });
  }
}

async function postGenerate(req, res) {
  try {
    const range = resolveWeek(req.query?.week !== undefined ? req.query : req.body);
    const insights = await loadWeek(req.user.id, range, { force: true });
    return res.json(insights);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to generate weekly insights.' });
  }
}

module.exports = { getHistory, getWeekly, postGenerate };
