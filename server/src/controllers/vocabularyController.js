const pool = require('../config/db');
const { ALLOWED_FIELDS, JLPT_LEVELS, STATUSES } = require('../constants');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseOptionLimit, parsePagination } = require('../pagination');
const {
  normalizeText,
  parseIdParam,
  validateStandardRecordPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById } = require('./helpers');
const { executePaginatedList } = require('./listHelpers');

async function listVocabulary(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    let whereSql = ' WHERE 1=1';
    const params = [];

    const search = normalizeText(req.query.search, 100, 'search');
    if (search) {
      const searchTerm = `%${search}%`;
      whereSql += ' AND (word LIKE ? OR reading LIKE ? OR meaning LIKE ?)';
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (req.query.jlpt) {
      const jlpt = normalizeText(req.query.jlpt, 2, 'jlpt').toUpperCase();
      if (!JLPT_LEVELS.includes(jlpt)) {
        return res.status(400).json({ error: 'Invalid JLPT level' });
      }
      whereSql += ' AND jlpt_level = ?';
      params.push(jlpt);
    }

    if (req.query.status) {
      const status = normalizeText(req.query.status, 20, 'status');
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      whereSql += ' AND status = ?';
      params.push(status);
    }

    return res.json(await executePaginatedList(pool, {
      table: 'vocabulary',
      columns: 'id_vocabulary, word, reading, meaning, jlpt_level, status',
      whereSql,
      params,
      orderBy: 'id_vocabulary DESC',
      page,
      limit,
      offset
    }));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Database unavailable' });
  }
}

async function listVocabularyOptions(req, res) {
  try {
    const limit = parseOptionLimit(req.query.limit);
    const search = normalizeText(req.query.search, 100, 'search');
    const params = [];
    let whereSql = '';

    if (search) {
      const term = `%${search}%`;
      whereSql = ' WHERE word LIKE ? OR reading LIKE ? OR meaning LIKE ?';
      params.push(term, term, term);
    }

    const [items] = await pool.execute(
      `SELECT id_vocabulary, word, reading, meaning FROM vocabulary${whereSql} ORDER BY id_vocabulary DESC LIMIT ?`,
      [...params, limit]
    );
    return res.json({ items });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load vocabulary options.' });
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
      word: normalizeText(body.word, 100, 'word'),
      reading: normalizeText(body.reading, 150, 'reading'),
      meaning: normalizeText(body.meaning, 255, 'meaning'),
      jlptLevel: body.jlpt_level === undefined || body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2, 'jlpt_level'),
      status: normalizeText(body.status, 20, 'status') || 'New',
      notes: normalizeText(body.notes, 1500, 'notes')
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
    const word = body.word !== undefined ? normalizeText(body.word, 100, 'word') : current.word;
    const meaning = body.meaning !== undefined ? normalizeText(body.meaning, 255, 'meaning') : current.meaning;
    if (body.word !== undefined && !word) throw new ValidationError('word is required.');
    if (body.meaning !== undefined && !meaning) throw new ValidationError('meaning is required.');
    const values = {
      word,
      reading: body.reading !== undefined ? normalizeText(body.reading, 150, 'reading') : current.reading,
      meaning,
      jlptLevel: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2, 'jlpt_level')) : current.jlpt_level,
      status: body.status !== undefined ? normalizeText(body.status, 20, 'status') || current.status : current.status,
      notes: body.notes !== undefined ? normalizeText(body.notes, 1500, 'notes') : current.notes
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
  listVocabularyOptions,
  listVocabulary,
  updateVocabulary
};
