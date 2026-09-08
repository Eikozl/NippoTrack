// VAF-B dialog tests: standalone hook wiring (entityPage), Analyzer
// zero-autofill-call guarantee, inline picker/a11y/provenance conventions,
// and minimal Fake-DOM interaction (debounce, prefill, stale, user-wins).
// Real-browser responsive coverage stays JLT_BROWSER-gated per repo patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Polling wait: robust under loaded event loops where fixed sleeps flake.
// Resolves when check() returns truthy; rejects on timeout.
async function waitFor(check, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

// ---------------------------------------------------------------- loader
function loadVaf({ apiRequestImpl, elementImpl, doc }) {
  const src = readSource('src/vocabularyAutofill.js');
  let code = src.replace(/import\s*\{[^}]+\}\s*from\s*['"][^'"]+['"];?/g, '');
  code = code.replace(/export\s+(?=const\s|let\s|var\s|function\s|async\s+function|class\s)/g, '');
  code += `\nreturn {
    VAF_DEBOUNCE_MS, VAF_PROVENANCE, VAF_STALE_MESSAGE, provenanceLabel, composeSenseMeaningMirror,
    createAutofillState, markUserEdited, planWordChange, isStaleAutofillResult,
    autofillMatchStatuses, normalizeReadingHint, normalizeMeaningHint,
    ownershipBannerModel, analyzerPrefillFromContext, evaluateExampleOffer,
    lookupVocabularyAutofill, fetchAutofillEntry, enableVocabularyAutofill
  };`;
  const factory = new Function('apiRequest', 'element', 'document', 'window', code);
  return factory(apiRequestImpl, elementImpl, doc, { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} });
}

// ------------------------------------------------------------- Fake DOM
class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc || null;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this._classes = new Set();
    this._listeners = new Map();
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.name = '';
    this.focused = false;
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...n) => n.forEach((x) => self._classes.add(x)),
      remove: (...n) => n.forEach((x) => self._classes.delete(x)),
      contains: (x) => self._classes.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !self._classes.has(x) : Boolean(force);
        if (on) self._classes.add(x); else self._classes.delete(x);
        return on;
      }
    };
  }
  setAttribute(k, v) {
    this.attributes.set(String(k), String(v));
    if (String(k) === 'name') this.name = String(v);
    if (String(k) === 'disabled') this.disabled = true;
  }
  getAttribute(k) { return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null; }
  removeAttribute(k) {
    this.attributes.delete(String(k));
    if (String(k) === 'disabled') this.disabled = false;
  }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { nodes.filter(Boolean).forEach((n) => this.appendChild(n)); }
  replaceChildren(...nodes) {
    this.children = [];
    // Support replaceChildren(node) and replaceChildren([nodes]) shapes.
    const flat = nodes.length === 1 && Array.isArray(nodes[0]) ? nodes[0] : nodes;
    flat.filter(Boolean).forEach((n) => this.appendChild(n));
    // Mirror textContent clearing when emptied (ui tests rely on it).
    if (!flat.filter(Boolean).length) this.textContent = '';
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c === node || (typeof c.contains === 'function' && c.contains(node)));
  }
  matches(selector) {
    const m = String(selector).match(/\[name="([^"]+)"\]/);
    if (m) return this.name === m[1] || this.getAttribute('name') === m[1];
    if (String(selector).startsWith('.')) return this._classes.has(String(selector).slice(1));
    return false;
  }
  querySelector(selector) {
    const m = String(selector).match(/\[name="([^"]+)"\]/);
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (m && (node.name === m[1] || node.getAttribute('name') === m[1])) return node;
      if (!m && String(selector).startsWith('.') && node._classes?.has(String(selector).slice(1))) return node;
      if (node.children?.length) queue.push(...node.children);
    }
    // Self-match for direct inputs.
    if (m && (this.name === m[1] || this.getAttribute('name') === m[1])) return this;
    return null;
  }
  querySelectorAll() { return []; }
  closest(selector) {
    if (String(selector) === '.field') {
      let node = this.parentNode;
      while (node) {
        if (node._classes?.has('field')) return node;
        node = node.parentNode;
      }
      return null;
    }
    return null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    this._listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatch(type) {
    for (const fn of [...(this._listeners.get(type) || [])]) fn({ target: this, currentTarget: this, preventDefault() {} });
  }
  focus() { this.focused = true; }
  click() { this.dispatch('click'); }
}

class FakeDocument {
  createElement(tag) { return new FakeNode(tag, this); }
  createDocumentFragment() { const n = new FakeNode('fragment', this); return n; }
}

function makeElement(doc) {
  return function element(tag, { className, text, attrs, dataset } = {}, children = []) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    for (const [k, v] of Object.entries(dataset || {})) node.dataset[k] = String(v);
    const list = Array.isArray(children) ? children : [children];
    // ui.element appends via appendChild; support nested arrays of one level.
    for (const child of list.filter(Boolean)) node.appendChild(child);
    return node;
  };
}

function makeDialogContent(doc, element) {
  const mk = (name, value = '') => {
    const label = element('label', { className: 'field' });
    const input = doc.createElement('input');
    input.setAttribute('name', name);
    input.name = name;
    input.value = value;
    label.appendChild(input);
    return { label, input };
  };
  const word = mk('word', '');
  const reading = mk('reading', '');
  const meaning = mk('meaning', '');
  const notes = mk('notes', 'keep me');
  const status = mk('status', 'New');
  return { content: [word.label, reading.label, meaning.label, notes.label, status.label], word: word.input, reading: reading.input, meaning: meaning.input };
}

function testPin() {
  return { sourceId: 's1', sourceName: 'JMdict', converter: 'test', converterVersion: '1', fileDate: '2026-01-01', sha256Verified: true };
}

function blankHints() {
  return {
    reading: { action: 'blank', value: null, choices: [], provenance: null },
    meaning: {
      action: 'blank', value: '', glossesUsed: [], glossCount: 0, remainingCount: 0,
      entryId: null, senseId: null, provenance: null, senseChoices: null, entryChoices: null
    }
  };
}

// Backend-realistic serialized payloads: dictionaryMatch/interpretation are
// ALWAYS nested {status,...} objects, never bare strings. Any test feeding a
// bare string here is asserting against a shape the backend never emits.
function realisticAutofillResponse(kind, overrides = {}) {
  const base = {
    reason: null,
    retryable: false,
    pin: testPin(),
    item: null,
    ownership: null,
    hint: null
  };
  if (kind === 'unique-compatible') {
    return {
      ...base,
      word: '学校',
      dictionaryMatch: {
        status: 'UNIQUE', identityStrategy: 'exact', lookupTruncated: false,
        entries: [{ entryId: '1000001', kanji: ['学校'], kana: ['がっこう'] }],
        entryCount: 1, selectedEntryId: '1000001',
        readings: { suggested: 'がっこう', alternatives: ['がっこう'], provenance: 'dictionary' }
      },
      interpretation: {
        status: 'COMPATIBLE', evaluationTruncated: false,
        selectedSense: { entryId: '1000001', senseId: 1, glosses: ['school'], pos: ['n'] },
        compatibleSenses: [{ entryId: '1000001', senseId: 1, glosses: ['school'], pos: ['n'] }],
        remainingCount: 2
      },
      fieldHints: {
        reading: { action: 'prefill', value: 'がっこう', choices: [], provenance: 'dictionary' },
        meaning: {
          action: 'prefill', value: 'school', glossesUsed: ['school'], glossCount: 1,
          remainingCount: 2, entryId: '1000001', senseId: 1, provenance: 'dictionary',
          senseChoices: null, entryChoices: null
        }
      },
      ...overrides
    };
  }
  if (kind === 'no-match') {
    return {
      ...base,
      word: 'zzz',
      dictionaryMatch: {
        status: 'NO_MATCH', identityStrategy: 'exact', lookupTruncated: false,
        entries: [], entryCount: 0, selectedEntryId: null,
        readings: { suggested: null, alternatives: [], provenance: null }, reason: 'no-match'
      },
      interpretation: {
        status: 'NOT_APPLICABLE', evaluationTruncated: false, selectedSense: null,
        compatibleSenses: [], remainingCount: 0, reason: 'nothing-to-interpret'
      },
      reason: 'no-match',
      fieldHints: blankHints(),
      hint: 'No JMdict entry matches this exact text. You can still add it manually. Tip: type the dictionary form (e.g. 行く instead of 行った).',
      ...overrides
    };
  }
  if (kind === 'unavailable-retryable') {
    return {
      ...base,
      word: 'みず',
      dictionaryMatch: {
        status: 'UNAVAILABLE', identityStrategy: 'exact', lookupTruncated: false,
        entries: [], entryCount: 0, selectedEntryId: null,
        readings: { suggested: null, alternatives: [], provenance: null }, reason: 'reference-query-failed'
      },
      interpretation: {
        status: 'NOT_APPLICABLE', evaluationTruncated: false, selectedSense: null,
        compatibleSenses: [], remainingCount: 0, reason: 'reference-unavailable'
      },
      reason: 'reference-query-failed',
      retryable: true,
      pin: null,
      fieldHints: blankHints(),
      ...overrides
    };
  }
  if (kind === 'unavailable-final') {
    return {
      ...base,
      word: 'みず',
      dictionaryMatch: {
        status: 'UNAVAILABLE', identityStrategy: 'exact', lookupTruncated: false,
        entries: [], entryCount: 0, selectedEntryId: null,
        readings: { suggested: null, alternatives: [], provenance: null }, reason: 'version-absent'
      },
      interpretation: {
        status: 'NOT_APPLICABLE', evaluationTruncated: false, selectedSense: null,
        compatibleSenses: [], remainingCount: 0, reason: 'reference-unavailable'
      },
      reason: 'version-absent',
      retryable: false,
      pin: null,
      fieldHints: blankHints(),
      ...overrides
    };
  }
  if (kind === 'multiple-hashi') {
    return {
      ...base,
      word: 'はし',
      dictionaryMatch: {
        status: 'MULTIPLE', identityStrategy: 'exact', lookupTruncated: false,
        entries: [
          { entryId: '3000001', kanji: ['橋'], kana: ['はし'] },
          { entryId: '3000002', kanji: ['箸'], kana: ['はし'] }
        ],
        entryCount: 2, selectedEntryId: null,
        readings: { suggested: null, alternatives: [], provenance: null }
      },
      interpretation: {
        status: 'AMBIGUOUS', evaluationTruncated: false, selectedSense: null,
        compatibleSenses: [
          { entryId: '3000001', senseId: 1, glosses: ['bridge'], pos: ['n'] },
          { entryId: '3000002', senseId: 1, glosses: ['chopsticks'], pos: ['n'] }
        ],
        remainingCount: 0
      },
      reason: 'multiple-entries',
      fieldHints: {
        reading: { action: 'blank', value: null, choices: [], provenance: null },
        meaning: {
          action: 'choose-entry-then-sense', value: '', glossesUsed: [], glossCount: 0,
          remainingCount: 0, entryId: null, senseId: null, provenance: null,
          senseChoices: null,
          entryChoices: [
            { entryId: '3000001', kanji: ['橋'], kana: ['はし'], glossPreview: 'bridge', pos: ['n'] },
            { entryId: '3000002', kanji: ['箸'], kana: ['はし'], glossPreview: 'chopsticks', pos: ['n'] }
          ]
        }
      },
      ...overrides
    };
  }
  throw new Error(`unknown realistic kind: ${kind}`);
}

function autofillOk(overrides = {}) {
  return { ...realisticAutofillResponse('unique-compatible'), ...overrides };
}

function entryOk(overrides = {}) {
  return {
    status: 'ok',
    pin: testPin(),
    entry: { entryId: '3000002', kanji: ['箸'], kana: ['はし'] },
    senses: [{ senseId: 1, glosses: ['chopsticks'], glossCount: 1, pos: ['n'], stagk: [], stagr: [] }],
    senseCursor: 0,
    nextCursor: null,
    truncated: false,
    totalSenses: 1,
    ...overrides
  };
}

function findButtons(nodes, needle, { exact = false } = {}) {
  const out = [];
  const queue = [...(Array.isArray(nodes) ? nodes : [nodes])];
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    if (node.tagName === 'BUTTON') {
      const label = String(node.textContent || '');
      if (exact ? label === needle : label.includes(needle)) out.push(node);
    }
    if (Array.isArray(node.children) && node.children.length) queue.push(...node.children);
  }
  return out;
}

// ------------------------------------------------- static wiring assertions
test('standalone hook mirrors the kanji pattern for create-mode vocabulary only', () => {
  const source = readSource('src/pages/entityPage.js');
  assert.ok(source.includes("from '../vocabularyAutofill.js'"), 'imports the shared VAF module');
  assert.ok(source.includes('enableVocabularyAutofill(content)'), 'standalone hook call');
  assert.ok(source.includes('ENTITY_CONFIGS.vocabulary && !record[config.idKey]'), 'create-mode vocabulary gate');
  // Edit mode and other entities keep their existing behavior.
  const hookLine = source.split('\n').find((l) => l.includes('enableVocabularyAutofill(content)'));
  assert.ok(hookLine, 'hook present');
  assert.ok(!source.includes('enableVocabularyAutofill(content, { fetchEnabled'), 'no analyzer flags leak into standalone');
});

test('VAF module consumes apiRequest signal support and ui primitives without touching the server', () => {
  const source = readSource('src/vocabularyAutofill.js');
  assert.ok(source.includes("from './api.js'"), 'colocated fetch reuses apiRequest');
  assert.ok(source.includes("from './ui.js'"), 'pickers reuse ui.js primitives');
  assert.ok(source.includes('signal'), 'AbortController signals forwarded');
  assert.ok(!source.includes('postgres'), 'never touches PostgreSQL');
  assert.ok(!source.includes('mariadb'), 'never touches the migration source');
  assert.ok(!source.includes('SUPABASE_') && !source.includes('service_role'), 'exposes no secrets');
});

test('standalone renders inline with a11y ownership banner, loading status, and pickers', () => {
  const source = readSource('src/vocabularyAutofill.js');
  for (const needle of [
    "role: 'status'", "'aria-live': 'polite'", "'aria-busy'", "role: 'group'",
    "'aria-label': 'Possible meanings", "'aria-label': 'Dictionary entries",
    'status-pill', 'button-secondary', 'sm:col-span-2', 'break-words',
    'Refresh dictionary lookup', 'Retry dictionary lookup'
  ]) {
    assert.ok(source.includes(needle), `inline UI keeps ${needle}`);
  }
  assert.ok(!source.includes('openDialog'), 'pickers render inline — never a second dialog');
  assert.ok(!source.includes('readingInput.disabled = true'), 'manual reading field stays enabled');
  assert.ok(!source.includes('meaningInput.disabled = true'), 'manual meaning field stays enabled');
});

test('provenance labels stay verbatim and out of i18n', () => {
  const source = readSource('src/vocabularyAutofill.js');
  for (const label of ['JMdict', 'Context', 'Parser', 'User']) {
    assert.ok(source.includes(`'${label}'`), `verbatim label ${label}`);
  }
  const i18n = readSource('src/i18n.js');
  assert.ok(!i18n.includes('JMdict'), 'proper-noun provenance never translated');
});

test('analyzer makes zero autofill calls on the normal path', () => {
  const source = readSource('src/pages/analyzer.js');
  assert.ok(source.includes('analyzerPrefillFromContext'), 'seeds from the cached context item');
  assert.ok(source.includes('fetchAutofillEntry'), 'only explicit entry expansion may fetch');
  assert.ok(!source.includes('/api/vocabulary/autofill'), 'no autofill endpoint literal on the analyzer path');
  assert.ok(source.includes("'/api/vocabulary'"), 'submit path unchanged (POST /api/vocabulary preserved)');
  assert.ok(source.includes('Use analyzed text'), 'explicit example action instead of auto-insert');
  assert.ok(!source.includes('lookupVocabularyAutofill'), 'analyzer never runs the standalone lookup');
});

test('analyzer keeps dirtyFields/syncStaleSuggestions semantics and extends them', () => {
  const source = readSource('src/pages/analyzer.js');
  assert.ok(source.includes('syncStaleSuggestions'), 'stale-suggestion guard preserved');
  assert.ok(source.includes("dirtyFields.add('meaning')"), 'sense picks mark user-controlled');
  assert.ok(source.includes("dirtyFields.add('example_sentence')"), 'example edits participate without weakening');
  assert.ok(source.includes('composeSenseMeaningMirror'), 'full same-sense composition, not primaryGloss-only');
  assert.ok(!source.includes('primaryGloss || choice.label'), 'primaryGloss-only fill removed from the Add dialog');
});

test('analyzer expansion branches overflow failures and guards overflow reading', () => {
  const source = readSource('src/pages/analyzer.js');
  assert.ok(source.includes("reason === 'snapshot-unavailable'"), 'stale snapshots branch to a refresh toast');
  assert.ok(source.includes('Dictionary data changed since this lookup.'), 'stale toast names the lookup change');
  assert.ok(source.includes('Could not load dictionary entry.'), 'transient toast names the entry failure');
  assert.ok(source.includes('normalizeReadingHint'), 'overflow reading consumed through the shared normalizer');
  assert.ok(source.includes("!dirtyFields.has('reading')"), 'user-edited analyzer readings are never overwritten');
  assert.ok(source.includes('Dictionary readings — choose one'), 'overflow reading choices render explicit buttons');
  assert.ok(!source.includes('alternatives[0]'), 'never falls back to the first alternative');
});

test('VAF gloss-note wording matches the language review', () => {
  assert.ok(
    readSource('src/vocabularyAutofill.js').includes('+${hint.remainingCount} more dictionary meanings. Choose the meaning that matches what you intend.'),
    'standalone remaining-count note uses the reviewed wording'
  );
  assert.ok(
    readSource('src/pages/analyzer.js').includes('+${prefill.glossMeta.remainingCount} more dictionary meanings. Additional dictionary glosses exist. Dictionary meaning — editable.'),
    'analyzer remaining-count note uses the reviewed wording'
  );
});

test('responsive posture stays compact with no fixed-width pickers', () => {
  for (const path of ['src/vocabularyAutofill.js', 'src/pages/analyzer.js']) {
    const source = readSource(path);
    assert.ok(source.includes('sm:col-span-2'), `${path} spans dialog columns on desktop`);
    assert.ok(source.includes('break-words'), `${path} wraps long dictionary text`);
  }
  const vaf = readSource('src/vocabularyAutofill.js');
  assert.ok(!vaf.includes('min-w-[') && !vaf.includes('w-['), 'no fixed-width picker utilities');
  assert.ok(!vaf.includes('.style.width'), 'no inline width measurements');
});

// ------------------------------------------------------- Fake-DOM behavior
function collectAllText(nodes) {
  const parts = [];
  const queue = [...(Array.isArray(nodes) ? nodes : [nodes])];
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    if (typeof node.textContent === 'string' && node.textContent) parts.push(node.textContent);
    if (Array.isArray(node.children) && node.children.length) queue.push(...node.children);
  }
  return parts.join(' ');
}

test('standalone lookup prefills reading+meaning with JMdict provenance and gloss note', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const calls = [];
  const vaf = loadVaf({
    apiRequestImpl: async (path, opts) => { calls.push({ path, opts }); await sleep(5); return autofillOk(); },
    elementImpl: element, doc
  });
  const { content, word, reading, meaning } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path, opts) => {
      calls.push({ path, opts });
      await sleep(5);
      return autofillOk();
    },
    debounceMs: 10
  });
  word.value = '学校';
  word.dispatch('input');
  await waitFor(() => reading.value === 'がっこう');
  assert.equal(calls.filter((c) => c.path === '/api/vocabulary/autofill').length, 1);
  assert.equal(word.value, '学校');
  assert.equal(meaning.value, 'school');
  assert.ok(collectAllText(content).includes('JMdict'), 'JMdict pill rendered inline');
  handle.destroy();
});

test('word edits debounce into a single lookup; loading never steals focus', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const calls = [];
  const vaf = loadVaf({
    apiRequestImpl: async () => autofillOk(),
    elementImpl: element, doc
  });
  const { content, word } = makeDialogContent(doc, element);
  const active = doc.createElement('input');
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path) => { calls.push(path); await sleep(5); return autofillOk(); },
    debounceMs: 15
  });
  void active;
  word.value = '学';
  word.dispatch('input');
  word.value = '学校';
  word.dispatch('input');
  word.value = '学校 ';
  word.dispatch('input');
  await waitFor(() => calls.filter((p) => p === '/api/vocabulary/autofill').length >= 1);
  // Settle window: a second lookup would only fire after another debounce.
  await sleep(60);
  assert.equal(calls.filter((p) => p === '/api/vocabulary/autofill').length, 1);
  assert.equal(word.focused, false, 'lookup status uses role=status without moving focus');
  handle.destroy();
});

test('late responses are discarded entirely; user edits always win', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading, meaning } = makeDialogContent(doc, element);
  const seen = [];
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path, opts) => {
      const w = opts.body.word;
      seen.push(w);
      if (w === '学校') await gate;
      await sleep(2);
      return autofillOk({ word: w, fieldHints: { reading: { action: 'prefill', value: `r-${w}`, choices: [], provenance: 'JMdict' }, meaning: { action: 'prefill', value: `m-${w}`, glossCount: 1, remainingCount: 0, entryId: null, senseId: null, provenance: 'JMdict', senseChoices: [], entryChoices: [] } } });
    },
    debounceMs: 5
  });
  word.value = '学校';
  word.dispatch('input');
  await waitFor(() => seen.includes('学校'));
  // User edits the reading while the first lookup is still in flight.
  reading.value = 'わたしのよみ';
  reading.dispatch('input');
  word.value = '行く';
  word.dispatch('input');
  releaseFirst();
  await waitFor(() => meaning.value === 'm-行く');
  assert.equal(reading.value, 'わたしのよみ', 'user-edited reading never overwritten');
  handle.destroy();
});

test('clearing the word clears system values but preserves notes/status', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading, meaning } = makeDialogContent(doc, element);
  const notes = content[3].querySelector('[name="notes"]');
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async () => autofillOk(),
    debounceMs: 5
  });
  word.value = '学校';
  word.dispatch('input');
  await waitFor(() => reading.value === 'がっこう');
  word.value = '';
  word.dispatch('input');
  await waitFor(() => reading.value === '');
  assert.equal(meaning.value, '', 'system-prefilled meaning cleared');
  assert.equal(meaning.value, '', 'system-prefilled meaning cleared');
  assert.equal(notes.value, 'keep me', 'user notes preserved');
  handle.destroy();
});

test('stale snapshots keep visible data with an explicit refresh action', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading, meaning } = makeDialogContent(doc, element);
  let mode = 'stale';
  const calls = [];
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path, opts) => {
      calls.push(opts.body.word);
      await sleep(2);
      if (mode === 'stale') return { reason: 'snapshot-unavailable', pin: { sourceId: 's1' } };
      return autofillOk();
    },
    debounceMs: 5
  });
  reading.value = 'typed';
  reading.dispatch('input');
  word.value = '学校';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Refresh dictionary lookup'));
  assert.equal(reading.value, 'typed', 'visible user data kept through stale snapshots');
  const before = calls.length;
  // Click the refresh button (the only button mentioning Refresh).
  const buttons = [];
  const queue = [...content];
  while (queue.length) {
    const node = queue.shift();
    if (node.tagName === 'BUTTON' && String(node.textContent).includes('Refresh')) buttons.push(node);
    if (node.children?.length) queue.push(...node.children);
  }
  assert.ok(buttons.length >= 1, 'refresh control exists');
  mode = 'fresh';
  buttons[0].click();
  await waitFor(() => meaning.value === 'school', { timeout: 3000 });
  assert.ok(calls.length > before, 'refresh starts a NEW lookup');
  handle.destroy();
});

test('unavailable shows manual fallback with retry only when retryable', async () => {
  for (const [kind, retryable] of [['unavailable-retryable', true], ['unavailable-final', false]]) {
    const doc = new FakeDocument();
    const element = makeElement(doc);
    const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
    const { content, word } = makeDialogContent(doc, element);
    const handle = vaf.enableVocabularyAutofill(content, {
      request: async () => realisticAutofillResponse(kind),
      debounceMs: 5
    });
    word.value = 'みず';
    word.dispatch('input');
    await waitFor(() => collectAllText(content).includes('manually'));
    const allText = collectAllText(content);
    assert.equal(allText.includes('Retry dictionary lookup'), retryable, `retry only when retryable=${retryable}`);
    handle.destroy();
  }
});

// ------------------------------------------------- VAF-B.1 real-shape coverage
test('nested NO_MATCH renders the neutral dictionary-form hint (string compares would miss it)', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading, meaning } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async () => realisticAutofillResponse('no-match'),
    debounceMs: 5
  });
  word.value = 'zzz';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('No JMdict entry matches'));
  assert.ok(collectAllText(content).includes('dictionary form'), 'hint points at the dictionary form');
  assert.equal(reading.value, '', 'reading degrades to manual');
  assert.equal(meaning.value, '', 'meaning degrades to manual');
  handle.destroy();
});

test('nested UNAVAILABLE (final) falls back to manual with no Retry', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async () => realisticAutofillResponse('unavailable-final'),
    debounceMs: 5
  });
  word.value = 'みず';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Dictionary lookup is unavailable'));
  assert.equal(findButtons(content, 'Retry').length, 0, 'no Retry when retryable is false');
  handle.destroy();
});

test('nested UNAVAILABLE (retryable) falls back to manual with a Retry control', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word } = makeDialogContent(doc, element);
  let calls = 0;
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async () => { calls += 1; return realisticAutofillResponse('unavailable-retryable'); },
    debounceMs: 5
  });
  word.value = 'みず';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Dictionary lookup is unavailable'));
  const retry = findButtons(content, 'Retry dictionary lookup');
  assert.equal(retry.length, 1, 'retryable UNAVAILABLE shows Retry');
  const before = calls;
  retry[0].click();
  await waitFor(() => calls > before, { timeout: 3000 });
  handle.destroy();
});

test('MULTIPLE はし renders the canonical entry picker with no auto-selection', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading, meaning } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async () => realisticAutofillResponse('multiple-hashi'),
    debounceMs: 5
  });
  word.value = 'はし';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Multiple dictionary entries'));
  const text = collectAllText(content);
  assert.ok(text.includes('橋'), 'bridge entry choice visible');
  assert.ok(text.includes('箸'), 'chopsticks entry choice visible');
  assert.equal(reading.value, '', 'reading stays blank — never alternatives[0]');
  assert.equal(meaning.value, '', 'meaning stays blank until an explicit pick');
  handle.destroy();
});

test('stale entry expansion offers Refresh (new lookup); transient offers Retry (same pin)', async () => {
  for (const [entryPayload, wantRefresh, wantRetry] of [
    [{ status: 'unavailable', reason: 'snapshot-unavailable', retryable: false, pin: null }, true, false],
    [{ status: 'unavailable', reason: 'reference-query-failed', retryable: true, pin: testPin() }, false, true]
  ]) {
    const doc = new FakeDocument();
    const element = makeElement(doc);
    const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
    const { content, word, reading } = makeDialogContent(doc, element);
    let lookups = 0;
    let expansions = 0;
    const handle = vaf.enableVocabularyAutofill(content, {
      request: async (path) => {
        await sleep(2);
        if (String(path).endsWith('/entry')) { expansions += 1; return entryPayload; }
        lookups += 1;
        return realisticAutofillResponse('multiple-hashi');
      },
      debounceMs: 5
    });
    reading.value = 'typed';
    reading.dispatch('input');
    word.value = 'はし';
    word.dispatch('input');
    await waitFor(() => collectAllText(content).includes('Multiple dictionary entries'));
    findButtons(content, '箸')[0].click();
    if (wantRefresh) {
      await waitFor(() => collectAllText(content).includes('Refresh dictionary lookup'));
      assert.ok(collectAllText(content).includes('Dictionary data changed since this lookup.'), 'stale notice shown');
      assert.equal(findButtons(content, 'Retry', { exact: true }).length, 0, 'stale offers Refresh, NOT retry');
      assert.equal(reading.value, 'typed', 'user-entered data untouched');
      const before = lookups;
      findButtons(content, 'Refresh dictionary lookup')[0].click();
      await waitFor(() => lookups > before, { timeout: 3000 });
    } else {
      await waitFor(() => collectAllText(content).includes('Could not load dictionary entry.'));
      assert.equal(findButtons(content, 'Refresh dictionary lookup').length, 0, 'transient offers Retry, NOT refresh');
      const retry = findButtons(content, 'Retry', { exact: true });
      assert.equal(retry.length, 1, 'transient failure shows Retry');
      assert.equal(reading.value, 'typed', 'user-entered data untouched');
      const before = expansions;
      retry[0].click();
      await waitFor(() => expansions > before, { timeout: 3000 });
      assert.equal(lookups, 1, 'retry repeats the same expansion, not a new lookup');
    }
    handle.destroy();
  }
});

test('entry expansion prefills overflow reading with JMdict provenance (はし→箸)', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path) => {
      await sleep(2);
      if (String(path).endsWith('/entry')) {
        return entryOk({ reading: { action: 'prefill', value: 'はし', choices: [], provenance: 'dictionary' } });
      }
      return realisticAutofillResponse('multiple-hashi');
    },
    debounceMs: 5
  });
  word.value = 'はし';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Multiple dictionary entries'));
  findButtons(content, '箸')[0].click();
  await waitFor(() => reading.value === 'はし');
  assert.ok(collectAllText(content).includes('JMdict'), 'JMdict provenance shown for the overflow reading');
  assert.ok(collectAllText(content).includes('chopsticks'), 'meaning choices still update');
  handle.destroy();
});

test('entry expansion with reading choices renders explicit buttons, never auto-fills', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path) => {
      await sleep(2);
      if (String(path).endsWith('/entry')) {
        return entryOk({
          reading: {
            action: 'choose', value: null, provenance: 'dictionary',
            choices: [
              { reading: 'はし', provenance: 'dictionary' },
              { reading: 'ハシ', provenance: 'dictionary' }
            ]
          }
        });
      }
      return realisticAutofillResponse('multiple-hashi');
    },
    debounceMs: 5
  });
  word.value = 'はし';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Multiple dictionary entries'));
  findButtons(content, '箸')[0].click();
  await waitFor(() => collectAllText(content).includes('Dictionary readings — choose one'));
  assert.equal(reading.value, '', 'no auto-selection — never alternatives[0]');
  findButtons(content, 'はし', { exact: true })[0].click();
  assert.equal(reading.value, 'はし', 'explicit reading pick applies');
  handle.destroy();
});

test('HASHI-MANUAL: user-edited reading survives entry expansion', async () => {
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, reading } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async (path) => {
      await sleep(2);
      if (String(path).endsWith('/entry')) {
        return entryOk({ reading: { action: 'prefill', value: 'はし', choices: [], provenance: 'dictionary' } });
      }
      return realisticAutofillResponse('multiple-hashi');
    },
    debounceMs: 5
  });
  word.value = 'はし';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Multiple dictionary entries'));
  reading.value = 'HASHI-MANUAL';
  reading.dispatch('input');
  findButtons(content, '箸')[0].click();
  await waitFor(() => collectAllText(content).includes('chopsticks'));
  assert.equal(reading.value, 'HASHI-MANUAL', 'overflow reading never overwrites a user-edited value');
  handle.destroy();
});

test('VAF UI strings avoid certainty language (closest/best/likely/recommended/confidence)', () => {
  for (const path of ['src/vocabularyAutofill.js', 'src/pages/analyzer.js']) {
    const source = readSource(path);
    // `.closest(` is a DOM traversal call, not user-facing copy.
    const copy = source.split('.closest').join('');
    for (const banned of ['closest', 'best', 'likely', 'recommended', 'confidence']) {
      assert.ok(!new RegExp(banned, 'i').test(copy), `${path} has no user-facing "${banned}"`);
    }
  }
});

test('backend-realistic payloads drive the client render path (§11 contract)', async () => {
  // Every payload below carries nested dictionaryMatch.status /
  // interpretation.status exactly as the backend serializes them.
  for (const kind of ['unique-compatible', 'no-match', 'unavailable-retryable', 'multiple-hashi']) {
    const shape = realisticAutofillResponse(kind);
    assert.equal(typeof shape.dictionaryMatch?.status, 'string', `${kind} carries nested dictionaryMatch.status`);
    assert.equal(typeof shape.interpretation?.status, 'string', `${kind} carries nested interpretation.status`);
  }
  const banned = [/closest/i, /\blikely\b/i, /\bbest\b/i, /recommended/i, /confidence/i];
  const scenarios = [
    {
      kind: 'unique-compatible', word: '学校',
      waitFor: 'Dictionary reading',
      assertText: (text) => assert.ok(text.includes('JMdict'), 'UNIQUE+COMPATIBLE shows JMdict provenance')
    },
    {
      kind: 'no-match', word: 'zzz',
      waitFor: 'No JMdict entry matches',
      assertText: (text) => assert.ok(text.includes('dictionary form'), 'NO_MATCH shows the dictionary-form hint')
    },
    {
      kind: 'unavailable-retryable', word: 'みず',
      waitFor: 'Dictionary lookup is unavailable',
      assertText: (text) => assert.ok(text.includes('Retry dictionary lookup'), 'retryable UNAVAILABLE shows Retry')
    },
    {
      kind: 'multiple-hashi', word: 'はし',
      waitFor: 'Multiple dictionary entries',
      assertText: (text) => {
        assert.ok(text.includes('橋') && text.includes('箸'), 'MULTIPLE shows 橋/箸 entry choices');
      }
    }
  ];
  for (const scenario of scenarios) {
    const doc = new FakeDocument();
    const element = makeElement(doc);
    const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
    const { content, word } = makeDialogContent(doc, element);
    const handle = vaf.enableVocabularyAutofill(content, {
      request: async () => realisticAutofillResponse(scenario.kind),
      debounceMs: 5
    });
    word.value = scenario.word;
    word.dispatch('input');
    await waitFor(() => collectAllText(content).includes(scenario.waitFor));
    const text = collectAllText(content);
    scenario.assertText(text);
    for (const pattern of banned) {
      assert.ok(!pattern.test(text), `${scenario.kind} renders no certainty language (${pattern})`);
    }
    handle.destroy();
  }
});

test('ownership banners render advisory states without blocking submit', async () => {
  for (const [ownership, needle] of [
    [{ state: 'existing', matches: [{ word: '学校' }] }, 'Already in Vocabulary'],
    [{ state: 'possible-match', matches: [{ word: '橋' }] }, 'Possible match'],
    [{ state: 'unavailable' }, 'Ownership unknown']
  ]) {
    const doc = new FakeDocument();
    const element = makeElement(doc);
    const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
    const { content, word } = makeDialogContent(doc, element);
    const handle = vaf.enableVocabularyAutofill(content, {
      request: async () => autofillOk({ ownership }),
      debounceMs: 5
    });
    word.value = '学校';
    word.dispatch('input');
    await waitFor(() => collectAllText(content).includes(needle));
    handle.destroy();
  }
});

test('explicit sense pick that cannot fit leaves meaning blank with a manual note', async () => {
  const longGloss = 'あ'.repeat(300);
  const doc = new FakeDocument();
  const element = makeElement(doc);
  const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
  const { content, word, meaning } = makeDialogContent(doc, element);
  const handle = vaf.enableVocabularyAutofill(content, {
    request: async () => autofillOk({
      interpretation: {
        status: 'AMBIGUOUS', evaluationTruncated: false, selectedSense: null,
        compatibleSenses: [{ entryId: '1', senseId: 1, glosses: [longGloss], pos: [] }],
        remainingCount: 0
      },
      fieldHints: {
        reading: { action: 'blank' },
        meaning: {
          action: 'choose', value: '', glossCount: 0, remainingCount: 0, provenance: 'JMdict',
          senseChoices: [{ entryId: '1', senseId: 1, glosses: [longGloss], pos: [] }],
          entryChoices: []
        }
      }
    }),
    debounceMs: 5
  });
  word.value = 'x';
  word.dispatch('input');
  await waitFor(() => collectAllText(content).includes('Possible meanings'));
  const buttons = [];
  const queue = [...content];
  while (queue.length) {
    const node = queue.shift();
    if (node.tagName === 'BUTTON' && String(node.textContent).includes(longGloss.slice(0, 10))) buttons.push(node);
    if (node.children?.length) queue.push(...node.children);
  }
  assert.ok(buttons.length >= 1, 'zero-fit sense choice renders');
  buttons[0].click();
  assert.equal(meaning.value, '', 'over-long gloss never placed in the stored field');
  assert.ok(collectAllText(content).includes('too long to fill in'), 'manual-entry note shown');
  handle.destroy();
});

// ------------------------------------------------- JLT_BROWSER responsive
test('responsive smoke: VAF dialog fits 320/375/768/1280 where a browser exists', {
  skip: !process.env.JLT_BROWSER
}, async () => {
  const { browserFixture } = await import('./helpers/browser.mjs');
  const browser = await browserFixture();
  try {
    for (const width of [320, 375, 768, 1280]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      const result = await browser.evaluate(`(async () => {
        document.getElementById('modal-root').replaceChildren();
        const { renderEntityPage, ENTITY_CONFIGS } = await import('/src/pages/entityPage.js');
        window.fetch = async (path, options = {}) => {
          let data = {};
          if (String(path).startsWith('/api/vocabulary/autofill')) {
            data = { word: '学校', dictionaryMatch: { status: 'UNIQUE', readings: { suggested: 'がっこう', alternatives: [], provenance: 'dictionary' } }, interpretation: { status: 'COMPATIBLE', selectedSense: { entryId: '1', senseId: 1, glosses: ['school'], pos: ['n'] }, remainingCount: 1 }, reason: null, retryable: false,
              pin: { sourceId: 's1' }, item: null,
              fieldHints: {
                reading: { action: 'prefill', value: 'がっこう', choices: [], provenance: 'JMdict' },
                meaning: { action: 'choose', value: '', glossCount: 0, remainingCount: 1, provenance: 'JMdict',
                  senseChoices: [{ entryId: '1', senseId: 1, glosses: ['school', 'schoolhouse'], pos: ['n'] }, { entryId: '1', senseId: 2, glosses: ['academy'], pos: ['n'] }],
                  entryChoices: [] } },
              ownership: null, hint: null };
          } else if (String(path).startsWith('/api/vocabulary')) data = { items: [], pagination: { page: 1, totalPages: 1, total: 0 } };
          return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        renderEntityPage(document.getElementById('app'), ENTITY_CONFIGS.vocabulary);
        await new Promise(r => setTimeout(r, 200));
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add vocabulary entry')).click();
        await new Promise(r => setTimeout(r, 200));
        const word = document.querySelector('#modal-root [name="word"]');
        word.value = '学校'; word.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        const dialog = document.querySelector('#modal-root [role="dialog"]');
        const d = dialog.getBoundingClientRect();
        return { left: d.left, right: d.right, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
      })()`);
      assert.ok(result.left >= -1 && result.right <= width + 1, `VAF dialog fits horizontally at ${width}px`);
      assert.equal(result.overflow, false, `no page-level horizontal overflow at ${width}px`);
    }
  } finally {
    await browser.close();
  }
});
