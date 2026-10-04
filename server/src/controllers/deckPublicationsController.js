// Persisted public decks: publish owned items, browse public decks,
// follow/unfollow and public author profiles.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam } = require('../validation');
const {
  getDeckAnalytics,
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

async function getAnalytics(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const analytics = await getDeckAnalytics(pool, id, req.user.id, { period: req.query?.period });
    if (!analytics) return res.status(404).json({ error: 'deck not found' });
    return res.json(analytics);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load deck analytics.' });
  }
}

async function listDecks(req, res) {
  try {
    const mine = req.query?.mine === 'true' || req.query?.mine === '1';
    const decks = await listPublicDecks(pool, {
      entityType: req.query?.entityType || null,
      limit: req.query?.limit,
      offset: req.query?.offset,
      ownerId: mine ? req.user.id : null
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

const OWN_PROFILE_FIELDS = ['username', 'display_name', 'bio', 'avatar_url', 'is_public'];

async function putOwnProfile(req, res) {
  try {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((key) => !OWN_PROFILE_FIELDS.includes(key));
    if (unknown.length) throw new ValidationError(`Unexpected field(s): ${unknown.join(', ')}.`);
    const patch = {};
    if (body.username !== undefined) {
      const username = String(body.username || '').toLowerCase();
      if (username !== '' && !/^[a-z0-9][a-z0-9-]{1,29}$/.test(username)) {
        throw new ValidationError('username holds 2-30 lowercase letters, numbers or hyphens');
      }
      patch.username = username === '' ? null : username;
    }
    if (body.display_name !== undefined) {
      const displayName = String(body.display_name || '').slice(0, 50);
      patch.display_name = displayName === '' ? null : displayName;
    }
    if (body.bio !== undefined) patch.bio = String(body.bio || '').slice(0, 500) || null;
    if (body.avatar_url !== undefined) patch.avatar_url = String(body.avatar_url || '').slice(0, 500) || null;
    if (body.is_public !== undefined) {
      if (typeof body.is_public !== 'boolean') throw new ValidationError('is_public must be a boolean');
      patch.is_public = body.is_public;
    }
    const columns = Object.keys(patch);
    if (!columns.length) throw new ValidationError('Nothing to update.');
    const excluded = columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ');
    try {
      await pool.execute(
        `INSERT INTO user_profile (user_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
         ON CONFLICT (user_id) DO UPDATE SET ${excluded}`,
        [req.user.id, ...columns.map((column) => patch[column])]
      );
    } catch (error) {
      if (String(error?.message || '').includes('user_profile_username_key')) {
        throw new ValidationError('username is already taken');
      }
      throw error;
    }
    const [rows] = await pool.execute(
      'SELECT username, display_name, bio, avatar_url, is_public FROM user_profile WHERE user_id = ?',
      [req.user.id]
    );
    const row = Array.isArray(rows) ? rows[0] : {};
    return res.json({
      username: row?.username || null,
      displayName: row?.display_name || null,
      bio: row?.bio || null,
      avatarUrl: row?.avatar_url || null,
      isPublic: Boolean(row?.is_public)
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save the public profile.' });
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
  getAnalytics,
  getDeck,
  getPublicUser,
  listDecks,
  listPublicUserDecks,
  listSuggest,
  postDecide,
  postFollow,
  postPublish,
  postSuggest,
  putOwnProfile
};
