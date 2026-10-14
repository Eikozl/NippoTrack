const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const { publishDeck } = require('../src/services/deckPublications');
const { importDeckItems } = require('../src/services/deckSharing');

const USER_ID = '00000000-0000-4000-8000-0000000000a1';

function makeStore() {
  return {
    decks: [],
    items: [],
    vocab: [
      { id_vocabulary: 1, word: 'taberu', reading: 'たべる', meaning: 'comer', user_id: USER_ID },
      { id_vocabulary: 2, word: 'nomu', reading: 'のむ', meaning: 'beber', user_id: USER_ID }
    ],
    nextDeckId: 100,
    nextVocabId: 10
  };
}

// Fake pool/connection pair sharing one store. Connections snapshot the
// store on BEGIN and restore it on ROLLBACK, emulating real transactions.
function makePool(store, { failOnItemInsertAt = Infinity } = {}) {
  let itemInserts = 0;
  let vocabInserts = 0;
  const calls = { begins: 0, commits: 0, rollbacks: 0 };
  async function dispatch(sql, params) {
    if (sql.startsWith('SELECT word, reading FROM vocabulary')) {
      return [store.vocab.filter((v) => v.word === params[0] && v.user_id === params[1])];
    }
    if (sql.includes('FROM vocabulary WHERE')) {
      const ids = params.slice(0, -1);
      const rows = store.vocab.filter((v) => ids.includes(v.id_vocabulary) && v.user_id === params[params.length - 1]);
      return [rows];
    }
    if (sql.startsWith('INSERT INTO deck_publications')) {
      const deck = { id: store.nextDeckId++, title: params[1] };
      store.decks.push(deck);
      return [{ insertId: deck.id }];
    }
    if (sql.startsWith('INSERT INTO deck_publication_items')) {
      itemInserts += 1;
      if (itemInserts >= failOnItemInsertAt) throw new Error('synthetic item insert failure');
      store.items.push({ deck: params[0], position: params[1] });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO vocabulary')) {
      vocabInserts += 1;
      if (vocabInserts >= (failOnItemInsertAt === Infinity ? Infinity : failOnItemInsertAt)) throw new Error('synthetic vocab insert failure');
      store.vocab.push({ id_vocabulary: store.nextVocabId++, word: params[1] });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  const connection = {
    calls,
    async execute(sql, params) { return dispatch(sql, params); },
    async beginTransaction() { calls.begins += 1; connection.snapshot = JSON.parse(JSON.stringify(store)); },
    async commit() { calls.commits += 1; connection.snapshot = null; },
    async rollback() {
      calls.rollbacks += 1;
      if (connection.snapshot) {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, connection.snapshot);
      }
    },
    release() {}
  };
  return {
    calls,
    async execute(sql, params) { return dispatch(sql, params); },
    async getConnection() { return connection; }
  };
}

test('publishDeck rolls back the deck row when an item insert fails', async () => {
  const store = makeStore();
  const pool = makePool(store, { failOnItemInsertAt: 2 });
  await assert.rejects(
    publishDeck(pool, USER_ID, { entityType: 'vocabulary', ids: [1, 2], title: 't' }),
    /synthetic item insert failure/
  );
  assert.deepEqual(store.decks, [], 'no orphan deck row remains');
  assert.deepEqual(store.items, [], 'no partial items remain');
  assert.equal(pool.calls.rollbacks, 1);
});

test('publishDeck commits deck plus items on success', async () => {
  const store = makeStore();
  const pool = makePool(store);
  const result = await publishDeck(pool, USER_ID, { entityType: 'vocabulary', ids: [1, 2], title: 't' });
  assert.equal(result.itemCount, 2);
  assert.equal(store.decks.length, 1);
  assert.equal(store.items.length, 2);
  assert.equal(pool.calls.commits, 1);
});

test('importDeckItems rolls back every insert when a later insert fails', async () => {
  const store = makeStore();
  const pool = makePool(store, { failOnItemInsertAt: 3 });
  const deck = {
    entityType: 'vocabulary',
    items: [
      { word: 'w1', meaning: 'm1' },
      { word: 'w2', meaning: 'm2' },
      { word: 'w3', meaning: 'm3' }
    ]
  };
  await assert.rejects(importDeckItems(pool, deck, USER_ID), /synthetic vocab insert failure/);
  assert.ok(!store.vocab.some((v) => v.word === 'w1'), 'no partial import remains');
  assert.ok(!store.vocab.some((v) => v.word === 'w2'), 'no partial import remains');
  assert.equal(pool.calls.rollbacks, 1);
});

test('importDeckItems still reports imported/skipped on success', async () => {
  const store = makeStore();
  const pool = makePool(store);
  const deck = {
    entityType: 'vocabulary',
    items: [
      { word: 'taberu', reading: 'たべる', meaning: 'comer' },
      { word: 'nuevo', meaning: 'nuevo' }
    ]
  };
  const result = await importDeckItems(pool, deck, USER_ID);
  assert.deepEqual(result, { imported: 1, skipped: 1 });
  assert.equal(pool.calls.commits, 1);
});
