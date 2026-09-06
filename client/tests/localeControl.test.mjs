// Authenticated-shell language control: desktop header button plus the
// account dialog section, both on the existing locale mechanism.
// Static source assertions; no DOM, servers, or browsers required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('desktop header exposes a compact language control', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('header-locale-wrap'), 'locale control wrapper');
  assert.ok(source.includes('themeToggle?.before(localeWrap)'), 'mounted between Estimate and Theme');
  assert.ok(source.includes("role: 'menu'"), 'menu semantics');
  assert.ok(source.includes("role: 'menuitemradio'"), 'options are radio items');
  assert.ok(source.includes("aria-checked"), 'current locale indicated');
});

test('language switching reuses the existing locale mechanism', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('setLocale(value)'), 'persists through setLocale');
  assert.ok(source.includes('getLocale()'), 'reads through getLocale');
  assert.ok(source.includes("window.addEventListener('jlt-locale-change', () => syncLocaleControl())"), 'control follows locale changes');
  assert.ok(!source.includes("setItem('jlt-locale'"), 'no second preference system');
});

test('locale menu follows dialog/menu conventions', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes("event.key === 'Escape'"), 'Escape closes the menu');
  assert.ok(source.includes('closeLocaleMenu(true)'), 'focus returns to the trigger');
  assert.ok(source.includes('localeWrap.contains(event.target)'), 'outside click closes');
});

test('compact mobile header gains no permanent language control', () => {
  const source = readSource('index.html');
  const mobileHeader = source.slice(source.indexOf('<header class="sticky top-0'), source.indexOf('id="app-content"'));
  assert.ok(!mobileHeader.includes('locale'), 'no locale button in the mobile topbar');
  assert.ok(!mobileHeader.includes('Japanese Learning Tracker'), 'brand text stays absent');
});

test('account dialog exposes language choice with sign out preserved', () => {
  const source = readSource('src/main.js');
  const dialogBlock = source.slice(source.indexOf('async function openAccountDialog'), source.indexOf('accountButtons.forEach'));
  assert.ok(dialogBlock.includes("text: 'Language'"), 'language section present');
  assert.ok(dialogBlock.includes("'English'") && dialogBlock.includes("'Spanish'"), 'both locales offered');
  assert.ok(dialogBlock.includes("aria-pressed"), 'current locale visibly identifiable');
  assert.ok(dialogBlock.includes("text: 'Sign out'"), 'sign out preserved');
  assert.ok(!dialogBlock.includes('avatar') && !dialogBlock.includes('OAuth') && !dialogBlock.includes('username'), 'no v5.1 profile work');
});

test('locale styles exist without duplicating dictionaries', () => {
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.header-locale-wrap'), 'control positioned');
  assert.ok(css.includes('.header-locale-menu'), 'menu card styled');
  assert.ok(css.includes('.header-locale-option'), 'options styled');
});
