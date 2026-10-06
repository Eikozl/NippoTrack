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

// V5.6 Study Now — single deterministic recommendation reusing existing
// signals only. Read-only, bounded, user-scoped. No new tables, no ML.
// Rule order (explainable):
//   dueCount > 0            -> review (reason includes difficultCount)
//   incomplete reading      -> continue reading
//   no collection yet       -> analyze first text
//   minutesToday == 0       -> log a session / keep streak
//   else                    -> explore / read something new
async function getStudyNow(req, res) {
  try {
    const today = resolveToday(req.query);
    const userId = req.user.id;
    const [dueRows] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM review_items ri
          JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary
          WHERE ri.due_on <= CURRENT_DATE AND ri.id_vocabulary IS NOT NULL AND ri.id_kanji IS NULL AND ri.id_grammar IS NULL
            AND v.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)) AS due_vocabulary,
        (SELECT COUNT(*) FROM review_items ri
          JOIN kanji k ON k.id_kanji = ri.id_kanji
          WHERE ri.due_on <= CURRENT_DATE AND ri.id_kanji IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_grammar IS NULL
            AND k.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)) AS due_kanji,
        (SELECT COUNT(*) FROM review_items ri
          JOIN grammar_points g ON g.id_grammar = ri.id_grammar
          WHERE ri.due_on <= CURRENT_DATE AND ri.id_grammar IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_kanji IS NULL
            AND g.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)) AS due_grammar,
        COALESCE((SELECT SUM(duration_minutes) FROM study_sessions WHERE user_id = ? AND session_date = COALESCE(?::date, CURRENT_DATE)), 0) AS minutes_today,
        (SELECT COUNT(*) FROM vocabulary WHERE user_id = ?) AS vocabulary_count,
        (SELECT COUNT(*) FROM kanji WHERE user_id = ?) AS kanji_count,
        (SELECT COUNT(*) FROM grammar_points WHERE user_id = ?) AS grammar_count
    `, [userId, userId, userId, userId, today, userId, userId, userId]);
    const [[difficultRows], [readingRows], [sampleRows]] = await Promise.all([
      pool.query(`
        SELECT ri.id_review_item FROM review_items ri
        LEFT JOIN review_events re ON re.id_review_item = ri.id_review_item
        LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
        LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
        LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
        WHERE (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)
        GROUP BY ri.id_review_item
        HAVING COUNT(*) FILTER (WHERE re.result = 'Again') >= 2
        LIMIT 10
      `, [userId, userId, userId, userId, userId, userId]),
      pool.query(`
        SELECT rt.id_reading_text AS id, rt.title AS title
        FROM user_reading_progress p
        JOIN reading_texts rt ON rt.id_reading_text = p.text_id
        WHERE p.user_id = ? AND p.completed_at IS NULL
        ORDER BY p.updated_at DESC NULLS LAST, p.text_id DESC
        LIMIT 1
      `, [userId]).catch(() => [[], []]),
      // Due sample: oldest-first titles so Study Now can say WHAT is due.
      // Bounded (5) and user-scoped per branch, same predicate as the counts.
      pool.query(`
        SELECT title FROM (
          SELECT ri.due_on AS due_on, v.word AS title FROM review_items ri
          JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary
          WHERE ri.due_on <= CURRENT_DATE AND ri.id_vocabulary IS NOT NULL AND ri.id_kanji IS NULL AND ri.id_grammar IS NULL
            AND v.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)
          UNION ALL
          SELECT ri.due_on AS due_on, k.character_kanji AS title FROM review_items ri
          JOIN kanji k ON k.id_kanji = ri.id_kanji
          WHERE ri.due_on <= CURRENT_DATE AND ri.id_kanji IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_grammar IS NULL
            AND k.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)
          UNION ALL
          SELECT ri.due_on AS due_on, g.grammar_point AS title FROM review_items ri
          JOIN grammar_points g ON g.id_grammar = ri.id_grammar
          WHERE ri.due_on <= CURRENT_DATE AND ri.id_grammar IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_kanji IS NULL
            AND g.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)
        ) due_sample ORDER BY due_on ASC LIMIT 5
      `, [userId, userId, userId]).catch(() => [[], []])
    ]);
    // чтения may fail on older/back-compat schemas — fail open to null.
    let incompleteReading = null;
    try {
      const row = Array.isArray(readingRows) ? readingRows[0] : readingRows?.rows?.[0];
      const list = Array.isArray(readingRows) ? readingRows : [];
      const first = list[0] || row;
      if (first && first.id !== undefined) incompleteReading = { id: first.id, title: first.title || 'Untitled text' };
    } catch { incompleteReading = null; }
    const snapshot = Array.isArray(dueRows) ? dueRows[0] : {};
    const dueVocabulary = Number(snapshot?.due_vocabulary || 0);
    const dueKanji = Number(snapshot?.due_kanji || 0);
    const dueGrammar = Number(snapshot?.due_grammar || 0);
    const dueCount = dueVocabulary + dueKanji + dueGrammar;
    const dueSample = (Array.isArray(sampleRows) ? sampleRows : []).map((row) => row?.title).filter(Boolean).slice(0, 5);
    const minutesToday = Number(snapshot?.minutes_today || 0);
    const vocabularyCount = Number(snapshot?.vocabulary_count || 0);
    const kanjiCount = Number(snapshot?.kanji_count || 0);
    const grammarCount = Number(snapshot?.grammar_count || 0);
    const difficultCount = Array.isArray(difficultRows) ? difficultRows.length : 0;
    const collectionCount = vocabularyCount + kanjiCount + grammarCount;

    let primary;
    if (dueCount > 0) {
      const estimate = `~${Math.max(2, Math.min(60, Math.round(dueCount * 0.5)))} min`;
      const parts = [
        dueVocabulary ? `${dueVocabulary} word${dueVocabulary === 1 ? '' : 's'}` : null,
        dueKanji ? `${dueKanji} kanji` : null,
        dueGrammar ? `${dueGrammar} pattern${dueGrammar === 1 ? '' : 's'}` : null
      ].filter(Boolean);
      const reason = [
        `${parts.join(' · ')} ready to recall.`,
        difficultCount > 0 ? `Includes ${difficultCount} you've marked Again more than once.` : null,
        dueSample.length ? `Up first: ${dueSample.slice(0, 3).join(', ')}.` : null,
        'Short recall now saves re-study later.'
      ].filter(Boolean).join(' ');
      primary = {
        kind: 'review',
        title: `${dueCount} review${dueCount === 1 ? '' : 's'} due`,
        reason,
        estimate,
        // Auto-session: the client builds the queue from GET /api/review/due
        // (oldest first) and hands it to #review — no manual setup needed.
        cta: dueCount === 1 ? 'Start now — 1 item' : `Start now — ${dueCount} items`,
        href: '#review',
        auto: 'due'
      };
    } else if (incompleteReading) {
      primary = {
        kind: 'reading',
        title: 'Continue reading',
        reason: `Pick up where you left off in “${String(incompleteReading.title).slice(0, 80)}”.`,
        estimate: '~10 min',
        cta: 'Continue reading',
        href: `#reading?id=${encodeURIComponent(incompleteReading.id)}`
      };
    } else if (collectionCount === 0) {
      primary = {
        kind: 'analyze',
        title: 'Analyze your first text',
        reason: 'Paste Japanese you are reading. NippoTrack shows what you know and lets you save it.',
        estimate: '~5 min',
        cta: 'Open Analyzer',
        href: '#analyzer'
      };
    } else if (minutesToday === 0) {
      primary = {
        kind: 'session',
        title: 'Log today’s study',
        reason: 'No minutes recorded today yet. A short session keeps your streak alive.',
        estimate: '~5 min',
        cta: 'Log study session',
        href: '#sessions?new=1'
      };
    } else {
      primary = {
        kind: 'explore',
        title: 'Read something new',
        reason: 'Reviews are clear and today is logged. New input keeps encounters growing.',
        estimate: '~10 min',
        cta: 'Browse reading',
        href: '#reading'
      };
    }
    return res.json({
      primary,
      signals: { dueCount, dueBreakdown: { vocabulary: dueVocabulary, kanji: dueKanji, grammar: dueGrammar }, dueSample, difficultCount, minutesToday, vocabularyCount, kanjiCount, grammarCount, incompleteReading }
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load study recommendation.' });
  }
}

module.exports = { getDashboard, getActivity, getStudyNow };
