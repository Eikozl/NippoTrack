// V5.3a — Immersion reading pipeline routes.
// Ownership always derives from req.user.id; write operations run inside a
// single transaction in the pipeline service.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { isValidDateString, normalizeText, validateAllowedValues } = require('../validation');
const { parsePagination, paginationPayload } = require('../pagination');
const { JLPT_LEVELS } = require('../constants');
const {
  MAX_IMMERSION_TEXT_LENGTH,
  acquireImmersionSlot,
  IMMERSION_BUSY_RETRY_AFTER_SECONDS,
  analyzeTextForImmersion,
  createImmersionSession,
  listImmersionSessions
} = require('../services/immersionPipeline');

function requireImmersionText(body) {
  const text = normalizeText(body && body.text, MAX_IMMERSION_TEXT_LENGTH, 'text');
  if (!text) throw new ValidationError('text is required.');
  return text;
}

const SELECTED_ID_FIELDS = ['vocabularyIds', 'kanjiIds', 'grammarIds'];

function normalizeSelectedItems(body) {
  const source = body && body.selectedItems;
  const normalized = { vocabularyIds: [], kanjiIds: [], grammarIds: [] };
  if (source === undefined || source === null) return normalized;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new ValidationError('selectedItems must be an object.');
  }
  for (const field of SELECTED_ID_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
      throw new ValidationError(`selectedItems.${field} must be an array of candidate id strings.`);
    }
    normalized[field] = [...new Set(value)];
  }
  return normalized;
}

// POST /api/immersion/analyze { text, options?: { autoCreateSession?: boolean } }
async function analyzeImmersionText(req, res) {
  try {
    const text = requireImmersionText(req.body);
    const options = req.body && req.body.options;
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw new ValidationError('options must be an object.');
    }
    if (options && options.autoCreateSession !== undefined && typeof options.autoCreateSession !== 'boolean') {
      throw new ValidationError('options.autoCreateSession must be a boolean.');
    }
    // options.autoCreateSession is validated and accepted for forward
    // compatibility but intentionally NEVER persists anything here: session
    // creation requires the user's reviewed candidate selection, which only
    // exists after this response. All writes live in /create-session.
    // Bulkhead: reject before parsing when both engine slots are busy.
    const releaseSlot = acquireImmersionSlot();
    if (!releaseSlot) {
      res.set('Retry-After', String(IMMERSION_BUSY_RETRY_AFTER_SECONDS));
      return res.status(429).json({ error: 'Too many text analyses running. Please retry in a few seconds.' });
    }
    try {
      const result = await analyzeTextForImmersion(pool, req.user.id, text);
      return res.json(result);
    } finally {
      releaseSlot();
    }
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to analyze text.' });
  }
}

// POST /api/immersion/create-session { text, selectedItems?, sourceText? }
async function createSession(req, res) {
  try {
    const text = requireImmersionText(req.body);
    if (req.body && req.body.sourceText !== undefined) {
      // Accepted and validated for forward compatibility; the stored
      // source_text is always the authoritative `text`, never client metadata.
      normalizeText(req.body.sourceText, MAX_IMMERSION_TEXT_LENGTH, 'sourceText');
    }
    const selectedItems = normalizeSelectedItems(req.body);
    const selected = SELECTED_ID_FIELDS.flatMap((field) => selectedItems[field]);
    const result = await createImmersionSession(pool, req.user.id, { text, selected });
    return res.status(201).json({
      sessionId: result.immersionSessionId,
      reviewSessionId: result.reviewSessionId,
      createdCounts: result.createdCounts,
      items: result.items,
      reviewSessionUrl: `/review?reviewSessionId=${result.reviewSessionId}`
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to create immersion session.' });
  }
}

// GET /api/immersion/history?from=&to=&level=&page=&limit=
async function listHistory(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query || {});
    const { from, to, level } = req.query || {};
    if (from !== undefined && !isValidDateString(from)) {
      throw new ValidationError('from must use YYYY-MM-DD format.');
    }
    if (to !== undefined && !isValidDateString(to)) {
      throw new ValidationError('to must use YYYY-MM-DD format.');
    }
    validateAllowedValues(level, JLPT_LEVELS, 'level');
    const { items, total } = await listImmersionSessions(pool, req.user.id, { from, to, level, page, limit, offset });
    return res.json(paginationPayload(items, total, page, limit));
  } catch (error) {
    return sendRouteError(res, error, { defaultMessage: 'Unable to load immersion history.' });
  }
}

module.exports = { analyzeImmersionText, createSession, listHistory };
