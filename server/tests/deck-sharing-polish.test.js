// Deck sharing polish: preview projection, index-subset selection and
// subset import against a fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDeckShare,
  deckPreview,
  importDeckItems,
  parseDeckShare,
  selectDeckItems
} = require('../src/services/deckSharing');

const SECRET = 'polish-secret';

const ITEMS = [
  { word: '水', reading: 'みず', meaning: 'water', jlpt_level: 'N5', status: 'New', notes: null },
  { word: '学校', reading: 'がっこう', meaning: 'school', jlpt_level: 'N5', status: 'New', notes: null }
];

function code(items = ITEMS) {
  return createDeckShare({ entityType: 'vocabulary', items, title: 'Basics', description: 'starter', creatorId: 'user-1' }, SECRET);
}

function fakeStore({ existingWords = [] } = {}) {
  const inserted = [];
  return {
    inserted,
    async execute(sql, params) {
      if (/SELECT word, reading FROM vocabulary/.test(sql)) {
        return [existingWords.filter((row) => row.word === params[0]).map((row) => ({ word: row.word, reading: row.reading }))];
      }
      if (/INSERT INTO vocabulary/.test(sql)) {
        inserted.push(params[1]);
        return [[{ affectedRows: 1 }]];
      }
      throw new Error(`unexpected SQL in deck polish test: ${sql.slice(0, 60)}`);
    }
  };
}

test('preview projects metadata, items and expiry', () => {
  const deck = parseDeckShare(code(), SECRET);
  const preview = deckPreview(deck);
  assert.equal(preview.title, 'Basics');
  assert.equal(preview.description, 'starter');
  assert.equal(preview.itemCount, 2);
  assert.deepEqual(preview.items[0], { entityType: 'vocabulary', display: '水', reading: 'みず', meaning: 'water' });
  assert.ok(!JSON.stringify(preview).includes('user-1'), 'creator stays hashed');
  assert.ok(Date.parse(preview.expiresAt) - Date.parse(deck.createdAt) === 90 * 86400000, '90-day TTL');
});

test('selectDeckItems keeps order, dedupes and rejects bad indices', () => {
  const deck = parseDeckShare(code(), SECRET);
  assert.deepEqual(selectDeckItems(deck, undefined).length, 2);
  assert.deepEqual(selectDeckItems(deck, [1, 0, 1]).map((entry) => entry.word), ['学校', '水']);
  assert.throws(() => selectDeckItems(deck, [2]), /valid item indices/);
  assert.throws(() => selectDeckItems(deck, [-1]), /valid item indices/);
  assert.throws(() => selectDeckItems(deck, ['0']), /valid item indices/);
  assert.throws(() => selectDeckItems(deck, 'all'), /valid item indices/);
});

test('subset import creates only selected new rows', async () => {
  const store = fakeStore({ existingWords: [{ word: '水', reading: 'みず' }] });
  const deck = parseDeckShare(code(), SECRET);
  const subset = selectDeckItems(deck, [0, 1]);
  const result = await importDeckItems(store, { ...deck, items: subset }, 'user-2');
  assert.deepEqual(result, { imported: 1, skipped: 1 });
  assert.deepEqual(store.inserted, ['学校']);
});

test('tampered and expired codes stay rejected', () => {
  assert.equal(parseDeckShare('garbage', SECRET), null);
  assert.equal(parseDeckShare(code().slice(0, -4) + 'abcd', SECRET), null);
});
