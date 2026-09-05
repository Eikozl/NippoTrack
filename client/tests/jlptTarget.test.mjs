import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  estimateTargetLine,
  isValidTargetLevel,
  targetContextLine,
  targetLevelOptions
} from '../src/jlptTarget.js';

const cumulativeN3 = { reviewed: 121, referenceTotal: 620 };

test('targetLevelOptions: no-target is first-class, bands follow', () => {
  const options = targetLevelOptions();
  assert.equal(options[0].label, 'No target selected');
  assert.deepEqual(options.slice(1).map((option) => option.value), ['N5', 'N4', 'N3', 'N2', 'N1']);
});

test('isValidTargetLevel: only null and exact N5-N1 pass', () => {
  assert.equal(isValidTargetLevel(null), true);
  assert.equal(isValidTargetLevel('N3'), true);
  assert.equal(isValidTargetLevel('n3'), false);
  assert.equal(isValidTargetLevel('N6'), false);
  assert.equal(isValidTargetLevel(''), false);
  assert.equal(isValidTargetLevel(3), false);
  assert.equal(isValidTargetLevel(undefined), false);
});

test('targetContextLine: highlights the correct cumulative band', () => {
  assert.equal(
    targetContextLine('N3', cumulativeN3),
    'Reference Kanji coverage toward your selected N3 study target: 121 / 620 reviewed'
  );
});

test('targetContextLine: no target yields the guidance state, never a band', () => {
  assert.equal(targetContextLine(null, cumulativeN3), null);
  assert.equal(targetContextLine('', cumulativeN3), null);
  assert.equal(targetContextLine(undefined, cumulativeN3), null);
  assert.equal(targetContextLine('N6', cumulativeN3), null);
});

test('estimateTargetLine: estimate below target stays neutral', () => {
  const line = estimateTargetLine('N4', 'N3');
  assert.equal(line, 'Estimated study band: N4 · Study target: N3');
  assert.doesNotMatch(line, /too easy|too hard|should|behind|ahead|recommend/i);
});

test('estimateTargetLine: estimate above target stays neutral', () => {
  const line = estimateTargetLine('N2', 'N3');
  assert.equal(line, 'Estimated study band: N2 · Study target: N3');
  assert.doesNotMatch(line, /too easy|too hard|should|behind|ahead|recommend/i);
});

test('estimateTargetLine: estimate equal to target stays neutral', () => {
  assert.equal(estimateTargetLine('N3', 'N3'), 'Estimated study band: N3 · Study target: N3');
});

test('estimateTargetLine: missing estimate never blocks the target', () => {
  assert.equal(
    estimateTargetLine(null, 'N3'),
    'Estimated study band: not enough evidence yet · Study target: N3'
  );
});

test('estimateTargetLine: no target yields no comparison line', () => {
  assert.equal(estimateTargetLine('N4', null), null);
  assert.equal(estimateTargetLine(null, null), null);
});

test('target copy: never confused with the current level', () => {
  const line = targetContextLine('N3', cumulativeN3);
  assert.doesNotMatch(line, /current level|your level is|you are/i);
  assert.ok(line.includes('study target'));
});

test('target selector: statistics panel keeps the qualified label and disambiguator', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'src/pages/statistics.js'), 'utf8');
  assert.ok(source.includes("'Target JLPT level'"), 'selector label stays qualified');
  assert.ok(source.includes('not your current level'), 'disambiguator travels with the selector');
  assert.doesNotMatch(source, /text:\s*'JLPT Level'/);
});
