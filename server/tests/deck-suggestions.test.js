// Deck suggestions: creation, validation, owner-only listing and decisions
// against a fake executor (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSuggestion,
  decideSuggestion,
  listSuggestions,
  sanitizeChanges
} = require('../src/services/deckSuggestions');

const DECK = { owner_id: 'owner-1', is_public: 1 };
const SUGGESTION = {
  id: 9, deck_id: 7, owner_id: 'owner-1', status: 'pending',
  changes_json: [{ field: 'title', oldValue: 'Old', newValue: 'New', reason: 'typo' }]
};

function fakeStore({ deck = DECK, suggestion = SUGGESTION, updated = [] } = {}) {
  return {
    updated,
    async execute(sql, params) {
      if (/FROM deck_publications WHERE id_deck_publication/.test(sql)) return [deck ? [deck] : []];
      if (/INSERT INTO deck_suggestions/.test(sql)) return [{ insertId: 44 }];
      if (/FROM deck_suggestions s JOIN/.test(sql)) return [suggestion ? [suggestion] : []];
      if (/FROM deck_suggestions WHERE/.test(sql)) {
        return [[{ id: 9, proposer_id: 'fan-1', changes_json: SUGGESTION.changes_json, status: 'pending', comment: null, created_at: '2026-01-01', decided_at: null }]];
      }
      if (/UPDATE deck_publications SET/.test(sql)) {
        updated.push({ sql, params });
        return [[{ affectedRows: 1 }]];
      }
      if (/UPDATE deck_suggestions SET/.test(sql)) {
        updated.push({ sql, params });
        return [[{ affectedRows: 1 }]];
      }
      throw new Error(`unexpected SQL in suggestions test: ${sql.slice(0, 60)}`);
    }
  };
}

test('suggestion creation validates fields, reasons and authorship', async () => {
  const store = fakeStore();
  const created = await createSuggestion(store, 7, 'fan-1', [
    { field: 'title', oldValue: 'Old', newValue: 'New', reason: 'typo fix' }
  ]);
  assert.deepEqual(created, { id: 44, status: 'pending' });
  assert.equal(await createSuggestion(fakeStore({ deck: null }), 999, 'fan-1', [{ field: 'title', oldValue: 'a', newValue: 'b', reason: 'r' }]), null);
  await assert.rejects(createSuggestion(store, 7, 'owner-1', [{ field: 'title', oldValue: 'a', newValue: 'b', reason: 'r' }]), /own deck/);
  await assert.rejects(createSuggestion(store, 7, 'fan-1', [{ field: 'items', oldValue: 'a', newValue: 'b', reason: 'r' }]), /title or description/);
  await assert.rejects(createSuggestion(store, 7, 'fan-1', [{ field: 'title', oldValue: 'a', newValue: 'b', reason: '' }]), /reason is required/);
  await assert.rejects(createSuggestion(store, 7, 'fan-1', []), /1-20/);
});

test('listing is owner-only', async () => {
  const items = await listSuggestions(fakeStore(), 7, 'owner-1');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(await listSuggestions(fakeStore(), 7, 'stranger-9'), null);
  assert.equal(await listSuggestions(fakeStore({ deck: null }), 999, 'owner-1'), null);
});

test('accept applies title and decides', async () => {
  const store = fakeStore();
  const result = await decideSuggestion(store, 9, 'owner-1', { decision: 'accept', comment: 'good catch' });
  assert.deepEqual(result, { id: 9, status: 'accepted' });
  const deckUpdate = store.updated.find((entry) => /UPDATE deck_publications/.test(entry.sql));
  assert.ok(deckUpdate, 'deck row updated on accept');
  assert.ok(deckUpdate.params.includes('New'), 'new title applied');
});

test('reject marks without touching the deck', async () => {
  const store = fakeStore();
  const result = await decideSuggestion(store, 9, 'owner-1', { decision: 'reject', comment: 'style' });
  assert.deepEqual(result, { id: 9, status: 'rejected' });
  assert.ok(!store.updated.some((entry) => /UPDATE deck_publications/.test(entry.sql)), 'deck untouched on reject');
});

test('non-owners, bad decisions and decided suggestions fail', async () => {
  const store = fakeStore();
  assert.equal(await decideSuggestion(store, 9, 'stranger-9', { decision: 'accept' }), null);
  await assert.rejects(decideSuggestion(store, 9, 'owner-1', { decision: 'maybe' }), /accept.*reject/);
  const decided = fakeStore({ suggestion: { ...SUGGESTION, status: 'accepted' } });
  await assert.rejects(decideSuggestion(decided, 9, 'owner-1', { decision: 'reject' }), /already decided/);
});
