// Deck collections: membership, reorder, share roundtrip and import-all
// against a fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addDeckToCollection,
  createCollection,
  createCollectionShare,
  getCollection,
  importCollectionShare,
  parseCollectionShare,
  removeDeckFromCollection,
  reorderCollection
} = require('../src/services/deckCollections');

const SECRET = 'collection-secret';

function fakeStore({ collection = { id: 3, owner_id: 'owner-1', is_public: 1 }, members = [11, 12], deckPublic = true, deckOwner = 'owner-1' } = {}) {
  const state = { members: members.slice(), positions: new Map(members.map((id, index) => [id, index])), nextId: 77, inserted: [] };
  return {
    state,
    async execute(sql, params) {
      if (/INSERT INTO deck_collections/.test(sql)) return [{ insertId: state.nextId }];
      if (/FROM deck_collections WHERE id_deck_collection/.test(sql)) return [collection ? [collection] : []];
      if (/MAX\(position\)/.test(sql)) {
        const positions = [...state.positions.values()];
        return [[{ max_position: positions.length ? Math.max(...positions) : -1 }]];
      }
      if (/FROM deck_publications WHERE id_deck_publication/.test(sql)) {
        if (!deckPublic) return [];
        const visibility = deckPublic === 'private' ? 0 : 1;
        return [[{ id: params[0], is_public: visibility, owner_id: deckOwner }]];
      }
      if (/INSERT INTO deck_collection_decks/.test(sql)) {
        state.members.push(params[1]);
        state.positions.set(params[1], params[2]);
        return [[{ affectedRows: 1 }]];
      }
      if (/DELETE FROM deck_collection_decks/.test(sql)) {
        state.members = state.members.filter((id) => id !== params[1]);
        state.positions.delete(params[1]);
        return [[{ affectedRows: 1 }]];
      }
      if (/FROM deck_collection_decks WHERE id_deck_collection/.test(sql) && /SELECT id_deck_publication/.test(sql)) {
        return [state.members.map((id) => ({ id_deck_publication: id }))];
      }
      if (/UPDATE deck_collection_decks SET position/.test(sql)) {
        state.positions.set(params[2], params[0]);
        return [[{ affectedRows: 1 }]];
      }
      if (/FROM deck_collection_decks c JOIN/.test(sql)) {
        return [state.members.map((id) => ({
          id, title: `deck-${id}`, entity_type: 'vocabulary', is_public: 1
        }))];
      }
      if (/FROM deck_collections WHERE id_deck_collection/.test(sql)) {
        return [[{ title: 'Mix', description: '', is_public: 1, created_at: '2026-01-01' }]];
      }
      if (/SELECT word, reading FROM vocabulary/.test(sql)) return [[]];
      if (/INSERT INTO vocabulary/.test(sql)) {
        state.inserted.push(params[1]);
        return [[{ affectedRows: 1 }]];
      }
      throw new Error(`unexpected SQL in collections test: ${sql.slice(0, 70)}`);
    }
  };
}

test('create validates the title and reports the id', async () => {
  const store = fakeStore();
  assert.deepEqual(await createCollection(store, 'owner-1', { title: 'Mix', description: 'd' }), { id: 77 });
  await assert.rejects(createCollection(store, 'owner-1', { title: '  ' }), /non-empty string/);
});

test('add respects ownership and public visibility', async () => {
  const store = fakeStore();
  const added = await addDeckToCollection(store, 3, 'owner-1', 13);
  assert.equal(added.added, true);
  assert.ok(store.state.members.includes(13), 'member recorded');
  assert.equal(await addDeckToCollection(fakeStore({ collection: null }), 999, 'owner-1', 13), null);
  await assert.rejects(addDeckToCollection(fakeStore({ deckPublic: 'private', deckOwner: 'owner-2' }), 3, 'owner-1', 13), /public decks/);
});

test('reorder requires exactly the member set', async () => {
  const store = fakeStore();
  const result = await reorderCollection(store, 3, 'owner-1', [12, 11]);
  assert.deepEqual(result, { reordered: true });
  assert.equal(store.state.positions.get(12), 0);
  assert.equal(store.state.positions.get(11), 1);
  await assert.rejects(reorderCollection(store, 3, 'owner-1', [12]), /exactly the collection member/);
  await assert.rejects(reorderCollection(store, 3, 'owner-1', [12, 99]), /exactly the collection member/);
  assert.equal(await reorderCollection(store, 3, 'stranger-9', [12, 11]), null);
  const removed = await removeDeckFromCollection(store, 3, 'owner-1', 12);
  assert.deepEqual(removed, { removed: true });
});

test('share roundtrip verifies and import-all dedupes per deck', async () => {
  const decks = [{
    id: 11, title: 'Basics', entityType: 'vocabulary',
    items: [
      { word: '水', reading: 'みず', meaning: 'water', jlpt_level: 'N5', status: 'New', notes: null },
      { word: '学校', reading: 'がっこう', meaning: 'school', jlpt_level: 'N5', status: 'New', notes: null }
    ]
  }];
  const code = createCollectionShare({ title: 'Mix', description: '' }, decks, 'owner-1', SECRET);
  const payload = parseCollectionShare(code, SECRET);
  assert.ok(payload, 'collection code verifies');
  assert.equal(payload.decks.length, 1);
  assert.equal(parseCollectionShare(code, 'wrong-secret'), null);
  const store = fakeStore();
  const result = await importCollectionShare(store, payload, 'user-2');
  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.decks[0].title, 'Basics');
});

test('private collections stay invisible to strangers', async () => {
  const hidden = fakeStore({ collection: { id: 3, owner_id: 'owner-1', is_public: 0 } });
  assert.equal(await getCollection(hidden, 3, 'stranger-9'), null);
  const visible = await getCollection(hidden, 3, 'owner-1');
  assert.equal(visible.decks.length, 2);
});
