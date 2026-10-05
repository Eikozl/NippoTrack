const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam, isValidDateString, validateAllowedValues } = require('../validation');
const { parsePagination, paginationPayload } = require('../pagination');
const { getReviewCandidates, toIsoDate } = require('../services/reviewCandidates');
const {
  CARD_TYPES,
  ENTITY_CARD_TYPES,
  getUserReviewPreferences,
  upsertUserReviewPreferences,
  detectAndStoreReviewPatterns,
  resolveIntervalDays
} = require('../services/reviewEngine');

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
// V5.3a: interval resolution is the FIRST statement in the transaction. The
// default engine_mode='fixed' keeps the frozen 1/3/7 curve byte-identical
// (one bounded preferences read per grade); the opt-in 'dynamic' mode applies
// the spec-verbatim facility formula from the item's recent events.
async function applyGrade(connection, { reviewItemId, result, sessionId, userId }) {
  const intervalResolution = await resolveIntervalDays(connection, userId, reviewItemId, result);
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
  const nextInterval = intervalResolution.intervalDays;
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

// Exactly one FK per row is enforced by chk_review_items_one_target, so three
// owned INNER JOIN branches UNION ALLed are equivalent to the old
// LEFT JOIN + OR ownership filter, while letting each branch use its
// (user_id, id) index instead of scanning every due row three times.
// Inert = auto-enrolled but never actually reviewed; new items enroll lazily on first grade.
const DUE_REVIEWS_SQL = `SELECT ri.id_review_item, ri.due_on, ri.interval_days, ri.last_reviewed_at, ri.last_result,
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
  ORDER BY due_on ASC, id_review_item ASC`;

async function listDueReviews(req, res) {
  try {
    const [items] = await pool.execute(DUE_REVIEWS_SQL, [req.user.id, req.user.id, req.user.id]);
    return res.json({ items });
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load reviews.' }); }
}

// V5.3a Review 2.0: due listing enriched with the card types each entity
// supports, optionally filtered to items that support at least one of the
// requested types. Read-only; the frozen /due rows themselves are unchanged.
async function listDueReviewCards(req, res) {
  try {
    const rawTypes = req.query?.types;
    let requestedTypes;
    if (rawTypes === undefined || rawTypes === null || rawTypes === '') {
      requestedTypes = null;
    } else {
      const parts = String(rawTypes).split(',').map((part) => part.trim()).filter(Boolean);
      if (!parts.length) throw new ValidationError('types must be a comma-separated subset of: recognition, recall, cloze, audio');
      for (const part of parts) {
        if (!CARD_TYPES.includes(part)) {
          throw new ValidationError('types must be a comma-separated subset of: recognition, recall, cloze, audio');
        }
      }
      requestedTypes = [...new Set(parts)];
    }
    const [rows] = await pool.execute(DUE_REVIEWS_SQL, [req.user.id, req.user.id, req.user.id]);
    const items = (rows || [])
      .map((row) => {
        const entityType = String(row.item_type || '').toLowerCase() === 'vocabulary'
          ? 'vocabulary'
          : String(row.item_type || '').toLowerCase() === 'kanji' ? 'kanji' : 'grammar';
        return { ...row, entityType, cardTypes: [...(ENTITY_CARD_TYPES[entityType] || ['recognition'])] };
      })
      .filter((row) => !requestedTypes || row.cardTypes.some((type) => requestedTypes.includes(type)));
    return res.json({ items });
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review cards.' }); }
}

// V5.3a Review 2.0: available card types + the user's stored preferences.
// Review 3.0: userPreferences also carries autoPick (default true for users
// who never saved it; resolved in the engine's preferencesFromRow).
async function getReviewTypes(req, res) {
  try {
    const userPreferences = await getUserReviewPreferences(pool, req.user.id);
    return res.json({ availableTypes: [...CARD_TYPES], userPreferences });
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review types.' }); }
}

// V5.3a Review 2.0: upsert the user's card-type preferences.
// Review 3.0: accepts an OPTIONAL autoPick boolean (absent/null defaults to
// true in the engine; any other non-boolean rejects with 400 via
// normalizeAutoPick). engineMode behavior unchanged.
async function putReviewPreferences(req, res) {
  try {
    const body = req.body || {};
    const allowed = ['cardTypes', 'weights', 'engineMode', 'autoPick', 'speechRate'];
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new ValidationError(`Unexpected field(s): ${unknown.join(', ')}.`);
    if (!Array.isArray(body.cardTypes)) throw new ValidationError('cardTypes is required and must be an array.');
    const saved = await upsertUserReviewPreferences(pool, req.user.id, {
      cardTypes: body.cardTypes,
      weights: body.weights,
      engineMode: body.engineMode,
      autoPick: body.autoPick,
      speechRate: body.speechRate
    });
    return res.json({ userPreferences: saved });
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save review preferences.' }); }
}

// V5.3a Review 2.0: run the pattern detector (heuristic, user-scoped, last 50
// events) and return the fresh pattern set. Detection replaces the stored
// rows so the panel and the API can never disagree.
async function getReviewPatterns(req, res) {
  try {
    const items = await detectAndStoreReviewPatterns(pool, req.user.id);
    return res.json({ items });
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review patterns.' }); }
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
    const { sourceFrom, sourceTo, items } = req.body || {};
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
    // Optional exact queue: persisted as review_session_items so an unfinished
    // session can be retaken where the user left off. Validated (type, shape,
    // ownership, no repeats, bounded) before anything is written.
    let queueItems = [];
    if (items !== undefined) {
      if (!Array.isArray(items) || !items.length || items.length > 500) {
        throw new ValidationError('items must be a non-empty array of at most 500 entries.');
      }
      const seen = new Set();
      queueItems = items.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          throw new ValidationError('items must be entries with entityType and entityId.');
        }
        validateAllowedValues(entry.entityType, ['kanji', 'vocabulary', 'grammar'], 'entityType');
        const entityId = Number(entry.entityId);
        if (!Number.isInteger(entityId) || entityId <= 0) {
          throw new ValidationError(`${entry.entityType} id must be a positive integer`);
        }
        const key = `${entry.entityType}:${entityId}`;
        if (seen.has(key)) throw new ValidationError('items must not repeat the same entity.');
        seen.add(key);
        return { entityType: entry.entityType, entityId, position: index };
      });
      for (const entry of queueItems) {
        const config = ENTITY_CONFIG[entry.entityType];
        const [entityRows] = await pool.execute(
          `SELECT 1 FROM ${config.table} WHERE ${config.pk} = ? AND user_id = ?`,
          [entry.entityId, req.user.id]
        );
        if (!entityRows[0]) return res.status(404).json({ error: 'review entity not found' });
      }
    }
    if (!queueItems.length) {
      const [result] = await pool.execute(
        'INSERT INTO review_sessions (user_id, source_from, source_to) VALUES (?, ?, ?) RETURNING id_review_session AS insertId',
        [req.user.id, sourceFrom, sourceTo]
      );
      const id = extractInsertId(result);
      if (!id) throw new Error('Failed to create review session.');
      return res.status(201).json({ id, sourceFrom, sourceTo, completedAt: null });
    }
    let connection = null;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [result] = await connection.execute(
        'INSERT INTO review_sessions (user_id, source_from, source_to) VALUES (?, ?, ?) RETURNING id_review_session AS insertId',
        [req.user.id, sourceFrom, sourceTo]
      );
      const id = extractInsertId(result);
      if (!id) throw new Error('Failed to create review session.');
      await connection.execute(
        `INSERT INTO review_session_items (id_review_session, entity_type, entity_id, position) VALUES ${queueItems.map(() => '(?, ?, ?, ?)').join(', ')}`,
        queueItems.flatMap((entry) => [id, entry.entityType, entry.entityId, entry.position])
      );
      await connection.commit();
      connection.release();
      connection = null;
      return res.status(201).json({ id, sourceFrom, sourceTo, completedAt: null, itemCount: queueItems.length });
    } catch (error) {
      if (connection) { await connection.rollback().catch(() => {}); connection.release(); connection = null; }
      throw error;
    }
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

// Read-only history over already-persisted sessions + events. No analytics,
// no new writes: paginated session summaries plus one bounded item listing.
async function listReviewSessions(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const [[totalRow]] = await pool.execute(
      'SELECT COUNT(*) AS total FROM review_sessions WHERE user_id = ?',
      [req.user.id]
    );
    const total = Number(totalRow?.total || 0);
    const [rows] = await pool.execute(
      `SELECT rs.id_review_session AS id,
        rs.source_from AS "sourceFrom", rs.source_to AS "sourceTo",
        rs.started_at AS "startedAt", rs.completed_at AS "completedAt",
        COUNT(re.id_review_event) AS total,
        COUNT(*) FILTER (WHERE ri.id_kanji IS NOT NULL) AS kanji,
        COUNT(*) FILTER (WHERE ri.id_vocabulary IS NOT NULL) AS vocabulary,
        COUNT(*) FILTER (WHERE ri.id_grammar IS NOT NULL) AS grammar,
        COUNT(*) FILTER (WHERE re.result = 'Again') AS again,
        COUNT(*) FILTER (WHERE re.result = 'Hard') AS hard,
        COUNT(*) FILTER (WHERE re.result = 'Good') AS good
       FROM review_sessions rs
       LEFT JOIN review_events re ON re.id_review_session = rs.id_review_session
       LEFT JOIN review_items ri ON ri.id_review_item = re.id_review_item
       WHERE rs.user_id = ?
       GROUP BY rs.id_review_session
       ORDER BY rs.started_at DESC, rs.id_review_session DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );
    const items = (rows || []).map((row) => ({
      id: Number(row.id),
      sourceFrom: row.sourceFrom,
      sourceTo: row.sourceTo,
      startedAt: row.startedAt,
      completedAt: row.completedAt || null,
      total: Number(row.total || 0),
      byType: {
        kanji: Number(row.kanji || 0),
        vocabulary: Number(row.vocabulary || 0),
        grammar: Number(row.grammar || 0)
      },
      byResult: {
        Again: Number(row.again || 0),
        Hard: Number(row.hard || 0),
        Good: Number(row.good || 0)
      }
    }));
    return res.json(paginationPayload(items, total, page, limit));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review history.' });
  }
}

async function getReviewSession(req, res) {
  try {
    const id = parseIdParam(req, 'review session');
    const [sessions] = await pool.execute(
      `SELECT id_review_session AS id, source_from AS "sourceFrom", source_to AS "sourceTo",
        started_at AS "startedAt", completed_at AS "completedAt"
       FROM review_sessions WHERE id_review_session = ? AND user_id = ?`,
      [id, req.user.id]
    );
    const session = sessions && sessions[0];
    if (!session) return res.status(404).json({ error: 'review session not found' });
    const [items] = await pool.execute(
      `SELECT re.reviewed_at AS "reviewedAt", re.result,
        CASE WHEN ri.id_kanji IS NOT NULL THEN 'kanji'
             WHEN ri.id_vocabulary IS NOT NULL THEN 'vocabulary'
             ELSE 'grammar' END AS "entityType",
        COALESCE(v.word, k.character_kanji, g.grammar_point) AS display,
        v.reading AS reading,
        COALESCE(v.meaning, k.meaning, g.meaning) AS meaning
       FROM review_events re
       JOIN review_items ri ON ri.id_review_item = re.id_review_item
       LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
       LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
       LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
       WHERE re.id_review_session = ?
       AND EXISTS (SELECT 1 FROM review_sessions rs WHERE rs.id_review_session = re.id_review_session AND rs.user_id = ?)
       ORDER BY re.reviewed_at ASC, re.id_review_event ASC
       LIMIT 500`,
      [req.user.id, req.user.id, req.user.id, id, req.user.id]
    );
    const summary = await getSessionSummary(pool, id, req.user.id);
    return res.json({
      session: {
        id: Number(session.id),
        sourceFrom: session.sourceFrom,
        sourceTo: session.sourceTo,
        startedAt: session.startedAt,
        completedAt: session.completedAt || null
      },
      items: items || [],
      ...summary
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review session.' });
  }
}

// Retake queue: the persisted session items in start order, each annotated
// with its latest grade inside THIS session (null = not yet reviewed).
// Only open sessions are resumable; missing-or-foreign 404s without leaking
// existence, mirroring requireOpenSession.
//
// Legacy fallback: sessions created before queue persistence (migration 026)
// — plus sessions from the still-supported no-items create path and
// target-less immersion runs — have zero persisted rows, so the queue alone
// cannot resume them even though GET /sessions/:id shows their graded
// events. For those OPEN sessions we reconstruct a resume set from candidate
// discovery over the session's own source range, minus entities already
// graded in this session (capped, deterministic, read-only: no new session,
// no writes). The additive `reconstructed` flag (+ the echoed source range)
// lets callers explain the substitution honestly.
const RECONSTRUCTED_QUEUE_LIMIT = 100;

async function buildReconstructedSessionItems(executor, sessionId, userId, sourceFrom, sourceTo) {
  const [gradedRows] = await executor.execute(
    `SELECT ri.id_kanji AS "kanjiId", ri.id_vocabulary AS "vocabularyId", ri.id_grammar AS "grammarId"
      FROM review_events re
      JOIN review_items ri ON ri.id_review_item = re.id_review_item
      WHERE re.id_review_session = ?
      AND EXISTS (SELECT 1 FROM review_sessions rs WHERE rs.id_review_session = re.id_review_session AND rs.user_id = ?)
      LIMIT 500`,
    [sessionId, userId]
  );
  const gradedKeys = new Set();
  for (const row of gradedRows || []) {
    if (row.kanjiId !== null && row.kanjiId !== undefined) gradedKeys.add(`kanji:${Number(row.kanjiId)}`);
    else if (row.vocabularyId !== null && row.vocabularyId !== undefined) gradedKeys.add(`vocabulary:${Number(row.vocabularyId)}`);
    else if (row.grammarId !== null && row.grammarId !== undefined) gradedKeys.add(`grammar:${Number(row.grammarId)}`);
  }
  // Same contract as listCandidates: full range, all types, no JLPT filter.
  const groups = await getReviewCandidates(executor, userId, {
    from: sourceFrom,
    to: sourceTo,
    jlpt: 'all',
    types: ['kanji', 'vocabulary', 'grammar']
  });
  const ordered = [];
  for (const entityType of ['kanji', 'vocabulary', 'grammar']) {
    const group = groups && groups[entityType];
    const list = group && Array.isArray(group.items) ? group.items : [];
    for (const item of list) {
      if (ordered.length >= RECONSTRUCTED_QUEUE_LIMIT) break;
      const entityId = Number(item && item.entityId);
      if (!Number.isInteger(entityId) || entityId <= 0) continue;
      if (gradedKeys.has(`${entityType}:${entityId}`)) continue;
      ordered.push({
        entityType,
        entityId,
        display: item.display ?? null,
        reading: item.reading ?? null,
        meaning: item.meaning ?? null
      });
    }
    if (ordered.length >= RECONSTRUCTED_QUEUE_LIMIT) break;
  }
  return ordered.map((entry, position) => ({
    position,
    entityType: entry.entityType,
    entityId: entry.entityId,
    display: entry.display,
    reading: entry.reading || null,
    meaning: entry.meaning || null,
    lastResult: null
  }));
}

async function getReviewSessionItems(req, res) {
  try {
    const id = parseIdParam(req, 'review session');
    try {
      await requireOpenSession(pool, id, req.user.id);
    } catch (sessionError) {
      if (sessionError && sessionError.status === 404) {
        return res.status(404).json({ error: 'review session not found' });
      }
      throw sessionError;
    }
    const [rows] = await pool.execute(
      `SELECT si.position AS "position",
        si.entity_type AS "entityType",
        si.entity_id AS "entityId",
        COALESCE(v.word, k.character_kanji, g.grammar_point) AS display,
        v.reading AS reading,
        COALESCE(v.meaning, k.meaning, g.meaning) AS meaning,
        last_event.result AS "lastResult"
       FROM review_session_items si
       JOIN review_sessions rs ON rs.id_review_session = si.id_review_session
       LEFT JOIN vocabulary v ON si.entity_type = 'vocabulary' AND v.id_vocabulary = si.entity_id AND v.user_id = ?
       LEFT JOIN kanji k ON si.entity_type = 'kanji' AND k.id_kanji = si.entity_id AND k.user_id = ?
       LEFT JOIN grammar_points g ON si.entity_type = 'grammar' AND g.id_grammar = si.entity_id AND g.user_id = ?
       LEFT JOIN LATERAL (
         SELECT re.result
         FROM review_events re
         JOIN review_items ri ON ri.id_review_item = re.id_review_item
         WHERE re.id_review_session = si.id_review_session
           AND ((si.entity_type = 'vocabulary' AND ri.id_vocabulary = si.entity_id)
             OR (si.entity_type = 'kanji' AND ri.id_kanji = si.entity_id)
             OR (si.entity_type = 'grammar' AND ri.id_grammar = si.entity_id))
         ORDER BY re.reviewed_at DESC, re.id_review_event DESC
         LIMIT 1
       ) last_event ON true
       WHERE si.id_review_session = ? AND rs.user_id = ?
       ORDER BY si.position ASC, si.id_review_session_item ASC
       LIMIT 500`,
      [req.user.id, req.user.id, req.user.id, id, req.user.id]
    );
    const persisted = (rows || []).map((row) => ({
      position: Number(row.position),
      entityType: row.entityType,
      entityId: Number(row.entityId),
      display: row.display,
      reading: row.reading || null,
      meaning: row.meaning || null,
      lastResult: row.lastResult || null
    }));
    if (persisted.length) {
      return res.json({ id, reconstructed: false, items: persisted });
    }
    // Empty persisted queue on an OPEN session: legacy (pre-026), no-items,
    // or target-less immersion session. Reconstruct a resume set instead of
    // stranding the user with []. requireOpenSession already proved ownership,
    // so the range lookup below stays user-scoped without leaking existence.
    const [sessions] = await pool.execute(
      'SELECT source_from AS "sourceFrom", source_to AS "sourceTo" FROM review_sessions WHERE id_review_session = ? AND user_id = ?',
      [id, req.user.id]
    );
    const range = sessions && sessions[0];
    if (!range) return res.status(404).json({ error: 'review session not found' });
    const sourceFrom = toIsoDate(range.sourceFrom);
    const sourceTo = toIsoDate(range.sourceTo);
    if (!isValidDateString(sourceFrom) || !isValidDateString(sourceTo)) {
      return res.json({ id, reconstructed: true, sourceFrom: sourceFrom || null, sourceTo: sourceTo || null, items: [] });
    }
    const reconstructed = await buildReconstructedSessionItems(pool, id, req.user.id, sourceFrom, sourceTo);
    return res.json({ id, reconstructed: true, sourceFrom, sourceTo, items: reconstructed });
  } catch (error) {
    if (error && error.status === 404) return res.status(404).json({ error: 'review session not found' });
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load review session items.' });
  }
}

// "Frequently difficult" = a review item with >= DIFFICULT_THRESHOLD
// 'Again' events in its history (reuses the existing Again result; no leech
// system, no ML, no second review classification). Read-only, one bounded
// query, no N+1.
const DIFFICULT_THRESHOLD = 2;
const DIFFICULT_LIMIT = 10;

async function listDifficultItems(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT ri.id_review_item AS id,
        CASE WHEN ri.id_kanji IS NOT NULL THEN 'kanji'
             WHEN ri.id_vocabulary IS NOT NULL THEN 'vocabulary'
             ELSE 'grammar' END AS "entityType",
        COALESCE(v.word, k.character_kanji, g.grammar_point) AS display,
        v.reading AS reading,
        COALESCE(v.meaning, k.meaning, g.meaning) AS meaning,
        COUNT(*) FILTER (WHERE re.result = 'Again') AS "againCount",
        COUNT(re.id_review_event) AS "totalEvents",
        MAX(re.reviewed_at) AS "lastReviewedAt"
       FROM review_items ri
       LEFT JOIN review_events re ON re.id_review_item = ri.id_review_item
       LEFT JOIN vocabulary v ON v.id_vocabulary = ri.id_vocabulary AND v.user_id = ?
       LEFT JOIN kanji k ON k.id_kanji = ri.id_kanji AND k.user_id = ?
       LEFT JOIN grammar_points g ON g.id_grammar = ri.id_grammar AND g.user_id = ?
       WHERE (v.user_id = ? OR k.user_id = ? OR g.user_id = ?)
       GROUP BY ri.id_review_item,
         CASE WHEN ri.id_kanji IS NOT NULL THEN 'kanji'
              WHEN ri.id_vocabulary IS NOT NULL THEN 'vocabulary'
              ELSE 'grammar' END,
         COALESCE(v.word, k.character_kanji, g.grammar_point),
         v.reading,
         COALESCE(v.meaning, k.meaning, g.meaning)
       HAVING COUNT(*) FILTER (WHERE re.result = 'Again') >= ${DIFFICULT_THRESHOLD}
       ORDER BY "againCount" DESC, "lastReviewedAt" DESC NULLS LAST
       LIMIT ${DIFFICULT_LIMIT}`,
      [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
    );
    return res.json({
      items: (rows || []).map((row) => ({
        idReviewItem: Number(row.id),
        entityType: row.entityType,
        display: row.display,
        reading: row.reading || null,
        meaning: row.meaning || null,
        againCount: Number(row.againCount || 0),
        totalEvents: Number(row.totalEvents || 0),
        lastReviewedAt: row.lastReviewedAt || null
      }))
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load difficult items.' });
  }
}

async function deleteReviewSession(req, res) {
  try {
    const id = parseIdParam(req, 'review session');
    const [result] = await pool.execute(
      'DELETE FROM review_sessions WHERE id_review_session = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'review session not found' });
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete the review session.' });
  }
}

async function clearReviewSessions(req, res) {
  try {
    const [result] = await pool.execute(
      'DELETE FROM review_sessions WHERE user_id = ?',
      [req.user.id]
    );
    return res.json({ success: true, deleted: Number(result.affectedRows || 0) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to clear review history.' });
  }
}

module.exports = { createReviewItem, listDueReviews, listDueReviewCards, recordReview, createReviewSession, completeReviewSession, gradeEntity, listCandidates, listReviewSessions, getReviewSession, getReviewSessionItems, deleteReviewSession, clearReviewSessions, listDifficultItems, getReviewTypes, putReviewPreferences, getReviewPatterns };
