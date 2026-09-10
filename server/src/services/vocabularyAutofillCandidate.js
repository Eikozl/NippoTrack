// VAF-B — standalone vocabulary candidate factory.
//
// Builds the single pos-less candidate for POST /api/vocabulary/autofill from
// a validated typed word. No Kuromoji, no deinflection, no name analysis: the
// trimmed word IS the lemma/canonical. Proper nouns receive an ordinary exact
// lookup (no UNSUPPORTED invention, no JMnedict) because eligibility is
// bypassed downstream — this factory never classifies.

const { buildSearchCandidates } = require('../search/japaneseSearch');

function buildStandaloneCandidate(word) {
  if (typeof word !== 'string' || word === '') {
    throw new Error('buildStandaloneCandidate requires a non-empty trimmed word.');
  }
  // Convert complete romaji for dictionary lookup while retaining the exact
  // submitted text so the VAF form is never silently rewritten.
  const searchCandidates = buildSearchCandidates(word);
  const lookupWord = searchCandidates.romajiComplete && searchCandidates.hiragana
    ? searchCandidates.hiragana
    : word;

  return {
    key: `standalone::${word}`,
    canonical: lookupWord,
    lemma: lookupWord,
    inputWord: word,
    pos: null,
    lemmaReading: null,
    surfaceReading: null,
    observed: []
  };
}

module.exports = {
  buildStandaloneCandidate
};
