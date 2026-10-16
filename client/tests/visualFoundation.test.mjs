// Part B core visual foundation — shared primitives + dashboard frame +
// feature-page alignment. Static source assertions only; no DOM, servers,
// browsers, or network required. Visual-only: no logic/API/auth semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const css = () => readSource('src/styles.css');
const tokens = () => readSource('src/tokens.css');

// --- canonical tokens (extended, not duplicated) -----------------------------

test('Part B tokens extend the canonical layer without duplicates', () => {
  const source = tokens();
  for (const name of ['--nt-accent-contrast', '--nt-success-soft', '--nt-warning-soft', '--nt-error-soft', '--nt-danger', '--nt-danger-soft', '--nt-chart-1', '--nt-chart-8']) {
    assert.ok(source.includes(name), `canonical ${name} defined`);
    // Light + dark definitions only (one per theme); match `name:` exactly
    // so --nt-danger does not count --nt-danger-soft.
    const occurrences = (source.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'g')) || []).length;
    assert.ok(occurrences <= 2, `${name} defined at most once per theme (found ${occurrences})`);
  }
  const aliases = css();
  for (const name of ['--jlt-accent-contrast', '--jlt-success', '--jlt-error-soft', '--jlt-danger', '--jlt-chart-1', '--jlt-chart-8']) {
    assert.ok(aliases.includes(name), `app alias ${name} present`);
  }
  assert.match(aliases, /--jlt-danger:\s*var\(--nt-danger\)/);
  assert.match(aliases, /--jlt-chart-1:\s*var\(--nt-chart-1\)/);
});

// --- buttons -----------------------------------------------------------------

test('Part B buttons: sumi primary / warm secondary / muted danger, 12px, states', () => {
  const source = css();
  assert.match(source, /\.button-primary \{[^}]*rounded-\[12px\]/);
  assert.match(source, /\.button-primary \{[^}]*background:\s*var\(--jlt-sumi\)/);
  assert.match(source, /\.button-primary:hover \{[^}]*var\(--jlt-sumi\)/);
  assert.match(source, /\.button-primary:focus-visible \{[^}]*var\(--nt-focus-ring\)/);
  assert.match(source, /\.button-secondary \{[^}]*rounded-\[12px\]/);
  assert.match(source, /\.button-secondary \{[^}]*background:\s*var\(--jlt-surface\)/);
  assert.match(source, /\.button-secondary \{[^}]*border:\s*1px solid var\(--jlt-border\)/);
  assert.match(source, /\.button-danger \{[^}]*text-red-700/);
  assert.match(source, /\.button-danger \{[^}]*background:\s*var\(--jlt-danger-soft\)/);
  assert.match(source, /\.button-danger \{[^}]*color:\s*var\(--jlt-danger\)/);
  assert.match(source, /\.button-ghost \{[^}]*color:\s*var\(--jlt-primary\)/);
  assert.match(source, /\.icon-button \{[^}]*rounded-\[12px\]/);
  assert.ok(source.includes('min-h-11'), '44px-ish touch targets');
  assert.ok(source.includes('disabled:opacity-55') && source.includes('disabled:cursor-not-allowed'), 'disabled states visible');
});

// --- forms -------------------------------------------------------------------

test('Part B forms: warm surfaces, subtle borders, 12px, hanko focus', () => {
  const source = css();
  assert.match(source, /\.field-control \{[^}]*background:\s*var\(--jlt-surface\)/);
  assert.match(source, /\.field-control \{[^}]*border:\s*1px solid var\(--jlt-border\)/);
  assert.match(source, /\.field-control \{[^}]*rounded-\[12px\]/);
  assert.match(source, /\.field-control:focus \{[^}]*border-color:\s*var\(--nt-focus-ring\)/);
  assert.match(source, /\.field-control:focus-visible \{[^}]*var\(--nt-focus-ring\)/);
  assert.match(source, /input\[type="checkbox"\][^{]*\{[^}]*accent-color:\s*var\(--nt-accent\)/);
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('inputmode'), 'validation behavior untouched (inputmode passthrough)');
});

// --- cards / panels ------------------------------------------------------------

test('Part B cards: 16px default, 20px prominent, subtle border + minimal shadow', () => {
  const source = css();
  assert.match(source, /\.surface \{[^}]*rounded-\[16px\]/);
  assert.match(source, /\.surface \{[^}]*border:\s*1px solid var\(--nt-border-subtle\)/);
  assert.match(source, /\.surface \{[^}]*box-shadow:\s*var\(--nt-shadow-sm\)/);
  assert.match(source, /\.chart-card, \.quick-add-card \{[^}]*border-radius:\s*20px/);
  assert.ok(!source.includes('border-radius:28px'), 'no oversized 28px cards remain');
});

// --- badges / pills ------------------------------------------------------------

test('Part B badges: muted semantic pills, text labels preserved', () => {
  const source = css();
  assert.match(source, /\.status-pill \{[^}]*border:\s*1px solid var\(--nt-border-subtle\)/);
  assert.ok(source.includes('.status-pill--success') && source.includes('var(--jlt-success-soft)'), 'success muted');
  assert.ok(source.includes('.status-pill--warning') && source.includes('var(--jlt-warning-soft)'), 'warning muted');
  assert.ok(source.includes('.status-pill--error') && source.includes('var(--jlt-error-soft)'), 'error muted');
  assert.ok(source.includes('.status-pill.status-jlpt'), 'JLPT badge hanko wash');
  assert.ok(source.includes('.status-pill.bg-emerald'), 'saturated chips neutralized via tokens');
  const entity = readSource('src/pages/entityPage.js');
  assert.ok(entity.includes('bg-emerald'), 'entity status strings preserved (CSS mutes them)');
  assert.ok(entity.includes("title: 'Self-reported status'"), 'pills never color-only');
  assert.ok(source.includes('.goal-complete'), 'completed-goal restraint kept');
});

// --- tables / lists ------------------------------------------------------------

test('Part B tables/lists: token separators, no table-to-card conversion', () => {
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(dashboard.includes('divide-stone'), 'row separators stay structural');
  assert.ok(css().includes('.table-header'), 'header language shared');
  assert.ok(css().includes('.list-row--selected'), 'selected-row language shared');
  assert.ok(!dashboard.includes('<table'), 'no tables introduced on dashboard');
});

// --- dialogs -------------------------------------------------------------------

test('Part B dialogs: warm surfaces, display headings, semantics intact', () => {
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('font-display text-lg'), 'dialog title uses display type');
  assert.ok(ui.includes('dialog-overlay') && ui.includes('dialog-panel'), 'warm token surfaces');
  assert.ok(ui.includes('bg-paper'), 'dialogs use the warm surface token');
  assert.ok(ui.includes("event.key === 'Escape'"), 'ESC preserved');
  assert.ok(ui.includes('event.target === overlay'), 'backdrop preserved');
  assert.ok(ui.includes('document.activeElement === first') && ui.includes('document.activeElement === last'), 'focus trap preserved');
  assert.ok(ui.includes('button-danger'), 'confirm hierarchy preserved');
  assert.match(css(), /\.dialog-overlay \{[^}]*background:\s*rgb\(0 0 0 \/ 0\.45\)/);
  assert.match(css(), /\.dialog-panel \{[^}]*background:\s*var\(--jlt-surface\)/);
});

// --- empty / loading -----------------------------------------------------------

test('Part B empty/loading: calm, no new actions, reduced motion respected', () => {
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('empty-state') && ui.includes('loading-state'), 'shared calm hooks');
  assert.ok(ui.includes('empty-state-title'), 'small heading hierarchy');
  assert.ok(!ui.includes('illustration') && !ui.includes('<svg'), 'no illustrations added');
  assert.match(css(), /\.skeleton \{[^}]*background:\s*var\(--jlt-surface-soft\)/);
  assert.ok(css().includes('@media (prefers-reduced-motion: reduce)'), 'reduced motion respected');
});

// --- charts --------------------------------------------------------------------

test('Part B charts: token palette, mechanism kept, no reddish bars', () => {
  const charts = readSource('src/charts.js');
  assert.ok(charts.includes('--jlt-muted') && charts.includes('--jlt-border') && charts.includes('--jlt-chart-text'), 'themeColors aliases alive');
  assert.ok(charts.includes('chartPalette') && charts.includes('--jlt-chart-'), 'palette reads canonical tokens');
  assert.ok(charts.includes('--nt-chart-') && charts.includes('--nt-accent'), 'canonical fallback path');
  assert.ok(!charts.includes('#c5533f') && !charts.includes('#d8876d'), 'reddish hexes removed');
  assert.ok(charts.includes('#B3402E'), 'hanko fallback only');
  assert.ok(charts.includes('#1C1A18'), 'sumi fallback present');
  assert.ok(charts.includes('prefersReducedMotion') && charts.includes('animation: false'), 'reduced motion kept');
});

// --- dashboard frame -----------------------------------------------------------

test('Part B dashboard frame: stable hierarchy, no charts, quiet links', () => {
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(dashboard.includes('dashboard-frame'), 'stable frame A.4 can extend');
  assert.ok(dashboard.includes('dashboard-metrics') && dashboard.includes('dashboard-panels'), 'grouped surfaces');
  assert.ok(dashboard.includes('font-display text-3xl'), 'metric hierarchy via display type');
  for (const marker of ['recentSessions', 'activityCalendar', '#statistics', 'metric(']) {
    assert.ok(dashboard.includes(marker), `dashboard keeps ${marker}`);
  }
  assert.ok(!dashboard.includes('weeklyChart') && !dashboard.includes('distributionChart'), 'dashboard stays chart-free');
  assert.ok(dashboard.includes('previewGoals.length ? [goalsPreview('), 'goals gating untouched');
});

// --- feature pages -------------------------------------------------------------

test('Part B pages: shared primitives only, kanji detail token-only, settings intact', () => {
  for (const path of ['src/pages/entityPage.js', 'src/pages/review.js', 'src/pages/sessions.js', 'src/pages/v2Pages.js', 'src/pages/analyzer.js', 'src/pages/statistics.js']) {
    const source = readSource(path);
    assert.ok(source.includes('surface') || source.includes('field-control') || source.includes('button-') || source.includes('status-pill'), `${path} uses shared primitives`);
  }
  const analyzer = readSource('src/pages/analyzer.js');
  assert.ok(analyzer.includes('filter-pill'), 'analyzer filters use the token pill');
  assert.ok(analyzer.includes('min-h-10 px-4 py-2'), 'per-card Add touch target untouched');
  const kanji = readSource('src/pages/entityPage.js');
  // B.1: the owned surface consumes the shared identity builder — the glyph
  // panel treatment lives in src/kanjiDetail.js, not inline in entityPage.
  assert.ok(kanji.includes('kanjiDetail.js'), 'owned kanji detail uses the shared identity builder');
  const sharedKanji = readSource('src/kanjiDetail.js');
  assert.ok(sharedKanji.includes('kanji-glyph-panel-large'), 'shared identity keeps the restrained glyph panel treatment');
  assert.ok(sharedKanji.includes('font-jp'), 'Japanese paths use font-jp');
  const settings = readSource('src/pages/settings.js');
  assert.ok(settings.includes('max-w-5xl'), 'settings cards keep desktop canvas');
  assert.ok(!settings.includes('persistAppTheme') && !settings.includes('jlt-theme-change'), 'appearance removed: no theme writes from settings');
});

// --- icons / japanese / dark / responsive ---------------------------------------

test('Part B icons/Japanese/dark/responsive stay token-driven', () => {
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes('lucide') && icons.includes('stroke-width'), 'library kept');
  assert.match(css(), /\.jlt-icon \{[^}]*stroke:\s*currentColor/);
  assert.ok(css().includes('.icon-tile .jlt-icon'), 'containers normalize alignment via CSS only');
  assert.ok(css().includes('#app-content [lang="ja"]'), 'Japanese default intact');
  // B.1: readings render from the shared builder; the reference page consumes
  // it via import (same endpoint, no duplicated data flow).
  assert.ok(readSource('src/kanjiDetail.js').includes('font-jp'), 'kanji paths extended');
  assert.ok(readSource('src/pages/kanjiReference.js').includes('kanjiDetail.js'), 'reference page uses the shared identity builder');
  // Part B additions are token-only: slice just the Part B @layer subsection
  // (up to the unlayered overrides) so pre-existing hex below is not blamed.
  const full = css();
  const partB = full.slice(full.indexOf('Part B foundation'), full.indexOf('/* Unlayered Part B'));
  assert.doesNotMatch(partB, /#[0-9a-fA-F]{3,6}/, 'Part B block uses tokens only (no hardcoded hex)');
  assert.ok(css().includes('@media (max-width: 640px)'), 'narrow viewports preserved');
  assert.ok(css().includes('min-w-0') || readSource('src/pages/analyzer.js').includes('min-w-0'), '320px shrink behavior kept');
});

// --- vermilion decision / regressions ------------------------------------------

test('Part B vermilion decision: aliases retained, zero-risk (no renames)', () => {
  assert.match(css(), /--color-vermilion:\s*var\(--jlt-primary\)/);
  assert.ok(css().includes('outline-vermilion'), 'focus ring alias kept');
  assert.ok(readSource('src/pages/review.js').includes('accent-vermilion'), 'checkbox accent alias kept');
  assert.ok(!css().includes('outline-indigo'), 'no speculative rename introduced');
});

test('Part B regressions: public frozen, auth gate untouched, routing intact', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes('renderAuthGate') && main.includes('jlt-auth-required'), 'auth gate code untouched');
  assert.ok(main.includes("title: 'Sign in'") || main.includes("'sign-in'"), 'auth render intact');
  assert.ok(main.includes("renderV2Page(container, 'tags')"), 'tags route registered');
  assert.ok(readSource('index.html').includes('alt="NippoTrack"'), 'shell brand intact (wordmark-only)');
  assert.ok(readSource('src/landing/landing.js').includes('NippoTrack — Bring your Japanese learning together'), 'public landing untouched');
  assert.ok(readSource('src/landing/howItWorks.js').includes('How it works'), 'how-it-works untouched');
});
