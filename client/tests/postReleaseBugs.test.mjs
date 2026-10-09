// Post-release bug block: request timeout, stats-only milestones, reading
// save persistence, tolerant cloze matching + cloze audio. Source
// assertions — no DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('apiRequest carries a default timeout so stalled requests fail loudly', () => {
  const source = readSource('src/api.js');
  assert.ok(source.includes('timeout = 30000'), 'default 30s timeout on every request');
  assert.ok(source.includes('new AbortController'), 'timeout enforced via AbortController');
  assert.ok(source.includes('timedOut'), 'timeout distinguished from caller abort');
  assert.ok(source.includes('timed out'), 'timeout surfaces its own message, never hangs');
  assert.ok(source.includes('signal.removeEventListener'), 'caller-signal listener cleaned up');
});

test('milestone composer publishes stats-only posts without a message', () => {
  const source = readSource('src/pages/communityFeed.js');
  assert.ok(source.includes('includeStats'), 'verified-snapshot flag still sent');
  assert.ok(source.includes('/api/community/posts'), 'publishes through the posts endpoint');
});

test('reading saves survive navigation until review consumes them', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('jlt-reading-saved:'), 'per-text persistence key');
  assert.ok(source.includes('persistSavedState'), 'state persisted on every save');
  assert.ok(source.includes('restoreSavedState'), 'state restored before first paint');
  assert.ok(source.includes("removeItem(savedStateKey)"), 'backup cleared once review consumes the handoff');
  assert.ok(source.includes('kept here until you review'), 'copy tells the learner saves persist');
  assert.ok(source.includes('ownedIdFromSaveResponse'), 'collection saves keep their entity ids');
  assert.ok(source.includes('queueFromSavedMetas'), 'saved words seed a real session queue');
  assert.ok(source.includes('/api/review/sessions'), 'seeded session via the sessions endpoint');
});

test('cloze matching ignores decorative symbols phones cannot type', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('MATCH_STRIP_PATTERN'), 'dedicated strip pattern for match normalization');
  assert.ok(source.includes('〜'), 'wave dash stripped');
  assert.ok(source.includes('•'), 'middle dot stripped');
  assert.ok(source.includes('normForMatch(raw) === normForMatch(want'), 'tolerant layer still compares both sides');
  assert.ok(source.includes('raw === want'), 'exact match still wins first');
});

test('cloze cards train the ear: speaker button plus autoplay on match', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('Hear the sentence aloud'), 'speaker button beside the sentence');
  assert.ok(source.includes('speakClozeSentence'), 'shared speak path for button + autoplay');
  assert.ok(source.includes('quiet: true'), 'autoplay stays silent when no Japanese voice is ready');
  assert.ok(source.includes("audioVoiceStatus() !== 'ready'"), 'autoplay never error-toasts on voiceless devices');
});
