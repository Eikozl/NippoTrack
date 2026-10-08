// Persisted public decks: publish owned items, browse public decks,
// follow/unfollow and public author profiles.
const pool = require('../config/db');
const { ValidationError, sendRouteError } = require('../errors/http');
const { parseIdParam, rejectUnknownFields } = require('../validation');
const {
  deleteDeckPublication,
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
const profileAvatar = require('../services/profileAvatar');

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

async function deleteDeck(req, res) {
  try {
    const id = parseIdParam(req, 'deck');
    const result = await deleteDeckPublication(pool, id, req.user.id);
    if (!result) return res.status(404).json({ error: 'deck not found' });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to delete the deck.' });
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
      ownerId: mine ? req.user.id : null,
      viewerId: req.user.id
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
    // Phase 2b: thread the viewer so private/blocked owners resolve to the
    // same 404-shape null as a missing user (no oracle). Shape unchanged.
    const profile = await getPublicProfile(pool, req.params.username, req.user.id);
    if (!profile || profile.gated) return res.status(404).json({ error: 'user not found' });
    return res.json(profile);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the public profile.' });
  }
}

async function getOwnProfile(req, res) {
  try {
    const [rows] = await pool.execute(
      'SELECT username, display_name, bio, avatar_url, is_public, jlpt_level, target_jlpt, interests FROM user_profile WHERE user_id = ?',
      [req.user.id]
    );
    const row = Array.isArray(rows) ? rows[0] : {};
    return res.json({
      username: row?.username || null,
      displayName: row?.display_name || null,
      bio: row?.bio || null,
      avatarUrl: row?.avatar_url || null,
      isPublic: Boolean(row?.is_public),
      jlptLevel: row?.jlpt_level || null,
      targetJlpt: row?.target_jlpt || null,
      interests: row?.interests || null
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to load the profile.' });
  }
}

const OWN_PROFILE_FIELDS = ['username', 'display_name', 'bio', 'avatar_url', 'is_public', 'jlpt_level', 'target_jlpt', 'interests'];
const PROFILE_JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

async function putOwnProfile(req, res) {
  try {
    const body = req.body || {};
    rejectUnknownFields(body, OWN_PROFILE_FIELDS);
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
    // avatar_url allowlist (security): only null/empty (clear) or the
    // caller's own Supabase Storage avatars object URL (as issued by
    // POST /api/users/me/avatar, with ?v= cache-buster). Anything else —
    // foreign hosts, data:/blob:/script schemes — is rejected so the open
    // PUT cannot bypass the upload pipeline's magic-byte/type/path controls.
    // avatar_url allowlist, pinned to the caller (security): only null/empty
    // (clear) or this user's own avatars object URL exactly as issued by
    // POST /api/users/me/avatar (with ?v= digits cache-buster). A looser
    // host/path pattern would let any authenticated user reference another
    // user's photo (profile impersonation via read-public URL guess).
    if (body.avatar_url !== undefined) {
      const raw = String(body.avatar_url || '');
      if (raw === '') patch.avatar_url = null;
      else {
        if (raw.length > 500) throw new ValidationError('avatar_url is too long.');
        let expectedPrefix = null;
        try {
          const base = profileAvatar.avatarServiceConfig().url.replace(/\/+$/, '');
          expectedPrefix = `${base}/storage/v1/object/public/avatars/${req.user.id}/avatar.jpg`;
        } catch { expectedPrefix = null; }
        const pinned = typeof expectedPrefix === 'string' && expectedPrefix.length > 0
          && (raw === expectedPrefix || (raw.startsWith(`${expectedPrefix}?v=`) && /^\?v=\d+$/.test(raw.slice(expectedPrefix.length))));
        if (!pinned) throw new ValidationError('avatar_url must be your uploaded profile photo.');
        patch.avatar_url = raw;
      }
    }
    if (body.is_public !== undefined) {
      if (typeof body.is_public !== 'boolean') throw new ValidationError('is_public must be a boolean');
      patch.is_public = body.is_public;
    }
    for (const levelKey of ['jlpt_level', 'target_jlpt']) {
      if (body[levelKey] !== undefined) {
        const level = String(body[levelKey] || '');
        if (level !== '' && !PROFILE_JLPT_LEVELS.includes(level)) {
          throw new ValidationError(`${levelKey} must be one of: ${PROFILE_JLPT_LEVELS.join(', ')}.`);
        }
        patch[levelKey] = level === '' ? null : level;
      }
    }
    if (body.interests !== undefined) patch.interests = String(body.interests || '').slice(0, 500) || null;
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
      'SELECT username, display_name, bio, avatar_url, is_public, jlpt_level, target_jlpt, interests FROM user_profile WHERE user_id = ?',
      [req.user.id]
    );
    const row = Array.isArray(rows) ? rows[0] : {};
    return res.json({
      username: row?.username || null,
      displayName: row?.display_name || null,
      bio: row?.bio || null,
      avatarUrl: row?.avatar_url || null,
      isPublic: Boolean(row?.is_public),
      jlptLevel: row?.jlpt_level || null,
      targetJlpt: row?.target_jlpt || null,
      interests: row?.interests || null
    });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to save the public profile.' });
  }
}

// Profile avatar upload: stores multipart field `avatar` as the single fixed
// `<userId>/avatar.jpg` object in the public `avatars` bucket (service-key
// mediated; see services/profileAvatar). Responds { avatarUrl }; the client
// persists the URL itself via PUT /api/users/me { avatar_url }.
async function postOwnAvatar(req, res) {
  try {
    const buffer = profileAvatar.extractAvatarFromMultipart(req);
    profileAvatar.validateAvatarBuffer(buffer);
    const consumed = profileAvatar.tryConsumeAvatarUpload({ userId: req.user.id });
    if (!consumed.allowed) {
      res.setHeader('Retry-After', String(consumed.retryAfterSec));
      return res.status(429).json({ error: 'Too many avatar uploads. Please try again later.' });
    }
    const { avatarUrl } = await profileAvatar.storeAvatar({ userId: req.user.id, buffer });
    return res.json({ avatarUrl });
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to upload the avatar.' });
  }
}

// Profile avatar removal: deletes the storage object (not-found ignored) and
// NULLs avatar_url through the same upsert path as putOwnProfile.
async function deleteOwnAvatar(req, res) {
  try {
    const result = await profileAvatar.clearAvatar({ userId: req.user.id });
    return res.json(result);
  } catch (error) {
    return sendRouteError(res, error, { defaultStatus: 503, defaultMessage: 'Unable to remove the avatar.' });
  }
}

async function listPublicUserDecks(req, res) {
  try {
    // Phase 2b: thread the viewer (profile gate already 404s private/blocked
    // owners). Owners browsing their own username path additionally see their
    // private rows; strangers keep the public-only, unblocked filter. The
    // { profile, items } shape is unchanged.
    const profile = await getPublicProfile(pool, req.params.username, req.user.id);
    if (!profile || profile.gated) return res.status(404).json({ error: 'user not found' });
    const lname = String(req.params.username || '').toLowerCase();
    const [ownerRows] = await pool.execute('SELECT user_id FROM user_profile WHERE username = ?', [lname]);
    const ownerId = Array.isArray(ownerRows) ? ownerRows[0]?.user_id : null;
    const isSelf = ownerId !== null && ownerId !== undefined && String(ownerId) === String(req.user.id);
    const gate = isSelf
      ? ''
      : 'AND d.is_public = TRUE AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = d.owner_id) OR (b.blocker_id = d.owner_id AND b.blocked_id = ?))';
    const gateParams = isSelf ? [] : [req.user.id, req.user.id];
    const [rows] = await pool.execute(
      `SELECT d.id_deck_publication AS id, d.title, d.description, d.entity_type, d.created_at,
         (SELECT COUNT(*) FROM deck_follows f WHERE f.id_deck_publication = d.id_deck_publication) AS followers,
         (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items
       FROM deck_publications d
       WHERE d.owner_id = (SELECT user_id FROM user_profile WHERE username = ?)
         ${gate}
       ORDER BY d.id_deck_publication DESC LIMIT ? OFFSET ?`,
      [
        lname,
        ...gateParams,
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
  deleteDeck,
  deleteFollow,
  deleteOwnAvatar,
  getAnalytics,
  getDeck,
  getOwnProfile,
  getPublicUser,
  getPublicUser,
  listDecks,
  listPublicUserDecks,
  listSuggest,
  postDecide,
  postFollow,
  postOwnAvatar,
  postPublish,
  postSuggest,
  putOwnProfile
};
