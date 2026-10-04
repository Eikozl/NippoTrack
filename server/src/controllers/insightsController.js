// Weekly insights endpoints: cached per (user, ISO week), generated on
// demand from the user's own review evidence. Regeneration overwrites.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const {
  currentWeekKey,
  generateWeeklyInsights,
  getCachedInsight,
  parseWeekKey,
  saveCachedInsight
} = require('../services/weeklyInsights');

function resolveWeek(query) {
  const raw = query?.week;
  if (raw === undefined || raw === null || raw === '') return parseWeekKey(currentWeekKey());
  try {
    return parseWeekKey(raw);
  } catch {
    throw new ValidationError(`Invalid week (expected YYYY-Www): ${raw}.`);
  }
}

async function loadWeek(userId, range, { force = false } = {}) {
  if (!force) {
    const cached = await getCachedInsight(pool, userId, range.weekStart);
    if (cached) return { ...cached.insights, cached: true, generatedAt: cached.generatedAt };
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
