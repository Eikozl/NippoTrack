// v5.1-F closure — regression guards for issues actually fixed in this phase.
// Static source assertions; no DOM or servers required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('entity filters stay single-column through small tablets (F R1)', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(!source.includes('sm:grid-cols-[minmax(14rem,1fr)_10rem_11rem]'), 'three-column filter must not trigger at 640px');
  assert.ok(source.includes('md:grid-cols-[minmax(14rem,1fr)_10rem_11rem]'), 'three-column filter waits for 768px');
});

test('dialog footer wraps long translated labels (F R2)', () => {
  const source = readSource('src/ui.js');
  assert.ok(source.includes('dialog-footer sticky bottom-0 flex flex-wrap justify-end'), 'footer wraps instead of overflowing');
});

test('global search options stay out of tab order (F K1)', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes("role: 'option', id, tabindex: '-1'"), 'options reachable via arrows, not Tab');
});

test('account menu closes on focus-out and supports arrow keys (F K2)', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes("menu.addEventListener('focusout'"), 'tab-away closes the menu');
  // Deferred close: sync relatedTarget is unreliable (often null) on touch
  // taps and would hide the menu mid-tap, swallowing it. The check re-runs
  // after the tap completes against the live focused element.
  assert.ok(source.includes('requestAnimationFrame'), 'focus-out close deferred past tap completion');
  assert.ok(source.includes('document.activeElement'), 'close decision re-checked against real focus');
  assert.ok(source.includes('menu.contains(active)'), 'focus inside the menu does not close it');
  assert.ok(!source.includes('.contains(event.relatedTarget)'), 'no sync relatedTarget close');
  assert.ok(source.includes("event.key === 'ArrowUp'"), 'ArrowUp moves through menu items');
  assert.ok(source.includes("event.key === 'Home'"), 'Home/End supported in menu');
});

test('review keeps exactly one h1 (F S1)', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(!source.includes("element('h1', { className: 'mt-2 text-2xl"), 'intro block demoted; pageHeader owns the landing h1');
  assert.ok(source.includes("element('h2', { className: 'mt-2 text-2xl"), 'intro heading is now h2');
  assert.ok(source.includes("text: 'Want to review your JLPT study?'"), 'intro copy preserved');
});

test('goals/content/notes/tags search has an accessible name (F S2)', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("'aria-label': `Search ${config.title}`"), 'search input labeled like entity filters');
});

test('streak and calendar day cells expose their labels (F S3)', () => {
  const main = readSource('src/main.js');
  assert.ok(main.includes("attrs: { role: 'img', 'aria-label': day.stateLabel }"), 'sidebar streak cells carry img role');
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(dashboard.includes("attrs: { role: 'img', title:"), 'calendar cells carry img role');
});

test('kanji glyph panel is a group, not an image (F S4)', () => {
  const source = readSource('src/kanjiDetail.js');
  assert.ok(source.includes("attrs: { role: 'group', 'aria-label': isOwned"), 'Replay button no longer nested inside role=img');
  assert.ok(!source.includes("attrs: { role: 'img', 'aria-label': isOwned"), 'old img role gone');
});

test('language submenu uses menu semantics (F S5)', () => {
  const source = readSource('src/main.js');
  assert.ok(source.includes("attrs: { id: languagePanelId, role: 'menu', 'aria-label': 'Language options'"), 'submenu panel is a menu');
});

test('locked kanji JLPT stays focusable without trapping (F S6)', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(!source.includes('field.tabIndex = locked ? -1 : 0'), 'locked field no longer leaves the tab order');
  assert.ok(source.includes('field.tabIndex = 0;'), 'locked field stays keyboard-focusable');
  assert.ok(source.includes("event.key === 'Tab' || event.key === 'Escape'"), 'Tab/Escape never swallowed by the lock guard');
});

test('grammar reference matches are plain buttons in a group (F S7)', () => {
  const source = readSource('src/grammarReferenceAutofill.js');
  assert.ok(source.includes("attrs: { role: 'group', 'aria-label': 'Grammar reference matches' }"), 'results use group semantics');
  assert.ok(!source.includes("role: 'option'"), 'no listbox contract without listbox keyboard');
});

test('shell references only servable asset URLs (F correctness)', () => {
  const html = readSource('index.html');
  assert.ok(!html.includes('/src/assets/'), 'no source-tree asset URL survives in the shell');
  assert.ok(html.includes('href="/favicon.png"'), 'favicon resolves from the public root in dist');
});
