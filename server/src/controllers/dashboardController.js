const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');

async function getDashboard(req, res) {
  try {
    const [todayData] = await pool.query(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS minutes_today FROM study_sessions WHERE session_date = CURDATE()'
    );
    const [weekData] = await pool.query(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS minutes_week FROM study_sessions WHERE YEARWEEK(session_date, 1) = YEARWEEK(CURDATE(), 1)'
    );
    const [vocabularyCount] = await pool.query('SELECT COUNT(*) AS total FROM vocabulary');
    const [kanjiCount] = await pool.query('SELECT COUNT(*) AS total FROM kanji');
    const [grammarCount] = await pool.query('SELECT COUNT(*) AS total FROM grammar_points');
    const [recentSessions] = await pool.query(
      'SELECT id_session, session_date, category, duration_minutes FROM study_sessions ORDER BY session_date DESC, id_session DESC LIMIT 5'
    );
    const [weeklyActivity] = await pool.query(
      'SELECT session_date AS date, SUM(duration_minutes) AS minutes FROM study_sessions WHERE session_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND CURDATE() GROUP BY session_date ORDER BY session_date'
    );
    const [studyDistribution] = await pool.query(
      'SELECT category, SUM(duration_minutes) AS minutes FROM study_sessions GROUP BY category ORDER BY minutes DESC'
    );

    return res.json({
      minutesToday: Number(todayData[0]?.minutes_today || 0),
      minutesThisWeek: Number(weekData[0]?.minutes_week || 0),
      vocabularyCount: Number(vocabularyCount[0]?.total || 0),
      kanjiCount: Number(kanjiCount[0]?.total || 0),
      grammarCount: Number(grammarCount[0]?.total || 0),
      recentSessions: recentSessions || [],
      weeklyActivity: weeklyActivity || [],
      studyDistribution: studyDistribution || []
    });
  } catch (error) {
    return sendRouteError(res, error, {
      defaultStatus: 503,
      defaultMessage: 'Database unavailable'
    });
  }
}

module.exports = { getDashboard };
