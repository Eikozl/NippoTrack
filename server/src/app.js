const express = require('express');
const path = require('path');
const helmet = require('helmet');
const pool = require('./config/db');

const app = express();

const ALLOWED_FIELDS = {
  sessions: ['session_date', 'duration_minutes', 'category', 'resource', 'notes'],
  vocabulary: ['word', 'reading', 'meaning', 'jlpt_level', 'status', 'notes'],
  kanji: ['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level', 'status', 'notes'],
  grammar: ['grammar_point', 'meaning', 'structure', 'example', 'jlpt_level', 'status', 'notes']
};

function validateWriteFields(body, allowedFields) {
  const providedKeys = Object.keys(body);
  const unauthorized = providedKeys.filter(key => !allowedFields.includes(key));
  
  if (unauthorized.length > 0) {
    throw new Error(`Unauthorized fields: ${unauthorized.join(', ')}`);
  }
}

const STUDY_CATEGORIES = ['Grammar', 'Vocabulary', 'Kanji', 'Reading', 'Listening', 'Speaking', 'Writing', 'Mixed'];
const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const STATUSES = ['New', 'Learning', 'Familiar', 'Mastered'];

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  
  const date = new Date(value + 'T00:00:00Z');
  const timestamp = date.getTime();
  
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return false;
  }
  
  const [year, month, day] = value.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  
  return dateObj.getFullYear() === year && 
         dateObj.getMonth() === month - 1 && 
         dateObj.getDate() === day;
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function normalizeText(value, maxLength = null) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  if (maxLength && text.length > maxLength) {
    throw new Error(`Field exceeds maximum length of ${maxLength} characters`);
  }

  return text;
}

function validateAllowedValues(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === '') {
    return true;
  }

  if (!allowedValues.includes(value)) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(', ')}`);
  }

  return true;
}

function parseIdParam(req, entityName) {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${entityName} id must be a positive integer`);
  }

  return id;
}

async function fetchEntityById(tableName, idColumn, idValue) {
  const [rows] = await pool.execute(`SELECT * FROM ${tableName} WHERE ${idColumn} = ?`, [idValue]);
  return rows.length ? rows[0] : null;
}

async function checkDatabase() {
  try {
    const [rows] = await pool.query('SELECT DATABASE() AS database_name');
    if (rows && rows.length > 0 && rows[0].database_name === 'jlt') {
      return { connected: true, database: 'jlt' };
    }
    return { connected: false };
  } catch (error) {
    return { connected: false };
  }
}

function validateStudySessionPayload(body, { partial = false } = {}) {
  if (!partial && !isValidDateString(body.session_date)) {
    throw new Error('session_date is required and must use YYYY-MM-DD format.');
  }

  if (body.session_date !== undefined && body.session_date !== null && body.session_date !== '' && !isValidDateString(body.session_date)) {
    throw new Error('session_date must use YYYY-MM-DD format.');
  }

  if (!partial && !isPositiveInteger(body.duration_minutes)) {
    throw new Error('duration_minutes must be a positive integer.');
  }

  if (body.duration_minutes !== undefined && body.duration_minutes !== null && body.duration_minutes !== '' && !isPositiveInteger(body.duration_minutes)) {
    throw new Error('duration_minutes must be a positive integer.');
  }

  if (!partial && !body.category) {
    throw new Error('category is required.');
  }

  if (body.category !== undefined && body.category !== null && body.category !== '') {
    validateAllowedValues(body.category, STUDY_CATEGORIES, 'category');
  }
}

function validateStandardRecordPayload(body, { requiredMeaning = true, requiredWord = true, requiredGrammar = false } = {}) {
  if (requiredWord && (!body.word || !String(body.word).trim())) {
    throw new Error('word is required.');
  }

  if (requiredGrammar && (!body.grammar_point || !String(body.grammar_point).trim())) {
    throw new Error('grammar_point is required.');
  }

  if (requiredMeaning && (!body.meaning || !String(body.meaning).trim())) {
    throw new Error('meaning is required.');
  }

  if (body.jlpt_level !== undefined && body.jlpt_level !== null && body.jlpt_level !== '') {
    validateAllowedValues(body.jlpt_level, JLPT_LEVELS, 'jlpt_level');
  }

  if (body.status !== undefined && body.status !== null && body.status !== '') {
    validateAllowedValues(body.status, STATUSES, 'status');
  }
}

app.use(helmet({ contentSecurityPolicy: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const allowedOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];
  const origin = req.get('origin');
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.static(path.join(__dirname, '../../client/src')));

// Redirect canonical naming /api/sessions to /api/study-sessions (backward compatible)
app.use('/api/sessions/:id', (req, res, next) => {
  req.url = `/api/study-sessions/${req.params.id}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  next();
});

app.use('/api/sessions', (req, res, next) => {
  req.url = `/api/study-sessions${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  next();
});

app.get('/api', (req, res) => {
  res.json({
    name: 'Japanese Learning Tracker API',
    version: '1.0.0',
    endpoints: [
      'GET /api/health',
      'GET /api/dashboard',
      'GET /api/sessions',
      'POST /api/sessions',
      'GET /api/vocabulary',
      'POST /api/vocabulary',
      'GET /api/kanji',
      'POST /api/kanji',
      'GET /api/grammar',
      'POST /api/grammar'
    ]
  });
});

app.get('/api/health', async (req, res) => {
  const database = await checkDatabase();

  res.json({
    ok: database.connected,
    status: database.connected ? 'healthy' : 'database_unavailable',
    database: database.connected ? 'jlt' : 'unavailable'
  });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    // Today's minutes
    const [todayData] = await pool.query(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS minutes_today FROM study_sessions WHERE session_date = CURDATE()'
    );

    // This week's minutes (Monday-based)
    const [weekData] = await pool.query(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS minutes_week FROM study_sessions WHERE YEARWEEK(session_date, 1) = YEARWEEK(CURDATE(), 1)'
    );

    // Counts
    const [vocabCount] = await pool.query('SELECT COUNT(*) AS total FROM vocabulary');
    const [kanjiCount] = await pool.query('SELECT COUNT(*) AS total FROM kanji');
    const [grammarCount] = await pool.query('SELECT COUNT(*) AS total FROM grammar_points');

    // Recent sessions (last 5)
    const [recentSessions] = await pool.query(
      'SELECT id_session, session_date, category, duration_minutes FROM study_sessions ORDER BY session_date DESC, id_session DESC LIMIT 5'
    );

    // Weekly activity (last 7 days)
    const [weeklyActivity] = await pool.query(
      'SELECT session_date AS date, SUM(duration_minutes) AS minutes FROM study_sessions WHERE session_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY session_date ORDER BY session_date'
    );

    // Study distribution (by category)
    const [studyDistribution] = await pool.query(
      'SELECT category, SUM(duration_minutes) AS minutes FROM study_sessions GROUP BY category ORDER BY minutes DESC'
    );

    res.json({
      minutesToday: Number(todayData[0]?.minutes_today || 0),
      minutesThisWeek: Number(weekData[0]?.minutes_week || 0),
      vocabularyCount: Number(vocabCount[0]?.total || 0),
      kanjiCount: Number(kanjiCount[0]?.total || 0),
      grammarCount: Number(grammarCount[0]?.total || 0),
      recentSessions: recentSessions || [],
      weeklyActivity: weeklyActivity || [],
      studyDistribution: studyDistribution || []
    });
  } catch (error) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/study-sessions', async (req, res) => {
  try {
    let query = 'SELECT id_session, session_date, duration_minutes, category, resource, notes FROM study_sessions WHERE 1=1';
    const params = [];

    if (req.query.category) {
      const category = String(req.query.category);
      if (!STUDY_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Invalid category' });
      }
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
    res.json(rows);
  } catch (error) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/study-sessions/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'study session');
    const session = await fetchEntityById('study_sessions', 'id_session', id);

    if (!session) {
      return res.status(404).json({ error: 'study session not found' });
    }

    return res.json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid study session id.' });
  }
});

app.post('/api/study-sessions', async (req, res) => {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.sessions);
    validateStudySessionPayload(body);

    const nextBody = {
      session_date: normalizeText(body.session_date),
      duration_minutes: Number(body.duration_minutes),
      category: normalizeText(body.category, 20),
      resource: normalizeText(body.resource, 255),
      notes: normalizeText(body.notes, 1500)
    };

    const [result] = await pool.execute(
      'INSERT INTO study_sessions (session_date, duration_minutes, category, resource, notes) VALUES (?, ?, ?, ?, ?)',
      [nextBody.session_date, nextBody.duration_minutes, nextBody.category, nextBody.resource, nextBody.notes]
    );

    const [rows] = await pool.execute('SELECT * FROM study_sessions WHERE id_session = ?', [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to create study session.' });
  }
});

app.put('/api/study-sessions/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'study session');
    const current = await fetchEntityById('study_sessions', 'id_session', id);

    if (!current) {
      return res.status(404).json({ error: 'study session not found' });
    }

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.sessions);
    validateStudySessionPayload(body, { partial: true });

    const nextBody = {
      session_date: body.session_date !== undefined ? normalizeText(body.session_date) || current.session_date : current.session_date,
      duration_minutes: body.duration_minutes !== undefined ? Number(body.duration_minutes) : current.duration_minutes,
      category: body.category !== undefined ? normalizeText(body.category, 20) || current.category : current.category,
      resource: body.resource !== undefined ? normalizeText(body.resource, 255) : current.resource,
      notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : current.notes
    };

    await pool.execute(
      'UPDATE study_sessions SET session_date = ?, duration_minutes = ?, category = ?, resource = ?, notes = ? WHERE id_session = ?',
      [nextBody.session_date, nextBody.duration_minutes, nextBody.category, nextBody.resource, nextBody.notes, id]
    );

    const updated = await fetchEntityById('study_sessions', 'id_session', id);
    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to update study session.' });
  }
});

app.delete('/api/study-sessions/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'study session');
    const current = await fetchEntityById('study_sessions', 'id_session', id);

    if (!current) {
      return res.status(404).json({ error: 'study session not found' });
    }

    await pool.execute('DELETE FROM study_sessions WHERE id_session = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to delete study session.' });
  }
});

app.get('/api/vocabulary', async (req, res) => {
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
    res.json(rows);
  } catch (error) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/vocabulary/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const entry = await fetchEntityById('vocabulary', 'id_vocabulary', id);

    if (!entry) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }

    return res.json(entry);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid vocabulary id.' });
  }
});

app.post('/api/vocabulary', async (req, res) => {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.vocabulary);
    validateStandardRecordPayload(body, { requiredWord: true, requiredMeaning: true });

    const nextBody = {
      word: normalizeText(body.word, 100),
      reading: normalizeText(body.reading, 150),
      meaning: normalizeText(body.meaning, 255),
      jlpt_level: body.jlpt_level === undefined || body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2),
      status: normalizeText(body.status, 20) || 'New',
      notes: normalizeText(body.notes, 1500)
    };

    const [result] = await pool.execute(
      'INSERT INTO vocabulary (word, reading, meaning, jlpt_level, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [nextBody.word, nextBody.reading, nextBody.meaning, nextBody.jlpt_level, nextBody.status, nextBody.notes]
    );

    const [rows] = await pool.execute('SELECT * FROM vocabulary WHERE id_vocabulary = ?', [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to create vocabulary entry.' });
  }
});

app.put('/api/vocabulary/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const current = await fetchEntityById('vocabulary', 'id_vocabulary', id);

    if (!current) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.vocabulary);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });

    const nextBody = {
      word: body.word !== undefined ? normalizeText(body.word, 100) || current.word : current.word,
      reading: body.reading !== undefined ? normalizeText(body.reading, 150) : current.reading,
      meaning: body.meaning !== undefined ? normalizeText(body.meaning, 255) || current.meaning : current.meaning,
      jlpt_level: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2)) : current.jlpt_level,
      status: body.status !== undefined ? normalizeText(body.status, 20) || current.status : current.status,
      notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : current.notes
    };

    await pool.execute(
      'UPDATE vocabulary SET word = ?, reading = ?, meaning = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_vocabulary = ?',
      [nextBody.word, nextBody.reading, nextBody.meaning, nextBody.jlpt_level, nextBody.status, nextBody.notes, id]
    );

    const updated = await fetchEntityById('vocabulary', 'id_vocabulary', id);
    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to update vocabulary entry.' });
  }
});

app.delete('/api/vocabulary/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'vocabulary entry');
    const current = await fetchEntityById('vocabulary', 'id_vocabulary', id);

    if (!current) {
      return res.status(404).json({ error: 'vocabulary entry not found' });
    }

    await pool.execute('DELETE FROM vocabulary WHERE id_vocabulary = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to delete vocabulary entry.' });
  }
});

app.get('/api/kanji', async (req, res) => {
  try {
    let query = 'SELECT id_kanji, character_kanji, meaning, onyomi, kunyomi, jlpt_level, status FROM kanji WHERE 1=1';
    const params = [];

    if (req.query.search) {
      const searchTerm = `%${String(req.query.search).trim()}%`;
      query += ' AND (character_kanji LIKE ? OR meaning LIKE ? OR onyomi LIKE ? OR kunyomi LIKE ?)';
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
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

    query += ' ORDER BY id_kanji DESC LIMIT 100';

    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/kanji/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'kanji entry');
    const entry = await fetchEntityById('kanji', 'id_kanji', id);

    if (!entry) {
      return res.status(404).json({ error: 'kanji entry not found' });
    }

    return res.json(entry);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid kanji id.' });
  }
});

app.post('/api/kanji', async (req, res) => {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.kanji);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: true });

    if (!body.character_kanji || !String(body.character_kanji).trim()) {
      throw new Error('character_kanji is required.');
    }

    const nextBody = {
      character_kanji: normalizeText(body.character_kanji, 4),
      meaning: normalizeText(body.meaning, 255),
      onyomi: normalizeText(body.onyomi, 255),
      kunyomi: normalizeText(body.kunyomi, 255),
      jlpt_level: body.jlpt_level === undefined || body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2),
      status: normalizeText(body.status, 20) || 'New',
      notes: normalizeText(body.notes, 1500)
    };

    const [result] = await pool.execute(
      'INSERT INTO kanji (character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nextBody.character_kanji, nextBody.meaning, nextBody.onyomi, nextBody.kunyomi, nextBody.jlpt_level, nextBody.status, nextBody.notes]
    );

    const [rows] = await pool.execute('SELECT * FROM kanji WHERE id_kanji = ?', [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to create kanji entry.' });
  }
});

app.put('/api/kanji/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'kanji entry');
    const current = await fetchEntityById('kanji', 'id_kanji', id);

    if (!current) {
      return res.status(404).json({ error: 'kanji entry not found' });
    }

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.kanji);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false });

    if (body.character_kanji !== undefined && !String(body.character_kanji).trim()) {
      throw new Error('character_kanji is required.');
    }

    const nextBody = {
      character_kanji: body.character_kanji !== undefined ? normalizeText(body.character_kanji, 4) || current.character_kanji : current.character_kanji,
      meaning: body.meaning !== undefined ? normalizeText(body.meaning, 255) || current.meaning : current.meaning,
      onyomi: body.onyomi !== undefined ? normalizeText(body.onyomi, 255) : current.onyomi,
      kunyomi: body.kunyomi !== undefined ? normalizeText(body.kunyomi, 255) : current.kunyomi,
      jlpt_level: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2)) : current.jlpt_level,
      status: body.status !== undefined ? normalizeText(body.status, 20) || current.status : current.status,
      notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : current.notes
    };

    await pool.execute(
      'UPDATE kanji SET character_kanji = ?, meaning = ?, onyomi = ?, kunyomi = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_kanji = ?',
      [nextBody.character_kanji, nextBody.meaning, nextBody.onyomi, nextBody.kunyomi, nextBody.jlpt_level, nextBody.status, nextBody.notes, id]
    );

    const updated = await fetchEntityById('kanji', 'id_kanji', id);
    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to update kanji entry.' });
  }
});

app.delete('/api/kanji/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'kanji entry');
    const current = await fetchEntityById('kanji', 'id_kanji', id);

    if (!current) {
      return res.status(404).json({ error: 'kanji entry not found' });
    }

    await pool.execute('DELETE FROM kanji WHERE id_kanji = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to delete kanji entry.' });
  }
});

app.get('/api/grammar', async (req, res) => {
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

    query += ' ORDER BY id_grammar DESC LIMIT 100';

    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/api/grammar/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'grammar point');
    const entry = await fetchEntityById('grammar_points', 'id_grammar', id);

    if (!entry) {
      return res.status(404).json({ error: 'grammar point not found' });
    }

    return res.json(entry);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid grammar id.' });
  }
});

app.post('/api/grammar', async (req, res) => {
  try {
    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.grammar);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: true, requiredGrammar: true });

    const nextBody = {
      grammar_point: normalizeText(body.grammar_point, 100),
      meaning: normalizeText(body.meaning, 255),
      structure: normalizeText(body.structure, 2000),
      example: normalizeText(body.example, 2000),
      jlpt_level: body.jlpt_level === undefined || body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2),
      status: normalizeText(body.status, 20) || 'New',
      notes: normalizeText(body.notes, 1500)
    };

    const [result] = await pool.execute(
      'INSERT INTO grammar_points (grammar_point, meaning, structure, example, jlpt_level, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nextBody.grammar_point, nextBody.meaning, nextBody.structure, nextBody.example, nextBody.jlpt_level, nextBody.status, nextBody.notes]
    );

    const [rows] = await pool.execute('SELECT * FROM grammar_points WHERE id_grammar = ?', [result.insertId]);
    return res.status(201).json(rows[0]);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to create grammar point.' });
  }
});

app.put('/api/grammar/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'grammar point');
    const current = await fetchEntityById('grammar_points', 'id_grammar', id);

    if (!current) {
      return res.status(404).json({ error: 'grammar point not found' });
    }

    const body = req.body || {};
    validateWriteFields(body, ALLOWED_FIELDS.grammar);
    validateStandardRecordPayload(body, { requiredWord: false, requiredMeaning: false, requiredGrammar: false });

    if (body.grammar_point !== undefined && !String(body.grammar_point).trim()) {
      throw new Error('grammar_point is required.');
    }

    const nextBody = {
      grammar_point: body.grammar_point !== undefined ? normalizeText(body.grammar_point, 100) || current.grammar_point : current.grammar_point,
      meaning: body.meaning !== undefined ? normalizeText(body.meaning, 255) || current.meaning : current.meaning,
      structure: body.structure !== undefined ? normalizeText(body.structure, 2000) : current.structure,
      example: body.example !== undefined ? normalizeText(body.example, 2000) : current.example,
      jlpt_level: body.jlpt_level !== undefined ? (body.jlpt_level === '' ? null : normalizeText(body.jlpt_level, 2)) : current.jlpt_level,
      status: body.status !== undefined ? normalizeText(body.status, 20) || current.status : current.status,
      notes: body.notes !== undefined ? normalizeText(body.notes, 1500) : current.notes
    };

    await pool.execute(
      'UPDATE grammar_points SET grammar_point = ?, meaning = ?, structure = ?, example = ?, jlpt_level = ?, status = ?, notes = ? WHERE id_grammar = ?',
      [nextBody.grammar_point, nextBody.meaning, nextBody.structure, nextBody.example, nextBody.jlpt_level, nextBody.status, nextBody.notes, id]
    );

    const updated = await fetchEntityById('grammar_points', 'id_grammar', id);
    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to update grammar point.' });
  }
});

app.delete('/api/grammar/:id', async (req, res) => {
  try {
    const id = parseIdParam(req, 'grammar point');
    const current = await fetchEntityById('grammar_points', 'id_grammar', id);

    if (!current) {
      return res.status(404).json({ error: 'grammar point not found' });
    }

    await pool.execute('DELETE FROM grammar_points WHERE id_grammar = ?', [id]);
    return res.json({ success: true, deletedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to delete grammar point.' });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled API error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'endpoint not found' });
});

module.exports = app;
