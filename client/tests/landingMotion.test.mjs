import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ESTIMATE_LEVELS,
  ESTIMATE_ROTATE_MS,
  HERO_ERASE_MS_PER_CHAR,
  HERO_HEADLINES,
  HERO_HOLDS_IN_ORDER,
  HERO_HOLD_ALT_ONE,
  HERO_HOLD_MAIN,
  HERO_HOLD_MAIN_FIRST,
  HERO_STREAK_MS,
  HERO_TYPE_MS_PER_CHAR,
  ONBOARDING_STAGED_TOTAL_MS,
  counterValue,
  heroHoldForLine,
  initEstimateRotation,
  initHeroStreak,
  initHeroTyping,
  shuffledEstimateLevels,
} from '../src/landing/interactions.js';

const sectionsSource = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');
const interactionsSource = readFileSync(new URL('../src/landing/interactions.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/landing/landing.css', import.meta.url), 'utf8');

test('progress counters interpolate deterministically and finish exactly', () => {
  assert.equal(counterValue(312, 0, 1600), 0);
  assert.equal(counterValue(312, 800, 1600), 156);
  assert.equal(counterValue(312, 1600, 1600), 312);
  assert.equal(counterValue(312, 2400, 1600), 312);
});

test('hero typing uses the approved timing constants', () => {
  assert.equal(HERO_TYPE_MS_PER_CHAR, 28);
  assert.equal(HERO_ERASE_MS_PER_CHAR, 9);
  assert.equal(HERO_HOLD_MAIN_FIRST, 2200);
  assert.equal(HERO_HOLD_ALT_ONE, 1650);
  assert.equal(HERO_HOLD_MAIN, 5000);
  assert.deepEqual(HERO_HOLDS_IN_ORDER, [2200, 1650, 5000]);
});

test('hero headlines keep the approved two-line cycle with main-dominated holds', () => {
  assert.deepEqual(HERO_HEADLINES, [
    'Bring your Japanese learning together.',
    'Track anywhere.',
  ]);
  assert.ok(HERO_HOLD_MAIN > HERO_HOLD_ALT_ONE);
  assert.ok(HERO_HOLD_MAIN > HERO_HOLD_MAIN_FIRST);
  assert.ok(HERO_HOLD_MAIN_FIRST > HERO_HOLD_ALT_ONE);
  assert.equal(heroHoldForLine(0, true), 2200);
  assert.equal(heroHoldForLine(0, false), 5000);
  assert.equal(heroHoldForLine(1), 1650);
  const first = sectionsSource.indexOf('Bring your Japanese learning together.');
  const second = sectionsSource.indexOf('Track anywhere.');
  assert.ok(first > -1 && second > first);
  assert.equal((sectionsSource.match(/data-hero-line/g) || []).length, 2);
  assert.ok(!sectionsSource.includes('Learn everywhere. Keep it connected.'));
  assert.ok(!sectionsSource.includes('Understand what you encounter. Track what matters.'));
});

test('canonical H1 stays single with an aria-hidden visual layer and no live region', () => {
  const h1Count = (sectionsSource.match(/<h1 id="hero-title">/g) || []).length;
  assert.equal(h1Count, 1);
  assert.ok(sectionsSource.includes('aria-labelledby="hero-title"'));
  assert.ok(sectionsSource.includes('data-hero-title-stack'));
  assert.ok(sectionsSource.includes('data-hero-typing'));
  assert.ok(sectionsSource.includes('aria-hidden="true" data-hero-typing'));
  assert.ok(sectionsSource.includes('data-hero-line'));
  const heroBlock = sectionsSource.slice(sectionsSource.indexOf('landing-hero'), sectionsSource.indexOf('landing-lede'));
  assert.ok(!heroBlock.includes('aria-live'));
  assert.ok(!sectionsSource.includes('aria-live'));
});

test('hero typing reserves the full main headline box on mobile and cleans up timers', () => {
  assert.ok(cssSource.includes('.hero-title-stack'));
  assert.ok(cssSource.includes('grid-area: 1 / 1'));
  assert.ok(cssSource.includes('position: absolute'));
  assert.ok(cssSource.includes('inset: 0'));
  assert.ok(cssSource.includes('.hero-typing-line'));
  assert.ok(cssSource.includes('visibility: hidden'));
  assert.ok(cssSource.includes('.landing-js .hero-title-stack.is-typing > h1'));
  assert.ok(cssSource.includes('.landing-js .hero-title-stack.is-typing > .hero-typing'));
  assert.ok(interactionsSource.includes('pagehide'));
  assert.ok(interactionsSource.includes('clearTimeout'));
  assert.ok(typeof initHeroTyping === 'function');
  assert.ok(interactionsSource.includes("matchMedia('(prefers-reduced-motion: reduce)')"));
});

test('reduced motion keeps a static canonical H1', () => {
  assert.ok(cssSource.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(cssSource.includes('.hero-title-stack > h1'));
  assert.ok(cssSource.includes('visibility: visible !important'));
  assert.ok(interactionsSource.includes('if (reducedMotion) return noop'));
});

test('how-it-works reuses the one-shot observer with restrained connectors', () => {
  assert.ok(sectionsSource.includes('id="how-it-works"'));
  assert.ok(sectionsSource.includes('data-demo="flow"'));
  assert.ok(sectionsSource.includes('--step-delay:100ms'));
  assert.ok(sectionsSource.includes('--step-delay:700ms'));
  assert.ok(sectionsSource.includes('--step-delay:1350ms'));
  assert.ok(sectionsSource.includes('flow-connector'));
  assert.ok(cssSource.includes('.flow-connector'));
  assert.ok(cssSource.includes('scaleX(0)'));
  assert.ok(cssSource.includes('scaleX(1)'));
  assert.ok(cssSource.includes('scaleY(0)'));
  assert.ok(cssSource.includes('scaleY(1)'));
  assert.ok(interactionsSource.includes("querySelectorAll('[data-demo]"));
  assert.ok(!interactionsSource.includes("remove('is-playing')"));
  // Existing 300ms enter wait is kept.
  assert.ok(interactionsSource.includes('setTimeout'));
  assert.ok(interactionsSource.includes('300'));
  // One-shot final state persists (no removal, forwards fill).
  assert.ok(cssSource.includes('forwards'));
});

test('how-it-works 料理 flow stages content with internal stagger', () => {
  // Coherent single-word loop with the approved reading and gloss.
  assert.ok(sectionsSource.includes('lang="ja">料理'));
  assert.ok(sectionsSource.includes('lang="ja">りょうり'));
  assert.ok(sectionsSource.includes('cooking · cuisine'));
  // Capture keeps the tracked word plus the four capture chips.
  assert.ok(sectionsSource.includes('flow-tracked'));
  assert.ok(sectionsSource.includes('--step-delay:500ms'));
  assert.ok(sectionsSource.includes('Vocabulary</li>'));
  assert.ok(sectionsSource.includes('Kanji</li>'));
  assert.ok(sectionsSource.includes('Grammar</li>'));
  assert.ok(sectionsSource.includes('Study session</li>'));
  // Understand wraps the in-sentence word for the highlight beat.
  assert.ok(sectionsSource.includes('flow-sentence-hit'));
  assert.ok(sectionsSource.includes('--step-delay:1000ms'));
  assert.ok(sectionsSource.includes('昨日、日本'));
  assert.ok(sectionsSource.includes('<b lang="ja">昨日、日本料理を作った。</b>'));
  // Internal stagger: gloss then context, then review answer then rating.
  assert.ok(sectionsSource.includes('--step-delay:1250ms'));
  assert.ok(sectionsSource.includes('--step-delay:1500ms'));
  assert.ok(sectionsSource.includes('flow-reveal'));
  assert.ok(sectionsSource.includes('--step-delay:1750ms'));
  assert.ok(sectionsSource.includes('--step-delay:2000ms'));
  assert.ok(sectionsSource.includes('flow-good'));
  assert.ok(sectionsSource.includes('--step-delay:2200ms'));
  // Total sequence stays restrained: final beat ~2.2s + ~0.5s duration.
  assert.ok(cssSource.includes('flowWordBeat'));
  assert.ok(cssSource.includes('flowHitBeat'));
  assert.ok(cssSource.includes('flowGoodBeat'));
  assert.ok(cssSource.includes('var(--step-delay'));
  // Allowed motion only: opacity/translate/connector draw/highlight/stagger.
  assert.ok(!cssSource.includes('flowWordBeat') || !cssSource.match(/flowWordBeat[^}]*bounce/));
  for (const forbidden of ['@keyframes bounce', 'parallax']) {
    assert.ok(!cssSource.toLowerCase().includes(forbidden), 'forbidden motion: ' + forbidden);
  }
  assert.ok(!sectionsSource.includes('fake-cursor'));
  assert.ok(!sectionsSource.includes('cursor-dot'));
});

test('desktop constellation drifts while the mobile ledger stays static', () => {
  // Desktop float system intact and scoped to the constellation.
  for (const drift of ['heroDriftOne', 'heroDriftTwo', 'heroDriftThree', 'heroDriftFour', 'heroDriftFive']) {
    assert.ok(cssSource.includes('@keyframes ' + drift), 'drift present: ' + drift);
  }
  assert.ok(cssSource.includes('.hero-ecosystem::before'), 'orbit ring present');
  // Mobile (≤900px): constellation hides, ledger shows, typing untouched.
  const start = cssSource.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1);
  const next = cssSource.indexOf('@media', start + 1);
  const tablet = cssSource.slice(start, next === -1 ? undefined : next);
  assert.ok(tablet.includes('.hero-ecosystem'), 'swap lives in the 900 band');
  assert.ok(tablet.includes('display: none'), 'constellation hides');
  assert.ok(tablet.includes('.hero-ledger'), 'ledger shows');
  assert.ok(interactionsSource.includes('initHeroTyping'));
  assert.ok(sectionsSource.includes('data-hero-typing'));
  assert.ok(sectionsSource.includes('data-hero-streak="30"'), 'streak target lives with the card');
  // Reduced motion freezes both systems to readable final states.
  const reduced = cssSource.slice(cssSource.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.hero-ecosystem .hero-card'));
  assert.ok(reduced.includes('.hero-panel'));
  assert.ok(reduced.includes('animation: none'));
  assert.ok(reduced.includes('.hero-title-stack > h1'));
  assert.ok(reduced.includes('visibility: visible !important'));
});

test('how-it-works reduced-motion and no-JS complete to a readable final state', () => {
  assert.ok(cssSource.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(cssSource.includes('[data-demo="flow"] .flow-tracked'));
  assert.ok(cssSource.includes('[data-demo="flow"] .flow-sentence-hit'));
  assert.ok(cssSource.includes('[data-demo="flow"] .flow-good'));
  // Animation enhancement only: initial-hidden is gated behind .landing-js.
  assert.ok(cssSource.includes('.landing-js .landing-page .demo-step'));
  assert.ok(cssSource.includes('.landing-js .flow-connector'));
  assert.ok(!cssSource.includes('.flow-sentence-hit {opacity: 0'));
  assert.ok(interactionsSource.includes('prefers-reduced-motion'));
});

test('starting-estimate rotation shuffles without repeats on a restrained interval', () => {
  assert.deepEqual([...ESTIMATE_LEVELS].sort(), ['N1', 'N2', 'N3', 'N4', 'N5']);
  assert.ok(ESTIMATE_ROTATE_MS >= 1000 && ESTIMATE_ROTATE_MS <= 2000, 'interval stays ~1-2s');
  for (let round = 0; round < 25; round++) {
    const order = shuffledEstimateLevels(round === 0 ? undefined : 'N4');
    assert.equal(order.length, 5);
    assert.deepEqual([...order].sort(), ['N1', 'N2', 'N3', 'N4', 'N5']);
    if (round > 0) assert.notEqual(order[0], 'N4', 'no immediate repeat across rounds');
  }
  let last = 'N4';
  for (let round = 0; round < 10; round++) {
    const order = shuffledEstimateLevels(last);
    assert.notEqual(order[0], last);
    last = order[order.length - 1];
  }
  assert.equal(typeof initEstimateRotation, 'function');
  assert.ok(interactionsSource.includes('IntersectionObserver'), 'offscreen gating present');
  assert.ok(interactionsSource.includes('visibilitychange'), 'hidden-tab gating present');
  assert.ok(interactionsSource.includes("matchMedia('(prefers-reduced-motion: reduce)')"), 'reduced-motion fallback present');
  // Width-lock + fade only (no slot-machine motion).
  assert.ok(cssSource.includes('.estimate-value'));
  assert.ok(cssSource.includes('min-width: 2.2ch'));
  assert.ok(cssSource.includes('tabular-nums'));
  assert.ok(cssSource.includes('.estimate-value.is-switching'));
  assert.ok(!cssSource.toLowerCase().includes('slot-machine'));
});

test('hero streak counts 0 to 30 once on reveal, final by default', () => {
  assert.equal(HERO_STREAK_MS, 2000, 'calm ~2s arc inside the 1.6–2.3s band');
  assert.equal(typeof initHeroStreak, 'function');
  // Reduced motion (and no-JS): the markup final stands untouched.
  const untouched = { textContent: '30', querySelector() { return null; } };
  const scope = { querySelector() { return untouched; }, querySelectorAll() { return []; } };
  assert.equal(typeof initHeroStreak(scope, { reducedMotion: true }), 'function');
  assert.equal(untouched.textContent, '30', 'reduced motion never rewrites the final');
  // Full run with a stub observer + manual frame clock: starts at 0,
  // climbs monotonically, lands exactly on target, then rests.
  const node = { textContent: '30', getAttribute: () => '30' };
  const frames = [];
  let observed = null;
  const observerClass = function (callback) {
    this.callback = callback;
    observed = this;
    this.observe = () => {};
    this.disconnect = () => {};
  };
  const cleanup = initHeroStreak({ querySelector: () => node }, {
    reducedMotion: false,
    observerClass,
    raf: (fn) => { frames.push(fn); return frames.length; }
  });
  assert.equal(typeof cleanup, 'function');
  observed.callback([{ isIntersecting: true }]);
  assert.equal(node.textContent, '0', 'count starts at zero on reveal');
  let now = 0;
  const seen = new Set();
  while (frames.length) {
    now += 100;
    frames.shift()(now);
    seen.add(node.textContent);
    if (frames.length > 500) throw new Error('streak animation never settles');
  }
  assert.equal(node.textContent, '30', 'lands exactly on the final value');
  assert.ok(seen.size > 5, 'visibly climbs instead of jumping');
  assert.ok([...seen].every((value) => Number(value) >= 0 && Number(value) <= 30), 'never overshoots');
  // Wiring + markup contract.
  assert.ok(sectionsSource.includes('data-hero-streak="30"'), 'target lives with the card');
  assert.ok(interactionsSource.includes('HERO_STREAK_MS'), 'timing is a named constant');
  cleanup();
});

test('quick assessment stages to ~5.5s with a preparing beat and untouched neighbors', () => {
  assert.ok(ONBOARDING_STAGED_TOTAL_MS >= 4500 && ONBOARDING_STAGED_TOTAL_MS <= 6000, 'total stays 4.5-6s');
  assert.ok(sectionsSource.includes('placement-preparing'), 'preparing state hook present');
  assert.ok(sectionsSource.includes('Preparing your estimate'), 'preparing beat copy present');
  assert.ok(sectionsSource.includes('--step-delay:3800ms'), 'preparing stages before the reveal');
  assert.ok(sectionsSource.includes('--step-delay:4600ms'), 'estimate reveal lands with the longer arc');
  assert.ok(cssSource.includes('@keyframes placementPreparing'), 'preparing keyframes present');
  assert.ok(cssSource.includes('placementWelcome 5.5s'), 'welcome stretches with the arc');
  assert.ok(cssSource.includes('placementQuestion 5.5s'), 'question stretches with the arc');
  assert.ok(cssSource.includes('placementResult 5.5s'), 'result reveals at the longer total');
  assert.ok(sectionsSource.includes('Starting estimate, for example N4 range'), 'sr-only example label present');
  assert.ok(sectionsSource.includes('not an official JLPT assessment'), 'disclaimer preserved');
  assert.ok(!sectionsSource.toLowerCase().includes('confidence'), 'no confidence language');
  // Other demos keep their restrained timings.
  assert.ok(cssSource.includes('analyzeThenSettle 2100ms'), 'analyzer timing untouched');
  assert.ok(cssSource.includes('typeWord 550ms'), 'vocabulary timing untouched');
  const reduced = cssSource.slice(cssSource.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.placement-preparing'), 'reduced-motion resolves the new beat');
  assert.ok(reduced.includes('.estimate-value.is-switching'), 'reduced-motion holds the estimate static');
});
