// Deck collections: owned playlists of publications with order, plus
// self-contained signed share codes (import-all reuses the per-deck
// importer). Secret handling mirrors shareController (503 without it).
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const {
  addDeckToCollection,
  createCollection,
  createCollectionShare,
  deleteCollection,
  getCollection,
  importCollectionShare,
  parseCollectionShare,
  removeDeckFromCollection,
  reorderCollection
} = require('../services/deckCollections');
const { getDeckPublication } = require('../services/deckPublications');

function signingSecret() {
  const secret = String(process.env.JLT_DECK_SHARE_SECRET || '').trim();
  return secret || null;
}

async function postCollection(req, res) {
  try {
    const body = req.body || {};
    const result = await createCollection(pool, req.user.id, {
      title: body.title,
      description: body.description,
      isPublic: body.isPublic
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to create the collection.' });
  }
}

async function listCollections(req, res) {
  try {
    const scope = String(req.query?.scope || 'mine');
    if (!['mine', 'public'].includes(scope)) throw new ValidationError('scope must be mine or public');
    const where = scope === 'mine' ? 'owner_id = ?' : 'is_public = TRUE';
    const [rows] = await pool.execute(
      `SELECT id_deck_collection AS id, owner_id, title, description, is_public, created_at,
         (SELECT COUNT(*) FROM deck_collection_decks c WHERE c.id_deck_collection = deck_collections.id_deck_collection) AS decks
       FROM deck_collections WHERE ${where} ORDER BY id_deck_collection DESC LIMIT ? OFFSET ?`,
      scope === 'mine'
        ? [req.user.id, Math.max(1, Math.min(50, Number(req.query?.limit) || 20)), Math.max(0, Number(req.query?.offset) || 0)]
        : [Math.max(1, Math.min(50, Number(req.query?.limit) || 20)), Math.max(0, Number(req.query?.offset) || 0)]
    );
    return res.json({
      items: (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id),
        title: row.title,
        description: row.description,
        isPublic: Boolean(row.is_public),
        createdAt: row.created_at,
        deckCount: Number(row.decks || 0)
      }))
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to list collections.' });
  }
}

async function getCollectionDetail(req, res) {
  try {
    const id = parseIdParam(req, 'collection');
    const collection = await getCollection(pool, id, req.user.id);
    if (!collection) return res.status(404).json({ error: 'collection not found' });
    return res.json(collection);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the collection.' });
  }
}

async function deleteCollectionHandler(req, res) {
  try {
    const id = parseIdParam(req, 'collection');
    const result = await deleteCollection(pool, id, req.user.id);
    if (!result) return res.status(404).json({ error: 'collection not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete the collection.' });
  }
}

async function postCollectionDeck(req, res) {
  try {
    const id = parseIdParam(req, 'collection');
    const deckId = Number(req.body?.deckId);
    if (!Number.isInteger(deckId) || deckId <= 0) throw new ValidationError('deckId must be a positive integer');
    const result = await addDeckToCollection(pool, id, req.user.id, deckId);
    if (!result) return res.status(404).json({ error: 'collection not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to add the deck.' });
  }
}

async function deleteCollectionDeck(req, res) {
  try {
    const id = parseIdParam(req, 'collection');
    const deckId = parseIdParam({ params: { id: req.params.deckId } }, 'deck');
    const result = await removeDeckFromCollection(pool, id, req.user.id, deckId);
    if (!result) return res.status(404).json({ error: 'collection not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to remove the deck.' });
  }
}

async function putCollectionOrder(req, res) {
  try {
    const id = parseIdParam(req, 'collection');
    const result = await reorderCollection(pool, id, req.user.id, req.body?.orderedIds);
    if (!result) return res.status(404).json({ error: 'collection not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to reorder the collection.' });
  }
}

async function postCollectionShare(req, res) {
  try {
    const secret = signingSecret();
    if (!secret) {
      return res.status(503).json({ error: 'Deck sharing is not configured on this server.' });
    }
    const id = parseIdParam(req, 'collection');
    const collection = await getCollection(pool, id, req.user.id);
    if (!collection) return res.status(404).json({ error: 'collection not found' });
    const decks = [];
    for (const member of collection.decks) {
      const full = await getDeckPublication(pool, member.id, req.user.id);
      if (full) decks.push({ id: full.id, title: full.title, entityType: full.entityType, items: full.items });
    }
    const shareCode = createCollectionShare(collection, decks, req.user.id, secret);
    return res.json({ shareCode, deckCount: decks.length });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to share the collection.' });
  }
}

async function postCollectionImport(req, res) {
  try {
    const secret = signingSecret();
    if (!secret) {
      return res.status(503).json({ error: 'Deck sharing is not configured on this server.' });
    }
    const code = req.body?.shareCode;
    if (typeof code !== 'string' || !code) throw new ValidationError('shareCode must be a non-empty string');
    const payload = parseCollectionShare(code, secret);
    if (!payload) return res.status(404).json({ error: 'Share code is invalid or expired.' });
    const result = await importCollectionShare(pool, payload, req.user.id);
    return res.json({ success: true, title: payload.title, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to import the collection.' });
  }
}

module.exports = {
  deleteCollection: deleteCollectionHandler,
  deleteCollectionDeck,
  getCollectionDetail,
  listCollections,
  postCollection,
  postCollectionDeck,
  postCollectionImport,
  postCollectionShare,
  putCollectionOrder
};
