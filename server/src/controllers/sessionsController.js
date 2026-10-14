const pool = require('../config/db');
const { ALLOWED_FIELDS, STUDY_CATEGORIES } = require('../constants');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parsePagination, paginationPayload } = require('../pagination');
const {
  isValidDateString,
  normalizeText,
  parseIdParam,
  validateStudySessionPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById, rollbackAndRelease } = require('./helpers');
const { ENCOUNTER_SOURCE_TYPES, recordKanjiEncounters } = require('../services/kanjiEncounters');
const { buildSessionKanjiDiscovery, extractDiscoveryCharacters } = require('../services/sessionKanjiDiscovery');
const { getReviewCandidates } = require('../services/reviewCandidates');

// Day-items aggregation cap: one bounded list per kind for the
// one-click "link what I studied that day" picker. 50 keeps the session
// form payload small while covering a full day of study.
const DAY_ITEMS_LIMIT = 50;

async function listSessions(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    // Qualified (s.*) because the items query joins writing/relationship
    // tables; filter semantics and parameter order are unchanged.
    let whereSql = ' WHERE 1=1';
    const params = [];

    if (req.query.category) {
      const category = normalizeText(req.query.category, 20, 'category');
      if (!STUDY_CATEGORIES.includes(category)) throw new ValidationError('Invalid category');
      whereSql += ' AND s.category = ?';
      params.push(category);
    }

    if (req.query.date) {
      if (!isValidDateString(req.query.date)) {
        throw new ValidationError('Invalid date format (YYYY-MM-DD)');
      }
      whereSql += ' AND s.session_date = ?';
      params.push(req.query.date);
    } else {
      if (req.query.from) {
        if (!isValidDateString(req.query.from)) {
          throw new ValidationError('Invalid from date (YYYY-MM-DD)');
        }
        whereSql += ' AND s.session_date >= ?';
        params.push(req.query.from);
      }
      if (req.query.to) {
        if (!isValidDateString(req.query.to)) {
          throw new ValidationError('Invalid to date (YYYY-MM-DD)');
        }
        whereSql += ' AND s.session_date <= ?';
        params.push(req.query.to);
      }
    }

    // Session-history list enrichment (single grouped query, list-only):
    // writing title + bounded excerpt for card previews and per-session
    // related-link counts. session_writings is 1:1 (UNIQUE id_session) so it
    // never fans out; junctions use COUNT(DISTINCT) to avoid cross-products.
    // The COUNT(*) query stays join-free so pagination totals are exact.
    // No per-card detail fetches (no N+1); kanji-discovery counts are
    // intentionally omitted (they require Han extraction, detail-only).
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM study_sessions s${whereSql} AND s.user_id = ?`,
      [...params, req.user.id]
    );
    const [items] = await pool.execute(
      `SELECT s.id_session, s.session_date, s.duration_minutes, s.category, s.resource, s.notes,
              w.title AS writing_title, LEFT(w.content, 400) AS writing_excerpt,
              COUNT(DISTINCT sv.id_vocabulary)::int AS vocabulary_count,
              COUNT(DISTINCT sk.id_kanji)::int AS kanji_count,
              COUNT(DISTINCT sg.id_grammar)::int AS grammar_count
         FROM study_sessions s
         LEFT JOIN session_writings w ON w.id_session = s.id_session
         LEFT JOIN session_vocabulary sv ON sv.id_session = s.id_session
         LEFT JOIN session_kanji sk ON sk.id_session = s.id_session
         LEFT JOIN session_grammar sg ON sg.id_session = s.id_session
        ${whereSql} AND s.user_id = ?
        GROUP BY s.id_session, s.session_date, s.duration_minutes, s.category, s.resource, s.notes, w.title, LEFT(w.content, 400)
        ORDER BY s.session_date DESC, s.id_session DESC LIMIT ? OFFSET ?`,
      [...params, req.user.id, limit, offset]
    );
    return res.json(paginationPayload(items, Number(countRows[0]?.total || 0), page, limit));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Database unavailable' });
  }
}

async function getSession(req, res) {
  try {
    const id = parseIdParam(req, 'study session');
    const session = await fetchEntityById('sessions', id, req.user.id);
    if (!session) return res.status(404).json({ error: 'study session not found' });

    const [vocabulary] = await pool.execute(
      'SELECT v.id_vocabulary, v.word, v.reading, v.meaning, v.jlpt_level, v.status FROM session_vocabulary sv JOIN vocabulary v ON sv.id_vocabulary = v.id_vocabulary WHERE sv.id_session = ? AND v.user_id = ?',
      [id, req.user.id]
    );
    const [kanji] = await pool.execute(
      'SELECT k.id_kanji, k.character_kanji, k.meaning, k.onyomi, k.kunyomi, k.jlpt_level, k.status FROM session_kanji sk JOIN kanji k ON sk.id_kanji = k.id_kanji WHERE sk.id_session = ? AND k.user_id = ?',
      [id, req.user.id]
    );
    const [grammar] = await pool.execute(
      'SELECT g.id_grammar, g.grammar_point, g.meaning, g.structure, g.example, g.jlpt_level, g.status FROM session_grammar sg JOIN grammar_points g ON sg.id_grammar = g.id_grammar WHERE sg.id_session = ? AND g.user_id = ?',
      [id, req.user.id]
    );
    const [writingRows] = await pool.execute(
      'SELECT w.id_session_writing, w.title, w.content, w.notes FROM session_writings w WHERE w.id_session = ? AND EXISTS (SELECT 1 FROM study_sessions s WHERE s.id_session = w.id_session AND s.user_id = ?)',
      [id, req.user.id]
    );
    const [stories] = await pool.execute(
      'SELECT c.id_content_entry, c.title, c.content_type FROM content_entry_sessions l JOIN content_entries c ON c.id_content_entry = l.id_content_entry WHERE l.id_session = ? AND c.user_id = ? ORDER BY c.content_date DESC, c.id_content_entry DESC',
      [id, req.user.id]
    );

    // Phase 6 (kanji discovery): deterministic Han detection over the
    // authoritative session-writing content (the same source Phase 3
    // encounter extraction scans). Two bounded batched queries — the
    // requester's kanji (owned) and the shared reference rows — run
    // concurrently. No N+1, no reading inference, no auto-creation.
    const discoveryChars = extractDiscoveryCharacters(writingRows.map((row) => row.content));
    const charPlaceholders = discoveryChars.map(() => '?').join(', ');
    const userKanjiPromise = discoveryChars.length ? pool.execute(
      'SELECT k.id_kanji, k.character_kanji, k.meaning, k.jlpt_level, k.status, k.onyomi AS user_onyomi, k.kunyomi AS user_kunyomi FROM kanji k WHERE k.user_id = ? AND k.character_kanji IN (' + charPlaceholders + ')',
      [req.user.id, ...discoveryChars]
    ) : Promise.resolve([[]]);
    const referencePromise = discoveryChars.length ? pool.execute(
      'SELECT character, jlpt_level, onyomi, kunyomi, meanings, stroke_count FROM kanji_reference WHERE character IN (' + charPlaceholders + ')',
      discoveryChars
    ) : Promise.resolve([[]]);
    const [[userKanjiRows], [referenceRows]] = await Promise.all([userKanjiPromise, referencePromise]);
    const kanjiDiscovery = buildSessionKanjiDiscovery(discoveryChars, userKanjiRows, referenceRows);

    return res.json({ ...session, vocabulary, kanji, grammar, stories, writing: writingRows[0] || null, kanjiDiscovery });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load study session.' });
  }
}

function normalizeSession(body, current = {}) {
  return {
    sessionDate: body.session_date !== undefined ? normalizeText(body.session_date, 10, 'session_date') : current.session_date,
    durationMinutes: body.duration_minutes !== undefined ? Number(body.duration_minutes) : current.duration_minutes,
    category: body.category !== undefined ? normalizeText(body.category, 20, 'category') : current.category,
    resource: body.resource !== undefined ? normalizeText(body.resource, 255, 'resource') : (current.resource ?? null),
    notes: body.notes !== undefined ? normalizeText(body.notes, 1500, 'notes') : (current.notes ?? null)
  };
}

function normalizeWriting(body, current = null) {
  const supplied = ['writing_title', 'writing_content', 'writing_notes'].some((field) => body[field] !== undefined);
  if (!supplied) return undefined;
  const content = body.writing_content !== undefined ? normalizeText(body.writing_content, 10000, 'writing_content') : current?.content;
  if (!content) throw new ValidationError('writing_content is required when saving writing.');
  return {
    title: body.writing_title !== undefined ? normalizeText(body.writing_title, 150, 'writing_title') : (current?.title ?? null),
    content,
    notes: body.writing_notes !== undefined ? normalizeText(body.writing_notes, 1500, 'writing_notes') : (current?.notes ?? null)
  };
}

async function saveWriting(connection, sessionId, writing) {
  if (!writing) return;
  await connection.execute(
    'INSERT INTO session_writings (id_session, title, content, notes) VALUES (?, ?, ?, ?) ON CONFLICT (id_session) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, notes = EXCLUDED.notes',
    [sessionId, writing.title, writing.content, writing.notes]
  );
}

async function ensureOwnedRelationships(connection, table, idColumn, ids, userId) {
  if (!ids?.length) return;
  const [rows] = await connection.execute(`SELECT ${idColumn} FROM ${table} WHERE user_id = ? AND ${idColumn} = ANY(?)`, [userId, ids]);
  if (rows.length !== ids.length) throw new ValidationError('Related entries must belong to the authenticated user.');
}

async function insertRelationshipRows(connection, table, idColumn, sessionId, targetIds) {
  if (!targetIds?.length) return;
  const placeholders = targetIds.map(() => '(?, ?)').join(', ');
  const params = targetIds.flatMap((targetId) => [sessionId, targetId]);
  await connection.execute(`INSERT INTO ${table} (id_session, ${idColumn}) VALUES ${placeholders}`, params);
}

async function insertRelationships(connection, sessionId, relationships, userId) {
  await ensureOwnedRelationships(connection, 'vocabulary', 'id_vocabulary', relationships.vocabularyIds, userId);
  await ensureOwnedRelationships(connection, 'kanji', 'id_kanji', relationships.kanjiIds, userId);
  await ensureOwnedRelationships(connection, 'grammar_points', 'id_grammar', relationships.grammarIds, userId);
  await insertRelationshipRows(connection, 'session_vocabulary', 'id_vocabulary', sessionId, relationships.vocabularyIds);
  await insertRelationshipRows(connection, 'session_kanji', 'id_kanji', sessionId, relationships.kanjiIds);
  await insertRelationshipRows(connection, 'session_grammar', 'id_grammar', sessionId, relationships.grammarIds);
}

async function createSession(req, res) {
  let connection;
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.sessions);
    const relationships = validateStudySessionPayload(body);
    const values = normalizeSession(body);
    const writing = normalizeWriting(body);

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      'INSERT INTO study_sessions (session_date, duration_minutes, category, resource, notes, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [values.sessionDate, values.durationMinutes, values.category, values.resource, values.notes, req.user.id]
    );
    await insertRelationships(connection, result.insertId, relationships, req.user.id);
    await saveWriting(connection, result.insertId, writing);
    if (writing) await recordKanjiEncounters(connection, req.user.id, writing.content, { type: ENCOUNTER_SOURCE_TYPES.SESSION_WRITING, sourceId: result.insertId });
    await connection.commit();
    connection.release();
    connection = null;

    return res.status(201).json(await fetchEntityById('sessions', result.insertId, req.user.id));
  } catch (error) {
    if (connection) await rollbackAndRelease(connection);
    return sendRouteError(res, error, { defaultMessage: 'Unable to create study session.' });
  }
}

async function updateSession(req, res) {
  let connection;
  try {
    const id = parseIdParam(req, 'study session');
    const current = await fetchEntityById('sessions', id, req.user.id);
    if (!current) return res.status(404).json({ error: 'study session not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.sessions);
    const relationships = validateStudySessionPayload(body, { partial: true });
    const values = normalizeSession(body, current);

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [writingRows] = await connection.execute('SELECT title, content, notes FROM session_writings WHERE id_session = ?', [id]);
    const writing = normalizeWriting(body, writingRows[0] || null);
    await connection.execute(
      'UPDATE study_sessions SET session_date = ?, duration_minutes = ?, category = ?, resource = ?, notes = ? WHERE id_session = ? AND user_id = ?',
      [values.sessionDate, values.durationMinutes, values.category, values.resource, values.notes, id, req.user.id]
    );

    if (relationships.vocabularyIds) {
      await connection.execute('DELETE FROM session_vocabulary WHERE id_session = ?', [id]);
    }
    if (relationships.kanjiIds) {
      await connection.execute('DELETE FROM session_kanji WHERE id_session = ?', [id]);
    }
    if (relationships.grammarIds) {
      await connection.execute('DELETE FROM session_grammar WHERE id_session = ?', [id]);
    }
    await insertRelationships(connection, id, relationships, req.user.id);
    await saveWriting(connection, id, writing);
    if (writing) await recordKanjiEncounters(connection, req.user.id, writing.content, { type: ENCOUNTER_SOURCE_TYPES.SESSION_WRITING, sourceId: id });
    await connection.commit();
    connection.release();
    connection = null;

    return res.json(await fetchEntityById('sessions', id, req.user.id));
  } catch (error) {
    if (connection) await rollbackAndRelease(connection);
    return sendRouteError(res, error, { defaultMessage: 'Unable to update study session.' });
  }
}

async function deleteSession(req, res) {
  try {
    const id = parseIdParam(req, 'study session');
    if (!await fetchEntityById('sessions', id, req.user.id)) return res.status(404).json({ error: 'study session not found' });
    await pool.execute('DELETE FROM study_sessions WHERE id_session = ? AND user_id = ?', [id, req.user.id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete study session.' });
  }
}

// GET /api/sessions/day-items?date=YYYY-MM-DD — one-click "link what I
// studied that day" evidence for the study-session form. Read-only, own
// data only (req.user.id), never invents records: vocabulary/kanji/grammar
// reuse the review-candidates evidence union for the single-day window
// (review_events.reviewed_at + session junctions via study_sessions.
// session_date + kanji_encounters.encountered_at (kanji-only) +
// created_at), content-log reads content_entries.content_date. All five
// statements are bounded set queries; no N+1, no writes.
//
// Shapes match the client picker labels so the form can auto-fill without
// new mapping logic: vocabulary {id:id_vocabulary,label:word},
// kanji {id:id_kanji,label:character_kanji}, grammar
// {id:id_grammar,label:grammar_point}, content
// {id:id_content_entry,label:title} (v2 Content Log card title).
//
// Ordering (documented): vocabulary/kanji/grammar inherit the
// review-candidates merged order — evidence strength first
// (review/session strong, then encounter moderate, then added weak),
// then latest date DESC, then entity id — sliced to DAY_ITEMS_LIMIT.
// For a single-day window every date is equal, so this is deterministic
// strength-then-id order. Content is newest-first
// (content_date DESC, id_content_entry DESC) sliced to DAY_ITEMS_LIMIT.
// Empty days return empty arrays, never 404/500. Invalid date → 400.
function toDayItemPair(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = Number(entry.entityId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const label = typeof entry.display === 'string' ? entry.display : null;
  if (!label) return null;
  return { id, label };
}

async function getDayItems(req, res) {
  try {
    const date = req.query?.date;
    if (!isValidDateString(date)) {
      throw new ValidationError('Invalid date format (YYYY-MM-DD)');
    }
    const groupsPromise = getReviewCandidates(pool, req.user.id, {
      from: date,
      to: date,
      jlpt: 'all',
      types: ['kanji', 'vocabulary', 'grammar']
    });
    const contentPromise = pool.execute(
      'SELECT id_content_entry, title FROM content_entries WHERE user_id = ? AND content_date = ? ORDER BY content_date DESC, id_content_entry DESC LIMIT 50',
      [req.user.id, date]
    );
    const [groups, [contentRows]] = await Promise.all([groupsPromise, contentPromise]);
    const vocabulary = ((groups && groups.vocabulary && groups.vocabulary.items) || [])
      .map(toDayItemPair)
      .filter(Boolean)
      .slice(0, DAY_ITEMS_LIMIT);
    const kanji = ((groups && groups.kanji && groups.kanji.items) || [])
      .map(toDayItemPair)
      .filter(Boolean)
      .slice(0, DAY_ITEMS_LIMIT);
    const grammar = ((groups && groups.grammar && groups.grammar.items) || [])
      .map(toDayItemPair)
      .filter(Boolean)
      .slice(0, DAY_ITEMS_LIMIT);
    const content = (contentRows || [])
      .filter((row) => row && Number.isInteger(Number(row.id_content_entry)) && Number(row.id_content_entry) > 0 && typeof row.title === 'string' && row.title)
      .slice(0, DAY_ITEMS_LIMIT)
      .map((row) => ({ id: Number(row.id_content_entry), label: row.title }));
    return res.json({ date, vocabulary, kanji, grammar, content });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load day items.' });
  }
}

module.exports = { createSession, deleteSession, getDayItems, getSession, listSessions, updateSession };
