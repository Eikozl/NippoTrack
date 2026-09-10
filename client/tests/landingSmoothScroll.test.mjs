import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LANDING_LENIS_ANCHOR_DURATION,
  LANDING_LENIS_ANCHOR_OFFSET,
  LANDING_LENIS_LERP,
  initLandingSmoothScroll,
  isLenisDebug,
  shouldEnhanceScroll
} from '../src/landing/smoothScroll.js';

const landingSource = readFileSync(new URL('../src/landing/landing.js', import.meta.url), 'utf8');
const hiwSource = readFileSync(new URL('../src/landing/howItWorks.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const smoothSource = readFileSync(new URL('../src/landing/smoothScroll.js', import.meta.url), 'utf8');

function withWindow(win, fn) {
  const realWindow = globalThis.window;
  const realDocument = globalThis.document;
  globalThis.window = win;
  try {
    return fn();
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
}

test('Lenis is landing-only: app shell never imports smooth scroll or lenis', () => {
  assert.ok(!mainSource.includes('smoothScroll'), 'authenticated app has no smooth-scroll import');
  assert.ok(!mainSource.includes('lenis'), 'authenticated app has no lenis reference');
  assert.ok(landingSource.includes('smoothScroll'), 'landing wires the helper');
  assert.ok(hiwSource.includes('smoothScroll'), 'how-it-works wires the helper');
  assert.ok(!landingSource.includes("from 'lenis'") && !hiwSource.includes("from 'lenis'"), 'lenis loads via dynamic import only');
});

test('tuning sits in the noticeable-but-controlled band', () => {
  assert.ok(LANDING_LENIS_LERP >= 0.08 && LANDING_LENIS_LERP <= 0.095, `lerp ${LANDING_LENIS_LERP} is perceptible without float`);
  assert.ok(LANDING_LENIS_LERP < 0.12, 'first-pass near-native 0.12 is gone');
  assert.equal(LANDING_LENIS_ANCHOR_DURATION, 1.0);
  assert.equal(LANDING_LENIS_ANCHOR_OFFSET, -8);
  assert.ok(!smoothSource.includes('syncTouch'), 'touch is never smoothed');
});

test('gate matrix: reduced-motion and touch-first stay native, desktop enhances', () => {
  const matrix = [
    [{ reduced: false, touch: false }, true],
    [{ reduced: true, touch: false }, false],
    [{ reduced: false, touch: true }, false],
    [{ reduced: true, touch: true }, false]
  ];
  for (const [{ reduced, touch }, expected] of matrix) {
    const result = withWindow({
      matchMedia: (query) => ({
        matches: query.includes('prefers-reduced-motion') ? reduced : touch
      })
    }, () => shouldEnhanceScroll());
    assert.equal(result, expected, `reduced=${reduced} touch=${touch}`);
  }
});

test('helper preserves anchors, hash, keyboard, touch, history, focus (static)', () => {
  for (const token of ['scrollTo', 'pushState', 'focus', 'prefers-reduced-motion', 'smoothWheel', 'pagehide']) {
    assert.ok(smoothSource.includes(token), `contract keeps ${token}`);
  }
  assert.ok(smoothSource.includes('hover: none'), 'touch viewports stay native');
  assert.ok(!smoothSource.includes('syncTouch'), 'touch is never smoothed');
});

test('init is observable and injectable: failure marks error, loader is stubbed', async () => {
  const realWindow = globalThis.window;
  const realDocument = globalThis.document;
  const listeners = {};
  const dataset = {};
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    location: { search: '' },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener: (name, fn) => { listeners[name] = fn; },
    removeEventListener: () => {}
  };
  globalThis.document = {
    documentElement: { dataset },
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null
  };
  try {
    const failing = await initLandingSmoothScroll(null, { loadLenis: async () => { throw new Error('blocked'); } });
    assert.equal(typeof failing, 'function', 'failure still resolves fail-open');
    assert.equal(dataset.jltLenis, 'error', 'import failure is observable as error');

    let constructed = null;
    const fakeLenis = function FakeLenis(options) {
      constructed = options;
      this.raf = () => {};
      this.destroy = () => {};
      this.scrollTo = () => {};
    };
    const cleanup = await initLandingSmoothScroll(null, { loadLenis: async () => ({ default: fakeLenis }) });
    assert.equal(typeof cleanup, 'function', 'success resolves a cleanup');
    assert.deepEqual(constructed, { lerp: LANDING_LENIS_LERP, smoothWheel: true }, 'tuning reaches the constructor');
    assert.equal(dataset.jltLenis, 'on', 'success is observable as on');
    cleanup();
    assert.equal(dataset.jltLenis, undefined, 'destroy clears the marker');
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});

test('debug channel is silent by default and explicit when asked', () => {
  withWindow({ matchMedia: () => ({ matches: false }), location: { search: '' } }, () => {
    assert.equal(isLenisDebug(), false, 'no console spam in production');
  });
  withWindow({ matchMedia: () => ({ matches: false }), location: { search: '?jlt-lenis-debug=1' } }, () => {
    assert.equal(isLenisDebug(), true, 'owner can diagnose with the query flag');
  });
});
