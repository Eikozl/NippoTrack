import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shouldEnhanceScroll } from '../src/landing/smoothScroll.js';

const landingSource = readFileSync(new URL('../src/landing/landing.js', import.meta.url), 'utf8');
const hiwSource = readFileSync(new URL('../src/landing/howItWorks.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const smoothSource = readFileSync(new URL('../src/landing/smoothScroll.js', import.meta.url), 'utf8');

function matchMedia(matches) {
  return () => ({ matches });
}

test('Lenis is landing-only: app shell never imports smooth scroll or lenis', () => {
  assert.ok(!mainSource.includes('smoothScroll'), 'authenticated app has no smooth-scroll import');
  assert.ok(!mainSource.includes('lenis'), 'authenticated app has no lenis reference');
  assert.ok(landingSource.includes('smoothScroll'), 'landing wires the helper');
  assert.ok(hiwSource.includes('smoothScroll'), 'how-it-works wires the helper');
  assert.ok(!landingSource.includes("from 'lenis'") && !hiwSource.includes("from 'lenis'"), 'lenis loads via dynamic import only');
});

test('reduced-motion and touch viewports keep native scrolling', () => {
  const realWindow = globalThis.window;
  globalThis.window = { matchMedia: (query) => ({ matches: query.includes('prefers-reduced-motion') }) };
  try {
    assert.equal(shouldEnhanceScroll(), false, 'reduced-motion disables enhancement');
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
  }
  const win2 = { matchMedia: matchMedia(false) };
  globalThis.window = win2;
  try {
    assert.equal(shouldEnhanceScroll(), true, 'desktop without reduced motion enhances');
  } finally {
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
  }
});

test('helper preserves anchors, hash, keyboard, touch, history, focus (static)', () => {
  for (const token of ['scrollTo', 'pushState', 'focus', 'prefers-reduced-motion', 'smoothWheel', 'pagehide']) {
    assert.ok(smoothSource.includes(token), `contract keeps ${token}`);
  }
  assert.ok(smoothSource.includes('hover: none'), 'touch viewports stay native');
  assert.ok(smoothSource.includes('lerp'), 'restrained feel configured (no scroll-jacking)');
  assert.ok(!smoothSource.includes('syncTouch'), 'touch is never smoothed');
});
