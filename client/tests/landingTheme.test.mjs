import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LANDING_THEME_KEY,
  LANDING_THEME_META,
  hasExplicitLandingTheme,
  isAllowedLandingTheme,
  landingToggleLabel,
  persistLandingTheme,
  pickLandingTheme,
  readStoredLandingTheme,
  resolveLandingTheme,
  watchLandingSystemTheme,
  wordmarkForTheme,
} from '../src/landing/theme.js';

const sectionsSource = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../src/landing/theme.js', import.meta.url), 'utf8');
const landingSource = readFileSync(new URL('../src/landing/landing.js', import.meta.url), 'utf8');
const themeInitSource = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/landing/landing.css', import.meta.url), 'utf8');

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

const matchDark = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
const matchLight = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

test('landing theme key and allowlist accept only light|dark', () => {
  assert.equal(LANDING_THEME_KEY, 'nippotrack-theme');
  assert.ok(isAllowedLandingTheme('light'));
  assert.ok(isAllowedLandingTheme('dark'));
  for (const invalid of ['', 'LIGHT', 'Dark', 'system', null, undefined, 0, ' light']) {
    assert.equal(isAllowedLandingTheme(invalid), false, 'should reject: ' + String(invalid));
  }
});

test('stored theme wins over OS preference, invalid stored values are ignored', () => {
  assert.equal(pickLandingTheme('light', true), 'light');
  assert.equal(pickLandingTheme('dark', false), 'dark');
  assert.equal(pickLandingTheme('SYSTEM', true), 'dark');
  assert.equal(pickLandingTheme('', false), 'light');
  assert.equal(pickLandingTheme(null, true), 'dark');
  assert.equal(pickLandingTheme(null, false), 'light');
});

test('resolveLandingTheme follows stored → OS → light priority', () => {
  assert.equal(
    resolveLandingTheme({ storage: memoryStorage({ [LANDING_THEME_KEY]: 'dark' }), matchMediaFn: matchLight }),
    'dark'
  );
  assert.equal(
    resolveLandingTheme({ storage: memoryStorage({ [LANDING_THEME_KEY]: 'light' }), matchMediaFn: matchDark }),
    'light'
  );
  assert.equal(
    resolveLandingTheme({ storage: memoryStorage({ [LANDING_THEME_KEY]: 'nope' }), matchMediaFn: matchDark }),
    'dark'
  );
  assert.equal(
    resolveLandingTheme({ storage: memoryStorage(), matchMediaFn: matchDark }),
    'dark'
  );
  assert.equal(
    resolveLandingTheme({ storage: memoryStorage(), matchMediaFn: matchLight }),
    'light'
  );
});

test('resolveLandingTheme tolerates broken storage and matchMedia', () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(resolveLandingTheme({ storage: throwingStorage, matchMediaFn: matchDark }), 'dark');
  assert.equal(resolveLandingTheme({ storage: throwingStorage, matchMediaFn: matchLight }), 'light');
  assert.equal(
    resolveLandingTheme({
      storage: memoryStorage(),
      matchMediaFn: () => {
        throw new Error('no matchMedia');
      },
    }),
    'light'
  );
  assert.equal(resolveLandingTheme({ storage: memoryStorage(), matchMediaFn: null }), 'light');
  assert.equal(resolveLandingTheme({ storage: memoryStorage() }), 'light');
});

test('landing theme persistence round-trips and rejects invalid values', () => {
  const storage = memoryStorage();
  assert.equal(persistLandingTheme('dark', storage), true);
  assert.equal(readStoredLandingTheme(storage), 'dark');
  assert.equal(hasExplicitLandingTheme(storage), true);
  assert.equal(persistLandingTheme('nope', storage), false);
  assert.equal(readStoredLandingTheme(storage), 'dark');
  const empty = memoryStorage();
  assert.equal(readStoredLandingTheme(empty), null);
  assert.equal(hasExplicitLandingTheme(empty), false);
  assert.equal(readStoredLandingTheme({ getItem: () => 'dark\0' }), null);
  const throwing = { setItem: () => { throw new Error('denied'); } };
  assert.equal(persistLandingTheme('dark', throwing), false);
});

test('toggle labels describe the destination theme', () => {
  assert.equal(landingToggleLabel('light'), 'Switch to dark mode');
  assert.equal(landingToggleLabel('dark'), 'Switch to light mode');
  assert.equal(themeSource.includes("'Switch to dark mode'"), true);
  assert.equal(themeSource.includes("'Switch to light mode'"), true);
});

test('wordmarks map light→black ink and dark→ivory ink', () => {
  assert.equal(wordmarkForTheme('light', { lightSrc: 'claro', darkSrc: 'oscuro' }), 'claro');
  assert.equal(wordmarkForTheme('dark', { lightSrc: 'claro', darkSrc: 'oscuro' }), 'oscuro');
  assert.equal(LANDING_THEME_META.light, '#F5F0E8');
  assert.equal(LANDING_THEME_META.dark, '#1C1A18');
  // Source wiring: dataset + colorScheme + meta + wordmark swap + toggle label.
  assert.ok(themeSource.includes('dataset.nippotrackTheme'));
  assert.ok(themeSource.includes('style.colorScheme'));
  assert.ok(themeSource.includes('meta[name="theme-color"]'));
  assert.ok(themeSource.includes('img[data-landing-wordmark]'));
  assert.ok(themeSource.includes('[data-landing-theme-toggle]'));
  assert.ok(themeSource.includes('aria-label'));
  // Alternate lazy-loads only on first toggle (guarded preload set).
  assert.ok(themeSource.includes('preloadedLandingWordmarks'));
  assert.ok(themeSource.includes('new Image()'));
});

test('system-change listener is single, guarded, and leak-free', () => {
  assert.ok(themeSource.includes('watchLandingSystemTheme'));
  assert.ok(themeSource.includes("'(prefers-color-scheme: dark)'"));
  assert.ok(themeSource.includes('addEventListener'));
  assert.ok(themeSource.includes('removeEventListener'));
  let calls = 0;
  const cleanup = watchLandingSystemTheme(() => { calls += 1; }, { matchMediaFn: null });
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.equal(calls, 0);
  const fake = () => null;
  assert.equal(typeof watchLandingSystemTheme(() => {}, { matchMediaFn: fake }), 'function');
});

test('theme-init.js extends additively without changing app behavior', () => {
  assert.ok(themeInitSource.includes("localStorage.getItem('jlt-theme')"));
  assert.ok(themeInitSource.includes('dataset.theme'));
  assert.ok(themeInitSource.includes('nippotrack-theme'));
  assert.ok(themeInitSource.includes('dataset.nippotrackTheme'));
  assert.ok(themeInitSource.includes('prefers-color-scheme'));
  assert.ok(themeInitSource.includes('colorScheme'));
});

test('landing.js boots the theme module before markup paint', () => {
  assert.ok(!landingSource.includes("colorScheme = 'light'"));
  assert.ok(landingSource.includes('resolveLandingTheme'));
  assert.ok(landingSource.includes('applyLandingTheme'));
  assert.ok(landingSource.includes('watchLandingSystemTheme'));
  assert.ok(landingSource.includes('persistLandingTheme'));
  assert.ok(landingSource.includes('Logo_Modo_Claro.png'));
  assert.ok(landingSource.includes('Logo_Modo_Oscuro.png'));
  assert.ok(landingSource.includes('readStoredLandingTheme'));
});

test('toggle is a native 44px button outside the hidden mobile containers', () => {
  assert.ok(sectionsSource.includes('<button class="landing-theme-toggle"'));
  assert.ok(sectionsSource.includes('data-landing-theme-toggle'));
  assert.ok(sectionsSource.includes('data-theme-icon="sun"'));
  assert.ok(sectionsSource.includes('data-theme-icon="moon"'));
  assert.ok(sectionsSource.includes('<svg'));
  assert.ok(cssSource.includes('.landing-theme-toggle'));
  assert.ok(cssSource.includes('width: 44px'));
  assert.ok(cssSource.includes('height: 44px'));
  assert.ok(cssSource.includes('.landing-nav-tools'));
  // Render order lives in navbar(): actions → persistent tools (toggle + menu).
  // The toggle markup itself lives in themeToggle() and is composed via
  // ${themeToggle()} inside the persistent tools container.
  const navbarBlock = sectionsSource.slice(
    sectionsSource.indexOf('function navbar'),
    sectionsSource.indexOf('export const HERO_HEADLINE_MAIN')
  );
  const actionsAt = navbarBlock.indexOf('landing-nav-actions');
  const toolsAt = navbarBlock.indexOf('landing-nav-tools');
  const toggleCallAt = navbarBlock.indexOf('themeToggle()');
  const menuAt = navbarBlock.indexOf('data-menu-button');
  assert.ok(actionsAt > -1 && toolsAt > -1 && toggleCallAt > -1 && menuAt > -1);
  assert.ok(actionsAt < toolsAt, 'tools container follows the collapsible actions');
  assert.ok(toggleCallAt > toolsAt, 'toggle composes inside the persistent tools container');
  assert.ok(menuAt > toolsAt, 'menu button shares the persistent container');
});

test('toggle shows exactly one icon with action labels and a hidden guard', () => {
  // Markup starts with one hidden icon (light offers the moon destination).
  assert.ok(sectionsSource.includes('data-theme-icon="sun"'));
  assert.ok(sectionsSource.includes('data-theme-icon="moon"'));
  const sunStart = sectionsSource.indexOf('<svg data-theme-icon="sun"');
  const sunEnd = sectionsSource.indexOf('>', sunStart);
  const sunTag = sectionsSource.slice(sunStart, sunEnd);
  assert.ok(sunTag.includes(' hidden'), 'sun starts hidden in light markup');
  const moonStart = sectionsSource.indexOf('<svg data-theme-icon="moon"');
  const moonEnd = sectionsSource.indexOf('>', moonStart);
  const moonTag = sectionsSource.slice(moonStart, moonEnd);
  assert.ok(!moonTag.includes(' hidden'), 'moon starts visible in light markup');
  // Both icons stay decorative; the button carries the action label.
  assert.ok(sectionsSource.includes('data-theme-icon="sun"') && sectionsSource.includes('aria-hidden="true"'));
  assert.ok(sectionsSource.includes('aria-label="Switch to dark mode"'));
  assert.ok(themeSource.includes("'Switch to dark mode'"));
  assert.ok(themeSource.includes("'Switch to light mode'"));
  // Scoped guard keeps `hidden` effective against author `display` resets.
  assert.ok(cssSource.includes('.landing-theme-toggle svg[hidden]'));
  assert.ok(cssSource.includes('display: none !important'));
  // Theme module toggles exactly one hidden attribute per theme.
  assert.ok(themeSource.includes("querySelector('[data-theme-icon=\"sun\"]')") || themeSource.includes('[data-theme-icon="sun"]'));
  assert.ok(themeSource.includes("removeAttribute('hidden')"));
  assert.ok(themeSource.includes("setAttribute('hidden'"));
  // Focus and size are unchanged.
  assert.ok(cssSource.includes(':focus-visible'));
});

test('toggle persistence regression: stored theme wins and labels follow', () => {
  assert.ok(landingSource.includes('persistLandingTheme'));
  assert.ok(landingSource.includes('applyLandingTheme'));
  assert.ok(landingSource.includes('readStoredLandingTheme'));
  assert.ok(themeSource.includes('nippotrack-theme'));
  assert.ok(themeSource.includes('landingToggleLabel'));
});

test('navbar and footer wordmarks expose both theme variants for swapping', () => {
  assert.ok(sectionsSource.includes('data-landing-wordmark'));
  assert.ok(sectionsSource.includes('data-light-src'));
  assert.ok(sectionsSource.includes('data-dark-src'));
});
