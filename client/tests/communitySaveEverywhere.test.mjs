// ITEM 1 — Save-from-Community confirmation everywhere (source asserts, no DOM).
// Audits EVERY save entry point reachable from Community and proves the old
// example-post gap now confirms like all other saves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('item1: example Save-as-vocab now confirms with display + meaning', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function exampleActions'), 'example renderer exists');
  assert.ok(source.includes('Save example as vocabulary') || source.includes('bookmarkSaveButton'), 'example save affordance present as bookmark icon');
  // The saveable branch must wrap the POST in confirmDialog (same pattern as
  // saveEntityButton: display + meaning, Save + pending).
  const exampleStart = source.indexOf('function exampleActions');
  const exampleEnd = source.indexOf('function linkedBox');
  const block = source.slice(exampleStart, exampleEnd);
  assert.ok(block.includes('confirmDialog({'), 'example save wrapped in confirmDialog');
  assert.ok(block.includes('Save "'), 'example confirm names what will be saved');
  assert.ok(block.includes('to your library?'), 'example confirm asks to save');
  assert.ok(block.includes('/api/vocabulary'), 'example save reuses the vocabulary endpoint');
  assert.ok(block.includes("confirmLabel: 'Save'"), 'example confirm uses Save');
  assert.ok(block.includes("pendingLabel: 'Saving…'"), 'example confirm has pending state');
});

test('item1: linkedBox single saves confirm (share_vocab/kanji/grammar)', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function saveEntityButton'), 'shared save entry present');
  assert.ok(source.includes('entityCreateBody(post.entityType'), 'honesty gates unchanged');
  const start = source.indexOf('function saveEntityButton');
  const block = source.slice(start, start + 3000);
  assert.ok(block.includes('confirmDialog({'), 'single save confirms first');
  assert.ok(block.includes('Save "'), 'single confirm names the display');
  assert.ok(block.includes('review queue'), 'single confirm explains the queue');
});

test('item1: deck viewer per-item Save and Save-all confirm with counts', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('Save all ${items.length} items to your library'), 'Save-all bookmark aria-label names the count');
  assert.ok(source.includes('Save ${items.length} items to your library?'), 'Save-all confirms with count');
  assert.ok(source.includes("confirmLabel: 'Save all'"), 'Save-all confirm labeled');
  assert.ok(source.includes('Save "${label}" to your library?'), 'per-item confirm names the item');
});

test('item1: Decks hub saves are explicit, disclosed, and counted (audit)', () => {
  const hub = readSource('src/pages/community.js');
  assert.ok(hub.includes('function itemsDialog'), 'Decks hub dialog exists');
  // Hub saves exist by product decision (Start Review save-then-queue):
  // they fire only behind the explicit Start Review action whose label
  // discloses saving, with per-outcome counts surfaced afterwards.
  assert.ok(hub.includes("'/api/vocabulary', { method: 'POST'"), 'hub save path present (save-then-queue)');
  assert.ok(hub.includes('Save deck items and start a review session'), 'Start Review discloses saving');
  assert.ok(hub.includes('savedCount') && hub.includes('alreadyCount') && hub.includes('skippedCount'), 'save/already/skipped counts tracked');
  assert.ok(hub.includes('already in library') && hub.includes('starting review with'), 'counts surfaced to the user');
  assert.ok(hub.includes('/api/vocabulary/options'), 'hub picker search stays read-only (not a save)');
  assert.ok(hub.includes("icon('volume'"), 'hub play uses the speaker glyph');
});

test('item1: Discover learningRow navigates only (no direct save to miss)', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function learningRow'), 'learning rows exist');
  const start = source.indexOf('function learningRow');
  const block = source.slice(start, start + 4000);
  assert.ok(block.includes('openPostDialog(hit.postId'), 'post hit opens the source post dialog');
  assert.ok(block.includes('openDeckViewer(hit.deckId'), 'deck hit opens the source deck viewer');
  assert.ok(!block.includes('/api/vocabulary'), 'learningRow has no direct save POST');
  assert.ok(!block.includes('confirmDialog'), 'learningRow needs no own confirm (destinations confirm)');
});
