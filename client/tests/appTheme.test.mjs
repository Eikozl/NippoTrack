// Part A core visual foundation — app theme unification, wordmarks, shell
// brand, and title. Static source assertions + pure-function unit tests;
// no DOM, servers, or network required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_THEME_KEY,
  APP_THEME_META,
  LEGACY_THEME_KEY,
  applyAppThemeAttributes,
  isAllowedAppTheme,
  persistAppTheme,
  resolveAppTheme,
  wordmarkForAppTheme,
} from '../src/appTheme.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    _store: store,
  };
}

const matchDark = () => ({ matches: true });
const matchLight = () => ({ matches: false });

// --- pure resolution ----------------------------------------------------------

test('canonical key is nippotrack-theme; legacy jlt-theme preserved, never deleted', () => {
  assert.equal(APP_THEME_KEY, 'nippotrack-theme');
  assert.equal(LEGACY_THEME_KEY, 'jlt-theme');
  assert.ok(isAllowedAppTheme('light'));
  assert.ok(isAllowedAppTheme('dark'));
  for (const invalid of ['', 'LIGHT', 'Dark', 'system', null, undefined, 0, ' light', 'dark ']) {
    assert.equal(isAllowedAppTheme(invalid), false, 'rejects: ' + String(invalid));
  }
});

test('resolution order: canonical → legacy (migrates) → OS → light', () => {
  // Stored canonical wins over everything.
  assert.equal(
    resolveAppTheme({ storage: memoryStorage({ [APP_THEME_KEY]: 'dark', [LEGACY_THEME_KEY]: 'light' }), matchMediaFn: matchLight }),
    'dark'
  );
  assert.equal(
    resolveAppTheme({ storage: memoryStorage({ [APP_THEME_KEY]: 'light' }), matchMediaFn: matchDark }),
    'light'
  );
  // Stored legacy is accepted AND migrated to canonical (legacy left intact).
  const migrated = memoryStorage({ [LEGACY_THEME_KEY]: 'dark' });
  assert.equal(resolveAppTheme({ storage: migrated, matchMediaFn: matchLight }), 'dark');
  assert.equal(migrated._store.get(APP_THEME_KEY), 'dark');
  assert.equal(migrated._store.get(LEGACY_THEME_KEY), 'dark');
  // Invalid canonical falls back to valid legacy.
  const fallback = memoryStorage({ [APP_THEME_KEY]: 'nope', [LEGACY_THEME_KEY]: 'light' });
  assert.equal(resolveAppTheme({ storage: fallback, matchMediaFn: matchDark }), 'light');
  // No stored choice → OS preference → light.
  assert.equal(resolveAppTheme({ storage: memoryStorage(), matchMediaFn: matchDark }), 'dark');
  assert.equal(resolveAppTheme({ storage: memoryStorage(), matchMediaFn: matchLight }), 'light');
});

test('arbitrary strings are rejected at every step', () => {
  assert.equal(resolveAppTheme({ storage: memoryStorage({ [APP_THEME_KEY]: 'SYSTEM' }), matchMediaFn: matchLight }), 'light');
  assert.equal(resolveAppTheme({ storage: memoryStorage({ [LEGACY_THEME_KEY]: 'DARK' }), matchMediaFn: matchLight }), 'light');
  const throwing = { getItem: () => { throw new Error('denied'); } };
  assert.equal(resolveAppTheme({ storage: throwing, matchMediaFn: matchDark }), 'dark');
  assert.equal(resolveAppTheme({ storage: memoryStorage(), matchMediaFn: null }), 'light');
});

test('writes persist BOTH keys and reject invalid themes', () => {
  const storage = memoryStorage();
  assert.equal(persistAppTheme('dark', storage), true);
  assert.equal(storage._store.get(APP_THEME_KEY), 'dark');
  assert.equal(storage._store.get(LEGACY_THEME_KEY), 'dark');
  assert.equal(persistAppTheme('nope', storage), false);
  assert.equal(storage._store.get(APP_THEME_KEY), 'dark');
});

test('wordmarks map light→claro and dark→oscuro; meta uses public canvas pair', () => {
  assert.equal(wordmarkForAppTheme('light', { lightSrc: 'claro', darkSrc: 'oscuro' }), 'claro');
  assert.equal(wordmarkForAppTheme('dark', { lightSrc: 'claro', darkSrc: 'oscuro' }), 'oscuro');
  assert.equal(APP_THEME_META.light, '#F5F0E8');
  assert.equal(APP_THEME_META.dark, '#1C1A18');
});

function fakeDocument() {
  const dataset = {};
  return { documentElement: { dataset } };
}

test('applyAppThemeAttributes keeps data-theme + data-nippotrack-theme in sync', () => {
  // H: dark → light runtime toggle flips BOTH attributes to light.
  const darkToLight = fakeDocument();
  darkToLight.documentElement.dataset.theme = 'dark';
  darkToLight.documentElement.dataset.nippotrackTheme = 'dark';
  assert.equal(applyAppThemeAttributes('light', darkToLight), true);
  assert.equal(darkToLight.documentElement.dataset.theme, 'light');
  assert.equal(darkToLight.documentElement.dataset.nippotrackTheme, 'light');
  // I: light → dark runtime toggle flips BOTH attributes to dark.
  const lightToDark = fakeDocument();
  lightToDark.documentElement.dataset.theme = 'light';
  lightToDark.documentElement.dataset.nippotrackTheme = 'light';
  assert.equal(applyAppThemeAttributes('dark', lightToDark), true);
  assert.equal(lightToDark.documentElement.dataset.theme, 'dark');
  assert.equal(lightToDark.documentElement.dataset.nippotrackTheme, 'dark');
  // Invalid values never touch the DOM.
  const invalid = fakeDocument();
  assert.equal(applyAppThemeAttributes('nope', invalid), false);
  assert.equal(applyAppThemeAttributes('nope'), false);
  assert.deepEqual(invalid.documentElement.dataset, {});
});

test('main.js syncs both attributes on every theme change; settings no longer touches theme', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes('applyAppThemeAttributes(savedTheme)'), 'boot syncs both attributes');
  assert.ok(main.includes('applyAppThemeAttributes(theme)'), 'runtime toggle syncs both attributes');
  assert.ok(main.includes('applyAppThemeAttributes(next)'), 'theme-change listener re-syncs');
  // Appearance removed from Settings: the switch UI is gone and the persisted
  // theme (localStorage) stays as-is. No replacement switcher is invented.
  const settings = readSource('src/pages/settings.js');
  assert.ok(!settings.includes('applyAppThemeAttributes'), 'settings no longer syncs theme attributes');
});

// --- wiring -------------------------------------------------------------------

test('main.js keeps compat surface while writing both keys', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes('resolveAppTheme'), 'boots through canonical resolution');
  assert.ok(main.includes('persistAppTheme'), 'writes both keys');
  assert.ok(main.includes("document.documentElement.dataset.theme"), 'keeps data-theme attribute');
  assert.ok(main.includes('jlt-theme-change'), 'keeps event name');
  assert.ok(main.includes('refreshChartTheme'), 'keeps chart refresh');
  assert.ok(main.includes('Logo_Modo_Claro_App.png'), 'light wordmark bundled (normalized bounds)');
  assert.ok(main.includes('Logo_Modo_Oscuro_App.png'), 'dark wordmark bundled (normalized bounds)');
  assert.ok(main.includes('wordmarkForAppTheme'), 'wordmark selection per theme');
  assert.ok(main.includes('brand-logo-dark'), 'dark hook preserved');
  assert.ok(!main.includes('JLT_logo-png'), 'legacy JLT mark removed from app shell');
});

test('settings.js no longer writes theme keys; persisted theme stays as-is', () => {
  const settings = readSource('src/pages/settings.js');
  assert.ok(!settings.includes('persistAppTheme'), 'settings no longer writes theme keys');
  assert.ok(!settings.includes('isAllowedAppTheme'), 'settings no longer validates themes');
  assert.ok(!settings.includes('jlt-theme-change'), 'settings no longer emits theme events');
  assert.ok(!settings.includes("key: 'appearance'"), 'appearance nav entry removed');
});

test('theme-init.js migrates legacy pre-paint and keeps landing behavior', () => {
  const init = readSource('public/theme-init.js');
  assert.ok(init.includes("localStorage.getItem('jlt-theme')"), 'legacy reader preserved');
  assert.ok(init.includes('dataset.theme'), 'app attribute preserved');
  assert.ok(init.includes('nippotrack-theme'), 'canonical key present');
  assert.ok(init.includes('dataset.nippotrackTheme'), 'landing attribute preserved');
  assert.ok(init.includes('prefers-color-scheme'), 'OS fallback preserved');
  assert.ok(init.includes('#F5F0E8') && init.includes('#1C1A18'), 'meta uses public canvas pair');
});

test('shell brand is wordmark-only with normalized bounds, no duplicated label', () => {
  const html = readSource('index.html');
  assert.ok(html.includes('id="brand-logo"'), 'wordmark hook preserved');
  assert.ok(!html.includes('/src/assets/'), 'no source-tree asset URL in shell (404s in dist; main.js sets the bundled wordmark at boot)');
  assert.ok(html.includes('href="/favicon.png"'), 'favicon served from public root in dist');
  assert.ok(html.includes('alt="NippoTrack"'), 'wordmark alt is NippoTrack');
  assert.ok(!html.includes('data-i18n="NippoTrack"'), 'no duplicated NippoTrack text beside the wordmark');
  assert.ok(!html.includes('Study tracker'), 'no duplicate tagline crowding the sidebar header');
  assert.ok(html.includes('id="close-navigation"'), 'mobile close button preserved');
  assert.ok(!html.includes('JLT_logo-png.png'), 'legacy mark gone from shell');
  assert.ok(html.includes('fonts.googleapis.com'), 'app fonts load statically');
  assert.ok(html.includes('Plus+Jakarta+Sans'), 'display family present');
  assert.ok(html.includes('Noto+Sans+JP'), 'Japanese family present');
});

test('app document title is NippoTrack; public titles untouched', () => {
  const entry = readSource('src/entry.js');
  assert.ok(entry.includes("document.title = 'NippoTrack'"), 'app title is NippoTrack');
  assert.ok(!entry.includes("document.title = 'Japanese Learning Tracker'"), 'legacy app title removed');
  const landing = readSource('src/landing/landing.js');
  assert.ok(landing.includes('NippoTrack — Bring your Japanese learning together'), 'public title untouched');
  const hiw = readSource('src/landing/howItWorks.js');
  assert.ok(hiw.includes('NippoTrack') && hiw.includes('How it works'), 'how-it-works title untouched');
});

test('shared type scale: display titles + Japanese utility, charts keep aliases', () => {
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('font-display text-2xl'), 'pageHeader title uses display type');
  assert.ok(ui.includes('font-display text-lg'), 'dialog title uses display type');
  const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
  assert.ok(css.includes('.font-display'), 'display utility defined');
  assert.ok(css.includes('.font-jp'), 'Japanese utility defined');
  const charts = readSource('src/charts.js');
  assert.ok(charts.includes('--jlt-muted') && charts.includes('--jlt-border') && charts.includes('--jlt-chart-text'), 'chart aliases alive');
});
