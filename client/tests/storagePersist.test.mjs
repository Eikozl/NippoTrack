import test from 'node:test';
import assert from 'node:assert/strict';

import { requestPersistentStorage } from '../src/storagePersist.js';

test('already-persistent storage resolves true without requesting', async () => {
  let persistCalls = 0;
  const result = await requestPersistentStorage({
    storage: { persisted: async () => true, persist: async () => { persistCalls += 1; return true; } }
  });
  assert.equal(result, true);
  assert.equal(persistCalls, 0);
});

test('granted request resolves true', async () => {
  const result = await requestPersistentStorage({
    storage: { persisted: async () => false, persist: async () => true }
  });
  assert.equal(result, true);
});

test('denials, missing APIs and throwables resolve false', async () => {
  assert.equal(await requestPersistentStorage({
    storage: { persisted: async () => false, persist: async () => false }
  }), false);
  assert.equal(await requestPersistentStorage({}), false);
  assert.equal(await requestPersistentStorage(null), false);
  assert.equal(await requestPersistentStorage(undefined), false);
  assert.equal(await requestPersistentStorage({
    storage: { persisted: async () => { throw new Error('private mode'); } }
  }), false);
});
