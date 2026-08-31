const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');

async function getDashboard(req, res) {
  try {
    const [rows] = await pool.query(`
      WITH user_sessions AS (SELECT * FROM study_sessions WHERE user_id = ?),
      user_vocabulary AS (SELECT * FROM vocabulary WHERE user_id = ?),
      user_kanji AS (SELECT * FROM kanji WHERE user_id = ?),
      user_grammar AS (SELECT * FROM grammar_points WHERE user_id = ?)
      SELECT
        COALESCE((SELECT SUM(duration_minutes) FROM user_sessions WHERE session_date = CURRENT_DATE), 0) AS minutes_today,
        COALESCE((SELECT SUM(duration_minutes) FROM user_sessions WHERE session_date >= date_trunc('week', CURRENT_DATE)::date AND session_date <= CURRENT_DATE), 0) AS minutes_week,
        (SELECT COUNT(*) FROM user_vocabulary) AS vocabulary_count,
        (SELECT COUNT(*) FROM user_kanji) AS kanji_count,
        (SELECT COUNT(*) FROM user_grammar) AS grammar_count,
        COALESCE((SELECT json_agg(row_to_json(recent)) FROM (
          SELECT id_session, session_date, category, duration_minutes
          FROM user_sessions ORDER BY session_date DESC, id_session DESC LIMIT 5
        ) recent), '[]'::json) AS recent_sessions,
        COALESCE((SELECT json_agg(row_to_json(weekly) ORDER BY weekly.date) FROM (
          SELECT session_date AS date, SUM(duration_minutes) AS minutes
          FROM user_sessions WHERE session_date BETWEEN CURRENT_DATE - 6 AND CURRENT_DATE
          GROUP BY session_date ORDER BY session_date
        ) weekly), '[]'::json) AS weekly_activity,
        COALESCE((SELECT json_agg(row_to_json(distribution) ORDER BY distribution.minutes DESC) FROM (
          SELECT category, SUM(duration_minutes) AS minutes
          FROM user_sessions GROUP BY category ORDER BY minutes DESC
        ) distribution), '[]'::json) AS study_distribution
    `, [req.user.id, req.user.id, req.user.id, req.user.id]);
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

async function getActivity(req, res) {
  try {
    const [[todayRows], [dateRows], [calendarRows]] = await Promise.all([
      pool.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today"),
      pool.query("SELECT to_char(session_date, 'YYYY-MM-DD') AS date FROM study_sessions WHERE user_id = ? GROUP BY session_date ORDER BY session_date ASC", [req.user.id]),
      pool.query("SELECT to_char(session_date, 'YYYY-MM-DD') AS date, SUM(duration_minutes) AS minutes FROM study_sessions WHERE user_id = ? AND session_date BETWEEN CURRENT_DATE - 34 AND CURRENT_DATE GROUP BY session_date ORDER BY session_date ASC", [req.user.id])
    ]);
    const today = isoDate(todayRows[0]?.today || new Date());
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
