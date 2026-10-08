// v6.1 — bookmark saves + text actions + immersion history parity (source asserts, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('v6.1 batch1: bookmark glyph served from icons.js lucide set', () => {
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes('Bookmark'), 'lucide Bookmark imported');
  assert.ok(icons.includes('bookmark:'), 'icons.js serves a bookmark glyph');
  assert.ok(icons.includes('bookmarkSaved'), 'saved-state glyph served (BookMarked)');
  assert.ok(icons.includes('BookMarked'), 'saved glyph reuses lucide set, no inline SVG');
});

test('v6.1 batch1: every Community save is a bookmark icon button', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('function bookmarkSaveButton'), 'shared bookmark helper exists');
  assert.ok(source.includes("icon('bookmark'") || source.includes("glyph"), 'helper renders the bookmark glyph');
  assert.ok(source.includes('bookmarkSaved'), 'saved state uses the saved glyph');
  assert.ok(source.includes('fill-current'), 'saved state filled feel');
  assert.ok(source.includes('min-h-11') && source.includes('min-w-11'), 'icon-only saves keep 44px touch targets');
  assert.ok(source.includes('icon-button'), 'saves reuse the existing icon-button primitive (focus-visible ring, keyboard reachable real buttons)');
  assert.ok(!source.includes("text: 'Save to library'"), 'no text Save button remains on shared boxes');
  assert.ok(!source.includes("text: 'Save as vocab'"), 'no text Save-as-vocab remains');
  assert.ok(!source.includes("'Saved ✓'"), 'no text Saved-check remains (saved is now the filled bookmark glyph)');
  assert.ok(!source.includes("text: `Save all"), 'no text Save-all remains (aria-label carries the count)');
});

test('v6.1 batch1: bookmark saves keep confirm + honesty + aria-labels + saved state', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('confirmDialog({'), 'confirm-then-save kept');
  assert.ok(source.includes('Save "'), 'confirms still name what will be saved');
  assert.ok(source.includes('pendingLabel'), 'pending state kept');
  assert.ok(source.includes('No dictionary meaning available'), 'honest disabled tooltip kept');
  assert.ok(source.includes('Save unavailable'), 'disabled aria-label kept');
  assert.ok(source.includes('Save ${snapshot.display} to library'), 'single-save aria-label kept');
  assert.ok(source.includes('Save example as vocabulary'), 'example aria-label kept');
  assert.ok(source.includes('Save all ${items.length} items to your library'), 'Save-all aria-label keeps the count');
  assert.ok(source.includes('Save ${label} to library'), 'per-item aria-label kept');
  assert.ok(source.includes('Saved ${label}'), 'saved aria-label kept');
  assert.ok(source.includes('Already saved'), 'saved tooltip kept');
  assert.ok(source.includes("title: `Save ${label} to library`") || source.includes('title:'), 'enabled saves carry a title tooltip');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML in save rendering');
});

test('v6.1 batch2a: Reply and Report are plain text buttons, Edit/Delete untouched', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('COMMENT_TEXT_ACTION_CLASS'), 'shared text-action class exists');
  assert.ok(source.includes('commentTextAction'), 'shared text-action helper exists');
  assert.ok(source.includes('text-muted'), 'minimalist muted text');
  assert.ok(source.includes('hover:underline'), 'hover underline minimalism');
  assert.ok(source.includes("aria-label': 'Report reply'") || source.includes("'Report reply'"), 'reply Report aria-label preserved');
  assert.ok(source.includes("'Report comment'"), 'top-level Report aria-label preserved');
  assert.ok(source.includes('Reply to ${authorName}'), 'Reply aria-label preserved');
  // Reply/Report must NOT use the bordered button primitives anymore.
  const replyReportSlice = source.slice(source.indexOf('BATCH 2(a)'), source.indexOf('BATCH 2(a)') + 6000);
  assert.ok(!replyReportSlice.includes('button-secondary'), 'Reply/Report helper region uses no bordered buttons');
  // Edit/Delete stay exactly as they were (bordered) — untouched per spec.
  assert.ok(source.includes("text: 'Edit'"), 'Edit affordances kept');
  assert.ok(source.includes('icon-button--danger'), 'Delete affordances kept as danger icon buttons');
  assert.ok(source.includes("aria-label': 'Edit reply'") || source.includes("'Edit reply'"), 'Edit reply label kept');
  assert.ok(source.includes("'Delete reply'"), 'Delete reply label kept');
  assert.ok(source.includes("'Edit comment'"), 'Edit comment label kept');
  assert.ok(source.includes("'Delete comment'"), 'Delete comment label kept');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML in comment rendering');
});

test('v6.1 batch2b: immersion history has item preview + reload as borderless text', () => {
  const source = readSource('src/pages/immersion.js');
  assert.ok(source.includes('Immersion history'), 'history section kept');
  assert.ok(source.includes('Reload'), 'reload affordance present');
  assert.ok(source.includes('Reload immersion history'), 'reload aria-label present');
  assert.ok(source.includes('Refreshing'), 'reload gives feedback then reloads');
  assert.ok(source.includes('loadHistory()'), 'reload re-runs the existing listImmersionHistory loader');
  assert.ok(source.includes('<details') || source.includes("'details'") || source.includes('"details"') || source.includes("element('details'"), 'item preview uses details disclosure');
  assert.ok(source.includes('Preview immersion session'), 'preview aria-label present');
  assert.ok(source.includes('Estimated level:') || source.includes('levelText'), 'preview presents the backend level decision');
  assert.ok(source.includes('vocabulary ·'), 'preview presents backend counts');
  assert.ok(!source.includes('source_text') || source.includes('never fabricated') || source.includes('MISSING'), 'no invented source-text preview (honest gap documented)');
  assert.ok(source.includes('hover:underline'), 'history reload follows the same borderless text minimalism');
  assert.ok(!source.includes('innerHTML'), 'no innerHTML in history rendering');
});

test('v6.1 batch2b/c GAP: immersion deletes are MISSING (no endpoint, never faked)', () => {
  const client = readSource('src/pages/immersion.js');
  const routes = readFileSync(join(root, '../server/src/routes/immersion.js'), 'utf8');
  // Client must NOT invent delete endpoints.
  assert.ok(!client.includes('/api/immersion/sessions'), 'no invented per-session DELETE path');
  assert.ok(!client.includes("method: 'DELETE'"), 'no DELETE issued from the immersion page');
  assert.ok(!client.includes("icon('trash'"), 'no per-session trash rendered (would imply a working delete)');
  assert.ok(!client.includes('Clear all immersion') && !client.includes('Clear immersion history'), 'no clear-all rendered (would imply a working delete)');
  // Server contract proves the gap: only analyze + create-session + history exist.
  assert.ok(routes.includes("router.post('/analyze'"), 'analyze route exists');
  assert.ok(routes.includes("router.post('/create-session'"), 'create-session route exists');
  assert.ok(routes.includes("router.get('/history'"), 'history route exists');
  assert.ok(!routes.includes('delete') && !routes.includes('DELETE'), 'no DELETE route exists for any immersion session type');
});

test('v6.1 batch2c reference: Review per-session trash pattern reused (glyph + confirm flow)', () => {
  const review = readSource('src/pages/review.js');
  assert.ok(review.includes("icon('trash'"), 'Review per-session trash uses the lucide trash glyph');
  assert.ok(review.includes('confirmDialog'), 'Review trash confirms first');
  assert.ok(review.includes('/api/review/sessions/${session.id}'), 'Review trash reuses the existing single-delete endpoint');
  assert.ok(review.includes('/api/review/sessions'), 'Review clear-all reuses the existing endpoint');
  const immersion = readSource('src/pages/immersion.js');
  assert.ok(!immersion.includes("icon('trash'"), 'immersion adds no divergent trash glyph (gap, not a second pattern)');
});
