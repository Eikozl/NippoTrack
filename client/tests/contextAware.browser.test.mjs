// CA-B3 browser tests: Context-Aware analyzer integration in a real DOM.
// Uses the existing isolated Chromium harness (Vite + CDP, no framework).
// window.fetch is stubbed: /api/analyze/text serves a lexical+context
// fixture, /api/kanji/reference serves romaji conversion, POST captures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './helpers/browser.mjs';

const SETUP = `
  window.requests = []; window.saved = [];
  window.lexicalBase = (overrides = {}) => Object.assign({
    status: 'ok', engine: { name: 'kuromoji' }, candidates: [], unverified: [],
    matching: { available: true }, warnings: [], limit: 2000, durationMs: 5
  }, overrides);
  window.cand = (overrides = {}) => Object.assign({
    occurrences: 1, firstStart: 0, surfaceReading: null, observed: [],
    match: { state: 'new', ownedCount: 0, possibleMatches: [] }
  }, overrides);
  window.uniqueCompatibleItem = () => ({
    key: 'noun::学校', canonical: '学校',
    dictionaryMatch: { status: 'UNIQUE', identityStrategy: 'ORTHOGRAPHIC', lookupTruncated: false,
      entries: [{ entryId: '1000001', kanji: ['学校'], kana: ['がっこう'], posSummary: ['n'], isCommon: true, matchedSurfaces: ['学校'], kanjiCount: 1, kanaCount: 1 }],
      entryCount: 1, selectedEntryId: '1000001',
      readings: { suggested: 'がっこう', alternatives: ['がっこう'], provenance: 'dictionary' }, reason: 'single-compatible-entry' },
    interpretation: { status: 'COMPATIBLE', evaluationTruncated: false,
      selectedSense: { entryId: '1000001', senseId: 1, glosses: ['school'], glossCount: 1, pos: ['n'] },
      compatibleSenses: [{ entryId: '1000001', senseId: 1, glosses: ['school'], glossCount: 1, pos: ['n'] }],
      remainingCount: 0, evidenceSummary: { codes: ['LEMMA_EXACT', 'ORTHOGRAPHIC_EXACT', 'POS_EXACT'], excludedBy: {} }, reason: 'single-compatible-sense' }
  });
  window.uniqueAmbiguousItem = () => ({
    key: 'verb::行く', canonical: '行く',
    dictionaryMatch: { status: 'UNIQUE', identityStrategy: 'ORTHOGRAPHIC', lookupTruncated: false,
      entries: [{ entryId: '1000006', kanji: ['行く'], kana: ['いく'], posSummary: ['v5k-s'], isCommon: true, matchedSurfaces: ['行く'], kanjiCount: 1, kanaCount: 1 }],
      entryCount: 1, selectedEntryId: '1000006',
      readings: { suggested: 'いく', alternatives: ['いく'], provenance: 'dictionary' }, reason: 'single-compatible-entry' },
    interpretation: { status: 'AMBIGUOUS', evaluationTruncated: false, selectedSense: null,
      compatibleSenses: [
        { entryId: '1000006', senseId: 1, glosses: ['to go'], glossCount: 1, pos: ['v5k-s'] },
        { entryId: '1000006', senseId: 2, glosses: ['to proceed'], glossCount: 1, pos: ['v5k-s'] }
      ],
      remainingCount: 0, evidenceSummary: { codes: ['LEMMA_EXACT', 'POS_BROAD'], excludedBy: {} }, reason: 'multiple-compatible-senses' }
  });
  window.multipleItem = () => ({
    key: 'noun::はし', canonical: 'はし',
    dictionaryMatch: { status: 'MULTIPLE', identityStrategy: 'READING_FALLBACK', lookupTruncated: false,
      entries: [
        { entryId: '3000001', kanji: ['橋'], kana: ['はし'], posSummary: ['n'], isCommon: true, matchedSurfaces: ['はし'], kanjiCount: 1, kanaCount: 1 },
        { entryId: '3000002', kanji: ['箸'], kana: ['はし'], posSummary: ['n'], isCommon: false, matchedSurfaces: ['はし'], kanjiCount: 1, kanaCount: 1 }
      ],
      entryCount: 2, selectedEntryId: null,
      readings: { suggested: null, alternatives: [], provenance: null }, reason: 'multiple-compatible-entries' },
    interpretation: { status: 'AMBIGUOUS', evaluationTruncated: false, selectedSense: null,
      compatibleSenses: [
        { entryId: '3000001', senseId: 1, glosses: ['bridge'], glossCount: 1, pos: ['n'] },
        { entryId: '3000002', senseId: 1, glosses: ['chopsticks'], glossCount: 1, pos: ['n'] }
      ],
      remainingCount: 0, evidenceSummary: { codes: [], excludedBy: {} }, reason: 'multiple-compatible-entries' }
  });
  window.dictionary = () => ({ source: 'JMdict', converter: 'jmdict-simplified', version: '3.6.2', fileDate: '2026-08-31', sourceId: '1' });
  window.fullAnalysis = () => ({
    kanji: [], notice: '', jlptDistribution: {},
    lexical: window.lexicalBase({
      candidates: [
        window.cand({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun', lemmaReading: 'がっこう' }),
        window.cand({ key: 'verb::行く', canonical: '行く', lemma: '行く', pos: 'verb', lemmaReading: 'いく', observed: [{ surface: '行った', surfaceReading: 'いった', occurrences: 1, firstStart: 4 }] }),
        window.cand({ key: 'noun::はし', canonical: 'はし', lemma: 'はし', pos: 'noun', lemmaReading: null })
      ],
      context: { status: 'ok', reason: null, dictionary: window.dictionary(),
        items: [window.uniqueCompatibleItem(), window.uniqueAmbiguousItem(), window.multipleItem()],
        summary: { dictionary: { UNIQUE: 2, MULTIPLE: 1, NO_MATCH: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 },
          interpretation: { COMPATIBLE: 1, AMBIGUOUS: 2, NOT_APPLICABLE: 0, UNAVAILABLE: 0 },
          truncated: { lookup: 0, evaluation: 0 } },
        warnings: [], retryable: false, truncated: false, durationMs: 12 }
    })
  });
  window.analysis = window.fullAnalysis();
  window.fetch = async (path, options = {}) => {
    window.requests.push(String(path));
    let data;
    if (String(path).startsWith('/api/kanji/reference?')) {
      const word = new URL(path, location.href).searchParams.get('search');
      data = { transliteration: { hiragana: ({ iku: 'いく', gakkou: 'がっこう', taberu: 'たべる' })[word] } };
    } else if (path === '/api/analyze/text') data = window.analysis;
    else if (options.method === 'POST' || options.method === 'PUT') { data = { id_vocabulary: 1, ...JSON.parse(options.body) }; window.saved.push(data); }
    else data = {};
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  window.tick = () => new Promise(resolve => setTimeout(resolve, 100));
  window.clickText = text => { const node = [...document.querySelectorAll('button')].find(n => n.textContent.trim() === text); if (!node) throw Error('Button missing: ' + text); node.click(); };
  window.openAnalyzer = async () => {
    document.getElementById('modal-root').replaceChildren();
    const { renderAnalyzer } = await import('/src/pages/analyzer.js');
    await renderAnalyzer(document.getElementById('app'));
    document.querySelector('textarea').value = '学校に行った。はし';
    window.clickText('Analyze text'); await window.tick();
  };
  window.sectionText = () => document.querySelector('[aria-label="Vocabulary analysis"]').textContent;
  window.openAdd = async canonical => { window.clickAddFor(canonical); await window.tick(); };
  window.clickAddFor = canonical => {
    const cards = [...document.querySelectorAll('[aria-label="Vocabulary analysis"] li')];
    for (const card of cards) {
      const head = card.querySelector('span.text-lg');
      if (head && head.textContent.trim() === canonical) {
        const button = [...card.querySelectorAll('button')].find(n => n.textContent.startsWith('Add'));
        if (!button) throw Error('Add missing for ' + canonical);
        button.click(); return;
      }
    }
    throw Error('Card missing: ' + canonical);
  };
  window.fieldValue = name => document.querySelector('#modal-root [name="' + name + '"]').value;
`;

test('Context-Aware analyzer browser integration', { skip: !process.env.JLT_BROWSER, timeout: 300000 }, async (t) => {
  const browser = await browserFixture();
  t.after(() => browser.close());
  const run = browser.evaluate;
  await run(SETUP);

  await t.test('states render: compatible, ambiguous, multiple, attribution, no raw codes', async () => {
    const result = await run(`(async () => { await openAnalyzer(); return sectionText(); })()`);
    assert.match(result, /Compatible meaning/);
    assert.match(result, /school/);
    assert.match(result, /Dictionary reading: がっこう/);
    assert.match(result, /Possible meanings/);
    assert.match(result, /to go/);
    assert.match(result, /to proceed/);
    assert.match(result, /JLT couldn't reliably distinguish one meaning/);
    assert.match(result, /Multiple dictionary matches/);
    assert.match(result, /橋 — bridge/);
    assert.match(result, /JMdict/);
    assert.match(result, /EDRDG/);
    assert.match(result, /CC BY-SA/);
    assert.doesNotMatch(result, /LEMMA_EXACT|STAGK|STAGR|LIKELY|confidence|Q1|Q2/);
    const analyzeCalls = await run(`requests.filter(r => r === '/api/analyze/text').length`);
    assert.equal(analyzeCalls, 1);
  });

  await t.test('UNIQUE+COMPATIBLE Add prefills word, reading, meaning', async () => {
    const fields = await run(`(async () => { await openAnalyzer(); await openAdd('学校'); return { word: fieldValue('word'), reading: fieldValue('reading'), meaning: fieldValue('meaning') }; })()`);
    assert.deepEqual(fields, { word: '学校', reading: 'がっこう', meaning: 'school' });
  });

  await t.test('UNIQUE+AMBIGUOUS Add prefills word+reading, blank meaning, explicit sense pick', async () => {
    const result = await run(`(async () => {
      await openAnalyzer(); await openAdd('行く');
      const before = { word: fieldValue('word'), reading: fieldValue('reading'), meaning: fieldValue('meaning') };
      const useButton = [...document.querySelectorAll('#modal-root button')].find(n => n.textContent.includes('Use “to go”'));
      if (!useButton) throw Error('sense choice missing');
      useButton.click(); await tick();
      return { before, after: fieldValue('meaning') };
    })()`);
    assert.deepEqual(result.before, { word: '行く', reading: 'いく', meaning: '' });
    assert.equal(result.after, 'to go');
  });

  await t.test('MULTIPLE Add carries no context-derived reading or meaning', async () => {
    const fields = await run(`(async () => { await openAnalyzer(); await openAdd('はし'); return { word: fieldValue('word'), reading: fieldValue('reading'), meaning: fieldValue('meaning') }; })()`);
    assert.equal(fields.word, 'はし');
    assert.equal(fields.reading, '');
    assert.equal(fields.meaning, '');
  });

  await t.test('stale suggestions clear on word edit; user edits survive', async () => {
    const result = await run(`(async () => {
      await openAnalyzer(); await openAdd('行く');
      const word = document.querySelector('#modal-root [name="word"]');
      const type = (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
      type(word, '帰る'); await tick();
      const cleared = { reading: fieldValue('reading'), meaning: fieldValue('meaning') };
      const disabled = [...document.querySelectorAll('#modal-root button')].filter(n => n.textContent.startsWith('Use “')).every(n => n.disabled);
      type(document.querySelector('#modal-root [name="meaning"]'), 'my meaning');
      type(word, '戻る'); await tick();
      return { cleared, disabled, kept: fieldValue('meaning') };
    })()`);
    assert.equal(result.cleared.reading, '');
    assert.equal(result.disabled, true);
    assert.equal(result.kept, 'my meaning');
  });

  await t.test('romaji conversion still works inside the Context Add dialog', async () => {
    const result = await run(`(async () => {
      await openAnalyzer(); await openAdd('はし');
      const input = document.querySelector('#modal-root [name="reading"]');
      input.focus(); input.value = 'gakkou'; input.dispatchEvent(new Event('input', { bubbles: true })); input.blur(); await tick();
      return input.value;
    })()`);
    assert.equal(result, 'がっこう');
  });

  await t.test('UNAVAILABLE retryable shows Retry that re-analyzes; non-retryable shows none', async () => {
    const result = await run(`(async () => {
      window.analysis = { kanji: [], notice: '', jlptDistribution: {},
        lexical: window.lexicalBase({ candidates: [window.cand({ key: 'noun::学校', canonical: '学校', lemma: '学校', pos: 'noun', lemmaReading: 'がっこう' })],
          context: { status: 'unavailable', reason: 'reference-query-failed', dictionary: null, items: [],
            summary: { dictionary: { UNIQUE: 0, MULTIPLE: 0, NO_MATCH: 0, UNSUPPORTED: 0, UNAVAILABLE: 0 },
              interpretation: { COMPATIBLE: 0, AMBIGUOUS: 0, NOT_APPLICABLE: 0, UNAVAILABLE: 0 }, truncated: { lookup: 0, evaluation: 0 } },
            warnings: ['reference-query-failed'], retryable: true, truncated: false, durationMs: 3 } }) };
      await openAnalyzer();
      const retryableSection = sectionText();
      const before = requests.filter(r => r === '/api/analyze/text').length;
      window.clickText('Retry analysis'); await tick();
      const after = requests.filter(r => r === '/api/analyze/text').length;
      window.analysis.lexical.context = { status: 'unavailable', reason: 'version-absent', dictionary: null, items: [],
        summary: window.analysis.lexical.context.summary, warnings: ['version-absent'], retryable: false, truncated: false, durationMs: 1 };
      await openAnalyzer();
      return { retryableSection, retried: after - before, absentSection: sectionText() };
    })()`);
    assert.match(result.retryableSection, /temporarily unavailable/);
    assert.match(result.retryableSection, /Retry analysis/);
    assert.equal(result.retried, 1);
    assert.match(result.absentSection, /isn't available in this environment yet/);
    assert.doesNotMatch(result.absentSection, /Retry analysis/);
  });

  await t.test('evidence disclosure expands without raw codes; dialog traps focus', async () => {
    const result = await run(`(async () => {
      window.analysis = window.fullAnalysis(); await openAnalyzer();
      const summary = [...document.querySelectorAll('summary')].find(n => n.textContent.trim() === 'Why this matches');
      if (!summary) throw Error('Why disclosure missing');
      const focusable = document.activeElement && document.activeElement.tagName;
      summary.click(); await tick();
      const open = summary.parentElement.open === true;
      const text = summary.parentElement.textContent;
      await openAdd('学校');
      const focused = document.activeElement && document.activeElement.getAttribute('name');
      return { focusable, open, text, focused };
    })()`);
    assert.match(result.text, /Dictionary form matches/);
    assert.doesNotMatch(result.text, /LEMMA_EXACT/);
    assert.equal(result.open, true);
    assert.equal(result.focused, 'word');
  });

  for (const width of [320, 360, 375, 390, 430, 768, 1280]) {
    await t.test(`${width}px: context cards and Add dialog fit the viewport`, { timeout: 60000 }, async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: width <= 430 ? 568 : 800, deviceScaleFactor: 1, mobile: false });
      const result = await run(`(async () => {
        window.analysis = window.fullAnalysis(); await openAnalyzer(); await tick();
        const cards = [...document.querySelectorAll('[data-context-kind]')];
        const cardRects = cards.map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right }; });
        await openAdd('行く'); await tick();
        const dialog = document.querySelector('#modal-root [role="dialog"]');
        const d = dialog.getBoundingClientRect();
        return { cards: cardRects.length, cardRects, dialog: { left: d.left, right: d.right, top: d.top, bottom: d.bottom },
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
      })()`);
      assert.ok(result.cards >= 3, `expected context cards, saw ${result.cards}`);
      for (const rect of result.cardRects) {
        assert.ok(rect.left >= -1, `card left ${rect.left} within viewport at ${width}px`);
        assert.ok(rect.right <= width + 1, `card right ${rect.right} within viewport at ${width}px`);
      }
      assert.ok(result.dialog.left >= -1 && result.dialog.right <= width + 1, `dialog fits horizontally at ${width}px`);
      assert.equal(result.pageOverflow, false);
    });
  }

  await t.test('dark mode keeps every context state readable', async () => {
    const result = await run(`(async () => {
      document.documentElement.dataset.theme = 'dark';
      window.analysis = window.fullAnalysis(); await openAnalyzer();
      const text = sectionText();
      document.documentElement.dataset.theme = 'light';
      return text;
    })()`);
    assert.match(result, /Compatible meaning/);
    assert.match(result, /Possible meanings/);
    assert.match(result, /Multiple dictionary matches/);
    assert.match(result, /JMdict/);
  });
});
