// v6.1 decorative eyebrows retired — static source assertions, no DOM needed.
// pageHeader() keeps accepting the param (call-site compat) but never renders it;
// page modules dropped their decorative descriptors; functional labels stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

test('pageHeader accepts the eyebrow param but never renders it', () => {
  const source = readSource('src/ui.js');
  assert.ok(source.includes('eyebrow: _eyebrow'), 'param still accepted for call-site compat');
  assert.ok(!source.includes("className: 'eyebrow'"), 'no eyebrow element in pageHeader output');
  assert.ok(source.includes("title: 'Dashboard'") === false, 'no page-specific content baked into the helper');
});

test('decorative page-header descriptors are gone from page modules', () => {
  for (const path of [
    'src/pages/entityPage.js',
    'src/pages/v2Pages.js',
    'src/pages/dashboard.js',
    'src/pages/review.js',
    'src/pages/sessions.js',
    'src/pages/analyzer.js',
    'src/pages/immersion.js',
    'src/pages/community.js',
    'src/pages/settings.js',
    'src/pages/statistics.js',
    'src/pages/reading.js',
    'src/pages/kanjiReference.js'
  ]) {
    const source = readSource(path);
    assert.ok(!source.includes('eyebrow'), `no eyebrow left in ${path}`);
  }
});

test('decorative standalone section eyebrows are gone', () => {
  const dashboard = readSource('src/pages/dashboard.js');
  assert.ok(!dashboard.includes("text: 'Study now'"), 'dashboard recommendation eyebrow removed');
  assert.ok(!dashboard.includes("text: 'Reading'"), 'dashboard continue-reading eyebrow removed');
  const review = readSource('src/pages/review.js');
  assert.ok(!review.includes("text: 'Review'"), 'review hub intro eyebrow removed');
});

test('functional eyebrows are kept, never relabeled', () => {
  const placement = readSource('src/firstExperience.js');
  assert.ok(placement.includes('FIRST SETUP'), 'onboarding step labels kept');
  const landing = readSource('src/landing/sections.js');
  assert.ok(landing.includes('landing-eyebrow'), 'landing marketing copy kept');
  const kanji = readSource('src/kanjiDetail.js');
  assert.ok(kanji.includes("'Your kanji'") && kanji.includes("'Meanings'"), 'kanji ownership labels kept');
  const search = readSource('src/main.js');
  assert.ok(search.includes("role: 'group'") && search.includes("'aria-hidden': 'true'"), 'search result group labels kept as functional group headers');
  const styles = readSource('src/styles.css');
  assert.ok(styles.includes('.eyebrow'), 'shared .eyebrow class kept for remaining users');
});
