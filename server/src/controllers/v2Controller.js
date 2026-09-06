const pool = require('../config/db');
const { ALLOWED_FIELDS, CONTENT_TYPES, GOAL_PERIODS, GOAL_TYPES, JLPT_LEVELS, NOTE_CATEGORIES, STATUSES } = require('../constants');
const { ValidationError } = require('../errors/http');
const { sendRouteError } = require('../errors/http');
const { executePaginatedList } = require('./listHelpers');
const { isValidDateString, normalizeText, parseIdParam, validateAllowedValues, validateWriteFields } = require('../validation');
const { parsePagination } = require('../pagination');
const { paginationPayload } = require('../pagination');

function requiredText(value, maxLength, fieldName) {
  const text = normalizeText(value, maxLength, fieldName);
  if (!text) throw new ValidationError(`${fieldName} is required.`);
  return text;
}

function optionalInteger(value, fieldName, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new ValidationError(`${fieldName} must be an integer between ${min} and ${max}.`);
  return Number(value);
}

function requiredDate(value, fieldName) {
  const date = requiredText(value, 10, fieldName);
  if (!isValidDateString(date)) throw new ValidationError(`${fieldName} must use YYYY-MM-DD format.`);
  return date;
}

function optionalDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return requiredDate(value, fieldName);
}

function goalValues(body) {
  const title = requiredText(body.title, 120, 'title');
  const goalType = requiredText(body.goal_type, 30, 'goal_type');
  const periodType = requiredText(body.period_type, 20, 'period_type');
  validateAllowedValues(goalType, GOAL_TYPES, 'goal_type');
  validateAllowedValues(periodType, GOAL_PERIODS, 'period_type');
  const targetValue = optionalInteger(body.target_value, 'target_value', { min: 1, max: 999 });
  const startDate = requiredDate(body.start_date, 'start_date');
  const dueDate = optionalDate(body.due_date, 'due_date');
  const targetJlpt = normalizeText(body.target_jlpt_level, 2, 'target_jlpt_level');
  const targetStatus = normalizeText(body.target_status, 20, 'target_status');
  validateAllowedValues(targetJlpt, JLPT_LEVELS, 'target_jlpt_level');
  validateAllowedValues(targetStatus, STATUSES, 'target_status');
  if (periodType === 'weekly' && goalType !== 'study_minutes') throw new ValidationError('weekly goals may only use study_minutes.');
  if (periodType === 'by_deadline' && !dueDate) throw new ValidationError('due_date is required for by_deadline goals.');
  if (dueDate && dueDate < startDate) throw new ValidationError('due_date cannot be earlier than start_date.');
  const active = body.is_active === undefined ? true : (body.is_active === true || body.is_active === 1 || body.is_active === '1' ? true : body.is_active === false || body.is_active === 0 || body.is_active === '0' ? false : null);
  if (active === null) throw new ValidationError('is_active must be true or false.');
  return [title, goalType, targetValue, periodType, targetJlpt, targetStatus, startDate, dueDate, active];
}

async function getGoalProgress(goal, userId) {
  let sql;
  let params;
  if (goal.goal_type === 'study_minutes') {
    if (goal.period_type === 'weekly') {
      sql = "SELECT COALESCE(SUM(duration_minutes), 0) AS progress FROM study_sessions WHERE user_id = ? AND session_date >= GREATEST(?, date_trunc('week', CURRENT_DATE)::date) AND session_date <= CURRENT_DATE";
      params = [userId, goal.start_date];
    } else {
      sql = 'SELECT COALESCE(SUM(duration_minutes), 0) AS progress FROM study_sessions WHERE user_id = ? AND session_date >= ? AND session_date <= ?';
      params = [userId, goal.start_date, goal.due_date || '9999-12-31'];
    }
  } else {
    const table = { vocabulary_count: 'vocabulary', kanji_count: 'kanji', grammar_count: 'grammar_points' }[goal.goal_type];
    const clauses = ['user_id = ?', 'created_at::date >= ?', 'created_at::date <= ?'];
    params = [userId, goal.start_date, goal.due_date || '9999-12-31'];
    if (goal.target_jlpt_level) { clauses.push('jlpt_level = ?'); params.push(goal.target_jlpt_level); }
    if (goal.target_status) { clauses.push('status = ?'); params.push(goal.target_status); }
    sql = `SELECT COUNT(*) AS progress FROM ${table} WHERE ${clauses.join(' AND ')}`;
  }
  const [rows] = await pool.execute(sql, params);
  const progress = Number(rows[0]?.progress || 0);
  return { ...goal, progress, isComplete: progress >= Number(goal.target_value) };
}

async function listGoals(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    let countWhere = ' WHERE 1=1';
    let itemsWhere = ' WHERE 1=1';
    const params = [];
    if (req.query.active !== undefined) { if (!['0', '1'].includes(req.query.active)) throw new ValidationError('active must be 0 or 1.'); countWhere += ' AND is_active = ?'; itemsWhere += ' AND g.is_active = ?'; params.push(req.query.active === '1'); }
    const [countResult, itemsResult] = await Promise.all([
      pool.execute(`SELECT COUNT(*) AS total FROM goals${countWhere} AND user_id = ?`, [...params, req.user.id]),
      pool.execute(
        `SELECT g.id_goal, g.title, g.goal_type, g.target_value, g.period_type, g.target_jlpt_level, g.target_status, g.start_date, g.due_date, g.is_active,
          (CASE
            WHEN g.goal_type = 'study_minutes' AND g.period_type = 'weekly'
              THEN (SELECT COALESCE(SUM(ss.duration_minutes), 0) FROM study_sessions ss WHERE ss.user_id = g.user_id AND ss.session_date >= GREATEST(g.start_date, date_trunc('week', CURRENT_DATE)::date) AND ss.session_date <= CURRENT_DATE)
            WHEN g.goal_type = 'study_minutes'
              THEN (SELECT COALESCE(SUM(ss.duration_minutes), 0) FROM study_sessions ss WHERE ss.user_id = g.user_id AND ss.session_date >= g.start_date AND ss.session_date <= COALESCE(g.due_date, '9999-12-31'))
            WHEN g.goal_type = 'vocabulary_count'
              THEN (SELECT COUNT(*) FROM vocabulary v WHERE v.user_id = g.user_id AND v.created_at::date >= g.start_date AND v.created_at::date <= COALESCE(g.due_date, '9999-12-31') AND (g.target_jlpt_level IS NULL OR v.jlpt_level = g.target_jlpt_level) AND (g.target_status IS NULL OR v.status = g.target_status))
            WHEN g.goal_type = 'kanji_count'
              THEN (SELECT COUNT(*) FROM kanji k WHERE k.user_id = g.user_id AND k.created_at::date >= g.start_date AND k.created_at::date <= COALESCE(g.due_date, '9999-12-31') AND (g.target_jlpt_level IS NULL OR k.jlpt_level = g.target_jlpt_level) AND (g.target_status IS NULL OR k.status = g.target_status))
            ELSE (SELECT COUNT(*) FROM grammar_points gp WHERE gp.user_id = g.user_id AND gp.created_at::date >= g.start_date AND gp.created_at::date <= COALESCE(g.due_date, '9999-12-31') AND (g.target_jlpt_level IS NULL OR gp.jlpt_level = g.target_jlpt_level) AND (g.target_status IS NULL OR gp.status = g.target_status))
          END) AS progress
        FROM goals g${itemsWhere} AND g.user_id = ? ORDER BY g.is_active DESC, g.due_date IS NULL, g.due_date ASC, g.id_goal DESC LIMIT ? OFFSET ?`,
        [...params, req.user.id, limit, offset]
      )
    ]);
    const total = Number(countResult[0][0]?.total || 0);
    const items = itemsResult[0].map((goal) => {
      const progress = Number(goal.progress || 0);
      return { ...goal, progress, isComplete: progress >= Number(goal.target_value) };
    });
    return res.json(paginationPayload(items, total, page, limit));
  } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load goals.' }); }
}

async function createGoal(req, res) {
  try {
    validateWriteFields(req.body || {}, ALLOWED_FIELDS.goals); const values = goalValues(req.body || {});
    const [result] = await pool.execute('INSERT INTO goals (title, goal_type, target_value, period_type, target_jlpt_level, target_status, start_date, due_date, is_active, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...values, req.user.id]);
    const [rows] = await pool.execute('SELECT id_goal, title, goal_type, target_value, period_type, target_jlpt_level, target_status, start_date, due_date, is_active FROM goals WHERE id_goal = ? AND user_id = ?', [result.insertId, req.user.id]);
    return res.status(201).json(await getGoalProgress(rows[0], req.user.id));
  } catch (error) { return sendRouteError(res, error, { defaultMessage: 'Unable to create goal.' }); }
}

async function updateGoal(req, res) {
  try {
    const id = parseIdParam(req, 'goal'); const [existing] = await pool.execute('SELECT * FROM goals WHERE id_goal = ? AND user_id = ?', [id, req.user.id]); if (!existing[0]) return res.status(404).json({ error: 'goal not found' });
    validateWriteFields(req.body || {}, ALLOWED_FIELDS.goals); const values = goalValues({ ...existing[0], ...(req.body || {}) });
    await pool.execute('UPDATE goals SET title=?, goal_type=?, target_value=?, period_type=?, target_jlpt_level=?, target_status=?, start_date=?, due_date=?, is_active=? WHERE id_goal=? AND user_id=?', [...values, id, req.user.id]);
    const [rows] = await pool.execute('SELECT id_goal, title, goal_type, target_value, period_type, target_jlpt_level, target_status, start_date, due_date, is_active FROM goals WHERE id_goal = ? AND user_id = ?', [id, req.user.id]); return res.json(await getGoalProgress(rows[0], req.user.id));
  } catch (error) { return sendRouteError(res, error, { defaultMessage: 'Unable to update goal.' }); }
}

async function deleteGoal(req, res) { try { const id = parseIdParam(req, 'goal'); const [result] = await pool.execute('DELETE FROM goals WHERE id_goal = ? AND user_id = ?', [id, req.user.id]); if (!result.affectedRows) return res.status(404).json({ error: 'goal not found' }); return res.json({ success: true, deletedId: id }); } catch (error) { return sendRouteError(res, error, { defaultMessage: 'Unable to delete goal.' }); } }

function resourceHandlers({ key, table, idKey, columns, allowed, normalize, orderBy, searchColumns = [] }) {
  async function list(req, res) {
    try { const { page, limit, offset } = parsePagination(req.query); let whereSql = ' WHERE 1=1'; const params = [];
      if (req.query.search && searchColumns.length) { const term = `%${normalizeText(req.query.search, 255, 'search')}%`; whereSql += ` AND (${searchColumns.map((column) => `${column} LIKE ?`).join(' OR ')})`; params.push(...searchColumns.map(() => term)); }
      return res.json(await executePaginatedList(pool, { table, columns, whereSql, params, orderBy, page, limit, offset, userId: req.user.id }));
    } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: `Unable to load ${key}.` }); }
  }
  async function create(req, res) { try { validateWriteFields(req.body || {}, allowed); const values = { ...normalize(req.body || {}), user_id: req.user.id }; const fields = Object.keys(values); const [result] = await pool.execute(`INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, Object.values(values)); const [rows] = await pool.execute(`SELECT ${columns} FROM ${table} WHERE ${idKey} = ? AND user_id = ?`, [result.insertId, req.user.id]); return res.status(201).json(rows[0]); } catch (error) { return sendRouteError(res, error, { defaultMessage: `Unable to create ${key}.` }); } }
  async function update(req, res) { try { const id = parseIdParam(req, key); const [existing] = await pool.execute(`SELECT * FROM ${table} WHERE ${idKey} = ? AND user_id = ?`, [id, req.user.id]); if (!existing[0]) return res.status(404).json({ error: `${key} not found` }); validateWriteFields(req.body || {}, allowed); const values = normalize({ ...existing[0], ...(req.body || {}) }); const fields = Object.keys(values); await pool.execute(`UPDATE ${table} SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE ${idKey} = ? AND user_id = ?`, [...Object.values(values), id, req.user.id]); const [rows] = await pool.execute(`SELECT ${columns} FROM ${table} WHERE ${idKey} = ? AND user_id = ?`, [id, req.user.id]); return res.json(rows[0]); } catch (error) { return sendRouteError(res, error, { defaultMessage: `Unable to update ${key}.` }); } }
  async function remove(req, res) { try { const id = parseIdParam(req, key); const [result] = await pool.execute(`DELETE FROM ${table} WHERE ${idKey} = ? AND user_id = ?`, [id, req.user.id]); if (!result.affectedRows) return res.status(404).json({ error: `${key} not found` }); return res.json({ success: true, deletedId: id }); } catch (error) { return sendRouteError(res, error, { defaultMessage: `Unable to delete ${key}.` }); } }
  return { list, create, update, remove };
}

const content = resourceHandlers({ key: 'content entry', table: 'content_entries', idKey: 'id_content_entry', columns: 'id_content_entry, title, content_type, content_date, perceived_difficulty, comprehension_percent, new_words_count, notes', allowed: ALLOWED_FIELDS.content, orderBy: 'content_date DESC, id_content_entry DESC', searchColumns: ['title', 'content_type'], normalize: (body) => { const type = requiredText(body.content_type, 20, 'content_type'); validateAllowedValues(type, CONTENT_TYPES, 'content_type'); return { title: requiredText(body.title, 255, 'title'), content_type: type, content_date: requiredDate(body.content_date, 'content_date'), perceived_difficulty: optionalInteger(body.perceived_difficulty, 'perceived_difficulty', { min: 1, max: 5 }), comprehension_percent: optionalInteger(body.comprehension_percent, 'comprehension_percent', { min: 0, max: 100 }), new_words_count: optionalInteger(body.new_words_count, 'new_words_count'), notes: normalizeText(body.notes, 1500, 'notes') }; } });
const notes = resourceHandlers({ key: 'note', table: 'notes', idKey: 'id_note', columns: 'id_note, title, body, category, created_at, updated_at', allowed: ALLOWED_FIELDS.notes, orderBy: 'updated_at DESC, id_note DESC', searchColumns: ['title', 'body', 'category'], normalize: (body) => { const category = requiredText(body.category, 20, 'category'); validateAllowedValues(category, NOTE_CATEGORIES, 'category'); return { title: normalizeText(body.title, 150, 'title'), body: requiredText(body.body, 10000, 'body'), category }; } });
const tags = resourceHandlers({ key: 'tag', table: 'tags', idKey: 'id_tag', columns: 'id_tag, name, normalized_name', allowed: ALLOWED_FIELDS.tags, orderBy: 'name ASC, id_tag ASC', searchColumns: ['name'], normalize: (body) => { const name = requiredText(body.name, 60, 'name'); return { name, normalized_name: name.toLocaleLowerCase() }; } });

const LINK_CONFIGS = {
  content: {
    entity: { table: 'content_entries', idColumn: 'id_content_entry', name: 'content entry' },
    groups: [{ key: 'sessions', table: 'content_entry_sessions', entityColumn: 'id_content_entry', targetColumn: 'id_session', select: 'SELECT s.id_session, s.session_date, s.duration_minutes, s.category, s.resource FROM content_entry_sessions l JOIN study_sessions s ON s.id_session = l.id_session WHERE l.id_content_entry = ? AND s.user_id = ? ORDER BY s.session_date DESC, s.id_session DESC' }]
  },
  notes: {
    entity: { table: 'notes', idColumn: 'id_note', name: 'note' },
    groups: [
      { key: 'sessions', table: 'note_study_sessions', entityColumn: 'id_note', targetColumn: 'id_session', select: 'SELECT s.id_session, s.session_date, s.duration_minutes, s.category, s.resource FROM note_study_sessions l JOIN study_sessions s ON s.id_session = l.id_session WHERE l.id_note = ? AND s.user_id = ? ORDER BY s.session_date DESC, s.id_session DESC' },
      { key: 'vocabulary', table: 'note_vocabulary', entityColumn: 'id_note', targetColumn: 'id_vocabulary', select: 'SELECT v.id_vocabulary, v.word, v.reading, v.meaning FROM note_vocabulary l JOIN vocabulary v ON v.id_vocabulary = l.id_vocabulary WHERE l.id_note = ? AND v.user_id = ? ORDER BY v.word' },
      { key: 'kanji', table: 'note_kanji', entityColumn: 'id_note', targetColumn: 'id_kanji', select: 'SELECT k.id_kanji, k.character_kanji, k.meaning FROM note_kanji l JOIN kanji k ON k.id_kanji = l.id_kanji WHERE l.id_note = ? AND k.user_id = ? ORDER BY k.character_kanji' },
      { key: 'grammar', table: 'note_grammar', entityColumn: 'id_note', targetColumn: 'id_grammar', select: 'SELECT g.id_grammar, g.grammar_point, g.meaning FROM note_grammar l JOIN grammar_points g ON g.id_grammar = l.id_grammar WHERE l.id_note = ? AND g.user_id = ? ORDER BY g.grammar_point' }
    ]
  },
  tags: {
    entity: { table: 'tags', idColumn: 'id_tag', name: 'tag' },
    groups: [
      { key: 'sessions', table: 'tag_study_sessions', entityColumn: 'id_tag', targetColumn: 'id_session', select: 'SELECT s.id_session, s.session_date, s.duration_minutes, s.category, s.resource FROM tag_study_sessions l JOIN study_sessions s ON s.id_session = l.id_session WHERE l.id_tag = ? AND s.user_id = ? ORDER BY s.session_date DESC, s.id_session DESC' },
      { key: 'vocabulary', table: 'tag_vocabulary', entityColumn: 'id_tag', targetColumn: 'id_vocabulary', select: 'SELECT v.id_vocabulary, v.word, v.reading, v.meaning FROM tag_vocabulary l JOIN vocabulary v ON v.id_vocabulary = l.id_vocabulary WHERE l.id_tag = ? AND v.user_id = ? ORDER BY v.word' },
      { key: 'kanji', table: 'tag_kanji', entityColumn: 'id_tag', targetColumn: 'id_kanji', select: 'SELECT k.id_kanji, k.character_kanji, k.meaning FROM tag_kanji l JOIN kanji k ON k.id_kanji = l.id_kanji WHERE l.id_tag = ? AND k.user_id = ? ORDER BY k.character_kanji' },
      { key: 'grammar', table: 'tag_grammar', entityColumn: 'id_tag', targetColumn: 'id_grammar', select: 'SELECT g.id_grammar, g.grammar_point, g.meaning FROM tag_grammar l JOIN grammar_points g ON g.id_grammar = l.id_grammar WHERE l.id_tag = ? AND g.user_id = ? ORDER BY g.grammar_point' }
    ]
  }
};

function linkIds(value, name) {
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) throw new ValidationError(`${name} must be an array of positive integer IDs.`);
  return [...new Set(value)];
}

const LINK_TARGETS = { id_session: 'study_sessions', id_vocabulary: 'vocabulary', id_kanji: 'kanji', id_grammar: 'grammar_points' };

async function ensureLinkEntity(config, id, userId) {
  const [rows] = await pool.execute(`SELECT ${config.entity.idColumn} FROM ${config.entity.table} WHERE ${config.entity.idColumn} = ? AND user_id = ?`, [id, userId]);
  if (!rows[0]) return false;
  return true;
}

function linkHandlers(kind) {
  const config = LINK_CONFIGS[kind];
  async function list(req, res) {
    try {
      const id = parseIdParam(req, config.entity.name);
      if (!await ensureLinkEntity(config, id, req.user.id)) return res.status(404).json({ error: `${config.entity.name} not found` });
      const rows = await Promise.all(config.groups.map(async (group) => [group.key, (await pool.execute(group.select, [id, req.user.id]))[0]]));
      return res.json(Object.fromEntries(rows));
    } catch (error) { return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: `Unable to load ${config.entity.name} links.` }); }
  }
  async function replace(req, res) {
    let connection;
    try {
      const id = parseIdParam(req, config.entity.name);
      if (!await ensureLinkEntity(config, id, req.user.id)) return res.status(404).json({ error: `${config.entity.name} not found` });
      const body = req.body || {};
      validateWriteFields(body, config.groups.map((group) => group.key));
      const supplied = config.groups.filter((group) => body[group.key] !== undefined).map((group) => ({ group, ids: linkIds(body[group.key], group.key) }));
      connection = await pool.getConnection(); await connection.beginTransaction();
      for (const { group, ids } of supplied) {
        const targetTable = LINK_TARGETS[group.targetColumn];
        if (ids.length) {
          const [owned] = await connection.execute(`SELECT ${group.targetColumn} FROM ${targetTable} WHERE user_id = ? AND ${group.targetColumn} = ANY(?)`, [req.user.id, ids]);
          if (owned.length !== ids.length) throw new ValidationError('Linked entries must belong to the authenticated user.');
        }
        await connection.execute(`DELETE FROM ${group.table} WHERE ${group.entityColumn} = ?`, [id]);
        if (ids.length) {
          const placeholders = ids.map(() => '(?, ?)').join(', ');
          const params = ids.flatMap((targetId) => [id, targetId]);
          await connection.execute(`INSERT INTO ${group.table} (${group.entityColumn}, ${group.targetColumn}) VALUES ${placeholders}`, params);
        }
      }
      await connection.commit(); connection.release(); connection = null;
      return res.json({ success: true });
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {}).then(() => connection.release());
      return sendRouteError(res, error, { defaultMessage: `Unable to update ${config.entity.name} links.` });
    }
  }
  return { list, replace };
}

const contentLinks = linkHandlers('content');
const noteLinks = linkHandlers('notes');
const tagLinks = linkHandlers('tags');

module.exports = { listGoals, createGoal, updateGoal, deleteGoal, goalValues, content, notes, tags, contentLinks, noteLinks, tagLinks };
