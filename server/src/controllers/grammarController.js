const pool = require('../config/db');
const { ALLOWED_FIELDS, JLPT_LEVELS, STATUSES } = require('../constants');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseOptionLimit, parsePagination } = require('../pagination');
const { buildSearchCandidates } = require('../search/japaneseSearch');
const { rankGrammarOptions } = require('../search/optionRanking');
const { buildComparisons, kanaSearchValues, normalizedJapaneseSql } = require('../search/sqlSearch');
const {
  normalizeText,
  parseIdParam,
  validateStandardRecordPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById } = require('./helpers');
const { executePaginatedList } = require('./listHelpers');
const { findGrammarReferenceId, getGrammarReferenceById, searchGrammarReferences } = require('../services/grammarReferenceStore');

async function listGrammar(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    let whereSql = ' WHERE 1=1';
    const params = [];
    let orderBy = 'id_grammar DESC';
    let orderParams = [];

    const search = normalizeText(req.query.search, 100, 'search');
    if (search) {
      const candidates = buildSearchCandidates(search);
      const rawContains = `%${candidates.raw}%`;
      const rawPrefix = `${candidates.raw}%`;
      const meaningWordPrefix = `% ${candidates.raw}%`;
      const kanaValues = kanaSearchValues(candidates);
      const normalizedPoint = normalizedJapaneseSql('grammar_point');
      const kanaContains = buildComparisons([normalizedPoint], kanaValues);
      const kanaExact = buildComparisons([normalizedPoint], kanaValues, { operator: '=' });
      const kanaPrefix = buildComparisons([normalizedPoint], kanaValues, { pattern: 'prefix' });
      whereSql += ` AND (grammar_point LIKE ? OR meaning LIKE ? OR structure LIKE ? OR example LIKE ?${kanaContains.sql ? ` OR ${kanaContains.sql}` : ''})`;
      params.push(rawContains, rawContains, rawContains, rawContains, ...kanaContains.params);
      orderBy = `CASE
        WHEN grammar_point = ? THEN 1
        ${kanaExact.sql ? `WHEN ${kanaExact.sql} THEN 2` : ''}
        WHEN grammar_point LIKE ? THEN 3
        ${kanaPrefix.sql ? `WHEN ${kanaPrefix.sql} THEN 4` : ''}
        WHEN meaning LIKE ? OR CONCAT(' ', COALESCE(meaning, '')) LIKE ? THEN 5
        ELSE 6 END, id_grammar DESC`;
      orderParams = [
        candidates.raw, ...kanaExact.params,
        rawPrefix, ...kanaPrefix.params, rawPrefix, meaningWordPrefix
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
      table: 'grammar_points',
      columns: 'id_grammar, grammar_point, meaning, structure, example, jlpt_level, status, reference_id',
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

async function listGrammarOptions(req, res) {
  try {
    const limit = parseOptionLimit(req.query.limit);
    const search = normalizeText(req.query.search, 100, 'search');
    const candidates = buildSearchCandidates(search || '');
    const normalizedPoint = normalizedJapaneseSql('grammar_point');
    let query = 'SELECT id_grammar, grammar_point, meaning, structure, example FROM grammar_points WHERE user_id = ?';
    let params = [req.user.id, limit];

    if (search) {
      const rawContains = `%${candidates.raw}%`;
      const rawPrefix = `${candidates.raw}%`;
      const meaningWordPrefix = `% ${candidates.raw}%`;
      const kanaValues = kanaSearchValues(candidates);
      const kanaContains = buildComparisons([normalizedPoint], kanaValues);
      const kanaExact = buildComparisons([normalizedPoint], kanaValues, { operator: '=' });
      const kanaPrefix = buildComparisons([normalizedPoint], kanaValues, { pattern: 'prefix' });
      const candidateLimit = Math.min(limit * 5, 200);
      query += ` AND (grammar_point LIKE ? OR meaning LIKE ? OR structure LIKE ? OR example LIKE ?
        ${kanaContains.sql ? `OR ${kanaContains.sql}` : ''})`;
      query += ` ORDER BY CASE
        WHEN grammar_point = ? THEN 1
        ${kanaExact.sql ? `WHEN ${kanaExact.sql} THEN 2` : ''}
        WHEN grammar_point LIKE ? THEN 3
        ${kanaPrefix.sql ? `WHEN ${kanaPrefix.sql} THEN 4` : ''}
        WHEN meaning LIKE ? OR CONCAT(' ', COALESCE(meaning, '')) LIKE ? THEN 5
        ELSE 6 END, id_grammar DESC LIMIT ?`;
      params = [
        req.user.id, rawContains, rawContains, rawContains, rawContains, ...kanaContains.params,
        candidates.raw, ...kanaExact.params,
        rawPrefix, ...kanaPrefix.params, rawPrefix, meaningWordPrefix,
        candidateLimit
      ];
    } else {
      query += ' ORDER BY id_grammar DESC LIMIT ?';
    }

    const [rows] = await pool.execute(query, params);
    return res.json({ items: rankGrammarOptions(rows, candidates, limit) });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load grammar options.' });
  }
}

async function getGrammar(req, res) {
  try {
    const id = parseIdParam(req, 'grammar point');
    const entry = await fetchEntityById('grammar', id, req.user.id);
    if (!entry) return res.status(404).json({ error: 'grammar point not found' });
    let reference = null;
    try { if (entry.reference_id) reference = await getGrammarReferenceById(entry.reference_id); } catch (_) { /* fail open for user record */ }
    return res.json({ ...entry, reference });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load grammar point.' });
  }
}

function normalizeGrammar(body, current = {}) {
  const grammarPoint = body.grammar_point !== undefined
    ? normalizeText(body.grammar_point, 100, 'grammar_point')
    : current.grammar_point;
  const meaning = body.meaning !== undefined ? normalizeText(body.meaning, 255, 'meaning') : current.meaning;
  if (body.grammar_point !== undefined && !grammarPoint) throw new ValidationError('grammar_point is required.');
  if (body.meaning !== undefined && !meaning) throw new ValidationError('meaning is required.');
  return {
    grammarPoint,
    meaning,
    structure: body.structure !== undefined ? normalizeText(body.structure, 2000, 'structure') : (current.structure ?? null),
    example: body.example !== undefined ? normalizeText(body.example, 2000, 'example') : (current.example ?? null),
    jlptLevel: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2, 'jlpt_level')) : (current.jlpt_level ?? null),
    status: body.status !== undefined ? normalizeText(body.status, 20, 'status') || current.status : (current.status || 'New'),
    notes: body.notes !== undefined ? normalizeText(body.notes, 1500, 'notes') : (current.notes ?? null)
  };
}

async function createGrammar(req, res) {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.grammar);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: true, requiredGrammar: true });
    const values = normalizeGrammar({
      ...body,
      status: body.status === undefined || body.status === null || body.status === '' ? 'New' : body.status
    });
    const referenceId = await findGrammarReferenceId(body.reference_id);
    const [result] = await pool.execute(
      'INSERT INTO grammar_points (grammar_point, meaning, structure, example, jlpt_level, status, notes, user_id, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [values.grammarPoint, values.meaning, values.structure, values.example, values.jlptLevel, values.status, values.notes, req.user.id, referenceId]
    );
    return res.status(201).json(await fetchEntityById('grammar', result.insertId, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, {
      defaultMessage: 'Unable to create grammar point.',
      conflictMessage: 'Grammar point already exists.'
    });
  }
}

async function updateGrammar(req, res) {
  try {
    const id = parseIdParam(req, 'grammar point');
    const current = await fetchEntityById('grammar', id, req.user.id);
    if (!current) return res.status(404).json({ error: 'grammar point not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.grammar);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });
    const values = normalizeGrammar(body, current);
    const referenceId = body.reference_id === undefined ? current.reference_id : await findGrammarReferenceId(body.reference_id);
    await pool.execute(
      'UPDATE grammar_points SET grammar_point = ?, meaning = ?, structure = ?, example = ?, jlpt_level = ?, status = ?, notes = ?, reference_id = ? WHERE id_grammar = ? AND user_id = ?',
      [values.grammarPoint, values.meaning, values.structure, values.example, values.jlptLevel, values.status, values.notes, referenceId, id, req.user.id]
    );
    return res.json(await fetchEntityById('grammar', id, req.user.id));
  } catch (error) {
    return sendRouteError(res, error, {
      defaultMessage: 'Unable to update grammar point.',
      conflictMessage: 'Grammar point already exists.'
    });
  }
}

async function listGrammarReferences(req, res) {
  try {
    const search = normalizeText(req.query.search, 100, 'search');
    if (!search) return res.json({ items: [] });
    return res.json(await searchGrammarReferences(search, parseOptionLimit(req.query.limit)));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to search grammar references.' });
  }
}

async function deleteGrammar(req, res) {
  try {
    const id = parseIdParam(req, 'grammar point');
    if (!await fetchEntityById('grammar', id, req.user.id)) return res.status(404).json({ error: 'grammar point not found' });
    await pool.execute('DELETE FROM grammar_points WHERE id_grammar = ? AND user_id = ?', [id, req.user.id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete grammar point.' });
  }
}

module.exports = { createGrammar, deleteGrammar, getGrammar, listGrammar, listGrammarOptions, listGrammarReferences, updateGrammar };
