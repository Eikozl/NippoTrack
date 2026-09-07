// Dashboard Active Goals preview + estimate intrinsic mobile layout.
// Static source assertions; no DOM, servers, or browsers required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('goals preview uses canonical active-work semantics', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('item.is_active && !item.isComplete'), 'active and not complete');
  assert.ok(source.includes('active=1'), 'server-side active filter');
});

test('goals preview is bounded to three in existing ordering', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('.slice(0, 3)'), 'maximum three previews');
  assert.ok(source.includes('limit=10'), 'one bounded request on the existing endpoint');
  assert.ok(!source.includes('ORDER BY'), 'no invented sorting — API ordering reused');
});

test('zero eligible goals render absolutely nothing', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('previewGoals.length ? [goalsPreview('), 'section only renders when eligible goals exist');
  assert.ok(!source.includes('No active goals'), 'no empty-state copy');
  assert.ok(!source.includes('Create your first goal'), 'no placeholder CTA');
});

test('preview navigates via existing routing with a restrained view-all', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes("href: '#goals'"), 'preview cards link to Goals');
  assert.ok(source.includes('View all goals'), 'view-all link present');
  assert.ok(source.includes('eligibleGoals.length > 3'), 'view-all only when more exist');
  const previewBlock = source.slice(source.indexOf('function goalsPreview'), source.indexOf('export async function'));
  assert.ok(!previewBlock.includes("'Edit'") && !previewBlock.includes("'Delete'"), 'no edit/delete controls in preview');
});

test('preview grid is count-aware: 1/2/3 goals fill the section width', () => {
  const source = readSource('src/pages/dashboard.js');
  const previewBlock = source.slice(source.indexOf('function goalsPreview'), source.indexOf('export async function'));
  assert.ok(previewBlock.includes('items.length > 2'), 'three-goal layout selected by rendered count');
  assert.ok(previewBlock.includes('items.length > 1'), 'two-goal layout selected by rendered count');
  assert.ok(previewBlock.includes("'mt-3 grid gap-4'"), 'single goal uses one full-width column');
  assert.ok(previewBlock.includes("'mt-3 grid gap-4 sm:grid-cols-2'"), 'two goals share two equal columns');
  assert.ok(previewBlock.includes("'mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3'"), 'three goals share three equal columns on desktop');
  assert.ok(!previewBlock.includes('absolute'), 'no absolute positioning');
  assert.ok(!previewBlock.includes('slice('), 'no re-capping here — the max-3 cap stays at the call site');
});

test('preview stays compact and responsive', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('sm:grid-cols-2 xl:grid-cols-3'), 'stacks on mobile, grid on wider layouts');
  assert.ok(source.includes('break-words'), 'long titles wrap');
  assert.ok(source.includes('min-w-0'), 'children never force overflow');
});

test('existing dashboard content still renders', () => {
  const source = readSource('src/pages/dashboard.js');
  for (const marker of ['recentSessions', 'activityCalendar', '#statistics', 'metric(']) {
    assert.ok(source.includes(marker), `dashboard keeps ${marker}`);
  }
  assert.ok(!source.includes('weeklyChart'), 'charts stay removed');
});

test('estimate morph uses intrinsic mobile layout below the tablet breakpoint', () => {
  const css = readSource('src/styles.css');
  const start = css.indexOf('@media (max-width: 640px)');
  const mobile = css.slice(start, css.indexOf('@keyframes spin', start));
  assert.ok(start >= 0, 'narrow breakpoint exists');
  assert.ok(mobile.includes('height: auto'), 'mobile height stays intrinsic');
  assert.ok(mobile.includes('max-height: none'), 'mobile has no height cap');
  assert.ok(mobile.includes('overflow: visible'), 'mobile content is not clipped');
  assert.ok(!mobile.includes('position: fixed'), 'mobile does not use a viewport sheet');
  assert.ok(!mobile.includes('100dvh'), 'mobile does not depend on viewport geometry');
  assert.ok(!css.includes('@media (max-width: 480px)'), 'old narrow fix superseded');
  assert.ok(css.includes('.level-estimate-morph { position: absolute'), 'desktop anchoring intact');
  assert.ok(css.includes('.level-estimate-morph, .level-estimate-morph *, .level-estimate-detail, .level-estimate-detail-inner { transition: none !important; }'), 'reduced motion preserved');
});
