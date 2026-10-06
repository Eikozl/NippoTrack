const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const {
  MAX_LIBRARY_LIMIT,
  MAX_READING_ENROLL_ITEMS,
  MAX_READING_TEXT_LENGTH,
  MAX_READING_TITLE_LENGTH,
  analyzeTextForReading,
  createUserReadingText,
  deleteUserReadingText,
  enrollReadingItems,
  getReadingText,
  importAozoraUrl,
  importHukuUrl,
  listReadingLibrary,
  listReadingProgress,
  previewAozoraSources,
  previewHukuSources,
  saveSentenceTranslations,
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

async function listProgress(req, res) {
  try {
    const query = req.query || {};
    const page = parseQueryInteger(query.page, 'page', 1);
    const limit = parseQueryInteger(query.limit, 'limit', 20, MAX_LIBRARY_LIMIT);
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) throw new ValidationError('page is too large.');
    const result = await listReadingProgress(pool, req.user.id, { page, limit, offset });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load reading progress.' });
  }
}

async function deleteText(req, res) {
  try {
    const id = parseIdParam(req, 'reading text');
    const result = await deleteUserReadingText(pool, req.user.id, id);
    if (!result) return res.status(404).json({ error: 'Reading text not found.' });
    return res.json({ id, deleted: true });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete reading text.' });
  }
}

async function enrollText(req, res) {
  try {
    const id = parseIdParam(req, 'reading text');
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['selected']);
    if (!Array.isArray(body.selected) || body.selected.length < 1 || body.selected.length > MAX_READING_ENROLL_ITEMS) {
      throw new ValidationError(`selected must be an array of 1 to ${MAX_READING_ENROLL_ITEMS} candidate id strings.`);
    }
    const result = await enrollReadingItems(pool, req.user.id, id, body.selected);
    if (!result) return res.status(404).json({ error: 'Reading text not found.' });
    return res.json({ text_id: id, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to enroll reading items.' });
  }
}

async function putTranslations(req, res) {
  try {
    const id = parseIdParam(req, 'reading text');
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['translations']);
    const translations = await saveSentenceTranslations(pool, req.user.id, id, body.translations);
    if (!translations) return res.status(404).json({ error: 'Reading text not found.' });
    return res.json({ text_id: id, translations });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save translations.' });
  }
}

const READING_SOURCES = ['aozora', 'hukumusume'];
const AOZORA_INDEXES = ['a', 'ka', 'sa', 'ta', 'na', 'ha', 'ma', 'ya', 'ra', 'wa'];
const HUKU_INDEXES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

async function previewImports(req, res) {
  try {
    const query = req.query || {};
    const source = query.source === undefined || query.source === '' ? 'aozora' : query.source;
    if (!READING_SOURCES.includes(source)) {
      throw new ValidationError('source must be aozora or hukumusume.');
    }
    // fetch is injectable through app.locals for offline tests/operators; the
    // service still pins every request to its fixed, allowlisted host.
    const fetchImpl = req.app?.locals?.readingFetch || globalThis.fetch;
    if (source === 'hukumusume') {
      if (query.index !== undefined && query.index !== '' && !HUKU_INDEXES.includes(query.index)) {
        throw new ValidationError('index must be one of: 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12.');
      }
      return res.json(await previewHukuSources(fetchImpl, { index: query.index || '01' }));
    }
    if (query.index !== undefined && query.index !== '' && !AOZORA_INDEXES.includes(query.index)) {
      throw new ValidationError('index must be one of: a, ka, sa, ta, na, ha, ma, ya, ra, wa.');
    }
    return res.json(await previewAozoraSources(fetchImpl, { index: query.index || 'a' }));
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to preview reading sources.' });
  }
}

function assertImportUrls(sourceType, urls) {
  if (urls === undefined) return null;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20) {
    throw new ValidationError('urls must be an array of 1 to 20 source URLs.');
  }
  const shape = sourceType === 'hukumusume'
    ? /^\/douwa\/pc\/jap\/\d\d\/\d+\.htm$/i
    : /^\/cards\/\d+\/card\d+\.html$/i;
  const host = sourceType === 'hukumusume' ? 'hukumusume.com' : 'www.aozora.gr.jp';
  return urls.map((entry) => {
    if (typeof entry !== 'string') throw new ValidationError('urls must be an array of 1 to 20 source URLs.');
    let parsed = null;
    try {
      parsed = new URL(entry.trim());
    } catch (_) {
      throw new ValidationError('urls must be an array of 1 to 20 source URLs.');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.port || parsed.username || parsed.password) {
      throw new ValidationError('urls must be an array of 1 to 20 source URLs.');
    }
    if (!shape.test(parsed.pathname)) {
      throw new ValidationError('urls must be an array of 1 to 20 source URLs.');
    }
    return parsed.href;
  });
}

async function importFromUrl(req, res) {
  try {
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['url']);
    if (typeof body.url !== 'string' || !body.url.trim()) {
      throw new ValidationError('url must be an Aozora work page or Hukumusume story page URL.');
    }
    // Shape-checked synchronously so malformed input 400s immediately; the
    // service re-checks before fetching. The single text is imported within
    // this request (awaited, never detached): on serverless runtimes nothing
    // survives the response, so fire-and-forget background work silently
    // never completes there. Failures return honest errors, never silence.
    const raw = String(body.url.trim());
    let sourceType = null;
    let url = null;
    try {
      url = assertAozoraCardUrlShape(raw);
      sourceType = 'aozora';
    } catch (_) {
      url = assertHukuStoryUrlShape(raw);
      sourceType = 'hukumusume';
    }
    const userId = req.user.id;
    const fetchImpl = req.app?.locals?.readingFetch || globalThis.fetch;
    const importSingle = sourceType === 'hukumusume' ? importHukuUrl : importAozoraUrl;
    const result = await importSingle(pool, userId, url, { fetch: fetchImpl });
    if (!result || result.status !== 'ok') {
      return res.status(502).json({ error: result?.reason || 'Source request failed.' });
    }
    return res.status(201).json({ status: 'ok', sourceType, imported: result.imported || 0, textsImported: result.textsImported || 0 });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to import reading link.' });
  }
}

function assertHukuStoryUrlShape(value) {
  const message = 'url must be a Hukumusume story page URL (https://hukumusume.com/douwa/pc/jap/…/….htm).';
  let parsed = null;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw new ValidationError(message);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'hukumusume.com' || parsed.port || parsed.username || parsed.password) {
    throw new ValidationError(message);
  }
  if (!/^\/douwa\/pc\/jap\/\d\d\/\d+\.htm$/i.test(parsed.pathname)) throw new ValidationError(message);
  return parsed.href;
}

function assertAozoraCardUrlShape(value) {
  const message = 'url must be an Aozora work page URL (https://www.aozora.gr.jp/cards/…/card….html).';
  let parsed = null;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw new ValidationError(message);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.aozora.gr.jp' || parsed.port || parsed.username || parsed.password) {
    throw new ValidationError(message);
  }
  if (!/^\/cards\/\d+\/card\d+\.html$/i.test(parsed.pathname)) throw new ValidationError(message);
  return parsed.href;
}

async function importSources(req, res) {
  try {
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['sourceType', 'urls', 'index']);
    if (!READING_SOURCES.includes(body.sourceType)) {
      throw new ValidationError('sourceType must be aozora or hukumusume.');
    }
    const allowedIndexes = body.sourceType === 'hukumusume' ? HUKU_INDEXES : AOZORA_INDEXES;
    if (body.index !== undefined && body.index !== null && body.index !== '' && !allowedIndexes.includes(body.index)) {
      throw new ValidationError(`index must be one of: ${allowedIndexes.join(', ')}.`);
    }
    // Optional selective import: a bounded list of exact page URLs, each
    // re-validated below (https + source host + story path) and then
    // intersected with the live listing, so only listed works can be pulled.
    const urls = assertImportUrls(body.sourceType, body.urls);
    // Awaited within the request (never detached): serverless runtimes kill
    // anything scheduled after the response, which is exactly how bulk
    // imports silently never landed. Items commit one by one inside the
    // service, so even a function timeout keeps partial progress and a
    // retry resumes idempotently via the advisory lock + existing-row
    // checks. The response carries honest counts, never blind optimism.
    const userId = req.user.id;
    const fetchImpl = req.app?.locals?.readingFetch || globalThis.fetch;
    const result = await syncReadingSources(pool, userId, body.sourceType, { fetch: fetchImpl, urls, index: body.index || null });
    if (!result || result.status !== 'ok') {
      return res.status(502).json({ error: result?.reason || 'Source request failed.' });
    }
    return res.status(200).json({ status: 'ok', sourceType: body.sourceType, imported: result.imported || 0, textsImported: result.textsImported || 0 });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to import reading sources.' });
  }
}

module.exports = {
  analyzeText,
  createUserText,
  deleteText,
  enrollText,
  getText,
  importFromUrl,
  importSources,
  listLibrary,
  listProgress,
  previewImports,
  putTranslations,
  updateProgress
};
