// Dashboard Active Goals preview + estimate viewport sheet.
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

test('preview stays compact and responsive', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('sm:grid-cols-2 xl:grid-cols-3'), 'stacks on mobile, grid on wider layouts');
  assert.ok(source.includes('break-words'), 'long titles wrap');
});

test('existing dashboard content still renders', () => {
  const source = readSource('src/pages/dashboard.js');
  for (const marker of ['recentSessions', 'activityCalendar', '#statistics', 'metric(']) {
    assert.ok(source.includes(marker), `dashboard keeps ${marker}`);
  }
  assert.ok(!source.includes('weeklyChart'), 'charts stay removed');
});

test('estimate morph uses a viewport sheet below the tablet breakpoint', () => {
  const css = readSource('src/styles.css');
  assert.ok(css.includes('@media (max-width: 640px)'), 'tablet-range containment');
  assert.ok(css.includes('left: 0.75rem'), 'left inset');
  assert.ok(css.includes('right: 0.75rem'), 'right inset');
  assert.ok(css.includes('top: 4.5rem'), 'top below the header region');
  assert.ok(css.includes('100dvh'), 'dvh-safe bottom geometry');
  assert.ok(css.includes('position: fixed'), 'trigger-relative placement overridden');
  assert.ok(!css.includes('@media (max-width: 480px)'), 'old narrow fix superseded');
  assert.ok(css.includes('.level-estimate-morph { position: absolute'), 'desktop anchoring intact');
  assert.ok(css.includes('.level-estimate-morph, .level-estimate-morph *, .level-estimate-detail, .level-estimate-detail-inner { transition: none !important; }'), 'reduced motion preserved');
});
