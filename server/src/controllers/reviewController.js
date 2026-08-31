const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');

const INTERVALS = { Again: 1, Hard: 3, Good: 7 };

async function createReviewItem(executor, targetColumn, targetId) {
  await executor.execute(
    `INSERT INTO review_items (${targetColumn}, due_on, interval_days) VALUES (?, CURRENT_DATE, 0) ON CONFLICT (${targetColumn}) DO NOTHING`,
    [targetId]
  );
}

async function listDueReviews(req, res) {
  try {
    const [items] = await pool.execute(`SELECT ri.id_review_item, ri.due_on, ri.interval_days, ri.last_reviewed_at, ri.last_result,
      CASE WHEN ri.id_vocabulary IS NOT NULL THEN 'Vocabulary' WHEN ri.id_kanji IS NOT NULL THEN 'Kanji' ELSE 'Grammar' END AS item_type,
      COALESCE(v.word, k.character_kanji, g.grammar_point) AS title,
      COALESCE(v.meaning, k.meaning, g.meaning) AS meaning,
      v.reading
      FROM review_items ri
      LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary
      LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji
      LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar
      WHERE ri.due_on <= CURRENT_DATE
      ORDER BY ri.due_on ASC, ri.id_review_item ASC`);
    return res.json({ items });
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load reviews.' }); }
}

async function recordReview(req, res) {
  let connection;
  try {
    const id = parseIdParam(req, 'review item');
    const result = req.body?.result;
    if (!Object.hasOwn(INTERVALS, result)) throw new ValidationError('result must be Again, Hard, or Good.');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT id_review_item, interval_days FROM review_items WHERE id_review_item = ? FOR UPDATE', [id]);
    if (!rows[0]) { await connection.rollback(); connection.release(); connection = null; return res.status(404).json({ error: 'review item not found' }); }
    const previousInterval = Number(rows[0].interval_days || 0);
    const nextInterval = INTERVALS[result];
    await connection.execute('INSERT INTO review_events (id_review_item, reviewed_at, result, previous_interval_days, next_interval_days) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)', [id, result, previousInterval, nextInterval]);
    await connection.execute('UPDATE review_items SET due_on = CURRENT_DATE + ?, interval_days = ?, last_reviewed_at = CURRENT_TIMESTAMP, last_result = ? WHERE id_review_item = ?', [nextInterval, nextInterval, result, id]);
    await connection.commit(); connection.release(); connection = null;
    return res.json({ success: true, result, nextIntervalDays: nextInterval });
  } catch (error) {
    if (connection) { await connection.rollback().catch(() => {}); connection.release(); }
    return sendRouteError(res, error, { defaultMessage: 'Unable to record review.' });
  }
}

module.exports = { createReviewItem, listDueReviews, recordReview };
