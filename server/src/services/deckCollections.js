// Deck collections (playlists): owned groups of publications with an order,
// plus self-contained signed share codes (collection snapshot, not live
// refs, so imports survive source edits). Import-all reuses the per-deck
// importer with its dedupe.
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { ValidationError } = require('../errors/http');
const { ENTITY, importDeckItems } = require('./deckSharing');

const COLLECTION_VERSION = 1;
const COLLECTION_TTL_MS = 90 * 86400000;
const MAX_COLLECTION_DECKS = 50;

function signCanonical(canonical, secret) {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url');
}

async function createCollection(executor, ownerId, { title, description, isPublic = true }) {
  const cleanTitle = String(title || '').trim().slice(0, 120);
  if (!cleanTitle) throw new ValidationError('title must be a non-empty string');
  const [inserted] = await executor.execute(
    'INSERT INTO deck_collections (owner_id, title, description, is_public) VALUES (?, ?, ?, ?)',
    [ownerId, cleanTitle, String(description || '').slice(0, 500), isPublic !== false]
  );
  const id = Number(inserted?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Unable to create the collection.');
  return { id };
}

async function collectionOwnerId(executor, collectionId) {
  const [rows] = await executor.execute(
    'SELECT id_deck_collection AS id, owner_id, is_public FROM deck_collections WHERE id_deck_collection = ?',
    [collectionId]
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getCollection(executor, collectionId, viewerId) {
  const collection = await collectionOwnerId(executor, collectionId);
  if (!collection) return null;
  if ((!collection.is_public && collection.is_public !== 1) && String(collection.owner_id) !== String(viewerId)) return null;
  const [rows] = await executor.execute(
    `SELECT d.id_deck_publication AS id, d.title, d.entity_type, d.is_public,
       (SELECT COUNT(*) FROM deck_publication_items i WHERE i.id_deck_publication = d.id_deck_publication) AS items
     FROM deck_collection_decks c JOIN deck_publications d ON d.id_deck_publication = c.id_deck_publication
     WHERE c.id_deck_collection = ? ORDER BY c.position ASC, c.id_deck_publication ASC`,
    [collectionId]
  );
  const [full] = await executor.execute(
    'SELECT title, description, is_public, created_at FROM deck_collections WHERE id_deck_collection = ?',
    [collectionId]
  );
  const meta = Array.isArray(full) ? full[0] : {};
  return {
    id: Number(collection.id),
    title: meta?.title,
    description: meta?.description,
    isPublic: Boolean(collection.is_public),
    createdAt: meta?.created_at,
    decks: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row.id),
      title: row.title,
      entityType: row.entity_type,
      isPublic: Boolean(row.is_public),
      itemCount: Number(row.items || 0)
    }))
  };
}

async function addDeckToCollection(executor, collectionId, viewerId, deckId) {
  const collection = await collectionOwnerId(executor, collectionId);
  if (!collection || String(collection.owner_id) !== String(viewerId)) return null;
  const [decks] = await executor.execute(
    'SELECT id_deck_publication AS id, is_public, owner_id FROM deck_publications WHERE id_deck_publication = ?',
    [deckId]
  );
  const deck = Array.isArray(decks) ? decks[0] : null;
  if (!deck) throw new ValidationError('deck not found');
  if ((!deck.is_public && deck.is_public !== 1) && String(deck.owner_id) !== String(viewerId)) {
    throw new ValidationError('only public decks (or your own) can join a collection');
  }
  const [members] = await executor.execute(
    'SELECT COALESCE(MAX(position), -1) AS max_position FROM deck_collection_decks WHERE id_deck_collection = ?',
    [collectionId]
  );
  const position = Number(members?.[0]?.max_position ?? -1) + 1;
  await executor.execute(
    'INSERT INTO deck_collection_decks (id_deck_collection, id_deck_publication, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [collectionId, deckId, position]
  );
  return { added: true, position };
}

async function removeDeckFromCollection(executor, collectionId, viewerId, deckId) {
  const collection = await collectionOwnerId(executor, collectionId);
  if (!collection || String(collection.owner_id) !== String(viewerId)) return null;
  await executor.execute(
    'DELETE FROM deck_collection_decks WHERE id_deck_collection = ? AND id_deck_publication = ?',
    [collectionId, deckId]
  );
  return { removed: true };
}

async function reorderCollection(executor, collectionId, viewerId, orderedIds) {
  const collection = await collectionOwnerId(executor, collectionId);
  if (!collection || String(collection.owner_id) !== String(viewerId)) return null;
  if (!Array.isArray(orderedIds) || !orderedIds.length || orderedIds.length > MAX_COLLECTION_DECKS) {
    throw new ValidationError('orderedIds must be a non-empty array of deck ids');
  }
  const clean = [...new Set(orderedIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const [members] = await executor.execute(
    'SELECT id_deck_publication FROM deck_collection_decks WHERE id_deck_collection = ?',
    [collectionId]
  );
  const memberIds = new Set((Array.isArray(members) ? members : []).map((row) => Number(row.id_deck_publication)));
  if (clean.length !== memberIds.size || !clean.every((id) => memberIds.has(id))) {
    throw new ValidationError('orderedIds must list exactly the collection member decks');
  }
  let position = 0;
  for (const id of clean) {
    await executor.execute(
      'UPDATE deck_collection_decks SET position = ? WHERE id_deck_collection = ? AND id_deck_publication = ?',
      [position++, collectionId, id]
    );
  }
  return { reordered: true };
}

function createCollectionShare(collection, decks, creatorId, secret, now = Date.now()) {
  if (!secret) throw new Error('Collection sharing requires a signing secret.');
  const payload = {
    version: COLLECTION_VERSION,
    createdAt: new Date(now).toISOString(),
    creator: createHash('sha256').update(String(creatorId || ''), 'utf8').digest('hex').slice(0, 16),
    title: collection.title,
    description: collection.description,
    decks: decks.map((deck) => ({
      deckId: deck.id,
      title: deck.title,
      entityType: deck.entityType,
      items: deck.items
    }))
  };
  const canonical = JSON.stringify(payload);
  return `${Buffer.from(canonical, 'utf8').toString('base64url')}.${signCanonical(canonical, secret)}`;
}

function parseCollectionShare(code, secret, now = Date.now()) {
  try {
    if (!secret || typeof code !== 'string') return null;
    const [encoded, signature] = code.split('.');
    if (!encoded || !signature) return null;
    const canonical = Buffer.from(String(encoded), 'base64url').toString('utf8');
    const expected = signCanonical(canonical, secret);
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(canonical);
    if (!payload || payload.version !== COLLECTION_VERSION || !Array.isArray(payload.decks)) return null;
    const age = now - Date.parse(payload.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > COLLECTION_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

async function importCollectionShare(executor, payload, userId) {
  let imported = 0;
  let skipped = 0;
  const perDeck = [];
  for (const deck of payload.decks) {
    if (!ENTITY[deck.entityType] || !Array.isArray(deck.items)) continue;
    const result = await importDeckItems(executor, { entityType: deck.entityType, items: deck.items }, userId);
    imported += result.imported;
    skipped += result.skipped;
    perDeck.push({ deckId: deck.deckId, title: deck.title, ...result });
  }
  return { imported, skipped, decks: perDeck };
}

module.exports = {
  COLLECTION_TTL_MS,
  addDeckToCollection,
  createCollection,
  createCollectionShare,
  getCollection,
  importCollectionShare,
  parseCollectionShare,
  removeDeckFromCollection,
  reorderCollection
};
