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

async function listKanji(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    let whereSql = ' WHERE 1=1';
    const params = [];

    const search = normalizeText(req.query.search, 100, 'search');
    if (search) {
      const searchTerm = `%${search}%`;
      whereSql += ' AND (character_kanji LIKE ? OR meaning LIKE ? OR onyomi LIKE ? OR kunyomi LIKE ?)';
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    if (req.query.jlpt) {
      const jlpt = normalizeText(req.query.jlpt, 2, 'jlpt').toUpperCase();
      if (!JLPT_LEVELS.includes(jlpt)) return res.status(400).json({ error: 'Invalid JLPT level' });
      whereSql += ' AND jlpt_level = ?';
      params.push(jlpt);
    }
    if (req.query.status) {
      const status = normalizeText(req.query.status, 20, 'status');
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      whereSql += ' AND status = ?';
      params.push(status);
    }

    return res.json(await executePaginatedList(pool, {
      table: 'kanji',
      columns: 'id_kanji, character_kanji, meaning, onyomi, kunyomi, jlpt_level, status',
      whereSql,
      params,
      orderBy: 'id_kanji DESC',
      page,
      limit,
      offset
    }));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Database unavailable' });
  }
}

async function listKanjiOptions(req, res) {
  try {
    const limit = parseOptionLimit(req.query.limit);
    const search = normalizeText(req.query.search, 100, 'search');
    const params = [];
    let whereSql = '';
    if (search) {
      const term = `%${search}%`;
      whereSql = ' WHERE character_kanji LIKE ? OR meaning LIKE ? OR onyomi LIKE ? OR kunyomi LIKE ?';
      params.push(term, term, term, term);
    }
    const [items] = await pool.execute(
      `SELECT id_kanji, character_kanji, meaning FROM kanji${whereSql} ORDER BY id_kanji DESC LIMIT ?`,
      [...params, limit]
    );
    return res.json({ items });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load kanji options.' });
  }
}

async function getKanji(req, res) {
  try {
    const id = parseIdParam(req, 'kanji entry');
    const entry = await fetchEntityById('kanji', id);
    if (!entry) return res.status(404).json({ error: 'kanji entry not found' });

    const [vocabulary] = await pool.execute(
      'SELECT v.id_vocabulary, v.word, v.reading, v.meaning, v.jlpt_level, v.status FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary WHERE kv.id_kanji = ? ORDER BY v.word',
      [id]
    );
    return res.json({ ...entry, vocabulary });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load kanji entry.' });
  }
}

function normalizeKanji(body, current = {}) {
  const character = body.character_kanji !== undefined
    ? normalizeText(body.character_kanji, 4, 'character_kanji')
    : current.character_kanji;
  const meaning = body.meaning !== undefined ? normalizeText(body.meaning, 255, 'meaning') : current.meaning;
  if (body.character_kanji !== undefined && !character) throw new ValidationError('character_kanji is required.');
  if (body.meaning !== undefined && !meaning) throw new ValidationError('meaning is required.');

  return {
    character,
    meaning,
    onyomi: body.onyomi !== undefined ? normalizeText(body.onyomi, 255, 'onyomi') : (current.onyomi ?? null),
    kunyomi: body.kunyomi !== undefined ? normalizeText(body.kunyomi, 255, 'kunyomi') : (current.kunyomi ?? null),
    jlptLevel: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2, 'jlpt_level')) : (current.jlpt_level ?? null),
    status: body.status !== undefined ? normalizeText(body.status, 20, 'status') || current.status : (current.status || 'New'),
    notes: body.notes !== undefined ? normalizeText(body.notes, 1500, 'notes') : (current.notes ?? null)
  };
}

async function createKanji(req, res) {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.kanji);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: true });
    if (body.character_kanji === undefined) {
      throw new ValidationError('character_kanji is required.');
    }
    const values = normalizeKanji({
      ...body,
      status: body.status === undefined || body.status === null || body.status === '' ? 'New' : body.status
    });
    const [result] = await pool.execute(
      'INSERT INTO kanji (character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [values.character, values.meaning, values.onyomi, values.kunyomi, values.jlptLevel, values.status, values.notes]
    );
    return res.status(201).json(await fetchEntityById('kanji', result.insertId));
  } catch (error) {
    return sendRouteError(res, error, {
      defaultMessage: 'Unable to create kanji entry.',
      conflictMessage: 'Kanji already exists.'
    });
  }
}

async function updateKanji(req, res) {
  try {
    const id = parseIdParam(req, 'kanji entry');
    const current = await fetchEntityById('kanji', id);
    if (!current) return res.status(404).json({ error: 'kanji entry not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.kanji);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });
    const values = normalizeKanji(body, current);
    await pool.execute(
      'UPDATE kanji SET character_kanji = ?, meaning = ?, onyomi = ?, kunyomi = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_kanji = ?',
      [values.character, values.meaning, values.onyomi, values.kunyomi, values.jlptLevel, values.status, values.notes, id]
    );
    return res.json(await fetchEntityById('kanji', id));
  } catch (error) {
    return sendRouteError(res, error, {
      defaultMessage: 'Unable to update kanji entry.',
      conflictMessage: 'Kanji already exists.'
    });
  }
}

async function deleteKanji(req, res) {
  try {
    const id = parseIdParam(req, 'kanji entry');
    if (!await fetchEntityById('kanji', id)) return res.status(404).json({ error: 'kanji entry not found' });
    await pool.execute('DELETE FROM kanji WHERE id_kanji = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete kanji entry.' });
  }
}

module.exports = { createKanji, deleteKanji, getKanji, listKanji, listKanjiOptions, updateKanji };
