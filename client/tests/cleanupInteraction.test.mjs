// Pass 3 + 4 interaction and accessibility cleanup — search combobox,
// statistics failure state, drawer, motion, summaries, touch targets.
// Static source assertions; no DOM or servers required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('search implements a combobox/listbox keyboard model', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('function createSearch('), 'shared search controller');
  assert.ok(source.includes("role: 'option'"), 'results carry option roles');
  assert.ok(source.includes('aria-activedescendant'), 'active option communicated');
  assert.ok(source.includes('aria-selected'), 'selection state communicated');
  assert.ok(source.includes('aria-expanded'), 'expanded state communicated');
  assert.ok(source.includes("event.key === 'ArrowDown'"), 'ArrowDown moves through results');
  assert.ok(source.includes("event.key === 'ArrowUp'"), 'ArrowUp moves through results');
  assert.ok(source.includes("event.key === 'Enter'"), 'Enter activates the selected result');
  assert.ok(source.includes('limit=5'), 'result limits remain bounded');
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.search-option-active'), 'keyboard selection is visible');
});

test('both headers share the search interaction', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('createSearch(searchInput, searchResults)'), 'desktop wired');
  assert.ok(source.includes('createSearch(mobileSearchInput, mobileSearchResults'), 'mobile wired');
  assert.ok(source.includes('openMobileSearch'), 'mobile bar opens');
  assert.ok(source.includes('closeMobileSearch'), 'mobile bar closes cleanly');
});

test('statistics progress failure is visible with retry', () => {
  const source = readSource('src/pages/statistics.js');
  assert.ok(source.includes('errorState(new Error('), 'null model renders an error, not silence');
  assert.ok(source.includes('errorState(error, loadProgress)'), 'fetch failure renders an error with retry');
  assert.ok(!source.includes('progressSlot.replaceChildren();'), 'no silent slot clearing remains');
});

test('dashboard no longer duplicates statistics charts', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(!source.includes('weeklyChart'), 'weekly chart removed from dashboard');
  assert.ok(!source.includes('distributionChart'), 'distribution chart removed from dashboard');
  assert.ok(!source.includes('chartCard'), 'chart card helper removed');
  assert.ok(source.includes("metric('review', 'Due reviews'"), 'due reviews metric exists');
  assert.ok(source.includes('metric-link'), 'linked metrics render as deep links');
  assert.ok(source.includes('#statistics'), 'detailed analytics link present');
  assert.ok(source.includes('activityCalendar'), 'activity calendar stays');
});

test('drawer reports state, closes on Escape, and stays out of tab order when hidden', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes('syncDrawerState'), 'drawer state synchronized');
  assert.ok(source.includes('aria-expanded'), 'trigger exposes expanded state');
  assert.ok(source.includes('closeNavigation({ refocus: true })'), 'Escape closes with focus return');
  assert.ok(source.includes('sidebar.inert'), 'hidden drawer is inert on mobile');
});

test('reduced motion is respected by JS-driven motion', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes('prefers-reduced-motion: reduce'), 'navigate checks reduced motion');
  assert.ok(!main.includes("behavior: 'smooth' })"), 'no unconditional smooth scroll remains');
  const charts = readSource('src/charts.js');
  assert.ok(charts.includes('prefersReducedMotion'), 'chart animation gated');
  assert.ok(charts.includes('animation: false'), 'animation disabled under reduced motion');
});

test('streak, calendar, and charts expose non-visual equivalents', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes('stateLabel'), 'streak days carry text state');
  assert.ok(main.includes('no study activity'), 'inactive days named');
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(dashboard.includes("role: 'group'"), 'calendar days grouped');
  assert.ok(dashboard.includes('Daily study activity, last 35 days'), 'calendar group labeled');
  const statistics = readSource('src/pages/statistics.js');
  assert.ok(statistics.includes('aria-describedby'), 'charts referenced by summaries');
  assert.ok(statistics.includes('visually-hidden'), 'summaries hidden visually, not from AT');
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.visually-hidden'), 'visually-hidden primitive exists');
  assert.ok(css.includes('.skip-link'), 'skip link styled');
  assert.ok(css.includes('.nav-group-label'), 'nav groups styled subtly');
});

test('touch targets and focus visibility get a targeted pass', () => {
  const analyzer = readSource('src/pages/analyzer.js');
  assert.ok(analyzer.includes('min-h-10 px-4 py-2'), 'per-card Add meets a comfortable height');
  const css = readSource('src/styles.css');
  assert.ok(css.includes('a[href]:focus-visible'), 'links show focus');
  assert.ok(css.includes('summary:focus-visible'), 'details summaries show focus');
  assert.ok(css.includes('.metric-link'), 'metric deep links styled');
});

test('estimate morph gains narrow-screen containment only', () => {
  const css = readSource('src/styles.css');
  assert.ok(css.includes('@media (max-width: 480px)'), 'narrow-screen containment rule');
  assert.ok(css.includes('.level-estimate-morph.is-open'), 'expanded surface constrained');
  assert.ok(css.includes('position: fixed'), 'trigger-relative placement overridden on narrow screens');
  assert.ok(css.includes('100dvh - 8rem') || css.includes('100dvh'), 'dvh-aware max height');
  assert.ok(css.includes('.level-estimate-morph, .level-estimate-morph *, .level-estimate-detail, .level-estimate-detail-inner { transition: none !important; }'), 'reduced motion preserved');
});
