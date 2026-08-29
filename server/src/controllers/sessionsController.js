const pool = require('../config/db');
const { ALLOWED_FIELDS, STUDY_CATEGORIES } = require('../constants');
const { sendRouteError } = require('../errors/http');
const {
  isValidDateString,
  normalizeText,
  parseIdParam,
  validateStudySessionPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById, rollbackAndRelease } = require('./helpers');

async function listSessions(req, res) {
  try {
    let query = 'SELECT id_session, session_date, duration_minutes, category, resource, notes FROM study_sessions WHERE 1=1';
    const params = [];

    if (req.query.category) {
      const category = String(req.query.category);
      if (!STUDY_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
      query += ' AND category = ?';
      params.push(category);
    }

    if (req.query.date) {
      if (!isValidDateString(req.query.date)) {
        return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
      }
      query += ' AND session_date = ?';
      params.push(req.query.date);
    } else {
      if (req.query.from) {
        if (!isValidDateString(req.query.from)) {
          return res.status(400).json({ error: 'Invalid from date (YYYY-MM-DD)' });
        }
        query += ' AND session_date >= ?';
        params.push(req.query.from);
      }
      if (req.query.to) {
        if (!isValidDateString(req.query.to)) {
          return res.status(400).json({ error: 'Invalid to date (YYYY-MM-DD)' });
        }
        query += ' AND session_date <= ?';
        params.push(req.query.to);
      }
    }

    query += ' ORDER BY session_date DESC, id_session DESC LIMIT 100';
    const [rows] = await pool.execute(query, params);
    return res.json(rows);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Database unavailable' });
  }
}

async function getSession(req, res) {
  try {
    const id = parseIdParam(req, 'study session');
    const session = await fetchEntityById('sessions', id);
    if (!session) return res.status(404).json({ error: 'study session not found' });

    const [vocabulary] = await pool.execute(
      'SELECT v.id_vocabulary, v.word, v.reading, v.meaning, v.jlpt_level, v.status FROM session_vocabulary sv JOIN vocabulary v ON sv.id_vocabulary = v.id_vocabulary WHERE sv.id_session = ?',
      [id]
    );
    const [kanji] = await pool.execute(
      'SELECT k.id_kanji, k.character_kanji, k.meaning, k.onyomi, k.kunyomi, k.jlpt_level, k.status FROM session_kanji sk JOIN kanji k ON sk.id_kanji = k.id_kanji WHERE sk.id_session = ?',
      [id]
    );
    const [grammar] = await pool.execute(
      'SELECT g.id_grammar, g.grammar_point, g.meaning, g.structure, g.example, g.jlpt_level, g.status FROM session_grammar sg JOIN grammar_points g ON sg.id_grammar = g.id_grammar WHERE sg.id_session = ?',
      [id]
    );

    return res.json({ ...session, vocabulary, kanji, grammar });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load study session.' });
  }
}

function normalizeSession(body, current = {}) {
  return {
    sessionDate: body.session_date !== undefined ? normalizeText(body.session_date) || current.session_date : current.session_date,
    durationMinutes: body.duration_minutes !== undefined ? Number(body.duration_minutes) : current.duration_minutes,
    category: body.category !== undefined ? normalizeText(body.category, 20) || current.category : current.category,
    resource: body.resource !== undefined ? normalizeText(body.resource, 255) : (current.resource ?? null),
    notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : (current.notes ?? null)
  };
}

async function insertRelationships(connection, sessionId, relationships) {
  for (const vocabularyId of relationships.vocabularyIds || []) {
    await connection.execute(
      'INSERT INTO session_vocabulary (id_session, id_vocabulary) VALUES (?, ?)',
      [sessionId, vocabularyId]
    );
  }
  for (const kanjiId of relationships.kanjiIds || []) {
    await connection.execute(
      'INSERT INTO session_kanji (id_session, id_kanji) VALUES (?, ?)',
      [sessionId, kanjiId]
    );
  }
  for (const grammarId of relationships.grammarIds || []) {
    await connection.execute(
      'INSERT INTO session_grammar (id_session, id_grammar) VALUES (?, ?)',
      [sessionId, grammarId]
    );
  }
}

async function createSession(req, res) {
  let connection;
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.sessions);
    const relationships = validateStudySessionPayload(body);
    const values = normalizeSession(body);

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      'INSERT INTO study_sessions (session_date, duration_minutes, category, resource, notes) VALUES (?, ?, ?, ?, ?)',
      [values.sessionDate, values.durationMinutes, values.category, values.resource, values.notes]
    );
    await insertRelationships(connection, result.insertId, relationships);
    await connection.commit();
    connection.release();
    connection = null;

    return res.status(201).json(await fetchEntityById('sessions', result.insertId));
  } catch (error) {
    if (connection) await rollbackAndRelease(connection);
    return sendRouteError(res, error, { defaultMessage: 'Unable to create study session.' });
  }
}

async function updateSession(req, res) {
  let connection;
  try {
    const id = parseIdParam(req, 'study session');
    const current = await fetchEntityById('sessions', id);
    if (!current) return res.status(404).json({ error: 'study session not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.sessions);
    const relationships = validateStudySessionPayload(body, { partial: true });
    const values = normalizeSession(body, current);

    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      'UPDATE study_sessions SET session_date = ?, duration_minutes = ?, category = ?, resource = ?, notes = ? WHERE id_session = ?',
      [values.sessionDate, values.durationMinutes, values.category, values.resource, values.notes, id]
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
    await insertRelationships(connection, id, relationships);
    await connection.commit();
    connection.release();
    connection = null;

    return res.json(await fetchEntityById('sessions', id));
  } catch (error) {
    if (connection) await rollbackAndRelease(connection);
    return sendRouteError(res, error, { defaultMessage: 'Unable to update study session.' });
  }
}

async function deleteSession(req, res) {
  try {
    const id = parseIdParam(req, 'study session');
    if (!await fetchEntityById('sessions', id)) return res.status(404).json({ error: 'study session not found' });
    await pool.execute('DELETE FROM study_sessions WHERE id_session = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete study session.' });
  }
}

module.exports = { createSession, deleteSession, getSession, listSessions, updateSession };
