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
  // B.1: the shared identity builder (src/kanjiDetail.js) renders the
  // reference pill for both surfaces; entityPage consumes it via import.
  const shared = readSource('src/kanjiDetail.js');
  assert.ok(source.includes('kanjiDetail.js') || shared.includes('JLPT ${data.jlptLevel} (Reference)'), 'shared reference wording preserved');
  assert.ok(shared.includes('(Reference)'), 'Reference-vs-user labeling kept in the shared builder');
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
    'Tools', 'System', 'Skip to main content', 'View detailed analytics in Statistics',
    'Current week', 'From start date onward', 'From start date to deadline',
    'How this coverage is calculated',
    'Reference Kanji coverage only — not official JLPT exam readiness.'
  ]) {
    assert.ok(i18n.includes(`'${key}':`), `es translation for "${key}"`);
  }
});

test('Goal periods use clearer labels backed by real counting windows', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("label: 'Current week'"), 'weekly relabeled');
  assert.ok(source.includes("label: 'From start date onward'"), 'cumulative relabeled');
  assert.ok(source.includes("label: 'From start date to deadline'"), 'by_deadline relabeled');
  assert.ok(!source.includes("label: 'This week'"), 'old weekly label removed from goals');
  assert.ok(source.includes('Counts matching activity from the start of the current week.'), 'weekly helper');
  assert.ok(source.includes('Counts matching activity from the selected start date onward'), 'cumulative helper');
  assert.ok(source.includes('Counts matching activity between the start date and deadline.'), 'deadline helper');
  assert.ok(source.includes('dueHolder.hidden'), 'due date hidden for weekly goals');
});

test('Target Amount enforces whole numbers 1–999 without clamping', () => {
  const source = readSource('src/pages/v2Pages.js');
  assert.ok(source.includes("from '../goalValidation'"), 'client-side guard imported from the tested contract');
  assert.ok(source.includes('isValidTargetAmount(raw)'), 'submit rejects invalid amounts');
  const contract = readSource('src/goalValidation.js');
  assert.ok(contract.includes('Enter a whole number from 1 to 999.'), 'user-facing explanation');
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('inputmode'), 'field helper passes inputmode through');
});

test('Notes and Content Log hide manual vocabulary/kanji/grammar linking', () => {
  const source = readSource('src/pages/v2Pages.js');
  const notesBlock = source.slice(source.indexOf('notes: {'), source.indexOf('tags: {'));
  assert.ok(notesBlock.includes("linkGroups: ['sessions']"), 'notes keep session linking only');
  assert.ok(!notesBlock.includes('sharedLinkGroups'), 'notes no longer use the full linking set');
  const contentBlock = source.slice(source.indexOf('content: {'), source.indexOf('notes: {'));
  assert.ok(!contentBlock.includes('linkGroups'), 'content log exposes no Links button');
  const tagsBlock = source.slice(source.indexOf('tags: {'));
  assert.ok(tagsBlock.includes('linkGroups: sharedLinkGroups'), 'tags backend relations preserved');
  const server = readSource('../server/src/controllers/v2Controller.js');
  assert.ok(server.includes('contentLinks') && server.includes('noteLinks'), 'backend link handlers preserved');
});

test('Statistics collapses the long explanation but keeps the honesty line', () => {
  const source = readSource('src/pages/statistics.js');
  assert.ok(source.includes("element('details'"), 'native disclosure used');
  assert.ok(source.includes('How this coverage is calculated'), 'concise summary label');
  assert.ok(source.includes('Reference Kanji coverage only — not official JLPT exam readiness.'), 'permanent line stays visible');
  assert.ok(source.includes('they are not pass/fail certification'), 'grades boundary preserved inside details');
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.jlpt-progress-details'), 'details styled for both themes');
});

test('Settings uses the desktop canvas without stretching edge to edge', () => {
  const source = readSource('src/pages/settings.js');
  assert.ok(source.includes('max-w-5xl'), 'cards widen to ~1024px');
  assert.ok(source.includes('settings-layout'), 'four-section layout owns the canvas');
});

test('Analyzer containers shrink instead of overflowing narrow screens', () => {
  const source = readSource('src/pages/analyzer.js');
  assert.ok(source.includes('grid min-w-0'), 'result grids allow shrinkage');
  assert.ok(source.includes('surface min-w-0'), 'cards allow shrinkage');
  assert.ok(source.includes('break-words'), 'long text wraps inside cards');
});
