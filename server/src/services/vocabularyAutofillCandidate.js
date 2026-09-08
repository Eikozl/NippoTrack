// VAF-B — standalone vocabulary candidate factory.
//
// Builds the single pos-less candidate for POST /api/vocabulary/autofill from
// a validated typed word. No Kuromoji, no deinflection, no name analysis: the
// trimmed word IS the lemma/canonical. Proper nouns receive an ordinary exact
// lookup (no UNSUPPORTED invention, no JMnedict) because eligibility is
// bypassed downstream — this factory never classifies.

function buildStandaloneCandidate(word) {
  if (typeof word !== 'string' || word === '') {
    throw new Error('buildStandaloneCandidate requires a non-empty trimmed word.');
  }
  return {
    key: `standalone::${word}`,
    canonical: word,
    lemma: word,
    pos: null,
    lemmaReading: null,
    surfaceReading: null,
    observed: []
  };
}

module.exports = {
  buildStandaloneCandidate
};
