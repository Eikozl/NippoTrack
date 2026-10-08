// ITEM 2 — Review audio cooldown (silent) + no-voices message kept + speaker glyphs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('item2: Review speak has a rapid-press cooldown that stays silent', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('SPEAK_COOLDOWN_MS'), 'cooldown window constant present');
  assert.ok(source.includes('lastSpeakAt'), 'cooldown timestamp tracked');
  assert.ok(source.includes('isRapidPress'), 'rapid press flagged per call');
  assert.ok(source.includes('Date.now()'), 'cooldown uses wall clock');
  // Overlapping/superseded utterances stay silent (no red toast); speaks still
  // coalesce via the pending timer + cancel path (no early speak block).
  assert.ok(source.includes('if (!wasCurrent) return;'), 'superseded utterance errors stay silent');
  assert.ok(source.includes('if (isRapidPress) return;'), 'cooldown suppresses duplicate error toasts');
  assert.ok(source.includes('function speakDisplay'), 'speaker entry preserved');
  assert.ok(!source.includes('if (now - lastSpeakAt < SPEAK_COOLDOWN_MS) return;'), 'speaks are not blocked (coalesce preserved)');
});

test('item2: genuine no-voice guidance is kept (not silenced by cooldown)', () => {
  const review = readSource('src/pages/review.js');
  assert.ok(review.includes('japaneseVoiceGuidance()'), 'guidance call kept');
  assert.ok(
    review.includes('Audio playback is unavailable on this device right now.'),
    'unavailable toast kept for genuine problems'
  );
  const speech = readSource('src/speech.js');
  assert.ok(speech.includes("reason: 'no-voice'"), 'speech verdict still reports no-voice');
  assert.ok(speech.includes('No Japanese voice'), 'speech guidance kept');
});

test('item2: Community example Play uses the speaker glyph, no emoji', () => {
  const feed = readSource('src/pages/communityFeed.js');
  assert.ok(feed.includes("icon('volume'"), 'example Play uses icons.js volume glyph');
  assert.ok(!feed.includes('🔊 Play'), 'emoji play pattern removed from Community');
  assert.ok(feed.includes('Play example aloud'), 'play affordance stays labeled');
  assert.ok(feed.includes('COMMUNITY_PLAY_COOLDOWN_MS'), 'community single-play has cooldown');
  assert.ok(feed.includes('isRapid'), 'community cooldown suppresses duplicate toasts (speaks still run)');
});

test('item2: Decks-hub play/play-all use volume glyph, stop kept, no triangle', () => {
  const hub = readSource('src/pages/community.js');
  assert.ok(hub.includes("icon('volume'"), 'hub play uses the speaker glyph');
  assert.ok(hub.includes("icon('stop'"), 'stop behavior kept');
  assert.ok(hub.includes('DECKS_PLAY_COOLDOWN_MS'), 'hub queue has cooldown');
  assert.ok(hub.includes('isRapidQueue'), 'hub cooldown suppresses duplicate toasts (queue still restarts)');
  assert.ok(!hub.includes('🔊'), 'no emoji speaker in the hub');
  assert.ok(!hub.includes('▶'), 'no triangle play affordance in the hub');
  const feed = readSource('src/pages/communityFeed.js');
  assert.ok(!feed.includes('▶'), 'no triangle play affordance in feed surfaces');
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes('Volume2'), 'lucide speaker glyph imported');
  assert.ok(icons.includes('volume:'), 'icons.js serves volume');
});
