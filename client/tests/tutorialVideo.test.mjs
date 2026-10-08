// First-login tutorial video overlay — source assertions (no DOM needed).
// Contract: fullscreen takeover on onboarding-incomplete first login only,
// responsive source (vertical handsets / horizontal rest), low-key
// bottom-right hold-to-skip (3s procedural bar), video-end + load-error
// completion, once-only persistence, setup shell underneath untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('tutorial module exposes the hold contract and responsive sources', () => {
  const source = readSource('src/tutorialVideo.js');
  assert.ok(source.includes('TUTORIAL_SKIP_HOLD_MS'), 'hold duration is a named constant');
  assert.ok(source.includes('3000'), 'hold lasts 3 seconds');
  assert.ok(source.includes('(max-width: 767px)'), 'handsets selected by viewport width (tablets keep horizontal)');
  assert.ok(source.includes('/videos/tutorial-vertical.mp4'), 'vertical cut served to handsets');
  assert.ok(source.includes('/videos/tutorial-horizontal.mp4'), 'horizontal cut served to desktop/tablets');
  assert.ok(source.includes('jlt-tutorial-seen'), 'once-only persistence key present');
});

test('takeover is fullscreen with a single low-key bottom-right exit', () => {
  const source = readSource('src/tutorialVideo.js');
  assert.ok(source.includes('fixed inset-0'), 'overlay covers the full screen');
  assert.ok(source.includes('role'), 'overlay exposes dialog semantics');
  assert.ok(source.includes('aria-modal'), 'overlay is modal');
  assert.ok(!source.includes('innerHTML'), 'no markup injection in the overlay');
  assert.ok(source.includes('bottom-5 right-5'), 'skip sits bottom-right of the video');
  assert.ok(source.includes('opacity-60'), 'skip rests at low opacity (never outshines the video)');
  assert.ok(source.includes('requestAnimationFrame'), 'hold bar is a procedural rAF fill, left to right');
  assert.ok(source.includes("fill.style.width"), 'bar width driven per frame');
  assert.ok(source.includes('pointerdown') && source.includes('pointerup'), 'press-and-hold pointer model');
  assert.ok(source.includes('pointercancel'), 'cancelled gestures reset the hold');
  assert.ok(source.includes("event.key === 'Enter'") || source.includes('event.key === "Enter"'), 'keyboard hold parity (Enter)');
  assert.ok(source.includes('keyup'), 'releasing the key resets the hold');
});

test('video plays muted inline; end and load failure both complete (fail-open)', () => {
  const source = readSource('src/tutorialVideo.js');
  assert.ok(source.includes('muted') && source.includes('playsinline'), 'autoplay-safe muted inline playback');
  assert.ok(!/controls\s*=\s*['"]?controls['"]?/.test(source) && !source.includes('setAttribute(\'controls\''), 'no native controls (skip is the exit)');
  assert.ok(source.includes("'ended'") && source.includes("'error'"), 'end + error listeners present');
});

test('boot shows the tutorial only for unseen new accounts, over the setup shell', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('hasSeenTutorialVideo'), 'boot consults the seen flag');
  assert.ok(source.includes('mountTutorialVideo(document.body)'), 'takeover mounts over the rendered setup shell');
  const branchStart = source.indexOf('onboarding?.completed === false');
  const branch = source.substring(branchStart, branchStart + 2500);
  assert.ok(branch.includes('renderFirstExperience'), 'setup shell still renders first (fail-open base)');
  assert.ok(branch.includes('mountTutorialVideo'), 'tutorial follows setup render in the new-account branch');
});
