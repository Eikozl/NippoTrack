import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BOOT_DRAW_MS,
  BOOT_FADE_MS,
  BOOT_HOLD_MS,
  BOOT_MAX_MS,
  BOOT_MIN_MS,
  BOOT_ORANGE_SRC,
  BOOT_RATE,
  createBootSplash,
  dismissBootSplash,
  isReducedMotion,
  runBootSplash,
} from '../src/bootSplash.js';

const bootSource = readFileSync(new URL('../src/bootSplash.js', import.meta.url), 'utf8');

function fakeNode(tag) {
  return {
    tag,
    attrs: {},
    children: [],
    textContent: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    remove() { this.removed = true; },
    classList: { added: [], add(name) { this.added.push(name); } },
  };
}

function fakeDoc() {
  return { createElement: (tag) => fakeNode(tag) };
}

test('boot pass references the bundled ember draw', () => {
  assert.equal(BOOT_ORANGE_SRC, '/videos/logo-draw-orange.mp4');
  assert.ok(!bootSource.includes('logo-draw-black'), 'single visible pass, no muddy overlap');
  assert.ok(BOOT_DRAW_MS >= 1900, 'resolve waits out the full draw');
  assert.ok(BOOT_MIN_MS >= BOOT_DRAW_MS + BOOT_HOLD_MS, 'floor covers draw plus hold');
  assert.ok(BOOT_MAX_MS > BOOT_MIN_MS, 'fail-open cap above the floor');
  assert.ok(BOOT_RATE > 1, 'pass runs faster than real time');
  assert.ok(BOOT_HOLD_MS > 0 && BOOT_FADE_MS > 0, 'hold and fade staged');
  assert.ok(bootSource.includes('multiply'), 'compositing documented with the module');
});

test('reduced-motion probe is injectable and fail-open', () => {
  assert.equal(isReducedMotion(() => ({ matches: true })), true);
  assert.equal(isReducedMotion(() => ({ matches: false })), false);
  assert.equal(isReducedMotion(null), false);
  assert.equal(isReducedMotion(() => { throw new Error('no matchMedia'); }), false);
});

test('splash keeps the session status for screen readers', () => {
  const doc = fakeDoc();
  const { root, stage, orange, mark } = createBootSplash(doc, { markUrl: '/logo-mark.png', reducedMotion: false });
  assert.equal(root.attrs.role, 'status');
  assert.ok(root.attrs.class.includes('auth-boot-note'), 'styling hook kept');
  const sr = root.children[0];
  assert.ok(String(sr.textContent).includes('Checking your session'), 'status copy preserved');
  assert.equal(stage.attrs['aria-hidden'], 'true', 'decorative stage hidden from AT');
  assert.ok(orange, 'ember pass staged');
  assert.equal(orange.attrs.src, BOOT_ORANGE_SRC);
  assert.equal(orange.attrs.muted, '', 'muted for autoplay policy');
  assert.equal(orange.attrs.playsinline, '', 'inline on iOS');
  assert.ok(mark, 'ink resolve staged');
  assert.equal(mark.attrs.src, '/logo-mark.png');
  assert.ok(!stage.children.some((c) => String(c.attrs.class || '').includes('boot-black')), 'no second pass');
});

test('reduced motion renders the static mark, never video', () => {
  const doc = fakeDoc();
  const { stage, orange } = createBootSplash(doc, { markUrl: '/logo-mark.png', reducedMotion: true });
  assert.equal(orange, null);
  assert.equal(stage.children.length, 1, 'single static mark');
  assert.equal(stage.children[0].tag, 'img');
});

test('run draws ember, resolves to ink, honoring draw plus floor', async () => {
  const events = [];
  const orange = {
    played: 0, paused: 0,
    play() { this.played += 1; events.push('play:orange'); return Promise.resolve(); },
    pause() { this.paused += 1; },
  };
  const stage = fakeNode('div');
  const run = runBootSplash({
    stage, orange, mark: fakeNode('img'), reducedMotion: false,
    delay: (ms) => { events.push(`wait:${ms}`); return Promise.resolve(); },
    now: () => 0,
  });
  await run.done;
  const playAt = events.indexOf('play:orange');
  const drawAt = events.indexOf(`wait:${BOOT_DRAW_MS}`);
  const maxAt = events.indexOf(`wait:${BOOT_MAX_MS}`);
  assert.ok(playAt > -1 && drawAt > playAt, 'draw waits out the full pass');
  assert.ok(maxAt > -1, 'fail-open cap armed');
  assert.equal(orange.playbackRate, BOOT_RATE, 'pass runs fast');
  assert.ok(stage.classList.added.includes('boot-resolved'), 'ink resolves beneath ember');
  assert.equal(orange.played, 1);
});

test('blocked autoplay resolves straight to the static mark', async () => {
  const stage = fakeNode('div');
  let resolved = false;
  const run = runBootSplash({
    stage,
    orange: { play() { throw new Error('blocked'); }, pause() {} },
    mark: fakeNode('img'),
    reducedMotion: false,
    delay: () => Promise.resolve(),
    now: () => 0,
  });
  await run.done;
  resolved = stage.classList.added.includes('boot-resolved');
  assert.equal(resolved, true, 'mark shows without video');
});

test('cancel pauses the pass and skips the resolve', async () => {
  const orange = { paused: 0, play() { return new Promise(() => {}); }, pause() { this.paused += 1; } };
  const stage = fakeNode('div');
  const run = runBootSplash({
    stage, orange, reducedMotion: false,
    delay: () => Promise.resolve(), now: () => 0,
  });
  run.cancel();
  await run.done;
  assert.equal(orange.paused, 1, 'pass stopped');
  assert.ok(!stage.classList.added.includes('boot-resolved'), 'cancelled boot never resolves');
});

test('dismiss fades then detaches, tolerating a replaced host', async () => {
  const root = fakeNode('div');
  await dismissBootSplash(root, { delay: () => Promise.resolve() });
  assert.ok(root.classList.added.includes('is-leaving'), 'fade class applied');
  assert.equal(root.removed, true, 'node detached');
  await dismissBootSplash(null, { delay: () => Promise.resolve() });
  await dismissBootSplash({ classList: null, remove() { throw new Error('gone'); } }, { delay: () => Promise.resolve() });
});
