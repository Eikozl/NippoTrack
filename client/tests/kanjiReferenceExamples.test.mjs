import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/kanjiReference.js', import.meta.url), 'utf8');

test('reference page shows JMdict vocabulary examples, never the placeholder', () => {
  assert.ok(page.includes("'Vocabulary examples'"), 'canonical heading present');
  assert.ok(page.includes("'Reference vocabulary from JMdict'"), 'provenance label present');
  assert.ok(!page.includes('not available yet'), 'old placeholder wording is gone');
  assert.ok(!page.includes('Common vocabulary'), 'never claims common without evidence-gated wording');
});

test('examples are capped, hierarchical, and read-only', () => {
  assert.ok(page.includes('slice(0, 3)'), 'hard max-3 enforced at render');
  assert.ok(page.includes('sm:grid-cols-3'), 'compact responsive row on desktop');
  assert.ok(page.includes("lang: 'ja'"), 'Japanese forms carry lang hooks');
  assert.ok(!page.includes('Add to Vocabulary'), 'no Add actions in reference examples');
  assert.ok(!page.includes('button'), 'no actions at all — read-only section');
});

test('empty and unavailable states stay distinct and restrained', () => {
  assert.ok(page.includes("'No reference vocabulary examples available.'"), 'zero-matches wording');
  assert.ok(page.includes("'Reference vocabulary is currently unavailable.'"), 'lookup-down wording');
  assert.ok(page.includes("vocabularyExamplesStatus === 'unavailable'"), 'status distinction preserved');
});

test('lookup contract fields flow through untouched', () => {
  assert.ok(page.includes('/api/kanji/lookup/'), 'existing endpoint reused, no new endpoint');
  assert.ok(page.includes('reference.character'), 'identity still drives the header');
});
