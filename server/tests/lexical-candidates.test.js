// Phase 12-B — lexical candidate aggregation + owned-vocabulary matching.
// Aggregation is pure (handcrafted tokens); matching uses a stubbed pool with
// real SQL-shape assertions (user scoping, no N+1, failure propagation).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLexicalCandidates,
  matchOwnedVocabulary,
  summarizeLexical
} = require('../src/services/lexicalCandidates');

function tok(surface, pos, extra = {}) {
  return {
    surface,
    lemma: extra.lemma !== undefined ? extra.lemma : surface,
    surfaceReading: extra.surfaceReading !== undefined ? extra.surfaceReading : null,
    lemmaReading: extra.lemmaReading !== undefined ? extra.lemmaReading : null,
    pos,
    posDetail: extra.posDetail || [],
    inflectionType: null,
    inflectionForm: null,
    start: extra.start !== undefined ? extra.start : 0,
    end: extra.end !== undefined ? extra.end : surface.length,
    isContentWord: extra.isContentWord !== undefined ? extra.isContentWord : true,
    isUnknown: !!extra.isUnknown,
    engine: {}
  };
}

test('repeated safe identities aggregate with observed forms and counts', () => {
  const { candidates, unverified } = buildLexicalCandidates([
    tok('学校', 'noun', { lemmaReading: 'がっこう', start: 0 }),
    tok('は', 'particle', { isContentWord: false, start: 2 }),
    tok('学校', 'noun', { lemmaReading: 'がっこう', start: 5 }),
    tok('学校', 'noun', { lemmaReading: 'がっこう', start: 9 }),
    tok('。', 'symbol', { isContentWord: false, start: 11 })
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical, '学校');
  assert.equal(candidates[0].occurrences, 3);
  assert.equal(candidates[0].firstStart, 0);
  assert.equal(candidates[0].lemmaReading, 'がっこう');
  assert.equal(candidates[0].observed.length, 1);
  assert.equal(candidates[0].observed[0].occurrences, 3);
  assert.deepEqual(unverified, []);
});

test('particles, auxiliaries, symbols never become candidates', () => {
  const { candidates } = buildLexicalCandidates([
    tok('は', 'particle', { isContentWord: false }),
    tok('た', 'auxiliary', { isContentWord: false }),
    tok('。', 'symbol', { isContentWord: false }),
    tok('さん', 'suffix', { isContentWord: false })
  ]);
  assert.deepEqual(candidates, []);
});

test('conjugated verb aggregates under its lemma with observed surfaces', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行っ', 'verb', { lemma: '行く', surfaceReading: 'いっ', start: 4 }),
    tok('行き', 'verb', { lemma: '行く', surfaceReading: 'いき', start: 10 })
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical, '行く');
  assert.equal(candidates[0].lemma, '行く');
  assert.equal(candidates[0].occurrences, 2);
  assert.deepEqual(candidates[0].observed.map((o) => o.surface).sort(), ['行き', '行っ']);
});

test('proper nouns and unknowns are unverified: visible, no readings, no import', () => {
  const { candidates, unverified } = buildLexicalCandidates([
    tok('田中', 'proper-noun', { surfaceReading: null, lemmaReading: null, isContentWord: false }),
    tok('ググ', 'unknown', { lemma: null, isUnknown: true, isContentWord: false })
  ]);
  assert.deepEqual(candidates, []);
  assert.equal(unverified.length, 2);
  for (const item of unverified) {
    assert.equal(item.match.state, 'unsupported');
    assert.equal(item.lemmaReading, null);
    assert.equal(item.surfaceReading, null);
  }
});

test('lemma exact match is confident existing (行きました → 行く)', async () => {
  const seen = [];
  const pool = {
    execute: async (sql, params) => {
      seen.push({ sql, params });
      if (/FROM vocabulary WHERE user_id = \? AND word IN/i.test(sql)) {
        assert.equal(params[0], 'user-1');
        const keys = params.slice(1);
        const rows = [{ word: '行く', reading: 'いく' }].filter((r) => keys.includes(r.word));
        return [rows];
      }
      return [[]];
    }
  };
  const { candidates } = buildLexicalCandidates([tok('行き', 'verb', { lemma: '行く' })]);
  const result = await matchOwnedVocabulary(pool, 'user-1', candidates);
  assert.equal(result.queries, 1); // word lookup only — no readings, no second query
  assert.equal(candidates[0].match.state, 'existing');
  assert.equal(candidates[0].match.ownedCount, 1);
});

test('reading-only hits are ambiguous, never confident', async () => {
  const pool = {
    execute: async (sql, params) => {
      if (/AND word IN/i.test(sql)) return [[], []];
      if (/AND reading IN/i.test(sql)) {
        return [[{ word: '橋', reading: 'はし' }]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }
  };
  const { candidates } = buildLexicalCandidates([
    tok('箸', 'noun', { lemmaReading: 'はし', surfaceReading: 'はし' })
  ]);
  await matchOwnedVocabulary(pool, 'user-1', candidates);
  assert.equal(candidates[0].match.state, 'ambiguous');
  assert.deepEqual(candidates[0].match.possibleMatches, [{ word: '橋' }]);
});

test('no reading overlap stays new; duplicate owned rows count without picking canonical', async () => {
  const pool = {
    execute: async (sql) => {
      if (/AND word IN/i.test(sql)) {
        return [[{ word: '学校', reading: 'がっこう' }, { word: '学校', reading: 'ガッコウ' }]];
      }
      return [[], []];
    }
  };
  const { candidates } = buildLexicalCandidates([
    tok('学校', 'noun', { lemmaReading: 'がっこう' }),
    tok('昨日', 'noun', { lemmaReading: 'きのう' })
  ]);
  await matchOwnedVocabulary(pool, 'user-1', candidates);
  const school = candidates.find((c) => c.canonical === '学校');
  const yesterday = candidates.find((c) => c.canonical === '昨日');
  assert.equal(school.match.state, 'existing');
  assert.equal(school.match.ownedCount, 2);
  assert.equal(yesterday.match.state, 'new');
});

test('matching is user-scoped and set-based (max 2 queries, no N+1)', async () => {
  const seen = [];
  const pool = {
    execute: async (sql, params) => {
      seen.push({ sql, params });
      return [[], []];
    }
  };
  const { candidates } = buildLexicalCandidates([
    tok('学校', 'noun'), tok('行っ', 'verb', { lemma: '行く' }), tok('食べ', 'verb', { lemma: '食べる' })
  ]);
  await matchOwnedVocabulary(pool, 'user-9', candidates);
  assert.ok(seen.length <= 2, `expected <=2 queries, got ${seen.length}`);
  for (const { sql, params } of seen) {
    assert.ok(/WHERE user_id = \?/i.test(sql), 'every lookup is user-scoped');
    assert.equal(params[0], 'user-9');
  }
});

test('lookup failure propagates so callers mark unavailable (never all-new)', async () => {
  const pool = { execute: async () => { throw new Error('db down'); } };
  const { candidates } = buildLexicalCandidates([tok('学校', 'noun')]);
  await assert.rejects(() => matchOwnedVocabulary(pool, 'user-1', candidates), /db down/);
});

test('empty candidates issue zero queries', async () => {
  let calls = 0;
  const pool = { execute: async () => { calls += 1; return [[], []]; } };
  const result = await matchOwnedVocabulary(pool, 'user-1', []);
  assert.equal(calls, 0);
  assert.deepEqual(result, { matched: 0, ambiguous: 0, queries: 0 });
});

test('summary counts states without inventing knowledge words', () => {
  const summary = summarizeLexical(
    [
      { match: { state: 'existing' } },
      { match: { state: 'new' } },
      { match: { state: 'ambiguous' } },
      { match: { state: 'unavailable' } }
    ],
    [{}, {}],
    true
  );
  assert.deepEqual(summary, { candidates: 4, existing: 1, new: 1, ambiguous: 1, unavailable: 1, unverified: 2 });
  const degraded = summarizeLexical([{ match: { state: 'new' } }], [], false);
  assert.equal(degraded.new, 0);
});

test('observed form reconstruction: 行っ + た → 行った', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行っ', 'verb', { lemma: '行く', surfaceReading: 'いっ', start: 4, end: 6 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 6, end: 7 })
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical, '行く');
  assert.equal(candidates[0].observed.length, 1);
  assert.equal(candidates[0].observed[0].surface, '行った');
  assert.equal(candidates[0].observed[0].surfaceReading, 'いった');
});

test('observed form reconstruction: 行き + まし + た → 行きました', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行き', 'verb', { lemma: '行く', surfaceReading: 'いき', start: 4, end: 6 }),
    tok('まし', 'auxiliary', { surfaceReading: 'まし', isContentWord: false, start: 6, end: 8 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 8, end: 9 })
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical, '行く');
  assert.equal(candidates[0].observed.length, 1);
  assert.equal(candidates[0].observed[0].surface, '行きました');
  assert.equal(candidates[0].observed[0].surfaceReading, 'いきました');
});

test('observed form reconstruction: 食べ + なかっ + た → 食べなかった', () => {
  const { candidates } = buildLexicalCandidates([
    tok('食べ', 'verb', { lemma: '食べる', surfaceReading: 'たべ', start: 3, end: 5 }),
    tok('なかっ', 'auxiliary', { surfaceReading: 'なかっ', isContentWord: false, start: 5, end: 8 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 8, end: 9 })
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical, '食べる');
  assert.equal(candidates[0].observed[0].surface, '食べなかった');
  assert.equal(candidates[0].observed[0].surfaceReading, 'たべなかった');
});

test('observed form reconstruction: 高かっ + た → 高かった', () => {
  const { candidates } = buildLexicalCandidates([
    tok('高かっ', 'i-adjective', { lemma: '高い', surfaceReading: 'たかかっ', start: 0, end: 4 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 4, end: 5 })
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical, '高い');
  assert.equal(candidates[0].observed[0].surface, '高かった');
  assert.equal(candidates[0].observed[0].surfaceReading, 'たかかった');
});

test('observed form reconstruction stops at particle boundary', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行っ', 'verb', { lemma: '行く', surfaceReading: 'いっ', start: 4, end: 6 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 6, end: 7 }),
    tok('が', 'particle', { isContentWord: false, start: 7, end: 8 }),
    tok('来', 'verb', { lemma: '来る', surfaceReading: 'き', start: 8, end: 9 })
  ]);
  assert.equal(candidates.length, 2);
  // First candidate should be 行った (stopped at particle)
  const iku = candidates.find((c) => c.canonical === '行く');
  assert.equal(iku.observed[0].surface, '行った');
  // Second candidate should be 来
  const kuru = candidates.find((c) => c.canonical === '来る');
  assert.equal(kuru.observed[0].surface, '来');
});

test('observed form reconstruction stops at independent content word', () => {
  const { candidates } = buildLexicalCandidates([
    tok('食べ', 'verb', { lemma: '食べる', surfaceReading: 'たべ', start: 0, end: 2 }),
    tok('ない', 'auxiliary', { surfaceReading: 'ない', isContentWord: false, start: 2, end: 4 }),
    tok('です', 'copula', { surfaceReading: 'です', isContentWord: false, start: 4, end: 6 }),
    tok('ね', 'particle', { isContentWord: false, start: 6, end: 7 }),
    tok('行く', 'verb', { lemma: '行く', surfaceReading: 'いく', start: 7, end: 9 })
  ]);
  assert.equal(candidates.length, 2);
  const taberu = candidates.find((c) => c.canonical === '食べる');
  assert.equal(taberu.observed[0].surface, '食べないです'); // stops at particle
  const iku = candidates.find((c) => c.canonical === '行く');
  assert.equal(iku.observed[0].surface, '行く');
});

test('observed form reconstruction requires contiguous offsets', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行っ', 'verb', { lemma: '行く', surfaceReading: 'いっ', start: 4, end: 6 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 7, end: 8 }) // gap!
  ]);
  assert.equal(candidates.length, 1);
  // Should NOT reconstruct because of gap
  assert.equal(candidates[0].observed[0].surface, '行っ');
});

test('observed form reading concatenates only when all components have reliable reading', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行っ', 'verb', { lemma: '行く', surfaceReading: 'いっ', start: 4, end: 6 }),
    tok('た', 'auxiliary', { surfaceReading: 'た', isContentWord: false, start: 6, end: 7 })
  ]);
  assert.equal(candidates[0].observed[0].surfaceReading, 'いった');
});

test('observed form reading is null when any component lacks reading', () => {
  const { candidates } = buildLexicalCandidates([
    tok('行っ', 'verb', { lemma: '行く', surfaceReading: 'いっ', start: 4, end: 6 }),
    tok('た', 'auxiliary', { surfaceReading: null, isContentWord: false, start: 6, end: 7 })
  ]);
  assert.equal(candidates[0].observed[0].surfaceReading, null);
});
