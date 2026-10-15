const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { validateTodayField } = require('../validation');
const { sessionActiveMinutes } = require('../services/reviewMinutes');

// Sessions are stored with the browser's LOCAL date (native date inputs),
// while the DB clock is UTC: after ~20:00 local in UTC-4 the dashboard's
// CURRENT_DATE already pointed at tomorrow and evening sessions summed to 0.
// `?today=` anchors every window on the client's local date; absent param
// keeps the previous UTC behavior for API consumers.
function resolveToday(query) {
  return validateTodayField(query?.today);
}

async function getDashboard(req, res) {
  try {
    const today = resolveToday(req.query);
    const [rows] = await pool.query(`
      WITH user_sessions AS (SELECT id_session, session_date, category, duration_minutes FROM study_sessions WHERE user_id = ?),
      user_vocabulary AS (SELECT 1 FROM vocabulary WHERE user_id = ?),
      user_kanji AS (SELECT 1 FROM kanji WHERE user_id = ?),
      user_grammar AS (SELECT 1 FROM grammar_points WHERE user_id = ?),
      -- Reading study time counts toward daily/weekly minutes (V6.0): the
      -- reader accumulates real seconds per day in reading_study_days.
      reading_minutes AS (
        SELECT COALESCE(SUM(seconds) FILTER (WHERE day = COALESCE(?::date, CURRENT_DATE)), 0) / 60 AS today,
               COALESCE(SUM(seconds) FILTER (WHERE day >= date_trunc('week', COALESCE(?::date, CURRENT_DATE))::date AND day <= COALESCE(?::date, CURRENT_DATE)), 0) / 60 AS week
        FROM reading_study_days WHERE user_id = ?
      ),
      -- Completed review sessions count too, with no session rows created:
      -- active grading minutes (gaps capped, see reviewMinutes) attributed
      -- to the completion day, so manual logging keeps its purpose.
      review_minutes AS (
        SELECT COALESCE(SUM(active) FILTER (WHERE completed_day = COALESCE(?::date, CURRENT_DATE)), 0) AS today,
               COALESCE(SUM(active) FILTER (WHERE completed_day >= date_trunc('week', COALESCE(?::date, CURRENT_DATE))::date AND completed_day <= COALESCE(?::date, CURRENT_DATE)), 0) AS week
        FROM (
          SELECT rs.completed_at::date AS completed_day, ${sessionActiveMinutes('rs')} AS active
          FROM review_sessions rs WHERE rs.user_id = ? AND rs.completed_at IS NOT NULL
        ) per_session
      )
      SELECT
        COALESCE((SELECT SUM(duration_minutes) FROM user_sessions WHERE session_date = COALESCE(?::date, CURRENT_DATE)), 0)
          + COALESCE((SELECT today FROM reading_minutes), 0) + COALESCE((SELECT today FROM review_minutes), 0) AS minutes_today,
        COALESCE((SELECT SUM(duration_minutes) FROM user_sessions WHERE session_date >= date_trunc('week', COALESCE(?::date, CURRENT_DATE))::date AND session_date <= COALESCE(?::date, CURRENT_DATE)), 0)
          + COALESCE((SELECT week FROM reading_minutes), 0) + COALESCE((SELECT week FROM review_minutes), 0) AS minutes_week,
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
    `, [req.user.id, req.user.id, req.user.id, req.user.id, today, today, today, req.user.id, today, today, today, req.user.id, today, today, today, today, today]);
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
    const [[dateRows], [calendarRows], [readingDayRows], [readingCalendarRows], [reviewDayRows], [reviewCalendarRows]] = await Promise.all([
      pool.query("SELECT to_char(session_date, 'YYYY-MM-DD') AS date FROM study_sessions WHERE user_id = ? GROUP BY session_date ORDER BY session_date ASC", [req.user.id]),
      pool.query("SELECT to_char(session_date, 'YYYY-MM-DD') AS date, SUM(duration_minutes) AS minutes FROM study_sessions WHERE user_id = ? AND session_date BETWEEN ?::date AND ?::date GROUP BY session_date ORDER BY session_date ASC", [req.user.id, shiftDays(today, -34), today]),
      // Reading counts toward streaks only on days with 5+ minutes (300s):
      // skimming for seconds must not keep a streak alive.
      pool.query("SELECT to_char(day, 'YYYY-MM-DD') AS date FROM reading_study_days WHERE user_id = ? AND seconds >= 300 GROUP BY day ORDER BY day ASC", [req.user.id]).catch(() => [[]]),
      pool.query("SELECT to_char(day, 'YYYY-MM-DD') AS date, SUM(seconds) / 60 AS minutes FROM reading_study_days WHERE user_id = ? AND day BETWEEN ?::date AND ?::date GROUP BY day ORDER BY day ASC", [req.user.id, shiftDays(today, -34), today]).catch(() => [[]]),
      // Any completed review session keeps the streak: finishing reviews is
      // real study time even without a manually logged session.
      pool.query("SELECT to_char(completed_at, 'YYYY-MM-DD') AS date FROM review_sessions WHERE user_id = ? AND completed_at IS NOT NULL GROUP BY date ORDER BY date ASC", [req.user.id]).catch(() => [[]]),
      pool.query(`SELECT to_char(completed_day, 'YYYY-MM-DD') AS date, SUM(active) AS minutes FROM (
          SELECT rs.completed_at::date AS completed_day, ${sessionActiveMinutes('rs')} AS active
          FROM review_sessions rs WHERE rs.user_id = ? AND rs.completed_at IS NOT NULL AND rs.completed_at::date BETWEEN ?::date AND ?::date
        ) per_session GROUP BY completed_day ORDER BY completed_day ASC`, [req.user.id, shiftDays(today, -34), today]).catch(() => [[]])
    ]);
    const readingByDate = new Map((readingCalendarRows || []).map((row) => [isoDate(row.date), Number(row.minutes || 0)]));
    const reviewByDate = new Map((reviewCalendarRows || []).map((row) => [isoDate(row.date), Number(row.minutes || 0)]));
    const dates = [...new Set([...dateRows.map((row) => isoDate(row.date)), ...readingDayRows.map((row) => isoDate(row.date)), ...reviewDayRows.map((row) => isoDate(row.date))])].sort();
    const active = new Set(dates);
    let currentStreak = 0;
    for (let day = dayNumber(today); active.has(new Date(day * 86400000).toISOString().slice(0, 10)); day -= 1) currentStreak += 1;
    let longestStreak = 0; let running = 0; let previous = null;
    dates.forEach((date) => { running = previous !== null && dayNumber(date) === previous + 1 ? running + 1 : 1; longestStreak = Math.max(longestStreak, running); previous = dayNumber(date); });
    const sessionByDate = new Map((calendarRows || []).map((row) => [isoDate(row.date), Number(row.minutes || 0)]));
    for (const [date, minutes] of readingByDate) {
      sessionByDate.set(date, (sessionByDate.get(date) || 0) + minutes);
    }
    for (const [date, minutes] of reviewByDate) {
      sessionByDate.set(date, (sessionByDate.get(date) || 0) + minutes);
    }
    return res.json({
      currentStreak,
      longestStreak,
      calendar: [...sessionByDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, minutes]) => ({ date, minutes }))
    });
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
        COALESCE((SELECT SUM(duration_minutes) FROM study_sessions WHERE user_id = ? AND session_date = COALESCE(?::date, CURRENT_DATE)), 0)
          + COALESCE((SELECT SUM(seconds) / 60 FROM reading_study_days WHERE user_id = ? AND day = COALESCE(?::date, CURRENT_DATE)), 0)
          + COALESCE((SELECT SUM(active) FROM (SELECT ${sessionActiveMinutes('rs')} AS active FROM review_sessions rs WHERE rs.user_id = ? AND rs.completed_at IS NOT NULL AND rs.completed_at::date = COALESCE(?::date, CURRENT_DATE)) per_session), 0) AS minutes_today,
        (SELECT COUNT(*) FROM vocabulary WHERE user_id = ?) AS vocabulary_count,
        (SELECT COUNT(*) FROM kanji WHERE user_id = ?) AS kanji_count,
        (SELECT COUNT(*) FROM grammar_points WHERE user_id = ?) AS grammar_count,
        (SELECT COUNT(*) FROM vocabulary WHERE user_id = ? AND created_at::date = COALESCE(?::date, CURRENT_DATE)) +
        (SELECT COUNT(*) FROM kanji WHERE user_id = ? AND created_at::date = COALESCE(?::date, CURRENT_DATE)) +
        (SELECT COUNT(*) FROM grammar_points WHERE user_id = ? AND created_at::date = COALESCE(?::date, CURRENT_DATE))
        AS new_items_today
    `, [userId, userId, userId, userId, today, userId, today, userId, today, userId, userId, userId, userId, today, userId, today, userId, today]);
    const [[difficultRows], [readingRows], [sampleRows], [gradedRows], [openRows]] = await Promise.all([
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
        SELECT rt.id_reading_text AS id, rt.title AS title,
          p.position AS position, p.time_spent_seconds AS "timeSpentSeconds"
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
      `, [userId, userId, userId]).catch(() => [[], []]),
      // Reviews graded today (any session or none): events joined to owned
      // entities only, so other users' reviews can never inflate the count.
      pool.query(`
        SELECT COUNT(*) AS graded_today
        FROM review_events re
        JOIN review_items ri ON ri.id_review_item = re.id_review_item
        LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
        LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
        LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
        WHERE re.reviewed_at::date = COALESCE(?::date, CURRENT_DATE)
          AND (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)
      `, [userId, userId, userId, today, userId, userId, userId]).catch(() => [[], []]),
      // Open (uncompleted) review sessions with persisted queues, newest
      // first. Remaining = queued − graded-in-session (floored at 0 below);
      // sessions with nothing left are not resumable and get filtered out.
      pool.query(`
        SELECT rs.id_review_session AS id, rs.source_from AS "sourceFrom", rs.source_to AS "sourceTo",
          rs.started_at AS "startedAt",
          (SELECT COUNT(*) FROM review_session_items si WHERE si.id_review_session = rs.id_review_session) AS total,
          (SELECT COUNT(*) FROM review_events re WHERE re.id_review_session = rs.id_review_session) AS graded
        FROM review_sessions rs
        WHERE rs.user_id = ? AND rs.completed_at IS NULL
        ORDER BY rs.started_at DESC, rs.id_review_session DESC LIMIT 3
      `, [userId]).catch(() => [[], []])
    ]);
    // Reading progress may fail on older/back-compat schemas — fail open to null.
    let incompleteReading = null;
    try {
      const row = Array.isArray(readingRows) ? readingRows[0] : readingRows?.rows?.[0];
      const list = Array.isArray(readingRows) ? readingRows : [];
      const first = list[0] || row;
      if (first && first.id !== undefined) incompleteReading = {
        id: first.id,
        title: first.title || 'Untitled text',
        position: Number(first.position || 0) || null,
        timeSpentSeconds: Number(first.timeSpentSeconds || 0) || null
      };
    } catch { incompleteReading = null; }
    // Genuinely resumable review work only: open sessions whose persisted
    // queue still has ungraded items. Fully-graded-but-uncompleted sessions
    // are not offered (finishing happens inside Review, not from Home).
    let openReviewSession = null;
    try {
      const sessions = Array.isArray(openRows) ? openRows : [];
      for (const session of sessions) {
        const total = Number(session?.total || 0);
        const graded = Number(session?.graded || 0);
        const remaining = Math.max(0, total - graded);
        if (total > 0 && remaining > 0) {
          openReviewSession = {
            id: Number(session.id),
            remaining,
            total,
            sourceFrom: session.sourceFrom ? String(session.sourceFrom).slice(0, 10) : null,
            sourceTo: session.sourceTo ? String(session.sourceTo).slice(0, 10) : null
          };
          break;
        }
      }
    } catch { openReviewSession = null; }
    const gradedToday = (() => {
      try {
        const rows = Array.isArray(gradedRows) ? gradedRows : [];
        return Number(rows[0]?.graded_today || rows[0]?.gradedToday || 0);
      } catch { return 0; }
    })();
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
      signals: { dueCount, dueBreakdown: { vocabulary: dueVocabulary, kanji: dueKanji, grammar: dueGrammar }, dueSample, difficultCount, minutesToday, vocabularyCount, kanjiCount, grammarCount, incompleteReading },
      todayProgress: {
        reviewsDone: gradedToday,
        reviewsDue: dueCount,
        readingMinutes: minutesToday,
        newItems: Number(snapshot?.new_items_today || 0)
      },
      continueStudying: {
        reading: incompleteReading,
        reviewSession: openReviewSession
      }
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load study recommendation.' });
  }
}

// New-items drill-down: what the "N new items today" row counts, split by
// category (display/reading/meaning, newest first, 30 each). Same
// created_at::date predicate + ?today= anchoring as the count, so the
// dialog can never disagree with the row.
const NEW_ITEMS_LIMIT = 30;
async function getNewItems(req, res) {
  try {
    const today = resolveToday(req.query);
    const userId = req.user.id;
    const [[vocabulary], [kanji], [grammar]] = await Promise.all([
      pool.query(
        'SELECT word AS display, reading, meaning FROM vocabulary WHERE user_id = ? AND created_at::date = COALESCE(?::date, CURRENT_DATE) ORDER BY id_vocabulary DESC LIMIT ?',
        [userId, today, NEW_ITEMS_LIMIT]
      ),
      pool.query(
        'SELECT character_kanji AS display, NULL AS reading, meaning FROM kanji WHERE user_id = ? AND created_at::date = COALESCE(?::date, CURRENT_DATE) ORDER BY id_kanji DESC LIMIT ?',
        [userId, today, NEW_ITEMS_LIMIT]
      ),
      pool.query(
        'SELECT grammar_point AS display, NULL AS reading, meaning FROM grammar_points WHERE user_id = ? AND created_at::date = COALESCE(?::date, CURRENT_DATE) ORDER BY id_grammar DESC LIMIT ?',
        [userId, today, NEW_ITEMS_LIMIT]
      )
    ]);
    const clean = (rows) => (Array.isArray(rows) ? rows : []).map((row) => ({
      display: row.display,
      reading: row.reading || null,
      meaning: row.meaning || null
    }));
    return res.json({ vocabulary: clean(vocabulary), kanji: clean(kanji), grammar: clean(grammar) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load new items.' });
  }
}

module.exports = { getDashboard, getActivity, getStudyNow, getNewItems };
