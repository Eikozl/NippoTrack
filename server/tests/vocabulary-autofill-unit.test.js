// VAF-B unit tests: composer, candidate factory, hint mapping table
// (all 5 dictionary statuses), ownership mapping. Pure logic + stubbed pool
// only (no network, no real DB, never Production/Integration remotes).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JLT_AUTH_BYPASS_FOR_TESTS = 'true';

const { buildStandaloneCandidate } = require('../src/services/vocabularyAutofillCandidate');
const {
  NO_MATCH_HINT,
  composeSenseMeaning,
  buildFieldHints,
  buildHint,
  resolveOwnership
} = require('../src/services/vocabularyAutofillService');
const { MATCH, INTERP } = require('../src/services/contextFilters');

// --- composer ------------------------------------------------------------

test('composer joins multiple glosses with middle dot', () => {
  const out = composeSenseMeaning(['school', 'academy']);
  assert.equal(out.value, 'school · academy');
  assert.deepEqual(out.glossesUsed, ['school', 'academy']);
  assert.equal(out.glossCount, 2);
  assert.equal(out.remainingCount, 0);
  assert.equal(out.fits, true);
});

test('composer greedily drops whole glosses beyond 255, never char-cuts', () => {
  const big = 'x'.repeat(100);
  const glosses = [big, big, big];
  const out = composeSenseMeaning(glosses, 255);
  // 100 + 3 + 100 = 203 fits; a third would reach 306 and is dropped whole.
  assert.equal(out.value, `${big} · ${big}`);
  assert.deepEqual(out.glossesUsed, [big, big]);
  assert.equal(out.glossCount, 2);
  assert.equal(out.remainingCount, 1);
  assert.equal(out.fits, true);
  for (const used of out.glossesUsed) {
    assert.ok(glosses.includes(used), 'only whole input glosses are emitted');
  }
  assert.ok(out.value.length <= 255);
});

test('composer single gloss beyond 255 yields blank with fits:false', () => {
  const huge = 'x'.repeat(300);
  const out = composeSenseMeaning([huge]);
  assert.equal(out.value, '');
  assert.deepEqual(out.glossesUsed, []);
  assert.equal(out.glossCount, 0);
  assert.equal(out.remainingCount, 1);
  assert.equal(out.fits, false);
});

test('composer empty input yields blank', () => {
  const out = composeSenseMeaning([]);
  assert.equal(out.value, '');
  assert.deepEqual(out.glossesUsed, []);
  assert.equal(out.remainingCount, 0);
  assert.equal(out.fits, false);
});

test('composer default max is 255 and deterministic', () => {
  const a = composeSenseMeaning(['one', 'two']);
  const b = composeSenseMeaning(['one', 'two']);
  assert.deepEqual(a, b);
  assert.equal(composeSenseMeaning(['a'.repeat(255)]).fits, true);
  assert.equal(composeSenseMeaning(['a'.repeat(256)]).fits, false);
});

// --- candidate factory ---------------------------------------------------

test('candidate factory builds pos-less standalone shape', () => {
  const c = buildStandaloneCandidate('学校');
  assert.equal(c.lemma, '学校');
  assert.equal(c.canonical, '学校');
  assert.equal(c.pos, null);
  assert.equal(c.lemmaReading, null);
  assert.equal(c.surfaceReading, null);
  assert.deepEqual(c.observed, []);
  assert.equal(typeof c.key, 'string');
  assert.ok(c.key.includes('学校'));
});

test('candidate factory rejects empty input', () => {
  assert.throws(() => buildStandaloneCandidate(''), /non-empty/);
});

// --- hint mapping table --------------------------------------------------

function finalizedUniqueCompatible() {
  return {
    matchStatus: MATCH.UNIQUE,
    matchReason: 'single-compatible-entry',
    interpretationStatus: INTERP.COMPATIBLE,
    interpretationReason: 'single-compatible-sense',
    selectedEntryId: '1000001',
    selectedSense: { entryId: '1000001', senseNo: 1, pos: ['n'], glossEn: ['school'] },
    compatibleSenses: [{ entryId: '1000001', senseNo: 1, pos: ['n'], glossEn: ['school'] }],
    survivingEntries: [{
      entryId: '1000001',
      posSummary: ['n'],
      isCommon: true,
      senses: [{ senseNo: 1, pos: ['n'], glossEn: ['school'], stagk: [], stagr: [] }],
      matchedForms: [],
      allForms: [
        { surface: '学校', kind: 'keb' },
        { surface: 'がっこう', kind: 'reb' }
      ],
      readings: { suggested: 'がっこう', alternatives: ['がっこう'], provenance: 'dictionary' }
    }],
    itemReadings: { suggested: 'がっこう', alternatives: ['がっこう'], provenance: 'dictionary' },
    lookupTruncated: false,
    evaluationTruncated: false
  };
}

test('hint UNIQUE+COMPATIBLE prefills reading and meaning', () => {
  const { reading, meaning } = buildFieldHints(finalizedUniqueCompatible());
  assert.equal(reading.action, 'prefill');
  assert.equal(reading.value, 'がっこう');
  assert.equal(reading.provenance, 'dictionary');
  assert.equal(meaning.action, 'prefill');
  assert.equal(meaning.value, 'school');
  assert.deepEqual(meaning.glossesUsed, ['school']);
  assert.equal(meaning.entryId, '1000001');
  assert.equal(meaning.senseId, 1);
  assert.equal(meaning.provenance, 'dictionary');
  assert.equal(buildHint(finalizedUniqueCompatible()), null);
});

test('hint UNIQUE+COMPATIBLE zero-fitting gloss yields blank meaning with counts', () => {
  const fin = finalizedUniqueCompatible();
  fin.selectedSense = { entryId: '9', senseNo: 1, pos: ['n'], glossEn: ['x'.repeat(300)] };
  const { meaning } = buildFieldHints(fin);
  assert.equal(meaning.action, 'blank');
  assert.equal(meaning.value, '');
  assert.equal(meaning.remainingCount, 1);
  assert.equal(meaning.glossCount, 1);
});

test('hint UNIQUE+AMBIGUOUS chooses meaning with bounded full-gloss senseChoices', () => {
  const fin = finalizedUniqueCompatible();
  fin.interpretationStatus = INTERP.AMBIGUOUS;
  fin.interpretationReason = 'multiple-compatible-senses';
  fin.selectedSense = null;
  fin.compatibleSenses = [
    { entryId: '1000006', senseNo: 1, pos: ['v5k-s', 'vi'], glossEn: ['to go'] },
    { entryId: '1000006', senseNo: 2, pos: ['v5k-s', 'vi'], glossEn: ['to proceed'] }
  ];
  const { reading, meaning } = buildFieldHints(fin);
  assert.equal(reading.action, 'prefill');
  assert.equal(reading.value, 'がっこう');
  assert.equal(meaning.action, 'choose');
  assert.equal(meaning.value, '');
  assert.equal(meaning.senseChoices.length, 2);
  assert.deepEqual(meaning.senseChoices[0], {
    entryId: '1000006',
    senseId: 1,
    glosses: ['to go'],
    pos: ['v5k-s', 'vi']
  });
  assert.equal(meaning.entryChoices, null);
});

test('hint MULTIPLE blanks reading (never alternatives[0]) and offers entryChoices', () => {
  const fin = {
    matchStatus: MATCH.MULTIPLE,
    matchReason: 'multiple-compatible-entries',
    interpretationStatus: INTERP.AMBIGUOUS,
    selectedEntryId: null,
    selectedSense: null,
    compatibleSenses: [
      { entryId: '3000001', senseNo: 1, pos: ['n'], glossEn: ['bridge'] },
      { entryId: '3000002', senseNo: 1, pos: ['n'], glossEn: ['chopsticks'] }
    ],
    survivingEntries: [
      {
        entryId: '3000001', posSummary: ['n'], isCommon: true,
        senses: [{ senseNo: 1, pos: ['n'], glossEn: ['bridge'], stagk: [], stagr: [] }],
        matchedForms: [], allForms: [{ surface: '橋', kind: 'keb' }, { surface: 'はし', kind: 'reb' }],
        readings: { suggested: null, alternatives: ['はし'], provenance: 'dictionary' }
      },
      {
        entryId: '3000002', posSummary: ['n'], isCommon: false,
        senses: [{ senseNo: 1, pos: ['n'], glossEn: ['chopsticks'], stagk: [], stagr: [] }],
        matchedForms: [], allForms: [{ surface: '箸', kind: 'keb' }, { surface: 'はし', kind: 'reb' }],
        readings: { suggested: null, alternatives: ['はし'], provenance: 'dictionary' }
      }
    ],
    itemReadings: { suggested: null, alternatives: [], provenance: null }
  };
  const { reading, meaning } = buildFieldHints(fin);
  assert.equal(reading.action, 'blank');
  assert.equal(reading.value, null);
  assert.deepEqual(reading.choices, []);
  assert.equal(meaning.action, 'choose-entry-then-sense');
  assert.equal(meaning.value, '');
  assert.ok(Array.isArray(meaning.entryChoices));
  assert.equal(meaning.entryChoices.length, 2);
  assert.equal(meaning.senseChoices, null);
  for (const choice of meaning.entryChoices) {
    assert.ok(choice.entryId);
    assert.ok('glossPreview' in choice);
    assert.ok('pos' in choice);
  }
});

test('hint NO_MATCH blanks with exact neutral text', () => {
  const fin = { matchStatus: MATCH.NO_MATCH, interpretationStatus: INTERP.NOT_APPLICABLE };
  const { reading, meaning } = buildFieldHints(fin);
  assert.equal(reading.action, 'blank');
  assert.equal(meaning.action, 'blank');
  assert.equal(buildHint(fin), NO_MATCH_HINT);
  assert.equal(
    NO_MATCH_HINT,
    'No JMdict entry matches this exact text. You can still add it manually. Tip: type the dictionary form (e.g. 行く instead of 行った).'
  );
});

test('hint UNAVAILABLE blanks with no neutral hint', () => {
  for (const interp of [INTERP.NOT_APPLICABLE, INTERP.UNAVAILABLE]) {
    const fin = { matchStatus: MATCH.UNAVAILABLE, interpretationStatus: interp };
    const { reading, meaning } = buildFieldHints(fin);
    assert.equal(reading.action, 'blank');
    assert.equal(meaning.action, 'blank');
    assert.equal(buildHint(fin), null);
  }
});

test('hint UNSUPPORTED defensively blanks', () => {
  const fin = { matchStatus: MATCH.UNSUPPORTED, interpretationStatus: INTERP.NOT_APPLICABLE };
  const { reading, meaning } = buildFieldHints(fin);
  assert.equal(reading.action, 'blank');
  assert.equal(meaning.action, 'blank');
  assert.equal(buildHint(fin), null);
});

// --- ownership mapping ---------------------------------------------------

function ownershipPool({ wordRows = [], readingRows = [], throwAll = false } = {}) {
  return {
    execute: async (sql, params) => {
      if (throwAll) throw new Error('vocabulary lookup down');
      if (/FROM vocabulary WHERE user_id = \?/i.test(sql)) {
        const [userId, ...keys] = params;
        assert.equal(typeof userId, 'string', 'user_id first bind');
        assert.ok(!/JOIN/i.test(sql), 'never JOIN vocabulary<->jmdict');
        if (/AND word IN/i.test(sql)) {
          return [wordRows.filter((row) => keys.includes(row.word))];
        }
        return [readingRows.filter((row) => keys.includes(row.reading))];
      }
      throw new Error(`unexpected SQL in ownership unit test: ${sql.slice(0, 60)}`);
    }
  };
}

test('ownership exact word maps to existing', async () => {
  const pool = ownershipPool({ wordRows: [{ word: '学校', reading: 'がっこう' }] });
  const out = await resolveOwnership(pool, 'user-a', '学校', ['がっこう']);
  assert.equal(out.state, 'existing');
  assert.equal(out.matches[0].word, '学校');
});

test('ownership reading-correlated maps to possible-match, bounded', async () => {
  const pool = ownershipPool({
    readingRows: [
      { word: '他校', reading: 'がっこう' },
      { word: '学校法人', reading: 'がっこう' }
    ]
  });
  const out = await resolveOwnership(pool, 'user-a', '学校', ['がっこう']);
  assert.equal(out.state, 'possible-match');
  assert.ok(out.matches.length >= 1 && out.matches.length <= 3);
  assert.ok(out.matches.every((m) => typeof m.word === 'string'));
});

test('ownership lookup throw maps to unavailable, never new', async () => {
  const pool = ownershipPool({ throwAll: true });
  const out = await resolveOwnership(pool, 'user-a', '学校', ['がっこう']);
  assert.equal(out.state, 'unavailable');
  assert.deepEqual(out.matches, []);
});

test('ownership clean miss maps to new', async () => {
  const pool = ownershipPool({});
  const out = await resolveOwnership(pool, 'user-a', '学校', ['がっこう']);
  assert.equal(out.state, 'new');
  assert.deepEqual(out.matches, []);
});
