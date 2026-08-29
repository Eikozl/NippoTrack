const pool = require('../config/db');
const { ALLOWED_FIELDS, JLPT_LEVELS, STATUSES } = require('../constants');
const { ValidationError, sendRouteError } = require('../errors/http');
const {
  normalizeText,
  parseIdParam,
  validateStandardRecordPayload,
  validateWriteFields
} = require('../validation');
const { fetchEntityById } = require('./helpers');

async function listGrammar(req, res) {
  try {
    let query = 'SELECT id_grammar, grammar_point, meaning, structure, example, jlpt_level, status FROM grammar_points WHERE 1=1';
    const params = [];

    if (req.query.search) {
      const searchTerm = `%${String(req.query.search).trim()}%`;
      query += ' AND (grammar_point LIKE ? OR meaning LIKE ? OR structure LIKE ?)';
      params.push(searchTerm, searchTerm, searchTerm);
    }
    if (req.query.jlpt) {
      const jlpt = String(req.query.jlpt).toUpperCase();
      if (!JLPT_LEVELS.includes(jlpt)) return res.status(400).json({ error: 'Invalid JLPT level' });
      query += ' AND jlpt_level = ?';
      params.push(jlpt);
    }
    if (req.query.status) {
      const status = String(req.query.status);
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY id_grammar DESC LIMIT 100';
    const [rows] = await pool.execute(query, params);
    return res.json(rows);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Database unavailable' });
  }
}

async function getGrammar(req, res) {
  try {
    const id = parseIdParam(req, 'grammar point');
    const entry = await fetchEntityById('grammar', id);
    if (!entry) return res.status(404).json({ error: 'grammar point not found' });
    return res.json(entry);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load grammar point.' });
  }
}

function normalizeGrammar(body, current = {}) {
  if (body.grammar_point !== undefined && !String(body.grammar_point).trim()) {
    throw new ValidationError('grammar_point is required.');
  }
  return {
    grammarPoint: body.grammar_point !== undefined ? normalizeText(body.grammar_point, 100) || current.grammar_point : current.grammar_point,
    meaning: body.meaning !== undefined ? normalizeText(body.meaning, 255) || current.meaning : current.meaning,
    structure: body.structure !== undefined ? normalizeText(body.structure, 2000) : (current.structure ?? null),
    example: body.example !== undefined ? normalizeText(body.example, 2000) : (current.example ?? null),
    jlptLevel: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2)) : (current.jlpt_level ?? null),
    status: body.status !== undefined ? normalizeText(body.status, 20) || current.status : (current.status || 'New'),
    notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : (current.notes ?? null)
  };
}

async function createGrammar(req, res) {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.grammar);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: true, requiredGrammar: true });
    const values = normalizeGrammar({ ...body, status: body.status || 'New' });
    const [result] = await pool.execute(
      'INSERT INTO grammar_points (grammar_point, meaning, structure, example, jlpt_level, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [values.grammarPoint, values.meaning, values.structure, values.example, values.jlptLevel, values.status, values.notes]
    );
    return res.status(201).json(await fetchEntityById('grammar', result.insertId));
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
    const current = await fetchEntityById('grammar', id);
    if (!current) return res.status(404).json({ error: 'grammar point not found' });

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.grammar);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });
    const values = normalizeGrammar(body, current);
    await pool.execute(
      'UPDATE grammar_points SET grammar_point = ?, meaning = ?, structure = ?, example = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_grammar = ?',
      [values.grammarPoint, values.meaning, values.structure, values.example, values.jlptLevel, values.status, values.notes, id]
    );
    return res.json(await fetchEntityById('grammar', id));
  } catch (error) {
    return sendRouteError(res, error, {
      defaultMessage: 'Unable to update grammar point.',
      conflictMessage: 'Grammar point already exists.'
    });
  }
}

async function deleteGrammar(req, res) {
  try {
    const id = parseIdParam(req, 'grammar point');
    if (!await fetchEntityById('grammar', id)) return res.status(404).json({ error: 'grammar point not found' });
    await pool.execute('DELETE FROM grammar_points WHERE id_grammar = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to delete grammar point.' });
  }
}

module.exports = { createGrammar, deleteGrammar, getGrammar, listGrammar, updateGrammar };
