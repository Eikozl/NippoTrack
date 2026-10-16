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
  playBootPass,
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

test('boot pass references the bundled ember draw with sound', () => {
  assert.equal(BOOT_ORANGE_SRC, '/videos/logo-draw-orange.mp4');
  assert.ok(!bootSource.includes('logo-draw-black'), 'single visible pass');
  assert.ok(bootSource.includes('muted = true'), 'autoplay-block fallback mutes and continues');
  assert.ok(BOOT_DRAW_MS >= 1900, 'hold waits out the full draw');
  assert.ok(BOOT_MIN_MS >= BOOT_DRAW_MS + BOOT_HOLD_MS, 'floor covers draw plus hold');
  assert.ok(BOOT_MAX_MS > BOOT_MIN_MS, 'fail-open cap above the floor');
  assert.ok(BOOT_RATE > 1, 'pass runs faster than real time');
  assert.ok(BOOT_HOLD_MS > 0 && BOOT_FADE_MS > 0, 'hold and fade staged');
});

test('reduced-motion probe is injectable and fail-open', () => {
  assert.equal(isReducedMotion(() => ({ matches: true })), true);
  assert.equal(isReducedMotion(() => ({ matches: false })), false);
  assert.equal(isReducedMotion(null), false);
  assert.equal(isReducedMotion(() => { throw new Error('no matchMedia'); }), false);
});

test('splash keeps the session status for screen readers', () => {
  const doc = fakeDoc();
  const { root, stage, orange } = createBootSplash(doc, { markUrl: '/logo-mark.png', reducedMotion: false });
  assert.equal(root.attrs.role, 'status');
  assert.ok(root.attrs.class.includes('auth-boot-note'), 'styling hook kept');
  const sr = root.children[0];
  assert.ok(String(sr.textContent).includes('Checking your session'), 'status copy preserved');
  assert.equal(stage.attrs['aria-hidden'], 'true', 'decorative stage hidden from AT');
  assert.ok(orange, 'ember pass staged');
  assert.equal(orange.attrs.src, BOOT_ORANGE_SRC);
  assert.ok(!('muted' in orange.attrs), 'sound attempted first, not pre-muted');
  assert.equal(orange.attrs.playsinline, '', 'inline on iOS');
});

test('reduced motion renders the static mark, never video', () => {
  const doc = fakeDoc();
  const { stage, orange } = createBootSplash(doc, { markUrl: '/logo-mark.png', reducedMotion: true });
  assert.equal(orange, null);
  assert.equal(stage.children.length, 1, 'single static mark');
  assert.equal(stage.children[0].tag, 'img');
});

test('loud attempt first, muted fallback on autoplay block', async () => {
  const loud = { play() { return Promise.resolve(); } };
  assert.equal(await playBootPass(loud, BOOT_RATE), 'loud');
  assert.equal(loud.playbackRate, BOOT_RATE, 'pass runs fast');
  let muted = false;
  const blocked = {
    play() {
      if (!muted) return Promise.reject(new Error('autoplay denied'));
      return Promise.resolve();
    },
  };
  Object.defineProperty(blocked, 'muted', { set(v) { muted = v; }, get() { return muted; } });
  assert.equal(await playBootPass(blocked, BOOT_RATE), 'muted');
  assert.equal(muted, true, 'fallback mutes and retries');
  assert.equal(await playBootPass(null, BOOT_RATE), 'blocked');
  assert.equal(await playBootPass({}, BOOT_RATE), 'blocked');
});

test('run draws ember with sound, holds, honoring the floor', async () => {
  const events = [];
  const orange = {
    played: 0, paused: 0,
    play() { this.played += 1; events.push('play:orange'); return Promise.resolve(); },
    pause() { this.paused += 1; },
  };
  const run = runBootSplash({
    orange, reducedMotion: false,
    delay: (ms) => { events.push(`wait:${ms}`); return Promise.resolve(); },
    now: () => 0,
  });
  await run.done;
  // Drain: the race settles first, the done chain lands right after.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, [
    'play:orange',
    `wait:${BOOT_MAX_MS}`,
    `wait:${BOOT_DRAW_MS}`,
    `wait:${BOOT_HOLD_MS}`,
    `wait:${BOOT_MIN_MS}`,
  ]);
  assert.equal(orange.played, 1);
});

test('cancel pauses the pass and skips the waits', async () => {
  const orange = { paused: 0, play() { return new Promise(() => {}); }, pause() { this.paused += 1; } };
  const run = runBootSplash({
    orange, reducedMotion: false,
    delay: () => Promise.resolve(), now: () => 0,
  });
  run.cancel();
  await run.done;
  assert.equal(orange.paused, 1, 'pass stopped');
});

test('dismiss fades then detaches, tolerating a replaced host', async () => {
  const root = fakeNode('div');
  await dismissBootSplash(root, { delay: () => Promise.resolve() });
  assert.ok(root.classList.added.includes('is-leaving'), 'fade class applied');
  assert.equal(root.removed, true, 'node detached');
  await dismissBootSplash(null, { delay: () => Promise.resolve() });
  await dismissBootSplash({ classList: null, remove() { throw new Error('gone'); } }, { delay: () => Promise.resolve() });
});
