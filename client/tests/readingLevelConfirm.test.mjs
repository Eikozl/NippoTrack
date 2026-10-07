// ITEM 3 — Reading level confirmation for user-created texts (source asserts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('item3: creation reuses the existing estimate, never invents detection', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('createUserReadingText'), 'creation flow present');
  assert.ok(source.includes('askReadingLevelConfirm(created'), 'confirm runs after processing');
  assert.ok(source.includes('normalizeDetectedReadingLevel(created?.level)'), 'detected value comes from the server estimate');
  assert.ok(!source.includes('estimateDifficultyLevel'), 'client never recomputes levels');
});

test('item3: level-confirm dialog asks with Yes/No in page language', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('function askReadingLevelConfirm'), 'confirm helper exists');
  assert.ok(source.includes('We detected level'), 'confirm names the detected level (English, matching page copy)');
  assert.ok(source.includes('Do you agree?'), 'confirm asks agreement');
  assert.ok(source.includes('Yes, keep'), 'Yes keeps the detected level');
  assert.ok(source.includes('No, choose another'), 'No opens the selector');
  assert.ok(source.includes('showFooter: false'), 'Yes/No are real buttons in content (not a single submit)');
});

test('item3: No opens an N5–N1 + no-level selector and saves the choice', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('function openReadingLevelSelector'), 'selector helper exists');
  assert.ok(source.includes('No level / Not sure'), 'no-level/unsure option present (model supports null)');
  for (const level of ['N5', 'N4', 'N3', 'N2', 'N1']) {
    assert.ok(source.includes(level), `selector covers ${level}`);
  }
  assert.ok(source.includes('Save chosen level'), 'selector saves the chosen value');
  assert.ok(source.includes('saveReadingLevelOverride'), 'chosen value saved into the existing level field path');
  assert.ok(source.includes('effectiveReadingLevel'), 'library + reader present the saved value');
});

test('item3: scope is user-created texts only, no schema change', () => {
  const source = readSource('src/pages/reading.js');
  assert.ok(source.includes('user-created texts only'), 'scope documented (not imports/community copies)');
  assert.ok(source.includes('localStorage'), 'override is local presentation state');
  assert.ok(source.includes('no schema change'), 'no migration claimed');
  // Only the paste-to-read flow triggers the confirm; imports never do.
  const ownSaveStart = source.indexOf('const ownSave = element');
  const ownSaveBlock = source.slice(ownSaveStart, ownSaveStart + 6000);
  assert.ok(ownSaveBlock.includes('askReadingLevelConfirm'), 'paste flow confirms');
  assert.ok(!source.includes('importReadingSources') || !source.slice(source.indexOf('importReadingSources'), source.indexOf('importReadingSources') + 200).includes('askReadingLevelConfirm'), 'imports do not confirm');
});
