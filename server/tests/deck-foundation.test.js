// Persisted public decks: publish, visibility, follows and public profiles
// against a fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDeckPublication,
  getPublicProfile,
  listPublicDecks,
  publishDeck,
  setDeckFollow
} = require('../src/services/deckPublications');

const OWNED = [
  { id_vocabulary: 11, word: '水', reading: 'みず', meaning: 'water', jlpt_level: 'N5', status: 'New', notes: null }
];

function fakeStore({ deck = null, items = [], publicDecks = [], profile = null, followers = 0 } = {}) {
  const state = { items: items.slice(), follows: followers, nextId: 500 };
  return {
    state,
    async execute(sql, params) {
      if (/FROM vocabulary WHERE/.test(sql)) return [OWNED.filter((row) => params.slice(0, -1).includes(row.id_vocabulary))];
      if (/INSERT INTO deck_publications/.test(sql)) return [{ insertId: state.nextId }];
      if (/INSERT INTO deck_publication_items/.test(sql)) {
        state.items.push({ position: params[1], item_json: JSON.parse(params[2]) });
        return [[{ affectedRows: 1 }]];
      }
      if (/COUNT\(\*\) AS total FROM deck_publications WHERE owner_id/.test(sql)) {
        return [[{ total: publicDecks.length }]];
      }
      if (/FROM deck_publications d WHERE d.id_deck_publication/.test(sql)) return [deck ? [deck] : []];
      if (/FROM deck_publication_items/.test(sql)) {
        return [state.items.map((entry) => ({ position: entry.position, item_json: entry.item_json }))];
      }
      if (/FROM deck_publications d WHERE/.test(sql)) return [publicDecks];
      if (/FROM deck_publications WHERE/.test(sql)) return [deck ? [deck] : []];
      if (/INSERT INTO deck_follows/.test(sql)) { state.follows += 1; return [[{ affectedRows: 1 }]]; }
      if (/DELETE FROM deck_follows/.test(sql)) { state.follows = Math.max(0, state.follows - 1); return [[{ affectedRows: 1 }]]; }
      if (/COUNT\(\*\) AS followers/.test(sql)) return [[{ followers: state.follows }]];
      if (/FROM user_profile WHERE/.test(sql)) return [profile ? [profile] : []];
      if (/FROM deck_publications WHERE owner_id/.test(sql)) return [[{ total: publicDecks.length }]];
      if (/JOIN deck_publications d ON/.test(sql)) return [[{ total: state.follows }]];
      throw new Error(`unexpected SQL in deck foundation test: ${sql.slice(0, 70)}`);
    }
  };
}

test('publish snapshots owned items in order', async () => {
  const store = fakeStore();
  const result = await publishDeck(store, 'owner-1', { entityType: 'vocabulary', ids: [11], title: 'Basics', description: 'starter', isPublic: true });
  assert.equal(result.id, 500);
  assert.equal(result.itemCount, 1);
  assert.equal(store.state.items.length, 1);
  assert.equal(store.state.items[0].item_json.word, '水');
  assert.equal(store.state.items[0].position, 0);
});

test('publish rejects foreign ids and bad input', async () => {
  const store = fakeStore();
  await assert.rejects(publishDeck(store, 'owner-1', { entityType: 'vocabulary', ids: [999], title: 'x' }), /No owned items/);
  await assert.rejects(publishDeck(store, 'owner-1', { entityType: 'emoji', ids: [11], title: 'x' }), /entityType/);
  await assert.rejects(publishDeck(store, 'owner-1', { entityType: 'vocabulary', ids: [], title: 'x' }), /1-200/);
  await assert.rejects(publishDeck(store, 'owner-1', { entityType: 'vocabulary', ids: [11], title: '  ' }), /title/);
});

test('private decks stay invisible to strangers but visible to the owner', async () => {
  const deck = { id: 7, owner_id: 'owner-1', title: 'Mine', description: '', entity_type: 'vocabulary', is_public: 0, created_at: '2026-01-01', followers: 0 };
  const stranger = await getDeckPublication(fakeStore({ deck }), 7, 'stranger-9');
  assert.equal(stranger, null);
  const owner = await getDeckPublication(fakeStore({ deck }), 7, 'owner-1');
  assert.equal(owner.title, 'Mine');
  assert.equal(owner.isPublic, false);
});

test('follow and unfollow move the counter', async () => {
  const deck = { id: 7, owner_id: 'owner-1', title: 'Open', description: '', entity_type: 'vocabulary', is_public: 1, created_at: '2026-01-01', followers: 0 };
  const store = fakeStore({ deck, followers: 2 });
  const followed = await setDeckFollow(store, 7, 'fan-1', true);
  assert.deepEqual(followed, { following: true, followers: 3 });
  const unfollowed = await setDeckFollow(store, 7, 'fan-1', false);
  assert.deepEqual(unfollowed, { following: false, followers: 2 });
  assert.equal(await setDeckFollow(fakeStore({ deck: null }), 999, 'fan-1', true), null);
});

test('public profiles gate on username, visibility and format', async () => {
  const profile = { user_id: 'owner-1', display_name: 'Taro', bio: 'learner', avatar_url: null };
  const store = fakeStore({ profile, publicDecks: [{ id: 1 }] });
  const found = await getPublicProfile(store, 'taro-123');
  assert.equal(found.username, 'taro-123');
  assert.equal(found.displayName, 'Taro');
  assert.equal(found.stats.decks, 1);
  assert.equal(await getPublicProfile(fakeStore({ profile: null }), 'ghost-1'), null);
  const upper = await getPublicProfile(store, 'UPPER');
  assert.equal(upper?.username, 'upper', 'usernames normalize to lowercase');
  assert.equal(await getPublicProfile(store, 'has space'), null);
  assert.equal(await getPublicProfile(store, 'x'), null);
});
