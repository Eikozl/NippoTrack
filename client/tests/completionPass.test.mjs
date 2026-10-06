// V5.6 Completion Pass — source assertions for Study Home depth, real review
// context, where-seen sections and the Retry/Clear merge. No DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('dashboard hierarchy is action, today, continue, then snapshot', () => {
  const source = readSource('src/pages/dashboard.js');
  const order = ['studyNowSection(studyNow)', 'todayProgressSection(studyNow)', 'continueSection(studyNow)', 'dashboard-metrics'];
  const positions = order.map((marker) => source.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0), 'all sections present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'action → today → continue → metrics');
});

test('today progress uses real numbers and hides without payload', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('function todayProgressSection'), 'dedicated section');
  assert.ok(source.includes('studyNow?.todayProgress'), 'reads the aggregation payload');
  assert.ok(source.includes('reviews done'), 'learner wording with counts');
  assert.ok(source.includes('No reviews due'), 'honest zero state, no fake 0/30');
  assert.ok(source.includes('return null'), 'fail-open hide');
});

test('continue shows only genuinely resumable work', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('function continueSection'), 'dedicated section');
  assert.ok(source.includes('#reading?id='), 'reading deep-link with text id');
  assert.ok(source.includes('#review?retake='), 'review deep-link with session id');
  assert.ok(source.includes('remaining'), 'unfinished sessions carry remaining counts');
  assert.ok(source.includes('if (!cards.length) return null'), 'nothing resumable renders nothing');
});

test('auto-session merges batched context with zero extra requests', () => {
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(dashboard.includes('applySessionContext(picked'), 'due flow merges creation context');
  const review = readSource('src/pages/review.js');
  assert.ok(review.includes('applySessionContext(picked, session)'), 'manual flow merges creation context');
  assert.ok(!review.includes('/api/review/context'), 'no per-card context endpoint exists');
});

test('review context is real, collapsed and never fabricated', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes("text: 'Context'"), 'collapsed Context block');
  assert.ok(source.includes('item.context'), 'reads batched queue context');
  assert.ok(source.includes('You saw this in:'), 'source sentence when present');
  assert.ok(source.includes('Seen ${'), 'encounter counts when present');
  assert.ok(source.includes('Last time: Again'), 'last-failed wording without the word failed');
  assert.ok(source.includes('function daysAgoText'), 'relative dates computed, invalid hidden');
});

test('review resumes unfinished sessions from continue links', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('tryResumeRetake'), 'retake deep-link handler');
  assert.ok(source.includes("get('retake')"), 'reads the session id param');
  assert.ok(source.includes('/api/review/sessions/${id}/items'), 'reuses the persisted queue endpoint');
});

test('vocabulary and grammar share one where-seen experience', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(source.includes('function fillWhereSeen'), 'single shared filler');
  assert.ok(source.includes('/encounters'), 'both types fetch encounters endpoints');
  assert.ok(source.includes("text: 'Where you"), 'learner header without jargon');
  assert.ok(source.includes('slot.remove()'), 'empty or failed sections hide, never hollow');
  assert.ok(!source.includes("text: 'SRS Review'"), 'no SRS jargon on any entity');
  assert.ok(!source.includes("text: 'Encounter Intelligence'"), 'no intelligence jargon anywhere');
});

test('handwriting has one reset control, not two', () => {
  const source = readSource('src/kanjiWriting.js');
  assert.ok(source.includes("text: 'Clear'"), 'Clear remains with announcement');
  assert.ok(!source.includes("text: 'Retry'"), 'duplicate Retry removed');
  assert.ok(source.includes("text: 'Watch order'") && source.includes("text: 'Done'"), 'watch and done intact');
});
