// Persisted public decks: publish owned items, browse public decks,
// follow/unfollow and public author profiles.
const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const {
  getDeckPublication,
  getPublicProfile,
  listPublicDecks,
  publishDeck,
  setDeckFollow
} = require('../services/deckPublications');
const {
  createSuggestion,
  decideSuggestion,
  listSuggestions
} = require('../services/deckSuggestions');

async function postPublish(req, res) {
  try {
    const body = req.body || {};
    const result = await publishDeck(pool, req.user.id, {
      entityType: body.entityType,
      ids: body.ids,
      title: body.title,
      description: body.description,
      isPublic: body.isPublic
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to publish the deck.' });
  }
}

async function getDeck(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const deck = await getDeckPublication(pool, id, req.user.id);
    if (!deck) return res.status(404).json({ error: 'deck not found' });
    return res.json(deck);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the deck.' });
  }
}

async function listDecks(req, res) {
  try {
    const decks = await listPublicDecks(pool, {
      entityType: req.query?.entityType || null,
      limit: req.query?.limit,
      offset: req.query?.offset
    });
    return res.json({ items: decks });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to list public decks.' });
  }
}

async function postFollow(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const result = await setDeckFollow(pool, id, req.user.id, true);
    if (!result) return res.status(404).json({ error: 'deck not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to follow the deck.' });
  }
}

async function deleteFollow(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const result = await setDeckFollow(pool, id, req.user.id, false);
    if (!result) return res.status(404).json({ error: 'deck not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to unfollow the deck.' });
  }
}

async function postSuggest(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const result = await createSuggestion(pool, id, req.user.id, req.body?.suggestedChanges);
    if (!result) return res.status(404).json({ error: 'deck not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to submit the suggestion.' });
  }
}

async function listSuggest(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const items = await listSuggestions(pool, id, req.user.id);
    if (!items) return res.status(404).json({ error: 'deck not found' });
    return res.json({ items });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to list suggestions.' });
  }
}

async function postDecide(req, res) {
  try {
    const id = parseIdParam(req, 'suggestion');
    const result = await decideSuggestion(pool, id, req.user.id, req.body || {});
    if (!result) return res.status(404).json({ error: 'suggestion not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to decide the suggestion.' });
  }
}

async function getPublicUser(req, res) {
  try {
    const profile = await getPublicProfile(pool, req.params.username);
    if (!profile) return res.status(404).json({ error: 'user not found' });
    return res.json(profile);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the public profile.' });
  }
}

async function listPublicUserDecks(req, res) {
  try {
    const profile = await getPublicProfile(pool, req.params.username);
    if (!profile) return res.status(404).json({ error: 'user not found' });
    const [rows] = await pool.execute(
      `SELECT d.id_deck_publication AS id, d.title, d.description, d.entity_type, d.created_at,
         (SELECT COUNT(*) FROM deck_follows f WHERE f.id_deck_publication = d.id_deck_publication) AS followers,
         (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items
       FROM deck_publications d
       WHERE d.owner_id = (SELECT user_id FROM user_profile WHERE username = ?)
         AND d.is_public = TRUE
       ORDER BY d.id_deck_publication DESC LIMIT ? OFFSET ?`,
      [
        String(req.params.username || '').toLowerCase(),
        Math.max(1, Math.min(50, Number(req.query?.limit) || 20)),
        Math.max(0, Number(req.query?.offset) || 0)
      ]
    );
    return res.json({
      profile,
      items: (Array.isArray(rows) ? rows : []).map((row) => ({
        id: Number(row.id),
        title: row.title,
        description: row.description,
        entityType: row.entity_type,
        createdAt: row.created_at,
        followers: Number(row.followers || 0),
        itemCount: Number(row.items || 0)
      }))
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to list user decks.' });
  }
}

module.exports = {
  deleteFollow,
  getDeck,
  getPublicUser,
  listDecks,
  listPublicUserDecks,
  listSuggest,
  postDecide,
  postFollow,
  postPublish,
  postSuggest
};
