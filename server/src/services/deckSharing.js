// Shared decks: export owned items as a signed JSON code, import a verified
// code as NEW rows in the importer's collection (ids never cross users).
// HMAC-SHA256 over canonical JSON; the secret is injected (never stored).
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { ValidationError } = require('../errors/http');
const { withTransaction } = require('./transactions');

const DECK_VERSION = 1;
const DECK_TTL_MS = 90 * 86400000;
const MAX_DECK_ITEMS = 200;

const ENTITY = {
  vocabulary: {
    table: 'vocabulary',
    idColumn: 'id_vocabulary',
    columns: ['word', 'reading', 'meaning', 'jlpt_level', 'status', 'notes'],
    naturalKey: (item) => ['word', 'reading'].map((key) => String(item?.[key] || '')),
    insertColumns: ['user_id', 'word', 'reading', 'meaning', 'jlpt_level', 'status', 'notes'],
    insertValues: (userId, item) => [userId, item.word, item.reading || null, item.meaning, item.jlpt_level || null, item.status || 'New', item.notes || null]
  },
  kanji: {
    table: 'kanji',
    idColumn: 'id_kanji',
    columns: ['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level', 'status', 'notes'],
    naturalKey: (item) => [String(item?.character_kanji || '')],
    insertColumns: ['user_id', 'character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level', 'status', 'notes'],
    insertValues: (userId, item) => [userId, item.character_kanji, item.meaning, item.onyomi || null, item.kunyomi || null, item.jlpt_level || null, item.status || 'New', item.notes || null]
  },
  grammar: {
    table: 'grammar_points',
    idColumn: 'id_grammar',
    columns: ['grammar_point', 'meaning', 'structure', 'example', 'jlpt_level', 'status', 'notes'],
    naturalKey: (item) => [String(item?.grammar_point || '')],
    insertColumns: ['user_id', 'grammar_point', 'meaning', 'structure', 'example', 'jlpt_level', 'status', 'notes'],
    insertValues: (userId, item) => [userId, item.grammar_point, item.meaning, item.structure || null, item.example || null, item.jlpt_level || null, item.status || 'New', item.notes || null]
  }
};

function base64urlEncode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function signPayload(canonical, secret) {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url');
}

function creatorHash(userId) {
  return createHash('sha256').update(String(userId || ''), 'utf8').digest('hex').slice(0, 16);
}

function sanitizeDeckInput({ entityType, ids, title, description }) {
  if (!ENTITY[entityType]) return { error: 'entityType must be vocabulary, kanji or grammar' };
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DECK_ITEMS) {
    return { error: `ids must be 1-${MAX_DECK_ITEMS} item ids` };
  }
  const cleanIds = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!cleanIds.length) return { error: 'ids must be 1-200 item ids' };
  return {
    value: {
      entityType,
      ids: cleanIds,
      title: String(title || '').slice(0, 120),
      description: String(description || '').slice(0, 500)
    }
  };
}

async function fetchOwnedItems(executor, entityType, ids, userId) {
  const def = ENTITY[entityType];
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await executor.execute(
    `SELECT ${def.idColumn}, ${def.columns.join(', ')} FROM ${def.table} WHERE ${def.idColumn} IN (${placeholders}) AND user_id = ?`,
    [...ids, userId]
  );
  return Array.isArray(rows) ? rows : [];
}

function createDeckShare({ entityType, items, title, description, creatorId }, secret, now = Date.now()) {
  if (!secret) throw new Error('Deck sharing requires a signing secret.');
  const payload = {
    version: DECK_VERSION,
    createdAt: new Date(now).toISOString(),
    creator: creatorHash(creatorId),
    title: String(title || '').slice(0, 120),
    description: String(description || '').slice(0, 500),
    entityType,
    items: items.map((item) => {
      const def = ENTITY[entityType];
      const entry = {};
      for (const column of ['word', 'character_kanji', 'grammar_point', 'reading', 'meaning', 'onyomi', 'kunyomi', 'structure', 'example', 'jlpt_level', 'status', 'notes']) {
        if (def.columns.includes(column)) entry[column] = item[column] ?? null;
      }
      return entry;
    })
  };
  const canonical = JSON.stringify(payload);
  return `${base64urlEncode(canonical)}.${signPayload(canonical, secret)}`;
}

function parseDeckShare(code, secret, now = Date.now()) {
  try {
    if (!secret || typeof code !== 'string') return null;
    const [encoded, signature] = code.split('.');
    if (!encoded || !signature) return null;
    const canonical = base64urlDecode(encoded);
    const expected = signPayload(canonical, secret);
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(canonical);
    if (!payload || payload.version !== DECK_VERSION || !ENTITY[payload.entityType]) return null;
    if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > MAX_DECK_ITEMS) return null;
    const age = now - Date.parse(payload.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > DECK_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

async function importDeckItems(executor, deck, userId) {
  const def = ENTITY[deck.entityType];
  // Atomic import: a mid-loop failure rolls back every inserted row, so a
  // retry reports a clean imported/skipped split instead of a misleading
  // partial one. Duplicate detection below is unchanged.
  return withTransaction(executor, async (connection) => {
    let imported = 0;
    let skipped = 0;
    for (const item of deck.items) {
      const key = def.naturalKey(item);
      if (!key[0]) { skipped += 1; continue; }
      // Duplicate check in code: NULL readings never match with SQL equality,
      // and per-user UNIQUEs differ per entity (vocabulary has none).
      let dupe = false;
      if (deck.entityType === 'vocabulary') {
        const [all] = await connection.execute(
          'SELECT word, reading FROM vocabulary WHERE word = ? AND user_id = ?',
          [key[0], userId]
        );
        dupe = (Array.isArray(all) ? all : []).some((row) => String(row.reading || '') === String(key[1] || ''));
      } else {
        const uniqueColumn = deck.entityType === 'kanji' ? 'character_kanji' : 'grammar_point';
        const [rows] = await connection.execute(
          `SELECT ${def.idColumn} FROM ${def.table} WHERE ${uniqueColumn} = ? AND user_id = ? LIMIT 1`,
          [key[0], userId]
        );
        dupe = Array.isArray(rows) && rows.length > 0;
      }
      if (dupe) { skipped += 1; continue; }
      const values = def.insertValues(userId, item);
      await connection.execute(
        `INSERT INTO ${def.table} (${def.insertColumns.join(', ')}) VALUES (${values.map(() => '?').join(', ')})`,
        values
      );
      imported += 1;
    }
    return { imported, skipped };
  });
}

function deckPreview(deck, ttlMs = DECK_TTL_MS) {
  const displayOf = (entry) => entry.word || entry.character_kanji || entry.grammar_point || 'item';
  const readingOf = (entry) => entry.reading || entry.onyomi || entry.kunyomi || null;
  const createdAt = deck.createdAt;
  return {
    title: deck.title || 'Shared deck',
    description: deck.description || '',
    itemCount: deck.items.length,
    items: deck.items.map((entry) => ({
      entityType: deck.entityType,
      display: displayOf(entry),
      reading: readingOf(entry),
      meaning: entry.meaning || null
    })),
    creator: { creatorHash: deck.creator, createdAt },
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString()
  };
}

// Subset import by 0-based item indices. Throws ValidationError on any
// out-of-range or non-integer index; duplicates removed, order kept.
function selectDeckItems(deck, selected) {
  if (selected === undefined) return deck.items;
  if (!Array.isArray(selected)) throw new ValidationError('selectedItems must be an array of valid item indices');
  for (const index of selected) {
    if (!Number.isInteger(index) || index < 0 || index >= deck.items.length) {
      throw new ValidationError('selectedItems must be an array of valid item indices');
    }
  }
  return [...new Set(selected)].map((index) => deck.items[index]);
}

module.exports = {
  DECK_TTL_MS,
  DECK_VERSION,
  ENTITY,
  MAX_DECK_ITEMS,
  createDeckShare,
  deckPreview,
  fetchOwnedItems,
  importDeckItems,
  parseDeckShare,
  sanitizeDeckInput,
  selectDeckItems
};
