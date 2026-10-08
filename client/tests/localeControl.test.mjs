// v5.1-C moves the sole authenticated-shell language control into the
// existing account menu while keeping the current setLocale mechanism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('language exists only in the account menu on the authenticated shell', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('user-menu-language'), 'account menu owns language');
  assert.ok(source.includes("setLocale(value)"), 'existing locale mechanism reused');
  assert.ok(source.includes("getLocale()"), 'selected locale read from existing mechanism');
  assert.ok(source.includes("role: 'menuitemradio'"), 'language choices expose radio-item semantics');
  assert.ok(source.includes("aria-checked"), 'current locale is perceivable without color');
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!executable.includes('themeToggle?.before(localeWrap)'), 'old desktop language mount removed');
  assert.ok(!executable.includes('openAccountDialog'), 'old account dialog removed');
});

test('language menu closes/reflects selection through the existing event flow', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('syncUserMenus()'), 'locale changes refresh the menu');
  assert.ok(source.includes("window.addEventListener('jlt-locale-change'"), 'existing locale event preserved');
  assert.ok(source.includes("event.key === 'Escape'"), 'Escape behavior remains available');
  assert.ok(source.includes('document.addEventListener(\'click\''), 'outside click closes account menu');
});

test('compact mobile header has no duplicate permanent language control', () => {
  const source = readSource('index.html');
  const mobileHeader = source.slice(source.indexOf('<header class="sticky top-0'), source.indexOf('id="app-content"'));
  assert.doesNotMatch(mobileHeader, /locale|language/i);
});

test('account menu keeps only the frozen quick actions', () => {
  const source = readSource('src/main.js');
  const menuBlock = source.slice(source.indexOf('function createUserMenu'), source.indexOf('function syncUserMenus'));
  for (const marker of ['Language', 'Settings', 'Sign out']) assert.ok(menuBlock.includes(marker), `${marker} action present`);
  for (const forbidden of ['Theme', 'JLPT target', 'Starting Point', 'Export backup', 'OAuth']) {
    assert.doesNotMatch(menuBlock, new RegExp(forbidden, 'i'), `${forbidden} stays out of menu`);
  }
  // Approved exception: the identity mark may overlay the user's photo when
  // set (photo display only — no menu action or destination is added).
  assert.ok(menuBlock.includes('avatarOverlayImg'), 'avatar photo overlay helper present');
  assert.ok(!/role:\s*['"]menuitem[^}]*avatar/i.test(menuBlock), 'no avatar menu action');
});

test('menu focus-out never closes synchronously mid-tap (touch)', () => {
  const source = readSource('src/main.js');
  const menuBlock = source.slice(source.indexOf('function createUserMenu'), source.indexOf('function syncUserMenus'));
  assert.ok(menuBlock.includes('requestAnimationFrame'), 'focus-out close deferred past tap completion');
  assert.ok(menuBlock.includes('document.activeElement'), 'close decision re-checked against real focus');
  assert.ok(!menuBlock.includes('.contains(event.relatedTarget)'), 'no sync relatedTarget close (null on touch, swallows taps)');
  assert.ok(menuBlock.includes('focus({ preventScroll: true })'), 'panel focus never scroll-jumps');
});

test('language panel honors the hidden attribute (unlayered display beats preflight)', () => {
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.user-menu-language-panel[hidden]'), 'explicit hidden guard on the language panel');
});

test('account trigger remains the existing accessible icon control', () => {
  const source = readSource('index.html');
  for (const id of ['account-button', 'mobile-account-button']) {
    assert.match(source, new RegExp(`id="${id}"[^>]*aria-haspopup="menu"`));
    assert.match(source, new RegExp(`id="${id}"[^>]*aria-expanded="false"`));
  }
});
