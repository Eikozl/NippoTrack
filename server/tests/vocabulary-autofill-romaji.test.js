const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStandaloneCandidate } = require('../src/services/vocabularyAutofillCandidate');

test('standalone vocabulary autofill derives kana lookup identities from complete romaji', () => {
  const cases = [
    ['nihongo', 'にほんご'],
    ['taberu', 'たべる'],
    ['benkyou', 'べんきょう'],
    ['gakkou', 'がっこう']
  ];

  for (const [input, expectedKana] of cases) {
    const candidate = buildStandaloneCandidate(input);
    assert.equal(candidate.canonical, expectedKana);
    assert.equal(candidate.lemma, expectedKana);
    assert.equal(candidate.inputWord, input);
    assert.equal(candidate.key, `standalone::${input}`);
  }
});

test('standalone vocabulary autofill leaves Japanese and English input unchanged', () => {
  assert.equal(buildStandaloneCandidate('日本語').canonical, '日本語');
  assert.equal(buildStandaloneCandidate('study').canonical, 'study');
});
