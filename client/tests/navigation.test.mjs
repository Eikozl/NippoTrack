// Navigation IA cleanup — Tags hidden, grouped destinations, skip link,
// mobile search entry. Static source assertions (same readSource pattern as
// levelEstimateControl.test.mjs); no DOM or servers required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

const html = () => readSource('index.html');

function navPages(source) {
  return [...source.matchAll(/data-page="([a-z-]+)"/g)].map((match) => match[1]);
}

test('Tags has no navigation entry (backend route stays intact)', () => {
  const pages = navPages(html());
  assert.ok(!pages.includes('tags'), 'tags button must not render in navigation');
  const main = readSource('src/main.js');
  assert.ok(main.includes("renderV2Page(container, 'tags')"), 'internal tags route must remain registered');
});

test('navigation renders grouped destinations in the approved order', () => {
  const source = html();
  const pages = navPages(source);
  assert.deepEqual(pages, [
    'dashboard', 'review', 'sessions', 'goals',
    'vocabulary', 'kanji', 'grammar', 'notes', 'content',
    'analyzer', 'statistics',
    'settings'
  ]);
  for (const group of ['Study', 'Library', 'Tools', 'System']) {
    assert.ok(source.includes(`data-i18n="${group}"`), `group label ${group} present`);
  }
  const order = ['Study', 'Library', 'Tools', 'System'].map((group) => source.indexOf(`data-i18n="${group}"`));
  assert.ok(order.every((position, index) => index === 0 || position > order[index - 1]), 'groups appear in Study/Library/Tools/System order');
  assert.ok(source.indexOf('data-page="review"') < source.indexOf('data-page="sessions"'), 'Review sits near Dashboard');
});

test('Content destination reads as Content Log', () => {
  assert.ok(html().includes('data-i18n="Content Log">Content Log<'), 'nav label is Content Log');
});

test('skip link targets the real main content area', () => {
  const source = html();
  assert.ok(source.includes('class="skip-link"'), 'skip link present');
  assert.ok(source.includes('href="#app-content"'), 'skip link targets #app-content');
  assert.ok(source.includes('id="app-content"'), 'main content anchor exists');
});

test('mobile header exposes a search entry with a collapsible bar', () => {
  const source = html();
  assert.ok(source.includes('id="mobile-search-button"'), 'mobile search button present');
  assert.ok(source.includes('id="mobile-search-bar"'), 'mobile search bar present');
  assert.ok(source.includes('id="mobile-search"'), 'mobile search input present');
  assert.ok(source.includes('id="mobile-search-results"'), 'mobile search results present');
  assert.ok(source.includes('aria-controls="mobile-search-bar"'), 'button controls the bar');
  assert.ok(source.includes('role="combobox"'), 'search inputs use combobox role');
  assert.ok(source.includes('role="listbox"'), 'results use listbox role');
});

test('drawer trigger exposes expanded state', () => {
  const source = html();
  assert.ok(source.includes('id="open-navigation"'), 'drawer trigger present');
  assert.ok(source.includes('aria-expanded="false" aria-controls="sidebar"'), 'trigger reports expanded state for the sidebar');
});

test('mobile header hides brand text on narrow widths, keeps every control', () => {
  const source = html();
  assert.ok(source.includes('hidden text-sm font-semibold text-ink sm:block'), 'brand text hidden below sm, shown above');
  for (const id of ['open-navigation', 'mobile-search-button', 'mobile-theme-toggle', 'mobile-account-button']) {
    assert.ok(source.includes(`id="${id}"`), `control ${id} preserved`);
  }
});
