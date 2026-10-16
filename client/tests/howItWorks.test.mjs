import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveExperience } from '../src/landing/routing.js';
import { footer, navbar } from '../src/landing/sections.js';
import {
  HIW_ANALYZER_TOTAL_MS,
  HIW_AUTOFILL_TOTAL_MS,
  HIW_CONNECTIONS_TOTAL_MS,
  HIW_ENCOUNTER_TOTAL_MS,
  HIW_ENTER_DELAY_MS,
  HIW_HERO_TOTAL_MS,
  HIW_PLACEMENT_TOTAL_MS,
  HIW_PROGRESS_CHART_MS,
  HIW_PROGRESS_COUNT_MS,
  HIW_PROGRESS_TOTAL_MS,
  HIW_REVIEW_TOTAL_MS,
  HIW_SESSION_TOTAL_MS,
  hiwCounterValue,
} from '../src/landing/howItWorksMotion.js';
import {
  ESTIMATE_LEVELS,
  ESTIMATE_ROTATE_MS,
  initEstimateRotation,
  shuffledEstimateLevels,
} from '../src/landing/interactions.js';

const hiw = readFileSync(new URL('../src/landing/howItWorks.js', import.meta.url), 'utf8');
const hiwCss = readFileSync(new URL('../src/landing/howItWorks.css', import.meta.url), 'utf8');
const hiwMotion = readFileSync(new URL('../src/landing/howItWorksMotion.js', import.meta.url), 'utf8');
const sections = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8');

test('route resolve covers /, /how-it-works, trailing slash, /app, and legacy hashes', () => {
  assert.equal(resolveExperience({ pathname: '/', hash: '' }), 'landing');
  assert.equal(resolveExperience({ pathname: '/how-it-works', hash: '' }), 'how-it-works');
  assert.equal(resolveExperience({ pathname: '/how-it-works/', hash: '' }), 'how-it-works');
  assert.equal(resolveExperience({ pathname: '/app', hash: '' }), 'app');
  assert.equal(resolveExperience({ pathname: '/app/', hash: '' }), 'app');
  assert.equal(resolveExperience({ pathname: '/', hash: '#review' }), 'app');
  assert.equal(resolveExperience({ pathname: '/', hash: '#kanji-reference/%E6%AE%BB' }), 'app');
  assert.equal(resolveExperience({ pathname: '/', hash: '#features' }), 'landing');
});

test('how-it-works bundle stays isolated from app/supabase/backend code', () => {
  // JMdict is allowed only as a presentational provenance label (single chip
  // in the Keep chapter). Backend coupling (network, auth, storage) is not.
  for (const forbidden of ['supabase', 'fetch(', 'apiRequest(', './main.js', '../api', 'authClient']) {
    assert.ok(!hiw.includes(forbidden), 'howItWorks.js must not contain: ' + forbidden);
    assert.ok(!hiwMotion.includes(forbidden), 'howItWorksMotion.js must not contain: ' + forbidden);
  }
  for (const forbidden of ['supabase', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
    assert.ok(!hiwMotion.includes(forbidden), 'motion must not use network: ' + forbidden);
  }
  const imports = [...hiw.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'expected static import graph to inspect');
  for (const specifier of imports) {
    const allowed =
      specifier === './landing.css' ||
      specifier === './howItWorks.css' ||
      specifier === './sections.js' ||
      specifier === './interactions.js' ||
      specifier === './howItWorksMotion.js' ||
      // V6 authorizes the shared font loader (presentation-only: appends
      // the static Google Fonts link, no network/auth/storage of its own).
      specifier === '../fonts.js' ||
      specifier === './theme.js' ||
      // v5.1-E.3 authorizes Lenis smooth scroll for the public experience.
      // smoothScroll.js is landing-scoped (dynamic lenis import, no backend).
      specifier === './smoothScroll.js' ||
      specifier.startsWith('../assets/');
    assert.ok(allowed, 'unexpected howItWorks import: ' + specifier);
  }
  const motionImports = [...hiwMotion.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const specifier of motionImports) {
    assert.ok(
      specifier === './interactions.js',
      'motion may only reuse the central observer helpers: ' + specifier
    );
  }
  // entry.js code-splits the new route; landing never pulls it and it never pulls the app.
  assert.ok(entry.includes("import('./landing/howItWorks.js')"), 'code-split dynamic import required');
  assert.ok(entry.includes("experience === 'how-it-works'"), 'three-way experience switch required');
  const hiwBranch = entry.slice(entry.indexOf("experience === 'how-it-works'"));
  assert.ok(!hiwBranch.includes('supabase'), 'no backend init on the new route');
  assert.ok(!hiwBranch.includes('./main.js'), 'app bundle not loaded on the new route');
});

test('how-it-works reuses shared landing components instead of duplicating them', () => {
  assert.ok(hiw.includes("from './sections.js'"), 'navbar/footer reuse via sections.js');
  assert.ok(hiw.includes('navbar(') && hiw.includes('footer('), 'shared navbar + footer composers used');
  assert.ok(hiw.includes("variant: 'how-it-works'"), 'how-it-works navbar variant selected');
  assert.ok(hiw.includes("from './theme.js'"), 'theme wiring reused');
  assert.ok(hiw.includes("from './interactions.js'"), 'header/menu wiring reused');
  assert.ok(hiw.includes("from './howItWorksMotion.js'"), 'single-observer motion module reused');
  assert.ok(hiw.includes("import './landing.css'"), 'landing tokens/containers/buttons/focus reused');
  assert.ok(hiw.includes("import './howItWorks.css'"), 'page-scoped rhythm stylesheet loaded');
  assert.ok(sections.includes('export function navbar'), 'navbar shared export exists');
  assert.ok(sections.includes('export function footer'), 'footer shared export exists');
  assert.ok(sections.includes("options.variant === 'how-it-works'"), 'variant contract lives in sections.js');
});

test('how-it-works navbar links Logo, Features, current page, FAQ, and auth destinations', () => {
  const landingNav = navbar('/wordmark.png', {});
  assert.ok(!landingNav.includes('aria-current'), 'landing marks no current page');
  const hiwNav = navbar('/wordmark.png', {}, { variant: 'how-it-works' });
  assert.ok(hiwNav.includes('href="/" aria-label="NippoTrack home"'), 'logo returns to overview');
  assert.ok(hiwNav.includes('href="/#features">Features</a>'), 'HIW variant Features points back to /');
  assert.ok(
    hiwNav.includes('href="/how-it-works" aria-current="page">How it works</a>'),
    'aria-current marks the page in desktop and mobile navs'
  );
  assert.ok(hiwNav.includes('href="#faq">FAQ</a>'), 'existing FAQ behavior preserved');
  assert.ok(hiwNav.includes('href="/app?auth=sign-in"'), 'existing Log in destination reused');
  assert.ok(hiwNav.includes('data-auth-open="sign-in"'), 'Log in opens the modal in place');
  assert.ok(hiwNav.includes('href="/app?auth=sign-up"'), 'existing Get started destination reused');
  assert.ok(hiwNav.includes('data-auth-open="sign-up"'), 'Get started opens the modal in place');
  const landingFooter = footer('/wordmark.png', {});
  assert.ok(landingFooter.includes('href="#features">Features</a>'), 'landing footer unchanged');
  assert.ok(landingFooter.includes('href="#how-it-works">How it works</a>'), 'landing footer unchanged');
  const hiwFooter = footer('/wordmark.png', {}, { variant: 'how-it-works' });
  assert.ok(hiwFooter.includes('href="/#features">Features</a>'), 'HIW footer Features resolves cross-page');
  assert.ok(hiwFooter.includes('href="/how-it-works">How it works</a>'), 'HIW footer resolves cross-page');
});

test('hero owns the single H1 with both CTAs', () => {
  const h1Count = (hiw.match(/<h1/g) || []).length;
  assert.equal(h1Count, 1);
  assert.ok(hiw.includes('<h1 id="hiw-title">See how your Japanese moves through NippoTrack.</h1>'));
  assert.ok(hiw.includes('From something you encounter to something you understand, keep, review, and build on.'));
  assert.ok(hiw.includes('href="/app?auth=sign-up"'), 'sign-up fallback destination kept');
  assert.ok(hiw.includes('data-auth-open="sign-up">Start with NippoTrack</a>'), 'hero CTA opens the modal in place');
  assert.ok(hiw.includes('href="/">Back to overview</a>'));
  assert.ok(hiw.includes('data-hiw-hero-journey'), 'hero journey mount point exists');
});

test('landing gains restrained links to the dedicated page', () => {
  const landingNav = navbar('/wordmark.png', {});
  assert.ok(landingNav.includes('href="/how-it-works">How it works</a>'), 'navbar How it works links the page');
  assert.ok(sections.includes('href="/how-it-works">See how it works'), 'hero links the page');
  assert.ok(sections.includes('href="/how-it-works">See the full flow'), 'preview links the full flow');
});

test('page follows the exact static section order with logical headings', () => {
  const ordered = [
    '<h1 id="hiw-title">See how your Japanese moves through NippoTrack.</h1>',
    '<h2 id="hiw-ch1-title">Start from where you are.</h2>',
    'A short, optional placement helps NippoTrack shape your first experience without pretending to give you an official JLPT diagnosis.',
    '<h2 id="hiw-ch2-title">Your Japanese doesn\'t begin inside NippoTrack.</h2>',
    'It begins in the things you already use—anime, manga, textbooks, YouTube, classes, conversations, and your own notes.',
    '<h2 id="hiw-ch3-title">Turn real Japanese into something you can understand.</h2>',
    'Inspect words in context, see readings and dictionary information, and decide what is useful to you.',
    '<h2 id="hiw-ch4-title">Save the pieces worth coming back to.</h2>',
    'NippoTrack can reduce repetitive typing while leaving the final decision with you.',
    '<h2 id="hiw-ch5-title">See how the pieces fit together.</h2>',
    'Vocabulary, kanji, context, and grammar become more useful when you can see their relationships.',
    '<h2 id="hiw-ch6-title">Track the work behind the words.</h2>',
    'Vocabulary matters, but so does the time you spend listening, reading, speaking, reviewing, and studying.',
    '<h2 id="hiw-ch7-title">Review your Japanese, not somebody else\'s course.</h2>',
    'Your review flow grows from the vocabulary you intentionally collected and studied.',
    '<h2 id="hiw-ch8-title">See your learning become visible.</h2>',
    "NippoTrack helps you see what you've collected, reviewed, and actually spent time studying.",
    'Collected ≠ Reviewed ≠ Known',
    "NippoTrack doesn't replace how you learn Japanese.",
    'It makes the way you already learn Japanese smarter.',
    '<h2 id="hiw-final-title">Bring your Japanese learning together.</h2>',
  ];
  let previous = -1;
  for (const needle of ordered) {
    const position = hiw.indexOf(needle);
    assert.ok(position > previous, 'missing or out-of-order copy: ' + needle);
    previous = position;
  }
  assert.ok(hiw.includes('class="landing-skip-link" href="#hiw-main"'), 'skip link targets the page main');
  assert.ok(hiw.includes('<main id="hiw-main"'), 'single page main landmark');
  assert.ok(!hiw.includes('aria-live'), 'no live regions on a static page');
});

test('demo mount points exist for the visuals/motion pass', () => {
  for (const mount of [
    'data-hiw-hero-journey',
    'data-hiw-demo="placement"',
    'data-hiw-demo="encounter"',
    'data-hiw-demo="analyzer"',
    'data-hiw-demo="autofill"',
    'data-hiw-demo="connections"',
    'data-hiw-demo="session"',
    'data-hiw-demo="review"',
    'data-hiw-demo="progress"',
    'data-hiw-thread',
    'data-hiw-truth',
  ]) {
    assert.ok(hiw.includes(mount), 'missing mount point: ' + mount);
  }
  assert.ok(hiw.includes('Detected ≠ matched ≠ interpreted ≠ added'), 'analyzer truth note present');
  const thread = hiw.slice(hiw.indexOf('data-hiw-thread'));
  for (const stage of ['Start', 'Encounter', 'Understand', 'Keep', 'Connect', 'Track', 'Review', 'See']) {
    assert.ok(thread.includes('<span>' + stage + '</span>'), 'thread missing stage: ' + stage);
  }
  assert.ok(thread.includes('aria-hidden="true"'), 'thread is decorative');
  assert.ok(hiw.includes('visually-hidden'), 'screen-reader thread equivalent present');
});

test('representative Japanese is hardcoded with lang="ja" throughout', () => {
  for (const text of [
    'lang="ja">旅行',
    'lang="ja">週末は友達と映画を見ます。',
    'lang="ja">映画',
    'lang="ja">えいが',
    'lang="ja">雨が降っている。',
    'lang="ja">雨',
    'lang="ja">あめ',
    'lang="ja">降っている',
    'lang="ja">降る',
    'lang="ja">図書館',
    'lang="ja">としょかん',
    'lang="ja">読<',
    'lang="ja">ドク',
    'lang="ja">よむ<',
    'lang="ja">読書',
    'lang="ja">どくしょ',
    'lang="ja">本を読む。',
    'lang="ja">ほんをよむ。',
    'lang="ja">約束',
    'lang="ja">やくそく',
    'lang="ja">約束を忘れないで。',
  ]) {
    assert.ok(hiw.includes(text), 'missing lang="ja" presentation copy: ' + text);
  }
  for (const text of ['movie', '“to fall”', 'library', 'reading', 'read a book', 'promise']) {
    assert.ok(hiw.includes(text), 'missing English gloss: ' + text);
  }
  for (const text of ['YouTube', 'Listening', '35 min', 'Shadowing practice']) {
    assert.ok(hiw.includes(text), 'missing session fallback: ' + text);
  }
  for (const text of ['312', '184', '27', '18h', 'Starting estimate N4 range', 'Current focus Building toward N3']) {
    assert.ok(hiw.includes(text), 'missing progress fallback: ' + text);
  }
  assert.ok(!hiw.includes('You are N3'), 'directional estimates only, never a level claim');
});

test('product-truth language suggests while leaving decisions with the learner', () => {
  for (const phrase of ['Dictionary suggestion', 'Ready to add', 'you decide']) {
    assert.ok(hiw.includes(phrase), 'missing product-truth wording: ' + phrase);
  }
  for (const forbidden of ['automatically saved', 'confidence', 'mastered', 'known-from-review', 'likely']) {
    assert.ok(!hiw.toLowerCase().includes(forbidden), 'forbidden intelligence claim: ' + forbidden);
  }
  assert.ok(!/\bbest\b/i.test(hiw), 'never claim a best match');
  // Visual actions present without faking function: spans, never buttons or inputs.
  assert.ok(!hiw.includes('<button'), 'chapter visuals must not use real buttons');
  assert.ok(!hiw.includes('<input'), 'chapter visuals must not use real inputs');
  assert.ok(!hiw.includes('<form'), 'chapter visuals must not use real forms');
});

test('page stylesheet reuses landing tokens with restrained scripted motion', () => {
  assert.ok(hiwCss.includes('var(--landing-'), 'theme tokens reused via landing vars');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(hiwCss), 'no hardcoded one-off colors');
  for (const forbidden of ['sakura', 'torii', 'glassmorphism', 'neon', 'blob']) {
    assert.ok(!hiwCss.toLowerCase().includes(forbidden), 'forbidden visual language: ' + forbidden);
  }
  // Scripted motion is transform/opacity/stroke only, one-shot and final.
  assert.ok(hiwCss.includes('@keyframes hiwStepReveal'), 'step reveal present');
  assert.ok(hiwCss.includes('@keyframes hiwDrawLine'), 'connector/chart draw present');
  assert.ok(hiwCss.includes('stroke-dashoffset'), 'SVG draw uses dashoffset');
  assert.ok(hiwCss.includes('forwards'), 'one-shot final state persists');
  assert.ok(!hiwCss.toLowerCase().includes('parallax'), 'no parallax');
  assert.ok(!hiwCss.toLowerCase().includes('gsap'), 'no animation library');
  assert.ok(!hiwCss.includes('aria-live'), 'no live regions in styles');
  assert.ok(hiwCss.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion final state declared');
  assert.ok(hiwCss.includes('html.hiw-js'), 'no-JS final-state scoping present');
  assert.ok(hiwCss.includes('@media (max-width: 767px)'), 'mobile breakpoint present');
  assert.ok(hiwCss.includes('@media (max-width: 1100px)'), 'desktop thread breakpoint present');
  assert.ok(hiwCss.includes('@media (max-width: 900px)'), 'tablet breakpoint present');
});

test('visual chapters render distinct compositions with presentational steps', () => {
  // Hero: linear journey strip, own identity apart from landing constellation.
  assert.ok(hiw.includes('hiw-journey'), 'hero journey strip present');
  assert.ok(hiw.includes('Encountered'), 'hero encounter fragment present');
  assert.ok(hiw.includes('Reading · meaning'), 'hero reading fragment present');
  assert.ok(hiw.includes('hiw-jmark'), 'hero progress mark present');
  assert.ok(hiw.includes('lang="ja">りょこう'), 'hero reading kept with lang');
  // Ch1: centered placement stage with 3 presentational questions + estimate.
  assert.ok(hiw.includes('Question 1 of 3'), 'placement Q1 present');
  assert.ok(hiw.includes('Question 2 of 3'), 'placement Q2 present');
  assert.ok(hiw.includes('Question 3 of 3'), 'placement Q3 present');
  assert.ok(hiw.includes('Preparing your starting estimate'), 'placement processing present');
  assert.ok(hiw.includes('Starting estimate, not an official JLPT assessment.'), 'placement disclaimer present');
  // Ch2: editorial encounter with emphasis + brought-in token.
  assert.ok(hiw.includes('hiw-hit'), 'encounter emphasis hook present');
  assert.ok(hiw.includes('hiw-capture-token'), 'encounter capture token present');
  assert.ok(hiw.includes('Brought in to inspect'), 'encounter avoids auto-collect wording');
  assert.ok(!hiw.toLowerCase().includes('drag'), 'no drag implication');
  // Ch3: wide workspace with candidates, context, and visual-only keep actions.
  assert.ok(hiw.includes('Analyzing…'), 'analyzer status present');
  assert.ok(hiw.includes('hiw-cand-active'), 'analyzer candidate highlight present');
  assert.ok(hiw.includes('Keep this word'), 'analyzer visual-only action present');
  assert.ok(hiw.includes('Add to Vocabulary'), 'analyzer second action present');
  assert.ok(hiw.includes('data-hiw-truth'), 'analyzer truth note hook kept');
  // Ch4: narrow form with lookup, JMdict provenance, ready, and confirmation.
  assert.ok(hiw.includes('Looking up dictionary…'), 'autofill lookup present');
  assert.ok(hiw.includes('JMdict'), 'autofill JMdict provenance present');
  assert.ok(hiw.includes('Ready to add'), 'autofill ready state present');
  assert.ok(hiw.includes('You confirm before anything is kept.'), 'autofill confirmation present');
  // Ch5: relationship diagram with two connectors + textual list fallback.
  assert.ok(hiw.includes('hiw-connect-diagram'), 'connections diagram present');
  assert.ok(hiw.includes('hiw-link-one'), 'first connector present');
  assert.ok(hiw.includes('hiw-link-two'), 'second connector present');
  assert.ok(hiw.includes('hiw-connect-list'), 'connections textual fallback present');
  // Ch6: session fields plus logged state and timeline mark.
  assert.ok(hiw.includes('Session logged in this example'), 'session logged example state present');
  assert.ok(hiw.includes('hiw-timeline'), 'session timeline present');
  assert.ok(hiw.includes('hiw-tick-new'), 'timeline new mark present');
  // Ch7: focused review with reveal and Good emphasis.
  assert.ok(hiw.includes('Reveal answer'), 'review reveal present');
  assert.ok(hiw.includes('hiw-rating'), 'review rating present');
  assert.ok(hiw.includes('hiw-good'), 'review Good emphasis present');
  const reviewSlice = hiw.slice(hiw.indexOf('hiw-ch7-title'), hiw.indexOf('hiw-ch8-title'));
  assert.ok(!reviewSlice.toLowerCase().includes('known'), 'review never claims known');
  assert.ok(!reviewSlice.toLowerCase().includes('mastered'), 'review never claims mastered');
  // Ch8: counters plus drawn chart plus directional focus.
  assert.ok(hiw.includes('data-hiw-count="312"'), 'vocabulary counter present');
  assert.ok(hiw.includes('data-hiw-count="184"'), 'kanji counter present');
  assert.ok(hiw.includes('data-hiw-count="27"'), 'sessions counter present');
  assert.ok(hiw.includes('data-hiw-count="18"'), 'time counter present');
  assert.ok(hiw.includes('hiw-line'), 'progress chart line present');
  assert.ok(hiw.includes('hiw-area'), 'progress chart area present');
  assert.ok(hiw.includes('Building toward N3'), 'directional focus present');
  // Compositions vary: stage, editorial, workspace, form, diagram, session, review, progress.
  for (const hook of [
    'hiw-demo-stage',
    'hiw-demo-editorial',
    'hiw-demo-workspace',
    'hiw-demo-form',
    'hiw-demo-connect',
    'hiw-demo-session',
    'hiw-demo-review',
    'hiw-demo-progress',
  ]) {
    assert.ok(hiw.includes(hook), 'distinct composition hook missing: ' + hook);
  }
});

test('motion uses a single one-shot observer with thread activation', () => {
  assert.ok(hiwMotion.includes('IntersectionObserver'), 'central observer present');
  assert.equal(
    (hiwMotion.match(/new IntersectionObserver/g) || []).length,
    1,
    'exactly one observer for all chapters'
  );
  assert.ok(hiwMotion.includes('HIW_ENTER_DELAY_MS'), 'short enter delay present');
  assert.ok(hiwMotion.includes("dataset.played === 'true'"), 'play-once guard present');
  assert.ok(hiwMotion.includes("classList.add('is-playing')"), 'playing hook present');
  assert.ok(!hiwMotion.includes("remove('is-playing')"), 'final state never removed');
  assert.ok(hiwMotion.includes('data-hiw-node'), 'thread node activation present');
  assert.ok(hiwMotion.includes("classList.add('is-active')"), 'thread activation hook present');
  assert.ok(hiwMotion.includes('initHowItWorksMotion'), 'motion initializer exported');
  assert.ok(hiw.includes('initHowItWorksMotion(root)'), 'page boots the motion pass');
  assert.ok(hiwMotion.includes('pagehide'), 'lifecycle cleanup present');
  assert.ok(hiwMotion.includes('visibilitychange'), 'hidden-tab pause present');
  assert.ok(hiwMotion.includes('disconnect'), 'observer cleanup present');
  assert.ok(hiwMotion.includes('clearTimeout'), 'timer cleanup present');
  const thread = hiw.slice(hiw.indexOf('data-hiw-thread'));
  for (const node of ['start', 'encounter', 'understand', 'keep', 'connect', 'track', 'review', 'see']) {
    assert.ok(thread.includes('data-hiw-node="' + node + '"'), 'thread node missing: ' + node);
  }
  assert.ok(hiwCss.includes('.hiw-thread li.is-active'), 'active thread styling present');
  // Thread is in-flow editorial, never a fixed/sticky progress bar.
  assert.ok(/\.hiw-thread\s*\{[^}]*position:\s*relative/.test(hiwCss), 'thread is in-flow (position: relative)');
  const threadBlocks = [...hiwCss.matchAll(/\.hiw-thread[^{]*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(threadBlocks.length > 0, 'thread styling present');
  for (const block of threadBlocks) {
    assert.ok(!block.includes('position: fixed'), 'thread never fixed: ' + block.slice(0, 60));
    assert.ok(!block.includes('position: sticky'), 'thread never sticky: ' + block.slice(0, 60));
  }
});

test('chapter timing constants stay within scripted ranges', () => {
  assert.ok(HIW_ENTER_DELAY_MS >= 150 && HIW_ENTER_DELAY_MS <= 400, 'enter delay restrained');
  assert.ok(HIW_HERO_TOTAL_MS >= 2800 && HIW_HERO_TOTAL_MS <= 3400, 'hero ~3s');
  assert.ok(HIW_PLACEMENT_TOTAL_MS >= 3500 && HIW_PLACEMENT_TOTAL_MS <= 4000, 'placement 3.5-4s');
  assert.ok(HIW_ENCOUNTER_TOTAL_MS >= 2800 && HIW_ENCOUNTER_TOTAL_MS <= 3400, 'encounter 2.8-3.4s');
  assert.ok(HIW_ANALYZER_TOTAL_MS >= 3600 && HIW_ANALYZER_TOTAL_MS <= 4200, 'analyzer ~4s');
  assert.ok(HIW_AUTOFILL_TOTAL_MS >= 3000 && HIW_AUTOFILL_TOTAL_MS <= 3500, 'autofill 3.0-3.4s');
  assert.ok(HIW_CONNECTIONS_TOTAL_MS >= 3000 && HIW_CONNECTIONS_TOTAL_MS <= 3600, 'connections 3.0-3.6s');
  assert.ok(HIW_SESSION_TOTAL_MS >= 2500 && HIW_SESSION_TOTAL_MS <= 3000, 'session 2.5-3s');
  assert.ok(HIW_REVIEW_TOTAL_MS >= 2500 && HIW_REVIEW_TOTAL_MS <= 3000, 'review 2.5-3s');
  assert.ok(HIW_PROGRESS_COUNT_MS >= 1500 && HIW_PROGRESS_COUNT_MS <= 1800, 'counters 1.5-1.8s');
  assert.ok(HIW_PROGRESS_CHART_MS >= 1800 && HIW_PROGRESS_CHART_MS <= 2000, 'chart 1.8-2s');
  assert.ok(HIW_PROGRESS_TOTAL_MS >= 3000 && HIW_PROGRESS_TOTAL_MS <= 3800, 'progress total sane');
  // Deterministic counters finish exactly.
  assert.equal(hiwCounterValue(312, 0, 1600), 0);
  assert.equal(hiwCounterValue(312, 800, 1600), 156);
  assert.equal(hiwCounterValue(312, 1600, 1600), 312);
  assert.equal(hiwCounterValue(312, 2400, 1600), 312);
  // Step delays in markup never exceed their chapter totals.
  const delays = [...hiw.matchAll(/--step-delay:(\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(delays.length >= 30, 'expected staged delays across chapters');
  assert.ok(Math.max(...delays) <= 3400, 'latest beat stays restrained');
});

test('reduced-motion and no-JS complete to readable final states', () => {
  assert.ok(hiwCss.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion block present');
  const reduced = hiwCss.slice(hiwCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('html.hiw-js .hiw-step'), 'steps resolve to final');
  assert.ok(reduced.includes('opacity: 1'), 'steps visible without motion');
  assert.ok(reduced.includes('html.hiw-js .hiw-line'), 'chart resolves to drawn');
  assert.ok(reduced.includes('stroke-dashoffset: 0'), 'chart/connectors drawn');
  assert.ok(reduced.includes('html.hiw-js .hiw-hit'), 'hit resolves to tint');
  assert.ok(reduced.includes('html.hiw-js .hiw-jmark'), 'hero ambient disabled');
  assert.ok(reduced.includes('animation: none'), 'ambient loop disabled');
  assert.ok(hiwMotion.includes("matchMedia('(prefers-reduced-motion: reduce)')"), 'JS respects reduced motion');
  assert.ok(hiwMotion.includes('hiw-reduced-motion'), 'reduced-motion flag present');
  // No-JS: initial-hidden states are scoped so fallback copy stays readable.
  assert.ok(hiwCss.includes('html.hiw-js .hiw-step'), 'hide states scoped under html.hiw-js');
  assert.ok(hiwCss.includes('html.hiw-js .hiw-line'), 'chart hide scoped');
  assert.ok(hiwCss.includes('html.hiw-js .hiw-link line'), 'connector hide scoped');
  assert.ok(!hiwCss.match(/^(\s*)(\.hiw-step\s*\{[^}]*opacity:\s*0)/m), 'no unscoped hidden steps');
});

test('decorative diagrams stay hidden from assistive tech with sane layering', () => {
  assert.ok(hiw.includes('<div class="hiw-journey" aria-hidden="true">'), 'hero journey decorative');
  assert.ok(hiw.includes('<div class="hiw-connect-diagram" aria-hidden="true">'), 'connections diagram decorative');
  assert.ok(hiw.includes('<div class="hiw-timeline'), 'timeline present');
  assert.ok(hiw.slice(hiw.indexOf('hiw-timeline')).includes('aria-hidden="true"'), 'timeline decorative');
  assert.ok(hiw.includes('<svg viewBox="0 0 760 180"'), 'progress chart svg present');
  assert.ok(hiw.includes('aria-hidden="true"><path class="hiw-grid"'), 'chart geometry decorative');
  assert.ok(hiw.includes('hiw-connect-list'), 'diagram has nearby supporting copy');
  assert.ok(hiwCss.includes('.hiw-thread'), 'thread layer present');
  assert.ok(/\.hiw-thread\s*\{[^}]*position:\s*relative/.test(hiwCss), 'thread is in-flow, not a fixed rail');
  assert.ok(!/\.hiw-thread[^{]*\{[^}]*(position:\s*fixed|position:\s*sticky)/.test(hiwCss), 'thread never fixed/sticky');
  assert.ok(hiwCss.includes('.hiw-demo'), 'demo layer present');
  assert.ok(hiwCss.includes('z-index: 1'), 'demos keep calm layering');
  assert.ok(!hiw.includes('aria-live'), 'no live regions in markup');
});

test('placement estimate reuses the shared rotator without new bundles', () => {
  assert.deepEqual([...ESTIMATE_LEVELS].sort(), ['N1', 'N2', 'N3', 'N4', 'N5']);
  assert.ok(ESTIMATE_ROTATE_MS >= 1000 && ESTIMATE_ROTATE_MS <= 2000, 'interval stays ~1-2s');
  const first = shuffledEstimateLevels('N4');
  assert.equal(first.length, 5);
  assert.notEqual(first[0], 'N4', 'shuffled round avoids an immediate repeat');
  assert.equal(typeof initEstimateRotation, 'function');
  assert.ok(hiw.includes('data-estimate-value'), 'HIW placement hooks the shared rotator');
  assert.ok(hiw.includes('data-estimate-delay="3400"'), 'rotation starts after the reveal');
  assert.ok(hiw.includes('aria-hidden="true"'), 'rotating text hides from AT');
  assert.ok(hiw.includes('Starting estimate, for example N4 range'), 'static sr-only example present');
  assert.ok(hiw.includes('Starting estimate, not an official JLPT assessment.'), 'disclaimer preserved');
  assert.ok(!hiw.toLowerCase().includes('confidence'), 'no confidence language');
  assert.ok(hiwMotion.includes('./interactions.js'), 'motion still shares the central helper');
  assert.ok(hiw.includes("from './interactions.js'"), 'page boots share the helper without new bundles');
  assert.ok(!hiwCss.includes('.estimate-value'), 'width-lock stays shared via landing.css, not duplicated');
  const reduced = hiwCss.slice(hiwCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(hiwMotion.includes("matchMedia('(prefers-reduced-motion: reduce)')"), 'reduced-motion stays static N4');
  assert.ok(entry.includes("experience === 'how-it-works'"), 'route regression guard');
  assert.equal(resolveExperience({ pathname: '/how-it-works', hash: '' }), 'how-it-works');
  assert.equal(resolveExperience({ pathname: '/', hash: '' }), 'landing');
});

test('autofill confirmation stages three rows with a restrained check', () => {
  assert.ok(hiwCss.includes('.hiw-actionrow'), 'analyzer action group hook present');
  const actionRow = hiwCss.slice(hiwCss.indexOf('.hiw-actionrow'));
  assert.ok(actionRow.includes('margin-top: 22px'), 'breathing room above the keep actions');
  assert.ok(actionRow.includes('margin-bottom: 6px'), 'breathing room below the keep actions');
  assert.ok(hiwCss.includes('.hiw-ready'), 'ready row hook present');
  assert.ok(hiwCss.includes('.hiw-confirm'), 'confirm row hook present');
  assert.ok(hiwCss.includes('.hiw-form-card > .hiw-note'), 'helper row stages separately');
  assert.ok(hiwCss.includes('.hiw-confirm-box::after'), 'check renders in a pseudo-element');
  assert.ok(hiwCss.includes('@keyframes hiwCheckSettle'), 'restrained check keyframes present');
  assert.ok(hiwCss.includes('hiwCheckSettle 420ms ease-out'), 'short settle without bounce');
  assert.ok(!hiwCss.toLowerCase().includes('bounce'), 'no bounce language');
  assert.ok(hiw.includes('<span class="hiw-confirm-box" aria-hidden="true">'), 'box stays decorative');
  assert.ok(!hiw.includes('<input'), 'confirmation stays non-interactive');
  assert.ok(!hiw.includes('<button'), 'confirmation stays non-interactive');
  const reduced = hiwCss.slice(hiwCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.hiw-confirm-box::after'), 'reduced-motion shows the checked final');
  assert.ok(reduced.includes('opacity: 1'), 'checked final renders instantly');
  assert.ok(reduced.includes('animation: none'), 'no transition under reduced motion');
});

test('tablet containment interpolates with flexible gutters and an in-flow thread', () => {
  const band1100 = hiwCss.slice(hiwCss.indexOf('@media (max-width: 1100px)'));
  assert.ok(band1100.includes('.hiw-hero-grid'), 'hero eases before the stack');
  assert.ok(band1100.includes('gap: 44px'), 'single intermediate hero rhythm');
  assert.ok(band1100.includes('.hiw-connect-diagram'), 'diagram eases before the stack');
  assert.ok(band1100.includes('minmax(40px, 64px)'), 'gutters narrow without a new breakpoint');
  assert.ok(hiwCss.includes('minmax(48px, 90px)'), 'base gutters flex instead of fixing 90px');
  assert.ok(!hiwCss.includes('grid-template-columns: 1fr 90px 1fr 90px 1fr'), 'no fixed-width diagram');
  assert.ok(/\.hiw-thread\s*\{[^}]*position:\s*relative/.test(hiwCss), 'thread stays in-flow');
  const mobile = hiwCss.slice(hiwCss.indexOf('@media (max-width: 767px)'));
  assert.ok(!mobile.includes('gap: 44px'), 'tablet easing never leaks to mobile');
  assert.ok(!mobile.includes('hiwCheckSettle'), 'check motion never redefined on mobile');
});

test('responsive hooks reuse landing breakpoints with mobile-safe narrative', () => {
  for (const breakpoint of ['@media (max-width: 1100px)', '@media (max-width: 900px)', '@media (max-width: 767px)']) {
    assert.ok(hiwCss.includes(breakpoint), 'landing breakpoint reused: ' + breakpoint);
  }
  assert.ok(hiwCss.includes('hiw-wide'), 'wide chapters have a container hook');
  assert.ok(hiwCss.includes('max-width: 100%'), 'panels never force horizontal scroll');
  assert.ok(hiwCss.includes('overflow-wrap: break-word'), 'long Japanese wraps safely');
  // Mobile keeps Japanese readable and targets reachable.
  const mobile = hiwCss.slice(hiwCss.indexOf('@media (max-width: 767px)'));
  assert.ok(mobile.includes('.hiw-sentence'), 'sentence scales on mobile');
  assert.ok(mobile.includes('font-size: 22px'), 'sentence never tiny');
  assert.ok(mobile.includes('.hiw-review-word'), 'review word scales on mobile');
  assert.ok(hiwCss.includes('min-height: 44px'), 'touch targets stay reachable');
  // In-flow thread simplifies on small screens instead of hiding at desktop widths.
  const desktop1100 = hiwCss.slice(hiwCss.indexOf('@media (max-width: 1100px)'));
  assert.ok(desktop1100.includes('.hiw-thread'), 'thread restrains itself at small-desktop widths');
  assert.ok(!/\.hiw-thread\s*\{[^}]*display:\s*none/.test(hiwCss), 'thread never display:none (stays in-flow)');
  assert.ok(mobile.includes('.hiw-thread'), 'thread simplifies on mobile');
});
