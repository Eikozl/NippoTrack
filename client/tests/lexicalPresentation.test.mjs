import test from 'node:test';
import assert from 'node:assert/strict';

import { groupLexicalCandidates, isLexicalPresentationNoise } from '../src/lexicalAnalyzer.js';

function candidate(canonical, extra = {}) {
  return {
    key: `noun::${canonical}`,
    canonical,
    lemma: canonical,
    pos: 'noun',
    lemmaReading: null,
    surfaceReading: null,
    observed: [{ surface: canonical, surfaceReading: null }],
    occurrences: 1,
    firstStart: 0,
    match: { state: 'new', ownedCount: 0, possibleMatches: [] },
    ...extra
  };
}

test('presentation noise hides whitespace/punctuation-only canonicals', () => {
  for (const noise of ['', '   ', '\n\t', '、', '。', '！？', '「」', '（）', '・', '...', '  、 ']) {
    assert.equal(isLexicalPresentationNoise(noise), true, JSON.stringify(noise));
  }
  assert.equal(isLexicalPresentationNoise('ー'), true, 'lone prolonged mark');
  assert.equal(isLexicalPresentationNoise('々'), true, 'lone iteration mark');
});

test('legitimate Japanese items stay visible (letters/numbers keep cards)', () => {
  for (const keep of ['日本語', 'ひらがな', 'カタカナ', '食べる', '時々', 'コンピューター', 'カルロス・ゴーン', '3年生', '３年生', '〜たち', 'PC', 'ありがとう']) {
    assert.equal(isLexicalPresentationNoise(keep), false, keep);
  }
});

test('grouping filters noise from candidates and unverified, payload untouched', () => {
  const lexical = {
    candidates: [candidate('日本語'), candidate('、'), candidate(' '), candidate('食べる')],
    unverified: [
      { key: 'proper-noun::田中', canonical: '田中', pos: 'proper-noun', occurrences: 1, firstStart: 5 },
      { key: 'unknown::。', canonical: '。', pos: 'unknown', occurrences: 2, firstStart: 6 }
    ]
  };
  const groups = groupLexicalCandidates(lexical, new Set());
  const visible = [...groups.existing, ...groups.fresh, ...groups.verify].map((view) => view.canonical);
  assert.ok(visible.includes('日本語'), 'word kept');
  assert.ok(visible.includes('食べる'), 'word kept');
  assert.ok(!visible.includes('、'), 'punctuation hidden from cards');
  assert.ok(!visible.includes(' '), 'whitespace hidden from cards');
  assert.ok(visible.includes('田中'), 'proper noun still needs verification');
  assert.ok(!visible.includes('。'), 'lone punctuation unverified hidden');
  // Internal payload intact (filter is presentation-only).
  assert.equal(lexical.candidates.length, 4);
  assert.equal(lexical.unverified.length, 2);
});
