const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');

// Sessions are stored with the browser's LOCAL date (native date inputs),
// while the DB clock is UTC: after ~20:00 local in UTC-4 the dashboard's
// CURRENT_DATE already pointed at tomorrow and evening sessions summed to 0.
// `?today=` anchors every window on the client's local date; absent param
// keeps the previous UTC behavior for API consumers.
function resolveToday(query) {
  const raw = query?.today;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError('today must be a YYYY-MM-DD date.');
  }
  return value;
}

async function getDashboard(req, res) {
  try {
    const today = resolveToday(req.query);
    const [rows] = await pool.query(`
      WITH user_sessions AS (SELECT id_session, session_date, category, duration_minutes FROM study_sessions WHERE user_id = ?),
      user_vocabulary AS (SELECT 1 FROM vocabulary WHERE user_id = ?),
      user_kanji AS (SELECT 1 FROM kanji WHERE user_id = ?),
      user_grammar AS (SELECT 1 FROM grammar_points WHERE user_id = ?)
      SELECT
        COALESCE((SELECT SUM(duration_minutes) FROM user_sessions WHERE session_date = COALESCE(?::date, CURRENT_DATE)), 0) AS minutes_today,
        COALESCE((SELECT SUM(duration_minutes) FROM user_sessions WHERE session_date >= date_trunc('week', COALESCE(?::date, CURRENT_DATE))::date AND session_date <= COALESCE(?::date, CURRENT_DATE)), 0) AS minutes_week,
        (SELECT COUNT(*) FROM user_vocabulary) AS vocabulary_count,
        (SELECT COUNT(*) FROM user_kanji) AS kanji_count,
        (SELECT COUNT(*) FROM user_grammar) AS grammar_count,
        COALESCE((SELECT json_agg(row_to_json(recent)) FROM (
          SELECT id_session, session_date, category, duration_minutes
          FROM user_sessions ORDER BY session_date DESC, id_session DESC LIMIT 5
        ) recent), '[]'::json) AS recent_sessions,
        COALESCE((SELECT json_agg(row_to_json(weekly) ORDER BY weekly.date) FROM (
          SELECT session_date AS date, SUM(duration_minutes) AS minutes
          FROM user_sessions WHERE session_date BETWEEN COALESCE(?::date, CURRENT_DATE) - 6 AND COALESCE(?::date, CURRENT_DATE)
          GROUP BY session_date ORDER BY session_date
        ) weekly), '[]'::json) AS weekly_activity,
        COALESCE((SELECT json_agg(row_to_json(distribution) ORDER BY distribution.minutes DESC) FROM (
          SELECT category, SUM(duration_minutes) AS minutes
          FROM user_sessions GROUP BY category ORDER BY minutes DESC
        ) distribution), '[]'::json) AS study_distribution
    `, [req.user.id, req.user.id, req.user.id, req.user.id, today, today, today, today, today]);
    const data = rows[0] || {};

    return res.json({
      minutesToday: Number(data.minutes_today || 0),
      minutesThisWeek: Number(data.minutes_week || 0),
      vocabularyCount: Number(data.vocabulary_count || 0),
      kanjiCount: Number(data.kanji_count || 0),
      grammarCount: Number(data.grammar_count || 0),
      recentSessions: data.recent_sessions || [],
      weeklyActivity: data.weekly_activity || [],
      studyDistribution: data.study_distribution || []
    });
  } catch (error) {
    return sendRouteError(res, error, {
      defaultStatus: 503,
      defaultMessage: 'Database unavailable'
    });
  }
}

function isoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dayNumber(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
}

function shiftDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

async function getActivity(req, res) {
  try {
    // Same local-date anchor as getDashboard: streak and calendar windows
    // follow the client's today, not the UTC server clock.
    let today = resolveToday(req.query);
    if (!today) {
      const [todayRows] = await pool.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today");
      today = isoDate(todayRows[0]?.today || new Date());
    }
    const [[dateRows], [calendarRows]] = await Promise.all([
      pool.query("SELECT to_char(session_date, 'YYYY-MM-DD') AS date FROM study_sessions WHERE user_id = ? GROUP BY session_date ORDER BY session_date ASC", [req.user.id]),
      pool.query("SELECT to_char(session_date, 'YYYY-MM-DD') AS date, SUM(duration_minutes) AS minutes FROM study_sessions WHERE user_id = ? AND session_date BETWEEN ?::date AND ?::date GROUP BY session_date ORDER BY session_date ASC", [req.user.id, shiftDays(today, -34), today])
    ]);
    const dates = dateRows.map((row) => isoDate(row.date));
    const active = new Set(dates);
    let currentStreak = 0;
    for (let day = dayNumber(today); active.has(new Date(day * 86400000).toISOString().slice(0, 10)); day -= 1) currentStreak += 1;
    let longestStreak = 0; let running = 0; let previous = null;
    dates.forEach((date) => { running = previous !== null && dayNumber(date) === previous + 1 ? running + 1 : 1; longestStreak = Math.max(longestStreak, running); previous = dayNumber(date); });
    return res.json({ currentStreak, longestStreak, calendar: calendarRows.map((row) => ({ date: isoDate(row.date), minutes: Number(row.minutes || 0) })) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load activity calendar.' });
  }
}

module.exports = { getDashboard, getActivity };
