// Reading publications: publish owned texts, browse community texts,
// import them into the reader library. Mirrors deckPublicationsController.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const {
  deleteReadingPublication,
  getReadingPublication,
  importReadingPublication,
  listReadingPublications,
  publishReading
} = require('../services/readingPublications');

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

async function postPublish(req, res) {
  try {
    const body = bodyObject(req.body);
    rejectUnknownFields(body, ['textId', 'title', 'description', 'isPublic']);
    const result = await publishReading(pool, req.user.id, {
      textId: body.textId,
      title: body.title,
      description: body.description,
      isPublic: body.isPublic
    });
    if (!result) return res.status(404).json({ error: 'Reading text not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to publish the text.' });
  }
}

async function listPublications(req, res) {
  try {
    const query = req.query || {};
    const result = await listReadingPublications(pool, {
      limit: query.limit !== undefined ? Number(query.limit) : 20,
      offset: query.offset !== undefined ? Number(query.offset) : 0,
      ownerId: query.ownerId || null,
      viewerId: req.user.id
    });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to list publications.' });
  }
}

async function getPublication(req, res) {
  try {
    const id = parseIdParam(req, 'publication');
    const publication = await getReadingPublication(pool, id, req.user.id);
    if (!publication) return res.status(404).json({ error: 'Publication not found.' });
    return res.json(publication);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the publication.' });
  }
}

async function deletePublication(req, res) {
  try {
    const id = parseIdParam(req, 'publication');
    const result = await deleteReadingPublication(pool, id, req.user.id);
    if (!result) return res.status(404).json({ error: 'Publication not found.' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete the publication.' });
  }
}

async function postImport(req, res) {
  try {
    const id = parseIdParam(req, 'publication');
    const result = await importReadingPublication(pool, req.user.id, id);
    if (!result) return res.status(404).json({ error: 'Publication not found.' });
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to import the text.' });
  }
}

module.exports = {
  deletePublication,
  getPublication,
  listPublications,
  postImport,
  postPublish
};
