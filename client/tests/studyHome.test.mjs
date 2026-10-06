// V5.6 Study Home — Study Now section. Static source assertions; no DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('dashboard fetches Study Now fail-open alongside existing signals', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('/api/dashboard/study-now'), 'new aggregation endpoint used');
  assert.ok(source.includes('.catch(() => null)'), 'fail-open preserved');
  assert.ok(source.includes('/api/dashboard?today='), 'existing dashboard still fetched');
  assert.ok(!source.includes("apiRequest('/api/review')"), 'dashboard never pulls the full due list; dues load on demand');
  assert.ok(!source.includes("metric('review', 'Due reviews'"), 'no duplicated due tile; Study Now owns dues');
  assert.ok(!source.includes("metric('today', 'Today'"), 'no duplicated today tile; Today’s Progress owns minutes');
});

test('Study Now renders explainable next action with CTA', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('function studyNowSection'), 'dedicated section');
  assert.ok(source.includes('Study now'), 'eyebrow labels the recommendation');
  assert.ok(source.includes('aria-label'), 'accessible section label');
  assert.ok(source.includes('button-primary'), 'primary CTA reuses existing style');
  assert.ok(source.includes('min-h-11'), 'touch target meets mobile minimum');
});

test('Study Now auto-starts due sessions instead of linking to setup', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes("primary.auto === 'due'"), 'review kind builds the queue itself');
  assert.ok(source.includes('Start now'), 'CTA names the action, not the module');
  assert.ok(source.includes('/api/review/due'), 'oldest-first due listing reused');
  assert.ok(source.includes('/api/review/sessions'), 'existing session endpoint reused — no new writes path');
  assert.ok(source.includes('jlt-study-now-queue'), 'same sessionStorage hand-off as Immersion');
  assert.ok(source.includes('from=study-now'), 'review knows the origin');
  assert.ok(source.includes('STUDY_NOW_SESSION_MAX'), 'bounded auto queue');
});

test('Study Now never blocks dashboard when payload is missing', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('studyNowSection(studyNow) ? [studyNowSection(studyNow)] : []'), 'null renders nothing');
});

test('dashboard header frames Study Home without breaking routes', () => {
  const source = readSource('src/pages/dashboard.js');
  assert.ok(source.includes('Study home'), 'study-home eyebrow');
  assert.ok(source.includes("title: 'Dashboard'"), 'stable title for existing tests/routes');
});

test('review shows collapsed why without disrupting speed', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('Why am I reviewing this?'), 'explainable reason present');
  assert.ok(source.includes('<details') || source.includes("'details'"), 'collapsed by default');
  assert.ok(source.includes('provenanceLine(item)'), 'uses true provenance, never fabricated');
});

test('review completion closes the loop to sessions', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('Log study session'), 'RETURN loop CTA');
  assert.ok(source.includes("href: '#sessions?new=1'"), 'opens the creation dialog, not just the list');
});

test('sessions auto-opens creation for log-now links', () => {
  const source = readSource('src/pages/sessions.js');
  assert.ok(source.includes("get('new') === '1'"), 'new=1 param detected');
  assert.ok(source.includes('openSessionDialog()'), 'creation dialog opens on arrival');
  assert.ok(source.includes("replaceState(null, '', '#sessions')"), 'param consumed so refresh lands on the list');
});

test('review resumes Study Now hand-offs straight into cards', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('jlt-study-now-queue'), 'study-now queue key consumed');
  assert.ok(source.includes('jlt-immersion-review-queue'), 'immersion hand-off still works');
  assert.ok(source.includes('Your due items are queued'), 'origin-aware banner copy');
});

test('reading empty state links to analyzer (cohesion)', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('Open Analyzer'), 'guided next step from empty library');
  assert.ok(source.includes("href: '#analyzer'"), 'reuses existing analyzer route');
});

test('community publish is limited to own reading texts', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('importedFromPublication'), 'import provenance read from text metadata');
  assert.ok(source.includes('Imported copies can’t be republished to Community.'), 'imported copies explain why publish is gone');
});

test('community re-import opens the existing copy', () => {
  const source = readSource('src/pages/community.js');
  assert.ok(source.includes('Already in your library'), 'duplicate import says so instead of silently duplicating');
});

test('encounter label uses learner wording', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(source.includes('Where you'), 'learner-friendly encounter header');
  assert.ok(!source.includes("text: 'Encounter Intelligence'"), 'jargon header removed');
  assert.ok(source.includes("text: 'Review schedule'"), 'schedule header without SRS jargon');
});

test('session and review verbs are consistent', () => {
  const sessions = readSource('src/pages/sessions.js');
  assert.ok(sessions.includes('Log a study session or adjust the current filters.'), 'sessions empty state uses Log');
  const immersion = readSource('src/pages/immersion.js');
  assert.ok(immersion.includes('Create review session'), 'immersion builds a review queue, not study time');
  assert.ok(!immersion.includes('Create study session'), 'old ambiguous label gone');
  const community = readSource('src/pages/community.js');
  assert.ok(!community.includes('`Ver más'), 'no mixed-language feed button');
});
