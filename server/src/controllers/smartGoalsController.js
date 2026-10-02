// V5.3a Smart Goals endpoints. Deliberate deviation from the V5.3a prompt:
// goalsController.js / routes/goals.js did not exist (manual goal CRUD lives
// in the v2 router), so these are NEW files; the smart endpoints coexist with
// /api/goals (v2 CRUD) because Express falls through to this router for the
// /smart* paths only.

const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const {
  adjustWeeklyGoal,
  checkStreak,
  generateMicroGoals,
  getActivitySnapshot,
  getSmartGoalRow,
  predictJlpt,
  upsertSmartGoalRow
} = require('../services/smartGoals');

async function getSmart(req, res) {
  try {
    const state = await getSmartGoalRow(pool, req.user.id);
    const snapshot = await getActivitySnapshot(pool, req.user.id);
    const streak = checkStreak(snapshot.dates, state.graceDays);
    const prediction = predictJlpt(snapshot.kanjiTotal, state.targetJlpt, { weeklyGoal: state.weeklyGoal });
    const microGoals = generateMicroGoals(state.targetJlpt, prediction.level);
    return res.json({
      weeklyGoal: state.weeklyGoal,
      weeklyProgress: snapshot.weeklyCounts[snapshot.weeklyCounts.length - 1] || 0,
      last4Weeks: snapshot.weeklyCounts,
      streak: streak.streak,
      graceUsed: streak.graceUsed,
      prediction,
      microGoals,
      preferences: { autoAdjust: state.autoAdjust, graceDays: state.graceDays, targetJlpt: state.targetJlpt }
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load smart goals.' });
  }
}

async function putPreferences(req, res) {
  try {
    const body = req.body || {};
    const allowed = ['autoAdjust', 'graceDays', 'targetJlpt'];
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new ValidationError(`Unexpected field(s): ${unknown.join(', ')}.`);
    const saved = await upsertSmartGoalRow(pool, req.user.id, body);
    return res.json({
      preferences: { autoAdjust: saved.autoAdjust, graceDays: saved.graceDays, targetJlpt: saved.targetJlpt }
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save smart goal preferences.' });
  }
}

async function postAdjust(req, res) {
  try {
    const state = await getSmartGoalRow(pool, req.user.id);
    const snapshot = await getActivitySnapshot(pool, req.user.id);
    const adjusted = adjustWeeklyGoal(state.weeklyGoal, snapshot.weeklyCounts);
    const saved = await upsertSmartGoalRow(pool, req.user.id, { weeklyGoal: adjusted });
    return res.json({
      previousGoal: state.weeklyGoal,
      weeklyGoal: saved.weeklyGoal,
      last4Weeks: snapshot.weeklyCounts,
      autoAdjust: state.autoAdjust
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to adjust the weekly goal.' });
  }
}

module.exports = { getSmart, postAdjust, putPreferences };
