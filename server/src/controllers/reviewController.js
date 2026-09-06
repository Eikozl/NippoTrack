const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam, isValidDateString, validateAllowedValues } = require('../validation');
const { getReviewCandidates } = require('../services/reviewCandidates');

const INTERVALS = { Again: 1, Hard: 3, Good: 7 };

async function createReviewItem(executor, targetColumn, targetId) {
  await executor.execute(
    `INSERT INTO review_items (${targetColumn}, due_on, interval_days) VALUES (?, CURRENT_DATE, 0) ON CONFLICT (${targetColumn}) DO NOTHING`,
    [targetId]
  );
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function dateDiffDays(from, to) {
  const [fromY, fromM, fromD] = from.split('-').map(Number);
  const [toY, toM, toD] = to.split('-').map(Number);
  const fromUtc = Date.UTC(fromY, fromM - 1, fromD);
  const toUtc = Date.UTC(toY, toM - 1, toD);
  return Math.round((toUtc - fromUtc) / 86400000);
}

// Adapter note (verified in postgresAdapter.js lines 1-60):
// - prepare() auto-appends `RETURNING <id>` for bare INSERTs only when the
//   table is in ID_COLUMNS. review_sessions is NOT in that map, so a bare
//   INSERT would leave result.insertId undefined.
// - convertSql() does not mangle an explicit RETURNING clause, and
//   mysqlLikeResult() exposes Object.values(rows[0])[0] as insertId for
//   INSERT ... RETURNING. So we write the RETURNING explicitly and still
//   handle both shapes defensively (adapter {insertId} vs raw rows).
function extractInsertId(first) {
  if (!first) return undefined;
  if (Array.isArray(first)) {
    const row = first[0];
    if (!row || typeof row !== 'object') return undefined;
    const value = row.insertId ?? row.insertid ?? row.id_review_session ?? row.id;
    return value === undefined ? undefined : Number(value);
  }
  if (typeof first === 'object') {
    const direct = first.insertId ?? first.insertid ?? first.id_review_session ?? first.id;
    if (direct !== undefined) return Number(direct);
    if (Array.isArray(first.rows) && first.rows[0]) {
      const row = first.rows[0];
      const value = row.insertId ?? row.insertid ?? row.id_review_session ?? Object.values(row)[0];
      return value === undefined ? undefined : Number(value);
    }
  }
  return undefined;
}

// Internal: body of the grade transaction after ownership is established.
// Returns null on missing-or-foreign review item so callers can keep the
// legacy exact behavior (rollback + 404 {error:'review item not found'}).
// On success returns { result, nextIntervalDays }.
async function applyGrade(connection, { reviewItemId, result, sessionId, userId }) {
  const [rows] = await connection.execute(`SELECT ri.id_review_item, ri.interval_days, ri.id_vocabulary, ri.id_kanji, ri.id_grammar
      FROM review_items ri
      WHERE ri.id_review_item = ? FOR UPDATE`, [reviewItemId]);
  if (!rows[0]) return null;
  const reviewItem = rows[0];
  let isOwner = false;
  if (reviewItem.id_vocabulary) {
    const [v] = await connection.execute('SELECT 1 FROM vocabulary WHERE id_vocabulary = ? AND user_id = ?', [reviewItem.id_vocabulary, userId]);
    isOwner = v.length > 0;
  } else if (reviewItem.id_kanji) {
    const [k] = await connection.execute('SELECT 1 FROM kanji WHERE id_kanji = ? AND user_id = ?', [reviewItem.id_kanji, userId]);
    isOwner = k.length > 0;
  } else if (reviewItem.id_grammar) {
    const [g] = await connection.execute('SELECT 1 FROM grammar_points WHERE id_grammar = ? AND user_id = ?', [reviewItem.id_grammar, userId]);
    isOwner = g.length > 0;
  }
  if (!isOwner) return null;
  const previousInterval = Number(reviewItem.interval_days || 0);
  const nextInterval = INTERVALS[result];
  await connection.execute(
    'INSERT INTO review_events (id_review_item, reviewed_at, result, previous_interval_days, next_interval_days, id_review_session) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?)',
    [reviewItemId, result, previousInterval, nextInterval, sessionId || null]
  );
  await connection.execute(
    'UPDATE review_items SET due_on = CURRENT_DATE + CAST(? AS INTEGER), interval_days = ?, last_reviewed_at = CURRENT_TIMESTAMP, last_result = ? WHERE id_review_item = ?',
    [nextInterval, nextInterval, result, reviewItemId]
  );
  return { result, nextIntervalDays: nextInterval };
}

// Session-id validation helper. Throws ValidationError('review session is not
// open') when the owned session is already completed. Throws a coded 404
// error when missing-or-foreign (never leak existence across users).
async function requireOpenSession(executor, sessionId, userId) {
  const [rows] = await executor.execute(
    'SELECT id_review_session, completed_at FROM review_sessions WHERE id_review_session = ? AND user_id = ?',
    [sessionId, userId]
  );
  const row = rows && rows[0];
  if (!row) {
    const error = new Error('review session not found');
    error.status = 404;
    throw error;
  }
  if (row.completed_at) {
    throw new ValidationError('review session is not open');
  }
  return row;
}

async function getSessionSummary(executor, sessionId, userId) {
  const [rows] = await executor.execute(
    `SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ri.id_kanji IS NOT NULL) AS kanji,
      COUNT(*) FILTER (WHERE ri.id_vocabulary IS NOT NULL) AS vocabulary,
      COUNT(*) FILTER (WHERE ri.id_grammar IS NOT NULL) AS grammar,
      COUNT(*) FILTER (WHERE re.result = 'Again') AS again,
      COUNT(*) FILTER (WHERE re.result = 'Hard') AS hard,
      COUNT(*) FILTER (WHERE re.result = 'Good') AS good
     FROM review_events re
     JOIN review_items ri ON ri.id_review_item = re.id_review_item
     WHERE re.id_review_session = ?
     AND EXISTS (SELECT 1 FROM review_sessions rs WHERE rs.id_review_session = re.id_review_session AND rs.user_id = ?)`,
    [sessionId, userId]
  );
  const row = (rows && rows[0]) || {};
  return {
    total: Number(row.total) || 0,
    byType: {
      kanji: Number(row.kanji) || 0,
      vocabulary: Number(row.vocabulary) || 0,
      grammar: Number(row.grammar) || 0
    },
    byResult: {
      Again: Number(row.again) || 0,
      Hard: Number(row.hard) || 0,
      Good: Number(row.good) || 0
    }
  };
}

async function listDueReviews(req, res) {
  try {
    // Exactly one FK per row is enforced by chk_review_items_one_target, so three
    // owned INNER JOIN branches UNION ALLed are equivalent to the old
    // LEFT JOIN + OR ownership filter, while letting each branch use its
    // (user_id, id) index instead of scanning every due row three times.
    // Inert = auto-enrolled but never actually reviewed; new items enroll lazily on first grade.
    const [items] = await pool.execute(`SELECT ri.id_review_item, ri.due_on, ri.interval_days, ri.last_reviewed_at, ri.last_result,
      'Vocabulary' AS item_type, v.word AS title, v.meaning AS meaning, v.reading
      FROM review_items ri
      JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary
      WHERE ri.due_on <= CURRENT_DATE AND ri.id_vocabulary IS NOT NULL AND ri.id_kanji IS NULL AND ri.id_grammar IS NULL AND v.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)
      UNION ALL
      SELECT ri.id_review_item, ri.due_on, ri.interval_days, ri.last_reviewed_at, ri.last_result,
      'Kanji' AS item_type, k.character_kanji AS title, k.meaning AS meaning, NULL AS reading
      FROM review_items ri
      JOIN kanji k ON k.id_kanji = ri.id_kanji
      WHERE ri.due_on <= CURRENT_DATE AND ri.id_kanji IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_grammar IS NULL AND k.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)
      UNION ALL
      SELECT ri.id_review_item, ri.due_on, ri.interval_days, ri.last_reviewed_at, ri.last_result,
      'Grammar' AS item_type, g.grammar_point AS title, g.meaning AS meaning, NULL AS reading
      FROM review_items ri
      JOIN grammar_points g ON g.id_grammar = ri.id_grammar
      WHERE ri.due_on <= CURRENT_DATE AND ri.id_grammar IS NOT NULL AND ri.id_vocabulary IS NULL AND ri.id_kanji IS NULL AND g.user_id = ? AND NOT (ri.interval_days = 0 AND ri.last_reviewed_at IS NULL)
      ORDER BY due_on ASC, id_review_item ASC`, [req.user.id, req.user.id, req.user.id]);
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
    const applied = await applyGrade(connection, { reviewItemId: id, result, sessionId: null, userId: req.user.id });
    if (!applied) {
      await connection.rollback();
      connection.release();
      connection = null;
      return res.status(404).json({ error: 'review item not found' });
    }
    await connection.commit();
    connection.release();
    connection = null;
    return res.json({ success: true, result: applied.result, nextIntervalDays: applied.nextIntervalDays });
  } catch (error) {
    if (connection) { await connection.rollback().catch(() => {}); connection.release(); }
    return sendRouteError(res, error, { defaultMessage: 'Unable to record review.' });
  }
}

async function createReviewSession(req, res) {
  try {
    const { sourceFrom, sourceTo } = req.body || {};
    if (!isValidDateString(sourceFrom) || !isValidDateString(sourceTo)) {
      throw new ValidationError('sourceFrom and sourceTo are required and must use YYYY-MM-DD format.');
    }
    if (sourceFrom > sourceTo) {
      throw new ValidationError('sourceFrom must not be after sourceTo.');
    }
    const today = todayString();
    if (sourceTo > today) {
      throw new ValidationError('sourceTo must not be in the future');
    }
    if (dateDiffDays(sourceFrom, sourceTo) > 366) {
      throw new ValidationError('Date range must not exceed 366 days.');
    }
    const [result] = await pool.execute(
      'INSERT INTO review_sessions (user_id, source_from, source_to) VALUES (?, ?, ?) RETURNING id_review_session AS insertId',
      [req.user.id, sourceFrom, sourceTo]
    );
    const id = extractInsertId(result);
    if (!id) throw new Error('Failed to create review session.');
    return res.status(201).json({ id, sourceFrom, sourceTo, completedAt: null });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 500, defaultMessage: 'Unable to start review session.' });
  }
}

async function completeReviewSession(req, res) {
  try {
    const id = parseIdParam(req, 'review session');
    const [rows] = await pool.execute(
      'SELECT id_review_session, completed_at FROM review_sessions WHERE id_review_session = ? AND user_id = ?',
      [id, req.user.id]
    );
    const session = rows && rows[0];
    if (!session) return res.status(404).json({ error: 'review session not found' });
    if (session.completed_at) {
      const summary = await getSessionSummary(pool, id, req.user.id);
      return res.json({ id, completedAt: session.completed_at, ...summary });
    }
    await pool.execute(
      'UPDATE review_sessions SET completed_at = CURRENT_TIMESTAMP WHERE id_review_session = ? AND user_id = ?',
      [id, req.user.id]
    );
    const [updatedRows] = await pool.execute(
      'SELECT completed_at FROM review_sessions WHERE id_review_session = ? AND user_id = ?',
      [id, req.user.id]
    );
    const completedAt = (updatedRows && updatedRows[0] && updatedRows[0].completed_at) || null;
    const summary = await getSessionSummary(pool, id, req.user.id);
    return res.json({ id, completedAt, ...summary });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 500, defaultMessage: 'Unable to complete review session.' });
  }
}

const ENTITY_CONFIG = {
  kanji: { table: 'kanji', pk: 'id_kanji', fk: 'id_kanji' },
  vocabulary: { table: 'vocabulary', pk: 'id_vocabulary', fk: 'id_vocabulary' },
  grammar: { table: 'grammar_points', pk: 'id_grammar', fk: 'id_grammar' }
};

async function gradeEntity(req, res) {
  let connection;
  try {
    const body = req.body || {};
    const { entityType, entityId, result, reviewSessionId } = body;
    if (typeof entityType !== 'string' || !entityType) {
      throw new ValidationError('entityType must be one of: kanji, vocabulary, grammar');
    }
    validateAllowedValues(entityType, ['kanji', 'vocabulary', 'grammar'], 'entityType');
    const config = ENTITY_CONFIG[entityType];
    const numericEntityId = Number(entityId);
    if (!Number.isInteger(numericEntityId) || numericEntityId <= 0) {
      throw new ValidationError(`${entityType} id must be a positive integer`);
    }
    if (!Object.hasOwn(INTERVALS, result)) throw new ValidationError('result must be Again, Hard, or Good.');
    const numericSessionId = Number(reviewSessionId);
    if (!Number.isInteger(numericSessionId) || numericSessionId <= 0) {
      throw new ValidationError('review session id must be a positive integer');
    }
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [entityRows] = await connection.execute(
      `SELECT 1 FROM ${config.table} WHERE ${config.pk} = ? AND user_id = ?`,
      [numericEntityId, req.user.id]
    );
    if (!entityRows[0]) {
      await connection.rollback();
      connection.release();
      connection = null;
      return res.status(404).json({ error: 'review entity not found' });
    }
    try {
      await requireOpenSession(connection, numericSessionId, req.user.id);
    } catch (sessionError) {
      if (sessionError && sessionError.status === 404) {
        await connection.rollback();
        connection.release();
        connection = null;
        return res.status(404).json({ error: 'review session not found' });
      }
      throw sessionError;
    }
    await createReviewItem(connection, config.fk, numericEntityId);
    const [itemRows] = await connection.execute(
      `SELECT id_review_item FROM review_items WHERE ${config.fk} = ? FOR UPDATE`,
      [numericEntityId]
    );
    const reviewItemId = itemRows && itemRows[0] && itemRows[0].id_review_item;
    if (!reviewItemId) throw new Error('Failed to enroll review item.');
    const applied = await applyGrade(connection, {
      reviewItemId,
      result,
      sessionId: numericSessionId,
      userId: req.user.id
    });
    if (!applied) {
      await connection.rollback();
      connection.release();
      connection = null;
      return res.status(404).json({ error: 'review item not found' });
    }
    await connection.commit();
    connection.release();
    connection = null;
    return res.json({
      success: true,
      result: applied.result,
      nextIntervalDays: applied.nextIntervalDays,
      idReviewItem: Number(reviewItemId),
      idReviewSession: numericSessionId
    });
  } catch (error) {
    if (connection) { await connection.rollback().catch(() => {}); connection.release(); }
    if (error && error.status === 404) return res.status(404).json({ error: 'review session not found' });
    return sendRouteError(res, error, { defaultMessage: 'Unable to record review.' });
  }
}

async function listCandidates(req, res) {
  try {
    const { from, to } = req.query || {};
    if (!isValidDateString(from) || !isValidDateString(to)) {
      throw new ValidationError('from and to are required and must use YYYY-MM-DD format.');
    }
    if (from > to) throw new ValidationError('from must not be after to.');
    const today = todayString();
    if (to > today) throw new ValidationError('to must not be in the future');
    if (dateDiffDays(from, to) > 366) throw new ValidationError('Date range must not exceed 366 days.');
    const rawJlpt = req.query.jlpt === undefined || req.query.jlpt === null || req.query.jlpt === ''
      ? 'all'
      : String(req.query.jlpt);
    validateAllowedValues(rawJlpt, ['all', 'N5', 'N4', 'N3', 'N2', 'N1'], 'jlpt');
    const rawTypes = req.query.types;
    let types;
    if (rawTypes === undefined || rawTypes === null || rawTypes === '') {
      types = ['kanji', 'vocabulary', 'grammar'];
    } else {
      const parts = String(rawTypes).split(',').map((part) => part.trim()).filter(Boolean);
      const allowed = ['kanji', 'vocabulary', 'grammar'];
      for (const part of parts) {
        if (!allowed.includes(part)) {
          throw new ValidationError('types must be a comma-separated subset of: kanji, vocabulary, grammar');
        }
      }
      types = [...new Set(parts)];
      if (!types.length) throw new ValidationError('types must be a comma-separated subset of: kanji, vocabulary, grammar');
    }
    const groups = await getReviewCandidates(pool, req.user.id, { from, to, jlpt: rawJlpt, types });
    return res.json({ from, to, groups });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review candidates.' });
  }
}

module.exports = { createReviewItem, listDueReviews, recordReview, createReviewSession, completeReviewSession, gradeEntity, listCandidates };
