// Navigation IA cleanup — Tags hidden, grouped destinations, skip link,
// mobile search entry, and Settings moved behind the account menu.
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
    'analyzer', 'immersion', 'reading', 'statistics'
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

test('mobile topbar carries controls, not brand text', () => {
  const source = html();
  const mobileHeader = source.slice(source.indexOf('<header class="sticky top-0'), source.indexOf('id="app-content"'));
  assert.ok(mobileHeader.length > 0, 'compact topbar located');
  assert.ok(!mobileHeader.includes('Japanese Learning Tracker'), 'no brand text in the compact topbar');
  for (const id of ['open-navigation', 'mobile-search-button', 'mobile-theme-toggle', 'mobile-account-button']) {
    assert.ok(source.includes(`id="${id}"`), `control ${id} preserved`);
  }
});

test('desktop sidebar branding remains', () => {
  const source = html();
  assert.ok(source.includes('id="brand-logo"'), 'sidebar brand logo preserved');
  assert.ok(source.includes('alt="NippoTrack"'), 'sidebar product name is NippoTrack');
  assert.ok(!source.includes('data-i18n="NippoTrack"'), 'no duplicated brand text beside the wordmark');
  assert.ok(!source.includes('JLT_logo-png.png'), 'legacy JLT mark removed from shell');
  assert.ok(!source.includes('/src/assets/'), 'no source-tree asset URL in shell (main.js sets the bundled wordmark at boot)');
});

test('Settings is reachable from the existing account trigger, not the sidebar', () => {
  const source = html();
  assert.doesNotMatch(source, /data-page="settings"/, 'standalone sidebar Settings removed');
  const main = readSource('src/main.js');
  assert.ok(main.includes("navigate('settings')"), 'account menu navigates to Settings');
  assert.ok(source.includes('id="account-button"') && source.includes('id="mobile-account-button"'), 'existing account triggers remain');
  assert.doesNotMatch(source, /sidebar[\s\S]{0,200}Account|Account[\s\S]{0,200}sidebar/i, 'no sidebar identity block added');
});
