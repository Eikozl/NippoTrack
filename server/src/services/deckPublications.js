// Persisted public decks (social foundation): publications with snapshotted
// items, public listing, follows and public author profiles. Unlike stateless
// share codes, publications are first-class rows with an owner, so
// suggestions, collections and import telemetry can build on them.
const { ValidationError } = require('../errors/http');
const { ENTITY, fetchOwnedItems } = require('./deckSharing');

const SNAPSHOT_COLUMNS = ['word', 'character_kanji', 'grammar_point', 'reading', 'meaning', 'onyomi', 'kunyomi', 'structure', 'example', 'jlpt_level', 'status'];

function snapshotItem(entityType, row) {
  const def = ENTITY[entityType];
  const entry = { id: row?.[def.idColumn] ?? null };
  for (const column of SNAPSHOT_COLUMNS) {
    if (def.columns.includes(column)) entry[column] = row[column] ?? null;
  }
  return entry;
}

function displayOf(entityType, entry) {
  if (entityType === 'kanji') return entry.character_kanji || 'item';
  if (entityType === 'grammar') return entry.grammar_point || 'item';
  return entry.word || 'item';
}

async function publishDeck(executor, ownerId, { entityType, ids, title, description, isPublic = true }) {
  if (!ENTITY[entityType]) throw new ValidationError('entityType must be vocabulary, kanji or grammar');
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new ValidationError('ids must be 1-200 item ids');
  const cleanIds = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!cleanIds.length) throw new ValidationError('ids must be 1-200 item ids');
  const cleanTitle = String(title || '').trim().slice(0, 120);
  if (!cleanTitle) throw new ValidationError('title must be a non-empty string');
  const rows = await fetchOwnedItems(executor, entityType, cleanIds, ownerId);
  if (!rows.length) throw new ValidationError('No owned items match the requested ids.');
  const byId = new Map(rows.map((row) => [Number(row[ENTITY[entityType].idColumn]), row]));
  const ordered = cleanIds.map((id) => byId.get(id)).filter(Boolean);
  const [inserted] = await executor.execute(
    'INSERT INTO deck_publications (owner_id, title, description, entity_type, is_public) VALUES (?, ?, ?, ?, ?)',
    [ownerId, cleanTitle, String(description || '').slice(0, 500), entityType, isPublic !== false]
  );
  const deckId = Number(inserted?.insertId);
  if (!Number.isInteger(deckId) || deckId <= 0) throw new Error('Unable to publish the deck.');
  let position = 0;
  for (const row of ordered) {
    await executor.execute(
      'INSERT INTO deck_publication_items (id_deck_publication, position, item_json) VALUES (?, ?, ?::jsonb)',
      [deckId, position++, JSON.stringify(snapshotItem(entityType, row))]
    );
  }
  return { id: deckId, itemCount: ordered.length };
}

async function getDeckPublication(executor, deckId, viewerId) {
  const [rows] = await executor.execute(
    `SELECT d.id_deck_publication AS id, d.owner_id, d.title, d.description, d.entity_type, d.is_public, d.created_at,
       p.username AS owner_username, p.display_name AS owner_display,
       (SELECT COUNT(*) FROM deck_follows f WHERE f.id_deck_publication = d.id_deck_publication) AS followers,
       CASE WHEN ? IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM deck_follows f WHERE f.id_deck_publication = d.id_deck_publication AND f.follower_id = ?) END AS viewer_following
     FROM deck_publications d
     LEFT JOIN user_profile p ON p.user_id = d.owner_id
     WHERE d.id_deck_publication = ?`,
    [viewerId || null, viewerId || null, deckId]
  );
  const deck = Array.isArray(rows) ? rows[0] : null;
  if (!deck) return null;
  if ((!deck.is_public && deck.is_public !== 1) && String(deck.owner_id) !== String(viewerId)) return null;
  const [items] = await executor.execute(
    'SELECT position, item_json FROM deck_publication_items WHERE id_deck_publication = ? ORDER BY position ASC',
    [deckId]
  );
  return {
    id: Number(deck.id),
    ownerId: deck.owner_id,
    ownerUsername: deck.owner_username || null,
    ownerDisplay: deck.owner_display || null,
    viewerFollowing: deck.viewer_following === null || deck.viewer_following === undefined ? null : Number(deck.viewer_following) === 1,
    title: deck.title,
    description: deck.description,
    entityType: deck.entity_type,
    isPublic: Boolean(deck.is_public),
    createdAt: deck.created_at,
    followers: Number(deck.followers || 0),
    items: (Array.isArray(items) ? items : []).map((row) => ({ position: Number(row.position), ...row.item_json }))
  };
}

async function listPublicDecks(executor, { entityType = null, limit = 20, offset = 0, ownerId = null, viewerId = null } = {}) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const where = [];
  const params = [];
  if (ownerId) {
    where.push('d.owner_id = ?');
    params.push(ownerId);
  } else {
    where.push('d.is_public = TRUE');
  }
  if (entityType) {
    if (!ENTITY[entityType]) throw new ValidationError('entityType must be vocabulary, kanji or grammar');
    where.push('d.entity_type = ?');
    params.push(entityType);
  }
  const [rows] = await executor.execute(
    `SELECT d.id_deck_publication AS id, d.title, d.description, d.entity_type, d.is_public, d.created_at,
       p.username AS owner_username, p.display_name AS owner_display,
       (SELECT COUNT(*) FROM deck_follows f WHERE f.id_deck_publication = d.id_deck_publication) AS followers,
       (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items,
       CASE WHEN ? IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM deck_follows f WHERE f.id_deck_publication = d.id_deck_publication AND f.follower_id = ?) END AS viewer_following
     FROM deck_publications d
     LEFT JOIN user_profile p ON p.user_id = d.owner_id
     WHERE ${where.join(' AND ')}
     ORDER BY followers DESC, d.id_deck_publication DESC LIMIT ? OFFSET ?`,
    [viewerId || null, viewerId || null, ...params, safeLimit, safeOffset]
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id),
    title: row.title,
    description: row.description,
    entityType: row.entity_type,
    isPublic: Boolean(row.is_public),
    ownerUsername: row.owner_username || null,
    ownerDisplay: row.owner_display || null,
    viewerFollowing: row.viewer_following === null || row.viewer_following === undefined ? null : Number(row.viewer_following) === 1,
    createdAt: row.created_at,
    followers: Number(row.followers || 0),
    itemCount: Number(row.items || 0)
  }));
}

async function deleteDeckPublication(executor, deckId, viewerId) {
  const [rows] = await executor.execute(
    'SELECT owner_id FROM deck_publications WHERE id_deck_publication = ?',
    [deckId]
  );
  const deck = Array.isArray(rows) ? rows[0] : null;
  if (!deck || String(deck.owner_id) !== String(viewerId)) return null;
  await executor.execute('DELETE FROM deck_publications WHERE id_deck_publication = ?', [deckId]);
  return { deletedId: Number(deckId) };
}

async function setDeckFollow(executor, deckId, followerId, follow) {
  const [rows] = await executor.execute(
    'SELECT id_deck_publication AS id, is_public FROM deck_publications WHERE id_deck_publication = ?',
    [deckId]
  );
  const deck = Array.isArray(rows) ? rows[0] : null;
  if (!deck || (!deck.is_public && deck.is_public !== 1)) return null;
  if (follow) {
    await executor.execute(
      'INSERT INTO deck_follows (id_deck_publication, follower_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [deckId, followerId]
    );
  } else {
    await executor.execute(
      'DELETE FROM deck_follows WHERE id_deck_publication = ? AND follower_id = ?',
      [deckId, followerId]
    );
  }
  const [count] = await executor.execute(
    'SELECT COUNT(*) AS followers FROM deck_follows WHERE id_deck_publication = ?',
    [deckId]
  );
  return { following: Boolean(follow), followers: Number(count?.[0]?.followers || 0) };
}

// Owner-only analytics from data the platform actually holds: follows over
// time (deck_follows is timestamped), suggestion decisions, item count.
// No geography/device tracking by design (privacy-first); per-item follower
// performance is unavailable because snapshots carry no shared identity.
async function getDeckAnalytics(executor, deckId, viewerId, { period = '30d' } = {}) {
  const validPeriods = { '7d': 7, '30d': 30, '90d': 90, all: null };
  const days = Object.hasOwn(validPeriods, period) ? validPeriods[period] : 30;
  const [rows] = await executor.execute(
    'SELECT id_deck_publication AS id, owner_id, title FROM deck_publications WHERE id_deck_publication = ?',
    [deckId]
  );
  const deck = Array.isArray(rows) ? rows[0] : null;
  if (!deck || String(deck.owner_id) !== String(viewerId)) return null;
  const since = days === null ? null : new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const [follows] = await executor.execute(
    `SELECT COUNT(*) AS total FROM deck_follows WHERE id_deck_publication = ?${since ? ' AND created_at >= ?' : ''}`,
    since ? [deckId, since] : [deckId]
  );
  const [daily] = await executor.execute(
    `SELECT SUBSTRING(CAST(created_at AS VARCHAR), 1, 10) AS day, COUNT(*) AS follows
     FROM deck_follows WHERE id_deck_publication = ?${since ? ' AND created_at >= ?' : ''}
     GROUP BY 1 ORDER BY 1 ASC`,
    since ? [deckId, since] : [deckId]
  );
  const [suggestions] = await executor.execute(
    `SELECT status, COUNT(*) AS total FROM deck_suggestions WHERE id_deck_publication = ? GROUP BY status`,
    [deckId]
  );
  const [items] = await executor.execute(
    'SELECT COUNT(*) AS total FROM deck_publication_items WHERE id_deck_publication = ?',
    [deckId]
  );
  const byStatus = { pending: 0, accepted: 0, rejected: 0 };
  for (const row of Array.isArray(suggestions) ? suggestions : []) {
    if (row.status in byStatus) byStatus[row.status] = Number(row.total || 0);
  }
  return {
    deckId: Number(deck.id),
    title: deck.title,
    period: days === null ? 'all' : `${days}d`,
    overview: {
      followers: Number(follows?.[0]?.total || 0),
      suggestions: byStatus,
      items: Number(items?.[0]?.total || 0)
    },
    followersByDay: (Array.isArray(daily) ? daily : []).map((row) => ({ date: row.day, follows: Number(row.follows || 0) }))
  };
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,29}$/;

async function getPublicProfile(executor, username) {
  const name = String(username || '').toLowerCase();
  if (!USERNAME_PATTERN.test(name)) return null;
  const [rows] = await executor.execute(
    'SELECT user_id, display_name, bio, avatar_url FROM user_profile WHERE username = ? AND is_public = TRUE',
    [name]
  );
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile) return null;
  const [[decks]] = await executor.execute(
    'SELECT COUNT(*) AS total FROM deck_publications WHERE owner_id = ? AND is_public = TRUE',
    [profile.user_id]
  );
  const [[follows]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM deck_follows f
     JOIN deck_publications d ON d.id_deck_publication = f.id_deck_publication
     WHERE d.owner_id = ? AND d.is_public = TRUE`,
    [profile.user_id]
  );
  return {
    username: name,
    displayName: profile.display_name || null,
    bio: profile.bio || null,
    avatarUrl: profile.avatar_url || null,
    stats: { decks: Number(decks?.total || 0), followers: Number(follows?.total || 0) }
  };
}

module.exports = {
  deleteDeckPublication,
  displayOf,
  getDeckAnalytics,
  getDeckPublication,
  getPublicProfile,
  listPublicDecks,
  publishDeck,
  setDeckFollow,
  snapshotItem
};
