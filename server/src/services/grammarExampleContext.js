const { adaptTokens } = require('./lexicalTokenAdapter');
const { engineMetadata, parseJapanese } = require('./japaneseParser');
const { detectGrammar } = require('./grammarDetector');
const { hydrateGrammarMatches } = require('./grammarReferenceStore');
const { buildLexicalCandidates, matchOwnedVocabulary } = require('./lexicalCandidates');

const MAX_EXAMPLES = 12;
const MAX_CODE_POINTS = 6000;
const codePoints = (value) => Array.from(value || '').length;

async function analyzeGrammarExamples({ userId, examples, hydrate = hydrateGrammarMatches }) {
  const selected = []; let used = 0; let truncated = false;
  for (const example of Array.isArray(examples) ? examples : []) {
    const sentence = typeof example?.sentence === 'string' ? example.sentence.trim() : '';
    if (!sentence) continue;
    const size = codePoints(sentence);
    if (selected.length >= MAX_EXAMPLES || used + size > MAX_CODE_POINTS) { truncated = true; continue; }
    selected.push({ ...example, sentence }); used += size;
  }
  const analyzed = await Promise.all(selected.map(async (example) => {
    try {
      const parsed = await parseJapanese(example.sentence);
      const tokens = adaptTokens(parsed.rawTokens, example.sentence, engineMetadata());
      return { idUsageExample: example.id_usage_example, sentence: example.sentence, matches: await hydrate(userId, detectGrammar(tokens)) };
    } catch (_) { return { idUsageExample: example.id_usage_example, sentence: example.sentence, matches: [], unavailable: true }; }
  }));
  return { examples: analyzed, analyzedExamples: analyzed.length, totalExamples: (examples || []).filter((example) => example?.sentence).length, truncated };
}

async function analyzeVocabularyInGrammarExample({ userId, sentence, pool }) {
  if (typeof sentence !== 'string' || !sentence.trim() || codePoints(sentence) > 2000) return { items: [], unavailable: false };
  try {
    const parsed = await parseJapanese(sentence);
    const tokens = adaptTokens(parsed.rawTokens, sentence, engineMetadata());
    const { candidates } = buildLexicalCandidates(tokens);
    await matchOwnedVocabulary(pool, userId, candidates);
    return { items: candidates.map((candidate) => ({ canonical: candidate.canonical, inVocabulary: candidate.match?.state === 'existing' })) };
  } catch (_) { return { items: [], unavailable: true }; }
}

module.exports = { MAX_CODE_POINTS, MAX_EXAMPLES, analyzeGrammarExamples, analyzeVocabularyInGrammarExample };
