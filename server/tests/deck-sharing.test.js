// Shared decks: sign/verify roundtrip, tamper and expiry rejection, and
// import deduplication against a fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDeckShare,
  fetchOwnedItems,
  importDeckItems,
  parseDeckShare,
  sanitizeDeckInput
} = require('../src/services/deckSharing');

const SECRET = 'test-secret-for-decks';
const OTHER_SECRET = 'different-secret';

function fakeStore({ owned = [], existingWords = [] } = {}) {
  const inserted = [];
  return {
    inserted,
    async execute(sql, params) {
      if (/FROM vocabulary WHERE/.test(sql) && /IN \(/.test(sql)) {
        return [owned.filter((row) => params.slice(0, -1).includes(row.id_vocabulary))];
      }
      if (/SELECT word, reading FROM vocabulary/.test(sql)) {
        return [existingWords.filter((row) => row.word === params[0]).map((row) => ({ word: row.word, reading: row.reading }))];
      }
      if (/INSERT INTO vocabulary/.test(sql)) {
        inserted.push({ word: params[1], reading: params[2] });
        return [[{ affectedRows: 1 }]];
      }
      throw new Error(`unexpected SQL in deck test: ${sql.slice(0, 60)}`);
    }
  };
}

const OWNED = [
  { id_vocabulary: 11, word: '水', reading: 'みず', meaning: 'water', jlpt_level: 'N5', status: 'Learning', notes: null },
  { id_vocabulary: 12, word: '学校', reading: 'がっこう', meaning: 'school', jlpt_level: 'N5', status: 'New', notes: null }
];

test('export roundtrip verifies and never leaks raw ids', () => {
  const { error, value } = sanitizeDeckInput({ entityType: 'vocabulary', ids: [11, 12, 12, 'x'], title: 'Basics', description: 'starter set' });
  assert.equal(error, undefined);
  assert.deepEqual(value.ids, [11, 12]);
  const code = createDeckShare({ entityType: 'vocabulary', items: OWNED, title: 'Basics', description: 'starter set', creatorId: 'user-1' }, SECRET);
  const deck = parseDeckShare(code, SECRET);
  assert.ok(deck, 'signed code verifies');
  assert.equal(deck.version, 1);
  assert.equal(deck.entityType, 'vocabulary');
  assert.equal(deck.items.length, 2);
  assert.equal(deck.items[0].word, '水');
  assert.ok(!JSON.stringify(deck).includes('user-1'), 'creator id is hashed, not raw');
});

test('tampered codes and wrong secrets are rejected', () => {
  const code = createDeckShare({ entityType: 'vocabulary', items: OWNED, title: '', description: '', creatorId: 'user-1' }, SECRET);
  assert.equal(parseDeckShare(code, OTHER_SECRET), null);
  const [encoded, signature] = code.split('.');
  const tampered = `${encoded.slice(0, -2)}ab.${signature}`;
  assert.equal(parseDeckShare(tampered, SECRET), null);
  assert.equal(parseDeckShare('not-a-code', SECRET), null);
  assert.equal(parseDeckShare(code, ''), null);
  assert.equal(sanitizeDeckInput({ entityType: 'kanji', ids: [] }).error, 'ids must be 1-200 item ids');
  assert.equal(sanitizeDeckInput({ entityType: 'emoji', ids: [1] }).error, 'entityType must be vocabulary, kanji or grammar');
});

test('expired and future-dated codes are rejected', () => {
  const old = createDeckShare({ entityType: 'vocabulary', items: OWNED, title: '', description: '', creatorId: 'u' }, SECRET, Date.now() - 91 * 86400000);
  assert.equal(parseDeckShare(old, SECRET), null, '91-day-old code expired');
  const fresh = createDeckShare({ entityType: 'vocabulary', items: OWNED, title: '', description: '', creatorId: 'u' }, SECRET, Date.now() + 60000);
  assert.equal(parseDeckShare(fresh, SECRET), null, 'future-dated code rejected');
});

test('import creates new rows, skips duplicates and blanks', async () => {
  const store = fakeStore({ existingWords: [{ word: '水', reading: 'みず' }] });
  const deck = {
    version: 1, entityType: 'vocabulary',
    items: [
      { word: '水', reading: 'みず', meaning: 'water', jlpt_level: 'N5', status: 'Learning', notes: null },
      { word: '学校', reading: 'がっこう', meaning: 'school', jlpt_level: 'N5', status: 'New', notes: null },
      { word: '', reading: '', meaning: 'blank', jlpt_level: null, status: 'New', notes: null }
    ]
  };
  const result = await importDeckItems(store, deck, 'user-2');
  assert.deepEqual(result, { imported: 1, skipped: 2 });
  assert.deepEqual(store.inserted, [{ word: '学校', reading: 'がっこう' }]);
});

test('fetchOwnedItems returns only the requester-owned rows', async () => {
  const store = fakeStore({ owned: OWNED });
  const rows = await fetchOwnedItems(store, 'vocabulary', [11, 12, 999], 'user-1');
  assert.equal(rows.length, 2);
});
