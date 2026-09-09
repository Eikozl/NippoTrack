import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileStore, initialsForDisplayName, normalizeDisplayName, normalizeProfile } from '../src/accountProfile.js';

test('initials are Unicode-safe and use first/last words', () => {
  assert.equal(initialsForDisplayName('Yeferson Sena'), 'YS');
  assert.equal(initialsForDisplayName('John Michael Doe'), 'JD');
  assert.equal(initialsForDisplayName('Yeferson'), 'Y');
  assert.equal(initialsForDisplayName('山田 太郎'), '山太');
  assert.equal(initialsForDisplayName('佐藤'), '佐');
  assert.equal(initialsForDisplayName('  山田　太郎  '), '山太');
});

test('empty and null display names never derive initials', () => {
  assert.equal(initialsForDisplayName(''), '');
  assert.equal(initialsForDisplayName(null), '');
  assert.equal(initialsForDisplayName(undefined), '');
  assert.equal(normalizeDisplayName('   '), null);
  assert.equal(normalizeProfile({ displayName: null, email: 'person@example.com' }).initials, '');
});

test('display-name normalization trims and enforces the Unicode character limit', () => {
  assert.equal(normalizeDisplayName(' Luis '), 'Luis');
  assert.equal(normalizeDisplayName('山田 太郎'), '山田 太郎');
  assert.throws(() => normalizeDisplayName('😀'.repeat(51)), /50/);
  assert.throws(() => normalizeDisplayName(42), /text or null/);
});

test('profile store shares one load and updates its cached profile after save', async () => {
  const calls = [];
  const store = createProfileStore(async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'PUT') return { displayName: options.body.display_name, email: 'user@example.com', updatedAt: 'now' };
    return { displayName: 'Luis', email: 'user@example.com', updatedAt: 'now' };
  });
  store.setEmail('user@example.com');
  assert.equal(store.get().email, 'user@example.com');
  const [first, second] = await Promise.all([store.load(), store.load()]);
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.equal(store.get().initials, 'L');
  const saved = await store.save('  山田 太郎  ');
  assert.equal(saved.displayName, '山田 太郎');
  assert.equal(saved.initials, '山太');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/profile');
  assert.equal(calls[1].options.method, 'PUT');
});
