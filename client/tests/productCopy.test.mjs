// Pass 1 product-copy cleanup — Goals labels, self-reported status, JLPT tag,
// encounter honesty, Analyzer boundary, Content Log, minor fixes.
// Static source assertions; no DOM or servers required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('Goals measure labels are countable and Kanji stays invariant', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("label: 'New vocabulary entries'"), 'vocabulary measure label');
  assert.ok(source.includes("label: 'New kanji'"), 'kanji measure label');
  assert.ok(source.includes("label: 'New grammar entries'"), 'grammar measure label');
  assert.ok(!source.includes('New Kanjis'), 'never write "Kanjis"');
  assert.ok(!source.includes('Grammar Refinement'), 'refinement label removed');
});

test('Goals per-goal JLPT filter cannot be confused with the global target', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("label: 'Limit counting to JLPT level'"), 'filter renamed');
  assert.ok(!source.includes('Only count this JLPT level'), 'old label removed');
  assert.ok(source.includes('Does not change the Target JLPT level in Statistics.'), 'cross-hint present');
  assert.ok(source.includes('minutes for Study Minutes, entries otherwise'), 'target amount unit follows the measure');
});

test('completed Goals render a restrained pill, not plain muted text', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes('goal-complete'), 'Complete pill class used');
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.goal-complete'), 'pill styled without gamification');
});

test('owned statuses are marked self-reported where set and viewed', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(source.includes('Your personal status label — not review-verified.'), 'form helper on status fields');
  assert.ok(source.includes("text: 'Status (self-reported)'"), 'detail rows qualified');
  assert.ok(source.includes("title: 'Self-reported status'"), 'pills carry tooltip');
  for (const value of ['New', 'Learning', 'Familiar', 'Mastered']) {
    assert.ok(source.includes(value), `status value ${value} preserved`);
  }
});

test('owned JLPT metadata reads as a personal tag, reference data untouched', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(source.includes("label: 'JLPT tag'"), 'owned field renamed');
  assert.ok(source.includes('Your label for filtering — not official reference data.'), 'owned helper present');
  assert.ok(source.includes('JLPT ${refJlpt} (Reference)'), 'shared reference wording preserved');
  const reference = readSource('src/pages/kanjiReference.js');
  assert.ok(reference.includes('not an official syllabus'), 'provenance semantics intact');
});

test('encounter surface states exposure-only semantics', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(source.includes('exposure only, not review evidence'), 'encounter subtitle present');
});

test('Analyzer header states the non-inference boundary', () => {
  const source = readSource('src/pages/analyzer.js');
  assert.ok(source.includes('Does not estimate your level or prove knowledge.'), 'honesty boundary near the top');
  assert.ok(source.includes('not a text level, not a proficiency estimate'), 'distribution disclaimer intact');
});

test('Content Log naming and Sessions boundary', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("title: 'Content Log'"), 'page concept renamed');
  assert.ok(source.includes('Sessions record focused study time.'), 'Sessions/Content Log split explained');
  const sessions = readSource('src/pages/sessions.js');
  assert.ok(sessions.includes('For a media diary, use Content Log.'), 'resource field points at Content Log');
  const icons = readSource('src/icons.js');
  assert.ok(icons.includes("'content log': 'content'"), 'page header icon still resolves');
});

test('minor copy fixes applied without broad rewrites', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("label: 'Japanese question'"), 'category label spaced');
  assert.ok(source.includes("value: 'JapaneseQuestion'"), 'stored value unchanged');
});

test('Spanish translations cover the new copy', () => {
  const i18n = readSource('src/i18n.js');
  for (const key of [
    'Content Log', 'New vocabulary entries', 'New kanji', 'New grammar entries',
    'Limit counting to JLPT level', 'JLPT tag', 'Self-reported status',
    'Status (self-reported)', 'Japanese question', 'Complete', 'Study', 'Library',
    'Tools', 'System', 'Skip to main content', 'View detailed analytics in Statistics'
  ]) {
    assert.ok(i18n.includes(`'${key}':`), `es translation for "${key}"`);
  }
});
