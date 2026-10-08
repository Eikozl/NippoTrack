// Locale toggle hardening: setLocale/getLocale must work even when
// localStorage or the DOM are unavailable (private mode, blocked storage,
// DOM-free contexts). Executable under node (no DOM globals here, which is
// exactly the fallback path under test).
import test from 'node:test';
import assert from 'node:assert/strict';

import { getLocale, setLocale, t } from '../src/i18n.js';

test('locale defaults to English with no storage or DOM available', () => {
  assert.equal(typeof localStorage, 'undefined', 'precondition: node has no localStorage');
  setLocale('en');
  assert.equal(getLocale(), 'en');
});

test('setLocale never throws without DOM/storage and takes effect in memory', () => {
  setLocale('es');
  assert.equal(getLocale(), 'es');
  setLocale('en');
  assert.equal(getLocale(), 'en');
});

test('invalid locale values fall back to English', () => {
  setLocale('fr');
  assert.equal(getLocale(), 'en');
  setLocale(null);
  assert.equal(getLocale(), 'en');
  setLocale('en');
});

test('t() follows the in-memory locale (end-to-end dict path)', () => {
  setLocale('es');
  assert.equal(t('Settings'), 'Ajustes');
  setLocale('en');
  assert.equal(t('Settings'), 'Settings');
  assert.equal(t('Unmapped string stays verbatim'), 'Unmapped string stays verbatim');
});
