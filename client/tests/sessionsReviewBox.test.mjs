import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('sessions preview labels linked content as Content linked', () => {
  const source = readSource('src/pages/sessions.js');
  assert.ok(source.includes("relatedList('Content linked'"), 'linked content box uses the Content linked label');
  assert.ok(!source.includes("relatedList('Stories'"), 'no Stories label remains in the preview');
});

test('sessions page shows a Reviewed today box fed by graded-today', () => {
  const source = readSource('src/pages/sessions.js');
  assert.ok(source.includes('/api/review/graded-today'), 'sessions list fetches the graded-today endpoint');
  assert.ok(source.includes('Reviewed today'), 'sessions list renders the Reviewed today box');
  assert.ok(source.includes('countByResult'), 'box summarizes Good/Hard/Again counts');
  assert.ok(source.includes("element('details'") && source.includes("element('summary'"), 'box collapses with details/summary');
});

test('session detail shows reviewed groups with each review result', () => {
  const source = readSource('src/pages/sessions.js');
  assert.ok(source.includes('graded-today${queryString({ today: day })}') || source.includes('/api/review/graded-today'), 'detail fetches graded items for the session date');
  assert.ok(source.includes('reviewedGroups'), 'detail groups reviewed items by type');
  assert.ok(source.includes('`reviewed`') || source.includes(' reviewed`'), 'reviewed groups carry a reviewed label');
  assert.ok(source.includes('(item) => item.result'), 'each reviewed item surfaces its Good/Hard/Again result');
});

test('review completion relies on server timestamps, not client day', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('/api/review/sessions/${sessionId}/complete'), 'finish posts to the complete endpoint');
  assert.ok(!source.includes('localTodayKey'), 'no client-day parameter: completion day derives from the completed session');
  assert.ok(source.includes('counted today'), 'complete screen surfaces the counted time');
  assert.ok(source.includes('formatDuration'), 'counted time uses the shared duration formatter');
});
