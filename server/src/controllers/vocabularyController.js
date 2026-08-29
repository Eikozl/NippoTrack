const pool = require('../config/db');
const { ALLOWED_FIELDS, JLPT_LEVELS, STATUSES } = require('../constants');
const { sendRouteError } = require('../errors/http');
const {
  normalizeText,
  parseIdParam,
  validateStandardRecordPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById } = require('./helpers');

async function listVocabulary(req, res) {
  try {
    let query = 'SELECT id_vocabulary, word, reading, meaning, jlpt_level, status FROM vocabulary WHERE 1=1';
    const params = [];

    if (req.query.search) {
      const searchTerm = `%${String(req.query.search).trim()}%`;
      query += ' AND (word LIKE ? OR reading LIKE ? OR meaning LIKE ?)';
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (req.query.jlpt) {
      const jlpt = String(req.query.jlpt).toUpperCase();
      if (!JLPT_LEVELS.includes(jlpt)) {
        return res.status(400).json({ error: 'Invalid JLPT level' });
      }
      query += ' AND jlpt_level = ?';
      params.push(jlpt);
    }

    if (req.query.status) {
      const status = String(req.query.status);
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY id_vocabulary DESC LIMIT 100';
    const [rows] = await pool.execute(query, params);
    return res.json(rows);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Database unavailable' });
  }
}

async function getVocabulary(req, res) {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const entry = await fetchEntityById('vocabulary', id);

    if (!entry) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }

    const [kanji] = await pool.execute(
      'SELECT k.id_kanji, k.character_kanji, k.meaning, k.jlpt_level, k.status FROM kanji_vocabulary kv JOIN kanji k ON kv.id_kanji = k.id_kanji WHERE kv.id_vocabulary = ? ORDER BY k.character_kanji',
      [id]
    );
    return res.json({ ...entry, kanji });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load vocabulary entry.' });
  }
}

async function createVocabulary(req, res) {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.vocabulary);
    validateStandardRecordPayload(body, { requiredWord: true, requiredMeaning: true });
    const values = {
      word: normalizeText(body.word, 100),
      reading: normalizeText(body.reading, 150),
      meaning: normalizeText(body.meaning, 255),
      jlptLevel: body.jlpt_level === undefined || body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2),
      status: normalizeText(body.status, 20) || 'New',
      notes: normalizeText(body.notes, 1500)
    };
    const [result] = await pool.execute(
      'INSERT INTO vocabulary (word, reading, meaning, jlpt_level, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [values.word, values.reading, values.meaning, values.jlptLevel, values.status, values.notes]
    );
    const created = await fetchEntityById('vocabulary', result.insertId);
    return res.status(201).json(created);
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to create vocabulary entry.' });
  }
}

async function updateVocabulary(req, res) {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const current = await fetchEntityById('vocabulary', id);
    if (!current) return res.status(404).json({ error: 'vocabulary entry not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.vocabulary);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });
    const values = {
      word: body.word !== undefined ? normalizeText(body.word, 100) || current.word : current.word,
      reading: body.reading !== undefined ? normalizeText(body.reading, 150) : current.reading,
      meaning: body.meaning !== undefined ? normalizeText(body.meaning, 255) || current.meaning : current.meaning,
      jlptLevel: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2)) : current.jlpt_level,
      status: body.status !== undefined ? normalizeText(body.status, 20) || current.status : current.status,
      notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : current.notes
    };
    await pool.execute(
      'UPDATE vocabulary SET word = ?, reading = ?, meaning = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_vocabulary = ?',
      [values.word, values.reading, values.meaning, values.jlptLevel, values.status, values.notes, id]
    );
    return res.json(await fetchEntityById('vocabulary', id));
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to update vocabulary entry.' });
  }
}

async function deleteVocabulary(req, res) {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    if (!await fetchEntityById('vocabulary', id)) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }
    await pool.execute('DELETE FROM vocabulary WHERE id_vocabulary = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete vocabulary entry.' });
  }
}

module.exports = {
  createVocabulary,
  deleteVocabulary,
  getVocabulary,
  listVocabulary,
  updateVocabulary
};
