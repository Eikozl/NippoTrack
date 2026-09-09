const test = require('node:test');
const assert = require('node:assert/strict');
const { detectGrammar, FAMILIES, RULES, validateRuleMappings } = require('../src/services/grammarDetector');

function token(surface, pos, start) { return { surface, pos, start, end: start + [...surface].length }; }

test('frozen detector manifest contains exactly 50 rules and 15 families with valid catalog mappings', () => {
  assert.equal(RULES.length, 50);
  assert.equal(FAMILIES.length, 15);
  assert.equal(validateRuleMappings(), true);
});

test('longer grammar constructions suppress their nested counterparts', () => {
  const matches = detectGrammar([
    token('来', 'verb', 0), token('なく', 'auxiliary', 1), token('て', 'particle', 3), token('も', 'particle', 4), token('いい', 'i-adjective', 5)
  ]);
  assert.deepEqual(matches.map((match) => match.ruleId || match.familyId), ['nakute-mo-ii']);
});

test('token grounded rules do not confuse a lexical noun with an auxiliary construction', () => {
  const matches = detectGrammar([token('鯛', 'noun', 0), token('を', 'particle', 1), token('食べ', 'verb', 2), token('た', 'auxiliary', 4)]);
  assert.equal(matches.some((match) => match.ruleId === 'tai'), false);
});
