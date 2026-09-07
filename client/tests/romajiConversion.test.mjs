// Phase 12 — romaji conversion for analyzer vocabulary reading test.
// Pure module, no DOM, no server, no async — just assertion logic.
import test from 'node:test';
import assert from 'node:assert/strict';

// Test the transliteratedValue helper directly (unit test)
import { transliteratedValue } from '../src/kanjiReference.js';

test('transliteratedValue returns hiragana when script is hiragana', () => {
  const transliteration = { hiragana: 'いく', katakana: 'イク' };
  assert.equal(transliteratedValue(transliteration, 'hiragana'), 'いく');
});

test('transliteratedValue returns katakana when script is katakana', () => {
  const transliteration = { hiragana: 'いく', katakana: 'イク' };
  assert.equal(transliteratedValue(transliteration, 'katakana'), 'イク');
});

test('transliteratedValue returns null for missing script', () => {
  const transliteration = { hiragana: 'いく' };
  assert.equal(transliteratedValue(transliteration, 'katakana'), null);
});

test('transliteratedValue returns null for empty transliteration', () => {
  assert.equal(transliteratedValue(null, 'hiragana'), null);
  assert.equal(transliteratedValue({}, 'hiragana'), null);
});

test('transliteratedValue returns null for invalid script', () => {
  const transliteration = { hiragana: 'いく', katakana: 'イク' };
  assert.equal(transliteratedValue(transliteration, 'invalid'), null);
});

// Real blur/dialog coverage lives in stabilization.browser.test.mjs.
