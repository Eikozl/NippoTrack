import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BOOT_BLACK_SRC,
  BOOT_FADE_MS,
  BOOT_MAX_MS,
  BOOT_MIN_MS,
  BOOT_ORANGE_DELAY_MS,
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
  return { createElement: (tag) => fakeNode(tag), made: [] };
}

test('boot passes reference the bundled stroke-draw videos', () => {
  assert.equal(BOOT_BLACK_SRC, '/videos/logo-draw-black.mp4');
  assert.equal(BOOT_ORANGE_SRC, '/videos/logo-draw-orange.mp4');
  assert.ok(BOOT_MIN_MS >= 2000, 'brand beat floor lets the draw read');
  assert.ok(BOOT_MAX_MS > BOOT_MIN_MS, 'fail-open cap above the floor');
  assert.ok(BOOT_RATE > 1, 'passes run faster than real time');
  assert.ok(BOOT_ORANGE_DELAY_MS > 0 && BOOT_ORANGE_DELAY_MS < BOOT_MIN_MS, 'orange follows black inside the beat');
  assert.ok(BOOT_FADE_MS > 0, 'dismiss fades instead of cutting');
  assert.ok(bootSource.includes('mix-blend-mode'), 'compositing documented with the module');
});

test('reduced-motion probe is injectable and fail-open', () => {
  assert.equal(isReducedMotion(() => ({ matches: true })), true);
  assert.equal(isReducedMotion(() => ({ matches: false })), false);
  assert.equal(isReducedMotion(null), false);
  assert.equal(isReducedMotion(() => { throw new Error('no matchMedia'); }), false);
});

test('splash keeps the session status for screen readers', () => {
  const doc = fakeDoc();
  const { root, stage, black, orange } = createBootSplash(doc, { markUrl: '/logo-mark.png', reducedMotion: false });
  assert.equal(root.attrs.role, 'status');
  assert.ok(root.attrs.class.includes('auth-boot-note'), 'styling hook kept');
  const sr = root.children[0];
  assert.ok(String(sr.textContent).includes('Checking your session'), 'status copy preserved');
  assert.equal(stage.attrs['aria-hidden'], 'true', 'decorative stage hidden from AT');
  assert.ok(black && orange, 'both passes staged');
  assert.equal(black.attrs.src, BOOT_BLACK_SRC);
  assert.equal(orange.attrs.src, BOOT_ORANGE_SRC);
  assert.equal(black.attrs.muted, '', 'muted for autoplay policy');
  assert.equal(black.attrs.playsinline, '', 'inline on iOS');
});

test('reduced motion renders the static mark, never videos', () => {
  const doc = fakeDoc();
  const { root, stage, black, orange } = createBootSplash(doc, { markUrl: '/logo-mark.png', reducedMotion: true });
  assert.equal(black, null);
  assert.equal(orange, null);
  assert.equal(stage.children.length, 1, 'single static mark');
  assert.equal(stage.children[0].tag, 'img');
  assert.equal(stage.children[0].attrs.src, '/logo-mark.png');
});

test('run plays black, then orange with handover, honoring the floor', async () => {
  const events = [];
  let clock = 0;
  const video = (name) => ({
    played: 0, paused: 0,
    play() { this.played += 1; events.push(`play:${name}`); return Promise.resolve(); },
    pause() { this.paused += 1; },
  });
  const black = video('black');
  const orange = video('orange');
  const stage = fakeNode('div');
  const run = runBootSplash({
    stage, black, orange, reducedMotion: false,
    delay: (ms) => { events.push(`wait:${ms}`); return Promise.resolve(); },
    now: () => clock,
  });
  await run.done;
  assert.ok(events.indexOf('play:black') < events.indexOf('play:orange'), 'black draws first');
  assert.ok(events.includes(`wait:${BOOT_ORANGE_DELAY_MS}`), 'orange delayed');
  assert.ok(events.includes(`wait:${BOOT_MAX_MS}`), 'fail-open cap armed');
  assert.equal(black.playbackRate, BOOT_RATE, 'black runs fast');
  assert.equal(orange.playbackRate, BOOT_RATE, 'orange runs fast');
  assert.ok(stage.classList.added.includes('boot-handover'), 'black hands over beneath orange');
  assert.equal(black.played, 1);
  assert.equal(orange.played, 1);
});

test('run honors the brand floor even with instant timers', async () => {
  const events = [];
  const run = runBootSplash({
    reducedMotion: true,
    delay: (ms) => { events.push(`wait:${ms}`); return Promise.resolve(); },
    now: () => 0,
  });
  await run.done;
  assert.deepEqual(events, [`wait:${BOOT_MIN_MS}`, `wait:${BOOT_MAX_MS}`]);
});

test('cancel pauses both passes and skips the orange start', async () => {
  let orangeStarted = false;
  const black = { play() { return Promise.resolve(); }, pause() {} };
  const orange = { play() { orangeStarted = true; return Promise.resolve(); }, pause() {} };
  const run = runBootSplash({
    black, orange, reducedMotion: false,
    delay: () => Promise.resolve(), now: () => 0,
  });
  run.cancel();
  await run.done;
  assert.equal(orangeStarted, false, 'cancelled boot never starts orange');
});

test('dismiss fades then detaches, tolerating a replaced host', async () => {
  const root = fakeNode('div');
  await dismissBootSplash(root, { delay: () => Promise.resolve() });
  assert.ok(root.classList.added.includes('is-leaving'), 'fade class applied');
  assert.equal(root.removed, true, 'node detached');
  await dismissBootSplash(null, { delay: () => Promise.resolve() });
  await dismissBootSplash({ classList: null, remove() { throw new Error('gone'); } }, { delay: () => Promise.resolve() });
});
