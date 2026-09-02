const pool = require('../config/db');
const { ALLOWED_FIELDS, JLPT_LEVELS, STATUSES } = require('../constants');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseOptionLimit, parsePagination } = require('../pagination');
const { buildSearchCandidates } = require('../search/japaneseSearch');
const { rankVocabularyOptions } = require('../search/optionRanking');
const { buildComparisons, kanaSearchValues, normalizedJapaneseSql } = require('../search/sqlSearch');
const {
  normalizeText,
  parseIdParam,
  validateStandardRecordPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById, rollbackAndRelease } = require('./helpers');
const { executePaginatedList } = require('./listHelpers');
const { createReviewItem } = require('./reviewController');
const { syncVocabularyKanjiLinks } = require('../services/kanjiVocabularyLinks');
const { ENCOUNTER_SOURCE_TYPES, recordKanjiEncounters } = require('../services/kanjiEncounters');

async function listVocabulary(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    let whereSql = ' WHERE 1=1';
    const params = [];
    let orderBy = 'id_vocabulary DESC';
    let orderParams = [];

    const search = normalizeText(req.query.search, 100, 'search');
    if (search) {
      const candidates = buildSearchCandidates(search);
      const rawContains = `%${candidates.raw}%`;
      const rawPrefix = `${candidates.raw}%`;
      const meaningWordPrefix = `% ${candidates.raw}%`;
      const kanaValues = kanaSearchValues(candidates);
      const normalizedWord = normalizedJapaneseSql('word');
      const normalizedReading = normalizedJapaneseSql('reading');
      const kanaContains = buildComparisons([normalizedWord, normalizedReading], kanaValues);
      const kanaExact = buildComparisons([normalizedWord, normalizedReading], kanaValues, { operator: '=' });
      const kanaPrefix = buildComparisons([normalizedWord, normalizedReading], kanaValues, { pattern: 'prefix' });
      whereSql += ` AND (word LIKE ? OR reading LIKE ? OR meaning LIKE ?${kanaContains.sql ? ` OR ${kanaContains.sql}` : ''})`;
      params.push(rawContains, rawContains, rawContains, ...kanaContains.params);
      orderBy = `CASE
        WHEN word = ? THEN 1
        WHEN reading = ? THEN 2
        ${kanaExact.sql ? `WHEN ${kanaExact.sql} THEN 3` : ''}
        WHEN word LIKE ? THEN 4
        WHEN reading LIKE ? THEN 5
        ${kanaPrefix.sql ? `WHEN ${kanaPrefix.sql} THEN 6` : ''}
        WHEN meaning LIKE ? OR CONCAT(' ', COALESCE(meaning, '')) LIKE ? THEN 7
        ELSE 8 END, id_vocabulary DESC`;
      orderParams = [
        candidates.raw, candidates.raw, ...kanaExact.params,
        rawPrefix, rawPrefix, ...kanaPrefix.params, rawPrefix, meaningWordPrefix
      ];
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

async function listVocabularyOptions(req, res) {
  try {
    const limit = parseOptionLimit(req.query.limit);
    const search = normalizeText(req.query.search, 100, 'search');
    const candidates = buildSearchCandidates(search || '');
    const normalizedWord = normalizedJapaneseSql('word');
    const normalizedReading = normalizedJapaneseSql('reading');
    let query = 'SELECT id_vocabulary, word, reading, meaning FROM vocabulary WHERE user_id = ?';
    let params = [req.user.id, limit];

    if (search) {
      const rawContains = `%${candidates.raw}%`;
      const rawPrefix = `${candidates.raw}%`;
      const meaningWordPrefix = `% ${candidates.raw}%`;
      const kanaValues = kanaSearchValues(candidates);
      const kanaContains = buildComparisons([normalizedWord, normalizedReading], kanaValues);
      const kanaExact = buildComparisons([normalizedWord, normalizedReading], kanaValues, { operator: '=' });
      const kanaPrefix = buildComparisons([normalizedWord, normalizedReading], kanaValues, { pattern: 'prefix' });
      const candidateLimit = Math.min(limit * 5, 200);
      query += ` AND (word LIKE ? OR reading LIKE ? OR meaning LIKE ?${kanaContains.sql ? ` OR ${kanaContains.sql}` : ''})`;
      query += ` ORDER BY CASE
        WHEN word = ? THEN 1
        WHEN reading = ? THEN 2
        ${kanaExact.sql ? `WHEN ${kanaExact.sql} THEN 3` : ''}
        WHEN word LIKE ? THEN 4
        WHEN reading LIKE ? THEN 5
        ${kanaPrefix.sql ? `WHEN ${kanaPrefix.sql} THEN 6` : ''}
        WHEN meaning LIKE ? OR CONCAT(' ', COALESCE(meaning, '')) LIKE ? THEN 7
        ELSE 8 END, id_vocabulary DESC LIMIT ?`;
      params = [
        req.user.id, rawContains, rawContains, rawContains, ...kanaContains.params,
        candidates.raw, candidates.raw, ...kanaExact.params,
        rawPrefix, rawPrefix, ...kanaPrefix.params, rawPrefix, meaningWordPrefix,
        candidateLimit
      ];
    } else {
      query += ' ORDER BY id_vocabulary DESC LIMIT ?';
    }

    const [rows] = await pool.execute(query, params);
    return res.json({ items: rankVocabularyOptions(rows, candidates, limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load vocabulary options.' });
  }
}

async function getVocabulary(req, res) {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const entry = await fetchEntityById('vocabulary', id, req.user.id);

    if (!entry) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }

    const [kanji] = await pool.execute(
      'SELECT k.id_kanji, k.character_kanji, k.meaning, k.jlpt_level, k.status FROM kanji_vocabulary kv JOIN kanji k ON kv.id_kanji = k.id_kanji WHERE kv.id_vocabulary = ? AND k.user_id = ? ORDER BY k.character_kanji',
      [id, req.user.id]
    );
    const [examples] = await pool.execute(
      'SELECT id_usage_example, sentence, translation, notes FROM usage_examples WHERE id_vocabulary = ? ORDER BY id_usage_example DESC',
      [id]
    );
    return res.json({ ...entry, kanji, examples });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load vocabulary entry.' });
  }
}

async function createVocabulary(req, res) {
  let connection;
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
    const exampleSentence = normalizeText(body.example_sentence, 2000, 'example_sentence');
    const exampleTranslation = normalizeText(body.example_translation, 2000, 'example_translation');
    const exampleNotes = normalizeText(body.example_notes, 1500, 'example_notes');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      'INSERT INTO vocabulary (word, reading, meaning, jlpt_level, status, notes, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [values.word, values.reading, values.meaning, values.jlptLevel, values.status, values.notes, req.user.id]
    );
    await syncVocabularyKanjiLinks(connection, { userId: req.user.id, vocabularyId: result.insertId, word: values.word });
    await recordKanjiEncounters(connection, req.user.id, values.word, { type: ENCOUNTER_SOURCE_TYPES.VOCABULARY, sourceId: result.insertId });
    if (exampleSentence) {
      await connection.execute('INSERT INTO usage_examples (id_vocabulary, sentence, translation, notes) VALUES (?, ?, ?, ?)', [result.insertId, exampleSentence, exampleTranslation, exampleNotes]);
    }
    await createReviewItem(connection, 'id_vocabulary', result.insertId);
    await connection.commit();
    connection.release();
    connection = null;
    const created = await fetchEntityById('vocabulary', result.insertId, req.user.id);
    return res.status(201).json(created);
  } catch (error) {
    if (connection) await rollbackAndRelease(connection);
    return sendRouteError(res, error, { defaultMessage: 'Unable to create vocabulary entry.' });
  }
}

async function updateVocabulary(req, res) {
  let connection;
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const current = await fetchEntityById('vocabulary', id, req.user.id);
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
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      'UPDATE vocabulary SET word = ?, reading = ?, meaning = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_vocabulary = ? AND user_id = ?',
      [values.word, values.reading, values.meaning, values.jlptLevel, values.status, values.notes, id, req.user.id]
    );
    await syncVocabularyKanjiLinks(connection, { userId: req.user.id, vocabularyId: id, word: values.word });
    await recordKanjiEncounters(connection, req.user.id, values.word, { type: ENCOUNTER_SOURCE_TYPES.VOCABULARY, sourceId: id });
    await connection.commit();
    connection.release();
    connection = null;
    return res.json(await fetchEntityById('vocabulary', id, req.user.id));
  } catch (error) {
    if (connection) await rollbackAndRelease(connection);
    return sendRouteError(res, error, { defaultMessage: 'Unable to update vocabulary entry.' });
  }
}

async function deleteVocabulary(req, res) {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    if (!await fetchEntityById('vocabulary', id, req.user.id)) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }
    await pool.execute('DELETE FROM vocabulary WHERE id_vocabulary = ? AND user_id = ?', [id, req.user.id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete vocabulary entry.' });
  }
}

function exampleValues(body, { partial = false } = {}) {
  const allowed = ['sentence', 'translation', 'notes'];
  validateWriteFields(body, allowed);
  if (!partial && body.sentence === undefined) throw new ValidationError('sentence is required.');
  const sentence = body.sentence === undefined ? undefined : normalizeText(body.sentence, 2000, 'sentence');
  if (!partial && !sentence) throw new ValidationError('sentence is required.');
  if (body.sentence !== undefined && !sentence) throw new ValidationError('sentence is required.');
  return { sentence, translation: body.translation === undefined ? undefined : normalizeText(body.translation, 2000, 'translation'), notes: body.notes === undefined ? undefined : normalizeText(body.notes, 1500, 'notes') };
}

async function createVocabularyExample(req, res) {
  try {
    const vocabularyId = parseIdParam(req, 'vocabulary entry');
    if (!await fetchEntityById('vocabulary', vocabularyId, req.user.id)) return res.status(404).json({ error: 'vocabulary entry not found' });
    const values = exampleValues(req.body || {});
    const [result] = await pool.execute('INSERT INTO usage_examples (id_vocabulary, sentence, translation, notes) VALUES (?, ?, ?, ?)', [vocabularyId, values.sentence, values.translation, values.notes]);
    const [rows] = await pool.execute('SELECT id_usage_example, sentence, translation, notes FROM usage_examples WHERE id_usage_example = ? AND id_vocabulary = ?', [result.insertId, vocabularyId]);
    return res.status(201).json(rows[0]);
  } catch (error) { return sendRouteError(res, error, { defaultMessage: 'Unable to create usage example.' }); }
}

async function updateVocabularyExample(req, res) {
  try {
    const vocabularyId = parseIdParam(req, 'vocabulary entry');
    const exampleId = Number(req.params.exampleId);
    if (!Number.isInteger(exampleId) || exampleId <= 0) throw new ValidationError('usage example id must be a positive integer');
    if (!await fetchEntityById('vocabulary', vocabularyId, req.user.id)) return res.status(404).json({ error: 'vocabulary entry not found' });
    const [existing] = await pool.execute('SELECT id_usage_example, sentence, translation, notes FROM usage_examples WHERE id_usage_example = ? AND id_vocabulary = ?', [exampleId, vocabularyId]);
    if (!existing[0]) return res.status(404).json({ error: 'usage example not found' });
    const values = exampleValues(req.body || {}, { partial: true });
    const current = existing[0];
    await pool.execute('UPDATE usage_examples SET sentence = ?, translation = ?, notes = ? WHERE id_usage_example = ? AND id_vocabulary = ?', [values.sentence ?? current.sentence, values.translation ?? current.translation, values.notes ?? current.notes, exampleId, vocabularyId]);
    const [rows] = await pool.execute('SELECT id_usage_example, sentence, translation, notes FROM usage_examples WHERE id_usage_example = ? AND id_vocabulary = ?', [exampleId, vocabularyId]);
    return res.json(rows[0]);
  } catch (error) { return sendRouteError(res, error, { defaultMessage: 'Unable to update usage example.' }); }
}

async function deleteVocabularyExample(req, res) {
  try {
    const vocabularyId = parseIdParam(req, 'vocabulary entry');
    const exampleId = Number(req.params.exampleId);
    if (!Number.isInteger(exampleId) || exampleId <= 0) throw new ValidationError('usage example id must be a positive integer');
    if (!await fetchEntityById('vocabulary', vocabularyId, req.user.id)) return res.status(404).json({ error: 'vocabulary entry not found' });
    const [result] = await pool.execute('DELETE FROM usage_examples WHERE id_usage_example = ? AND id_vocabulary = ?', [exampleId, vocabularyId]);
    if (!result.affectedRows) return res.status(404).json({ error: 'usage example not found' });
    return res.json({ success: true, deletedId: exampleId });
  } catch (error) { return sendRouteError(res, error, { defaultMessage: 'Unable to delete usage example.' }); }
}

module.exports = {
  createVocabulary,
  deleteVocabulary,
  getVocabulary,
  createVocabularyExample,
  updateVocabularyExample,
  deleteVocabularyExample,
  listVocabularyOptions,
  listVocabulary,
  updateVocabulary
};
