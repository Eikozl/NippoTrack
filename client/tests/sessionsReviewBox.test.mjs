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
});

test('review completion anchors the day and surfaces counted time', () => {
  const source = readSource('src/pages/review.js');
  assert.ok(source.includes('/api/review/sessions/${sessionId}/complete'), 'finish posts to the complete endpoint');
  assert.ok(source.includes('today: localTodayKey()'), 'finish sends the browser-local day');
  assert.ok(source.includes('counted today'), 'complete screen surfaces the counted time');
  assert.ok(source.includes('formatDuration'), 'counted time uses the shared duration formatter');
});
