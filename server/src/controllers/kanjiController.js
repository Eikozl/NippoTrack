const pool = require('../config/db');
const { ALLOWED_FIELDS, JLPT_LEVELS, STATUSES } = require('../constants');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseOptionLimit, parsePagination } = require('../pagination');
const { buildSearchCandidates } = require('../search/japaneseSearch');
const { rankKanjiOptions } = require('../search/optionRanking');
const { buildComparisons, kanaSearchValues, normalizedJapaneseSql } = require('../search/sqlSearch');
const {
  normalizeText,
  parseIdParam,
  validateStandardRecordPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById } = require('./helpers');
const { executePaginatedList } = require('./listHelpers');
const { createReviewItem } = require('./reviewController');

async function listKanji(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    let whereSql = ' WHERE 1=1';
    const params = [];
    let orderBy = 'id_kanji DESC';
    let orderParams = [];

    const search = normalizeText(req.query.search, 100, 'search');
    if (search) {
      const candidates = buildSearchCandidates(search);
      const rawContains = `%${candidates.raw}%`;
      const rawPrefix = `${candidates.raw}%`;
      const meaningWordPrefix = `% ${candidates.raw}%`;
      const kanaValues = kanaSearchValues(candidates);
      const normalizedOnyomi = normalizedJapaneseSql('onyomi');
      const normalizedKunyomi = normalizedJapaneseSql('kunyomi');
      const kanaContains = buildComparisons([normalizedOnyomi, normalizedKunyomi], kanaValues);
      const kanaExact = buildComparisons([normalizedOnyomi, normalizedKunyomi], kanaValues, { operator: '=' });
      const kanaPrefix = buildComparisons([normalizedOnyomi, normalizedKunyomi], kanaValues, { pattern: 'prefix' });
      whereSql += ` AND (character_kanji LIKE ? OR meaning LIKE ? OR onyomi LIKE ? OR kunyomi LIKE ?${kanaContains.sql ? ` OR ${kanaContains.sql}` : ''})`;
      params.push(rawContains, rawContains, rawContains, rawContains, ...kanaContains.params);
      orderBy = `CASE
        WHEN character_kanji = ? THEN 1
        WHEN onyomi = ? OR kunyomi = ? THEN 2
        ${kanaExact.sql ? `WHEN ${kanaExact.sql} THEN 3` : ''}
        WHEN onyomi LIKE ? OR kunyomi LIKE ? THEN 4
        ${kanaPrefix.sql ? `WHEN ${kanaPrefix.sql} THEN 5` : ''}
        WHEN meaning LIKE ? OR CONCAT(' ', COALESCE(meaning, '')) LIKE ? THEN 6
        ELSE 7 END, id_kanji DESC`;
      orderParams = [
        candidates.raw, candidates.raw, candidates.raw, ...kanaExact.params,
        rawPrefix, rawPrefix, ...kanaPrefix.params, rawPrefix, meaningWordPrefix
      ];
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
      orderBy,
      orderParams,
      userId: req.user.id,
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
    const candidates = buildSearchCandidates(search || '');
    const normalizedOnyomi = normalizedJapaneseSql('onyomi');
    const normalizedKunyomi = normalizedJapaneseSql('kunyomi');
    let query = 'SELECT id_kanji, character_kanji, meaning, onyomi, kunyomi FROM kanji WHERE user_id = ?';
    let params = [req.user.id, limit];

    if (search) {
      const rawContains = `%${candidates.raw}%`;
      const rawPrefix = `${candidates.raw}%`;
      const meaningWordPrefix = `% ${candidates.raw}%`;
      const kanaValues = kanaSearchValues(candidates);
      const kanaContains = buildComparisons([normalizedOnyomi, normalizedKunyomi], kanaValues);
      const kanaExact = buildComparisons([normalizedOnyomi, normalizedKunyomi], kanaValues, { operator: '=' });
      const kanaPrefix = buildComparisons([normalizedOnyomi, normalizedKunyomi], kanaValues, { pattern: 'prefix' });
      const candidateLimit = Math.min(limit * 5, 200);
      query += ` AND (character_kanji LIKE ? OR meaning LIKE ? OR onyomi LIKE ? OR kunyomi LIKE ?
        ${kanaContains.sql ? `OR ${kanaContains.sql}` : ''})`;
      query += ` ORDER BY CASE
        WHEN character_kanji = ? THEN 1
        WHEN onyomi = ? OR kunyomi = ? THEN 2
        ${kanaExact.sql ? `WHEN ${kanaExact.sql} THEN 3` : ''}
        WHEN onyomi LIKE ? OR kunyomi LIKE ? THEN 4
        ${kanaPrefix.sql ? `WHEN ${kanaPrefix.sql} THEN 5` : ''}
        WHEN meaning LIKE ? OR CONCAT(' ', COALESCE(meaning, '')) LIKE ? THEN 6
        ELSE 7 END, id_kanji DESC LIMIT ?`;
      params = [
        req.user.id, rawContains, rawContains, rawContains, rawContains, ...kanaContains.params,
        candidates.raw, candidates.raw, candidates.raw, ...kanaExact.params,
        rawPrefix, rawPrefix, ...kanaPrefix.params, rawPrefix, meaningWordPrefix,
        candidateLimit
      ];
    } else {
      query += ' ORDER BY id_kanji DESC LIMIT ?';
    }

    const [rows] = await pool.execute(query, params);
    return res.json({ items: rankKanjiOptions(rows, candidates, limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load kanji options.' });
  }
}

async function getKanji(req, res) {
  try {
    const id = parseIdParam(req, 'kanji entry');
    const entry = await fetchEntityById('kanji', id, req.user.id);
    if (!entry) return res.status(404).json({ error: 'kanji entry not found' });

    const [vocabulary] = await pool.execute(
      'SELECT v.id_vocabulary, v.word, v.reading, v.meaning, v.jlpt_level, v.status FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary WHERE kv.id_kanji = ? AND v.user_id = ? ORDER BY v.word',
      [id, req.user.id]
    );
    const [usageExamples] = await pool.execute(
      'SELECT v.id_vocabulary, v.word, v.reading, ue.id_usage_example, ue.sentence, ue.translation FROM kanji_vocabulary kv JOIN vocabulary v ON kv.id_vocabulary = v.id_vocabulary JOIN usage_examples ue ON ue.id_vocabulary = v.id_vocabulary WHERE kv.id_kanji = ? AND v.user_id = ? ORDER BY v.word, ue.id_usage_example DESC',
      [id, req.user.id]
    );
    return res.json({ ...entry, vocabulary, usageExamples });
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
      'INSERT INTO kanji (character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [values.character, values.meaning, values.onyomi, values.kunyomi, values.jlptLevel, values.status, values.notes, req.user.id]
    );
    await createReviewItem(pool, 'id_kanji', result.insertId);
    return res.status(201).json(await fetchEntityById('kanji', result.insertId, req.user.id));
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
    const current = await fetchEntityById('kanji', id, req.user.id);
    if (!current) return res.status(404).json({ error: 'kanji entry not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.kanji);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });
    const values = normalizeKanji(body, current);
    await pool.execute(
      'UPDATE kanji SET character_kanji = ?, meaning = ?, onyomi = ?, kunyomi = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_kanji = ? AND user_id = ?',
      [values.character, values.meaning, values.onyomi, values.kunyomi, values.jlptLevel, values.status, values.notes, id, req.user.id]
    );
    return res.json(await fetchEntityById('kanji', id, req.user.id));
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
    if (!await fetchEntityById('kanji', id, req.user.id)) return res.status(404).json({ error: 'kanji entry not found' });
    await pool.execute('DELETE FROM kanji WHERE id_kanji = ? AND user_id = ?', [id, req.user.id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete kanji entry.' });
  }
}

module.exports = { createKanji, deleteKanji, getKanji, listKanji, listKanjiOptions, updateKanji };
