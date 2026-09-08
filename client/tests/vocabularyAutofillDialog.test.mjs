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
    VAF_DEBOUNCE_MS, VAF_PROVENANCE, provenanceLabel, composeSenseMeaningMirror,
    createAutofillState, markUserEdited, planWordChange, isStaleAutofillResult,
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

function autofillOk(overrides = {}) {  return {
    word: '学校',
    dictionaryMatch: 'UNIQUE',
    interpretation: 'COMPATIBLE',
    reason: null,
    retryable: false,
    pin: { sourceId: 's1' },
    item: null,
    fieldHints: {
      reading: { action: 'prefill', value: 'がっこう', choices: [], provenance: 'JMdict' },
      meaning: {
        action: 'prefill', value: 'school', glossesUsed: ['school'], glossCount: 1,
        remainingCount: 2, entryId: '1000001', senseId: 1, provenance: 'JMdict',
        senseChoices: [], entryChoices: []
      }
    },
    ownership: null,
    hint: null,
    ...overrides
  };
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
  for (const retryable of [true, false]) {
    const doc = new FakeDocument();
    const element = makeElement(doc);
    const vaf = loadVaf({ apiRequestImpl: async () => autofillOk(), elementImpl: element, doc });
    const { content, word } = makeDialogContent(doc, element);
    const handle = vaf.enableVocabularyAutofill(content, {
      request: async () => ({ word: 'x', dictionaryMatch: 'UNAVAILABLE', interpretation: 'UNAVAILABLE', reason: 'reference-query-failed', retryable, pin: null, fieldHints: { reading: { action: 'blank' }, meaning: { action: 'blank' } }, ownership: null, hint: null }),
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
      interpretation: 'AMBIGUOUS',
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
            data = { word: '学校', dictionaryMatch: 'UNIQUE', interpretation: 'COMPATIBLE', reason: null, retryable: false,
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
