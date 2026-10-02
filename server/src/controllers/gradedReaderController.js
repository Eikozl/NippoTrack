const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const {
  MAX_LIBRARY_LIMIT,
  MAX_READING_TEXT_LENGTH,
  MAX_READING_TITLE_LENGTH,
  analyzeTextForReading,
  createUserReadingText,
  getReadingText,
  listReadingLibrary,
  syncReadingSources,
  upsertReadingProgress
} = require('../services/gradedReader');

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be an object.');
  }
  return body;
}

function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ValidationError(`Unexpected field(s): ${unknown.join(', ')}.`);
}

function parseQueryInteger(value, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new ValidationError(`${name} must be a positive integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new ValidationError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return number;
}

function validateTextField(body) {
  if (typeof body.text !== 'string') throw new ValidationError('text is required and must be a string.');
  const text = body.text.trim();
  if (!text) throw new ValidationError('text is required.');
  if (Array.from(text).length > MAX_READING_TEXT_LENGTH) {
    throw new ValidationError(`text must not exceed ${MAX_READING_TEXT_LENGTH} characters.`);
  }
  return text;
}

async function listLibrary(req, res) {
  try {
    const query = req.query || {};
    const page = parseQueryInteger(query.page, 'page', 1);
    const limit = parseQueryInteger(query.limit, 'limit', 20, MAX_LIBRARY_LIMIT);
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) throw new ValidationError('page is too large.');
    const result = await listReadingLibrary(pool, req.user.id, {
      level: query.level,
      source: query.source,
      date: query.date,
      page,
      limit,
      offset
    });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load reading library.' });
  }
}

async function getText(req, res) {
  try {
    const id = parseIdParam(req, 'reading text');
    const result = await getReadingText(pool, req.user.id, id);
    if (!result) return res.status(404).json({ error: 'Reading text not found.' });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load reading text.' });
  }
}

async function analyzeText(req, res) {
  try {
    const body = bodyObject(req.body);
    // Deliberate security correction: identity is always req.user.id. A caller
    // may not select another user's vocabulary/kanji by supplying body.userId.
    rejectUnknownFields(body, ['text']);
    const text = validateTextField(body);
    const result = await analyzeTextForReading(pool, req.user.id, text);
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to analyze reading text.' });
  }
}

async function createUserText(req, res) {
  try {
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['text', 'title']);
    const text = validateTextField(body);
    if (body.title !== undefined && (typeof body.title !== 'string' || Array.from(body.title.trim()).length > MAX_READING_TITLE_LENGTH)) {
      throw new ValidationError(`title must be a string no longer than ${MAX_READING_TITLE_LENGTH} characters.`);
    }
    const result = await createUserReadingText(pool, req.user.id, { text, title: body.title });
    return res.status(201).json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save reading text.' });
  }
}

async function updateProgress(req, res) {
  try {
    const id = parseIdParam(req, 'reading text');
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['position', 'timeSpentSeconds', 'completed']);
    if (!Number.isSafeInteger(body.position) || body.position < 1 || body.position > MAX_READING_TEXT_LENGTH) {
      throw new ValidationError(`position must be a positive integer no greater than ${MAX_READING_TEXT_LENGTH}.`);
    }
    if (body.timeSpentSeconds !== undefined && (!Number.isSafeInteger(body.timeSpentSeconds) || body.timeSpentSeconds < 1 || body.timeSpentSeconds > 86400)) {
      throw new ValidationError('timeSpentSeconds must be a positive integer no greater than 86400.');
    }
    if (body.completed !== undefined && typeof body.completed !== 'boolean') {
      throw new ValidationError('completed must be a boolean.');
    }
    const progress = await upsertReadingProgress(pool, req.user.id, id, body);
    if (!progress) return res.status(404).json({ error: 'Reading text not found.' });
    return res.json({ id, ...progress });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to update reading progress.' });
  }
}

async function importSources(req, res) {
  try {
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['sourceType']);
    if (!['aozora', 'nhk'].includes(body.sourceType)) {
      throw new ValidationError('sourceType must be aozora or nhk.');
    }
    // fetch is injectable through app.locals for offline tests/operators; the
    // service still pins every request to its fixed, allowlisted host.
    const fetchImpl = req.app?.locals?.readingFetch || globalThis.fetch;
    const result = await syncReadingSources(pool, req.user.id, body.sourceType, { fetch: fetchImpl });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to import reading sources.' });
  }
}

module.exports = {
  analyzeText,
  createUserText,
  getText,
  importSources,
  listLibrary,
  updateProgress
};
