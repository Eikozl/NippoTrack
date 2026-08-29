const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'jlt_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'test-only';
process.env.DB_NAME = process.env.DB_NAME || 'jlt';

const app = require('../src/app');
const pool = require('../src/config/db');
const { listVocabularyOptions } = require('../src/controllers/vocabularyController');
const { listKanjiOptions } = require('../src/controllers/kanjiController');
const { listGrammarOptions } = require('../src/controllers/grammarController');

const {
  buildSearchCandidates,
  hiraganaToRomaji,
  katakanaToHiragana,
  normalizeJapaneseReading,
  normalizeRomaji,
  romajiToHiragana
} = require('../src/search/japaneseSearch');
const {
  rankGrammarOptions,
  rankKanjiOptions,
  rankVocabularyOptions
} = require('../src/search/optionRanking');

const VOCABULARY_ROWS = [
  { id_vocabulary: 1, word: '日本', reading: 'にほん', meaning: 'Japan' },
  { id_vocabulary: 2, word: '日本語', reading: 'にほんご', meaning: 'Japanese language' },
  { id_vocabulary: 3, word: '肉', reading: 'にく', meaning: 'meat' },
  { id_vocabulary: 4, word: '食べる', reading: 'たべる', meaning: 'to eat' }
];
const KANJI_ROWS = [
  { id_kanji: 1, character_kanji: '食', meaning: 'eat; food', onyomi: 'ショク', kunyomi: 'た.べる' },
  { id_kanji: 2, character_kanji: '水', meaning: 'water', onyomi: 'スイ', kunyomi: 'みず' }
];
const GRAMMAR_ROWS = [
  { id_grammar: 1, grammar_point: '〜から', meaning: 'because; from', structure: 'clause + から', example: null },
  { id_grammar: 2, grammar_point: '〜たい', meaning: 'want to do', structure: 'verb stem + たい', example: null },
  { id_grammar: 3, grammar_point: '〜てもいい', meaning: 'may; it is okay to', structure: 'て-form + もいい', example: null },
  { id_grammar: 4, grammar_point: '〜てください', meaning: 'please do', structure: 'て-form + ください', example: null }
];

function ids(items, idKey) {
  return items.map((item) => item[idKey]);
}

test.after(async () => {
  await pool.end();
});

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withPoolStubs(stubs, callback) {
  const originals = {};
  for (const [method, replacement] of Object.entries(stubs)) {
    originals[method] = pool[method];
    pool[method] = replacement;
  }
  try {
    await callback();
  } finally {
    for (const [method, original] of Object.entries(originals)) pool[method] = original;
  }
}

async function getJson(server, route) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
  return { response, data: await response.json() };
}

test('normalizes ordinary romaji deterministically', () => {
  assert.equal(normalizeRomaji('  NihonGo  '), 'nihongo');
  assert.equal(normalizeRomaji("  shin’you  "), "shin'you");
  assert.equal(normalizeRomaji('日本語'), null);
  assert.throws(() => normalizeRomaji({}), /must be a string/i);
});

test('transliterates common syllables, contracted sounds, sokuon and standalone n', () => {
  const examples = {
    nihongo: 'にほんご',
    taberu: 'たべる',
    gakkou: 'がっこう',
    kitte: 'きって',
    sensei: 'せんせい',
    shoku: 'しょく',
    kudasai: 'ください',
    ryokou: 'りょこう',
    chotto: 'ちょっと'
  };
  Object.entries(examples).forEach(([romaji, hiragana]) => {
    assert.equal(romajiToHiragana(romaji), hiragana, romaji);
  });
});

test('supports common keyboard variants, separators and incremental romaji prefixes', () => {
  const variants = {
    si: 'し',
    ti: 'ち',
    tu: 'つ',
    hu: 'ふ',
    zi: 'じ',
    konnyaku: 'こんにゃく',
    annai: 'あんない',
    onna: 'おんな',
    matcha: 'まっちゃ',
    'nihon go': 'にほんご',
    'nihon-go': 'にほんご'
  };
  Object.entries(variants).forEach(([romaji, hiragana]) => {
    assert.equal(romajiToHiragana(romaji), hiragana, romaji);
    assert.equal(buildSearchCandidates(romaji).romajiComplete, true, romaji);
  });

  const expectedPrefixes = {
    n: ['ん', 'な', 'に', 'の'],
    nih: ['にほ'],
    ny: ['にゃ'],
    sh: ['し', 'しゃ'],
    ch: ['ち', 'ちゃ'],
    ts: ['つ'],
    ky: ['きゃ']
  };
  Object.entries(expectedPrefixes).forEach(([query, expected]) => {
    const generated = buildSearchCandidates(query).kanaCandidates.map(({ hiragana }) => hiragana);
    expected.forEach((candidate) => assert.equal(generated.includes(candidate), true, `${query} -> ${candidate}`));
  });
});

test('normalizes katakana and punctuation-bearing Japanese readings', () => {
  assert.equal(katakanaToHiragana('ショク'), 'しょく');
  assert.equal(katakanaToHiragana('ミズ'), 'みず');
  assert.equal(normalizeJapaneseReading('た.べる'), 'たべる');
  assert.equal(normalizeJapaneseReading('〜ても・いい'), 'てもいい');
});

test('builds raw, romaji, kana and normalized Japanese candidates', () => {
  assert.deepEqual(buildSearchCandidates('taberu'), {
    raw: 'taberu',
    normalizedRomaji: 'taberu',
    hiragana: 'たべる',
    katakana: 'タベル',
    kanaCandidates: [{ hiragana: 'たべる', katakana: 'タベル' }],
    normalizedJapanese: 'たべる',
    romajiComplete: true
  });
  assert.deepEqual(buildSearchCandidates('ショク'), {
    raw: 'ショク',
    normalizedRomaji: null,
    hiragana: null,
    katakana: 'ショク',
    kanaCandidates: [{ hiragana: 'しょく', katakana: 'ショク' }],
    normalizedJapanese: 'しょく',
    romajiComplete: false
  });
});

test('derives display romaji without persisting it', () => {
  assert.equal(hiraganaToRomaji('にほんご'), 'nihongo');
  assert.equal(hiraganaToRomaji('がっこう'), 'gakkou');
  assert.equal(hiraganaToRomaji('ショク'), 'shoku');
});

test('ranks vocabulary across romaji, Japanese, kana and English meaning', () => {
  const search = (query) => rankVocabularyOptions(VOCABULARY_ROWS, buildSearchCandidates(query), 20);
  assert.deepEqual(ids(search('nihongo'), 'id_vocabulary'), [2]);
  assert.deepEqual(ids(search('nih'), 'id_vocabulary'), [1, 2]);
  assert.deepEqual(ids(search('taberu'), 'id_vocabulary'), [4]);
  assert.deepEqual(ids(search('tabe'), 'id_vocabulary'), [4]);
  assert.deepEqual(ids(search('にほん'), 'id_vocabulary'), [1, 2]);
  assert.deepEqual(ids(search('日本'), 'id_vocabulary'), [1, 2]);
  assert.deepEqual(ids(search('language'), 'id_vocabulary'), [2]);
  assert.deepEqual(ids(search('eat'), 'id_vocabulary'), [4, 3]);
  assert.equal(search('nihongo')[0].displayRomaji, 'nihongo');
});

test('ranks exact matches before prefixes, applies limits, and preserves unsearched SQL order', () => {
  const vocabulary = [
    { id_vocabulary: 31, word: '日本語学', reading: 'にほんごがく', meaning: 'Japanese studies' },
    { id_vocabulary: 30, word: '日本語', reading: 'にほんご', meaning: 'Japanese language' },
    { id_vocabulary: 29, word: '無関係', reading: 'むかんけい', meaning: 'unrelated' }
  ];
  assert.deepEqual(
    ids(rankVocabularyOptions(vocabulary, buildSearchCandidates('nihongo'), 2), 'id_vocabulary'),
    [30, 31]
  );
  assert.deepEqual(
    ids(rankVocabularyOptions(vocabulary, buildSearchCandidates('nihongo'), 1), 'id_vocabulary'),
    [30]
  );

  const kanji = [
    { id_kanji: 41, character_kanji: '品', meaning: 'goods', onyomi: 'ショクヒン', kunyomi: null },
    { id_kanji: 40, character_kanji: '食', meaning: 'food', onyomi: 'ショク', kunyomi: 'た.べる' },
    { id_kanji: 39, character_kanji: '水', meaning: 'water', onyomi: 'スイ', kunyomi: 'みず' }
  ];
  assert.deepEqual(ids(rankKanjiOptions(kanji, buildSearchCandidates('shoku'), 3), 'id_kanji'), [40, 41]);

  const grammar = [
    { id_grammar: 51, grammar_point: '〜てもいい', meaning: 'may', structure: null, example: null },
    { id_grammar: 50, grammar_point: '〜ても', meaning: 'even if', structure: null, example: null },
    { id_grammar: 49, grammar_point: '〜から', meaning: 'because', structure: null, example: null }
  ];
  assert.deepEqual(ids(rankGrammarOptions(grammar, buildSearchCandidates('temo'), 3), 'id_grammar'), [50, 51]);

  const unsearched = rankVocabularyOptions(vocabulary, buildSearchCandidates(''), 20);
  assert.deepEqual(ids(unsearched, 'id_vocabulary'), [31, 30, 29]);
});

test('matches alternate romaji spellings and katakana vocabulary without stored romaji', () => {
  const rows = [
    { id_vocabulary: 61, word: 'テスト', reading: 'テスト', meaning: 'test' },
    { id_vocabulary: 60, word: '詩', reading: 'し', meaning: 'poem' }
  ];
  assert.deepEqual(ids(rankVocabularyOptions(rows, buildSearchCandidates('tesuto'), 20), 'id_vocabulary'), [61]);
  assert.deepEqual(ids(rankVocabularyOptions(rows, buildSearchCandidates('てすと'), 20), 'id_vocabulary'), [61]);
  assert.deepEqual(ids(rankVocabularyOptions(rows, buildSearchCandidates('si'), 20), 'id_vocabulary'), [60]);
});

test('romaji reading matches rank above weaker English contains matches', () => {
  const rows = [
    { id_vocabulary: 71, word: '日本語', reading: 'にほんご', meaning: 'Japanese language' },
    { id_vocabulary: 70, word: '下', reading: 'げ', meaning: 'below' }
  ];
  assert.deepEqual(ids(rankVocabularyOptions(rows, buildSearchCandidates('ge'), 20), 'id_vocabulary'), [70, 71]);
  assert.deepEqual(ids(rankVocabularyOptions(rows, buildSearchCandidates('language'), 20), 'id_vocabulary'), [71]);
});

test('ranks kanji through normalized onyomi, kunyomi, romaji and meaning', () => {
  const search = (query) => rankKanjiOptions(KANJI_ROWS, buildSearchCandidates(query), 20);
  for (const query of ['shoku', 'ショク', 'しょく', 'taberu', 'たべる']) {
    assert.deepEqual(ids(search(query), 'id_kanji'), [1], query);
  }
  for (const query of ['mizu', 'みず', 'water']) {
    assert.deepEqual(ids(search(query), 'id_kanji'), [2], query);
  }
  assert.equal(search('shoku')[0].displayRomaji, 'shoku / taberu');
});

test('ranks grammar through decoration-normalized kana, romaji and English meaning', () => {
  const search = (query) => rankGrammarOptions(GRAMMAR_ROWS, buildSearchCandidates(query), 20);
  assert.deepEqual(ids(search('kara'), 'id_grammar'), [1]);
  assert.deepEqual(ids(search('tai'), 'id_grammar'), [2]);
  assert.deepEqual(ids(search('temo'), 'id_grammar'), [3]);
  assert.deepEqual(ids(search('kudasai'), 'id_grammar'), [4]);
  assert.deepEqual(ids(search('because'), 'id_grammar'), [1]);
  assert.deepEqual(ids(search('want'), 'id_grammar'), [2]);
  assert.deepEqual(ids(search('〜てもいい'), 'id_grammar'), [3]);
  assert.equal(search('temo')[0].displayRomaji, 'temoii');
});

test('paginated library endpoints use romaji candidates without breaking counts or filters', async () => {
  const calls = [];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 1 }]];
      if (sql.includes('FROM vocabulary')) return [[VOCABULARY_ROWS[1]]];
      if (sql.includes('FROM kanji')) return [[KANJI_ROWS[0]]];
      return [[GRAMMAR_ROWS[2]]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const cases = [
        {
          route: '/api/vocabulary?search=nihongo&jlpt=N5&status=Learning&page=1&limit=30',
          idKey: 'id_vocabulary',
          id: 2,
          candidates: ['%にほんご%', '%ニホンゴ%']
        },
        {
          route: '/api/kanji?search=shoku&jlpt=N5&status=Learning&page=1&limit=30',
          idKey: 'id_kanji',
          id: 1,
          candidates: ['%しょく%', '%ショク%']
        },
        {
          route: '/api/grammar?search=temo&jlpt=N5&status=Learning&page=1&limit=30',
          idKey: 'id_grammar',
          id: 3,
          candidates: ['%ても%', '%テモ%']
        }
      ];

      for (const { route, idKey, id } of cases) {
        const { response, data } = await getJson(server, route);
        assert.equal(response.status, 200, route);
        assert.equal(data.items[0][idKey], id);
        assert.equal(data.pagination.total, 1);
      }

      cases.forEach(({ candidates }, index) => {
        const countCall = calls[index * 2];
        const listCall = calls[(index * 2) + 1];
        candidates.forEach((candidate) => assert.equal(countCall.params.includes(candidate), true));
        assert.equal(countCall.params.includes('N5'), true);
        assert.equal(countCall.params.includes('Learning'), true);
        assert.deepEqual(listCall.params.slice(0, countCall.params.length), countCall.params);
        assert.deepEqual(listCall.params.slice(-2), [30, 0]);
        assert.match(listCall.sql, /ORDER BY CASE/);
        assert.equal((listCall.sql.match(/\?/g) || []).length, listCall.params.length);
      });
    } finally {
      await stopServer(server);
    }
  });
});

test('romaji-aware option endpoints preserve Japanese and English search with ranked readings', async () => {
  const calls = [];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM vocabulary')) return [VOCABULARY_ROWS];
      if (sql.includes('FROM kanji')) return [KANJI_ROWS];
      return [GRAMMAR_ROWS];
    }
  }, async () => {
    const server = await startServer();
    try {
      const cases = [
        ['/api/vocabulary/options?search=nihongo&limit=20', 'id_vocabulary', [2]],
        ['/api/vocabulary/options?search=nih&limit=20', 'id_vocabulary', [1, 2]],
        ['/api/vocabulary/options?search=n&limit=20', 'id_vocabulary', [3, 1, 2]],
        ['/api/vocabulary/options?search=taberu&limit=20', 'id_vocabulary', [4]],
        ['/api/vocabulary/options?search=tabe&limit=20', 'id_vocabulary', [4]],
        [`/api/vocabulary/options?search=${encodeURIComponent('たべる')}&limit=20`, 'id_vocabulary', [4]],
        [`/api/vocabulary/options?search=${encodeURIComponent('日本')}&limit=20`, 'id_vocabulary', [1, 2]],
        ['/api/vocabulary/options?search=language&limit=20', 'id_vocabulary', [2]],
        ['/api/vocabulary/options?search=eat&limit=20', 'id_vocabulary', [4, 3]],
        ['/api/kanji/options?search=shoku&limit=20', 'id_kanji', [1]],
        [`/api/kanji/options?search=${encodeURIComponent('ショク')}&limit=20`, 'id_kanji', [1]],
        [`/api/kanji/options?search=${encodeURIComponent('しょく')}&limit=20`, 'id_kanji', [1]],
        ['/api/kanji/options?search=taberu&limit=20', 'id_kanji', [1]],
        [`/api/kanji/options?search=${encodeURIComponent('たべる')}&limit=20`, 'id_kanji', [1]],
        ['/api/kanji/options?search=mizu&limit=20', 'id_kanji', [2]],
        ['/api/kanji/options?search=water&limit=20', 'id_kanji', [2]],
        ['/api/grammar/options?search=kara&limit=20', 'id_grammar', [1]],
        ['/api/grammar/options?search=tai&limit=20', 'id_grammar', [2]],
        ['/api/grammar/options?search=temo&limit=20', 'id_grammar', [3]],
        ['/api/grammar/options?search=kudasai&limit=20', 'id_grammar', [4]],
        ['/api/grammar/options?search=because&limit=20', 'id_grammar', [1]],
        ['/api/grammar/options?search=want&limit=20', 'id_grammar', [2]],
        [`/api/grammar/options?search=${encodeURIComponent('〜てもいい')}&limit=20`, 'id_grammar', [3]]
      ];

      for (const [route, idKey, expectedIds] of cases) {
        const { response, data } = await getJson(server, route);
        assert.equal(response.status, 200, route);
        assert.deepEqual(ids(data.items, idKey), expectedIds, route);
        data.items.forEach((item) => assert.equal(typeof item.displayRomaji, 'string'));
      }

      calls.forEach(({ sql, params }) => {
        assert.match(sql, /^SELECT /);
        assert.match(sql, /ORDER BY CASE/);
        assert.doesNotMatch(sql, /\bromaji\b/i);
        assert.equal((sql.match(/\?/g) || []).length, params.length);
      });
      const shokuCall = calls.find(({ params }) => params.includes('shoku'));
      assert.equal(shokuCall.params.includes('%しょく%'), true);
      assert.equal(shokuCall.params.includes('%ショク%'), true);
      const nCall = calls.find(({ params }) => params.includes('n'));
      assert.equal(nCall.params.includes('%に%'), true);
      assert.equal(nCall.params.includes('%の%'), true);
      const taberuCall = calls.find(({ params }) => params.includes('taberu'));
      assert.equal(taberuCall.params.includes('%たべる%'), true);
      assert.equal(Object.hasOwn(VOCABULARY_ROWS[0], 'displayRomaji'), false);
    } finally {
      await stopServer(server);
    }
  });
});

test('option response limits also apply when database stubs return extra rows', async () => {
  const calls = [];
  const extraKanji = [
    ...KANJI_ROWS,
    { id_kanji: 3, character_kanji: '日', meaning: 'day', onyomi: 'ニチ', kunyomi: 'ひ' }
  ];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM vocabulary')) return [VOCABULARY_ROWS];
      if (sql.includes('FROM kanji')) return [extraKanji];
      return [GRAMMAR_ROWS];
    }
  }, async () => {
    const server = await startServer();
    try {
      for (const endpoint of ['/api/vocabulary/options', '/api/kanji/options', '/api/grammar/options']) {
        const { response, data } = await getJson(server, `${endpoint}?limit=2`);
        assert.equal(response.status, 200, endpoint);
        assert.equal(data.items.length, 2, endpoint);
      }
      calls.forEach(({ sql, params }) => {
        assert.doesNotMatch(sql, /ORDER BY CASE/);
        assert.match(sql, /ORDER BY id_\w+ DESC LIMIT \?$/);
        assert.equal(params.at(-1), 2);
      });
    } finally {
      await stopServer(server);
    }
  });
});

test('romaji option search stays bounded and parameterized under hostile input', async () => {
  const injection = "x%' OR 1=1; DROP TABLE vocabulary; --";
  const calls = [];
  await withPoolStubs({
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return [[]];
    }
  }, async () => {
    const server = await startServer();
    try {
      const endpoints = ['/api/vocabulary/options', '/api/kanji/options', '/api/grammar/options'];
      for (const endpoint of endpoints) {
        const hostile = await getJson(server, `${endpoint}?search=${encodeURIComponent(injection)}&limit=20`);
        assert.equal(hostile.response.status, 200, endpoint);
        assert.deepEqual(hostile.data.items, []);
      }
      assert.equal(calls.length, 3);
      calls.forEach(({ sql, params }) => {
        assert.doesNotMatch(sql, /DROP TABLE|OR 1=1/);
        assert.match(sql, /LIMIT \?/);
        assert.equal((sql.match(/\?/g) || []).length, params.length);
        assert.equal(params.some((value) => String(value).includes('DROP TABLE')), true);
        assert.equal(Number.isInteger(params.at(-1)) && params.at(-1) <= 200, true);
      });

      const callCount = calls.length;
      for (const endpoint of endpoints) {
        for (const suffix of [
          `?search=${'a'.repeat(101)}`,
          '?search=a&search=b',
          '?search=valid&limit=101'
        ]) {
          const { response } = await getJson(server, `${endpoint}${suffix}`);
          assert.equal(response.status, 400, `${endpoint}${suffix}`);
        }
      }
      assert.equal(calls.length, callCount);
    } finally {
      await stopServer(server);
    }
  });
});

test('object search values are rejected before any option query executes', async () => {
  let queryCount = 0;
  await withPoolStubs({
    execute: async () => {
      queryCount += 1;
      return [[]];
    }
  }, async () => {
    for (const handler of [listVocabularyOptions, listKanjiOptions, listGrammarOptions]) {
      const response = {
        statusCode: 200,
        payload: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return this;
        }
      };
      await handler({ query: { search: { invalid: true }, limit: '20' } }, response);
      assert.equal(response.statusCode, 400);
      assert.match(response.payload.error, /string/i);
    }
    assert.equal(queryCount, 0);
  });
});
