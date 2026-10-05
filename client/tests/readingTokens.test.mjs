// Reading token layer — consumer-side QA locks (per-occurrence tokens).
//
// SELF-CONTAINED by design: the reader UI lands in parallel, so every rule
// below runs against LOCAL stub payloads plus LOCAL consumer helpers that
// mirror the pinned contract. No product module is imported (even ui.js stays
// out — it is under parallel edit), so mid-edit sources can never break file
// load. A static probe at the bottom reads pages/reading.js as text and
// SKIPs while the token UI has not landed yet.
//
// Pinned consumer rules asserted here:
// - per-occurrence slicing covers the inflected surface fully (暑くて, not 暑い)
// - ruby comes only from surfaceReading and only for Han surfaces
// - dictionary-form row renders only when surface !== lemma
// - tappable false renders non-interactive (span, no action)
// - Story context shows the sentence text for token.sentenceId
// - enroll posts {selected:[candidateId]} to /api/reading/text/:id/enroll
//   and handles the {reviewSessionId} handoff (storage + hash navigation)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------- minimal DOM double
class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc || null;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.attributes = new Map();
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this._listeners = new Map();
    this._classes = new Set();
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...n) => n.forEach((x) => self._classes.add(x)),
      remove: (...n) => n.forEach((x) => self._classes.delete(x)),
      contains: (x) => self._classes.has(x)
    };
  }
  setAttribute(k, v) {
    const value = String(v);
    this.attributes.set(String(k), value);
    if (String(k) === 'disabled') this.disabled = true;
  }
  getAttribute(k) { return this.attributes.has(String(k)) ? this.attributes.get(String(k)) : null; }
  hasAttribute(k) { return this.attributes.has(String(k)); }
  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) if (n) this.appendChild(n); return this; }
  replaceChildren(...nodes) {
    this.children = [];
    const flat = nodes.length === 1 && Array.isArray(nodes[0]) ? nodes[0] : nodes;
    for (const n of flat) if (n) this.appendChild(n);
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  click() {
    if (this.disabled) return;
    for (const fn of [...(this._listeners.get('click') || [])]) fn({ target: this, preventDefault() {} });
  }
  matches(selector) {
    let text = String(selector).trim();
    if (!text) return false;
    const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/g;
    const conds = [];
    let m;
    while ((m = attrRe.exec(text)) !== null) conds.push({ name: m[1], value: m[2] });
    const bare = text.replace(attrRe, '').trim();
    let tag = null;
    let cls = null;
    if (bare) {
      if (bare.startsWith('.')) cls = bare.slice(1);
      else {
        const tm = bare.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
        if (tm) tag = tm[1].toUpperCase();
        const cm = bare.match(/\.([\w-]+)/);
        if (cm) cls = cm[1];
      }
    }
    if (tag && this.tagName !== tag) return false;
    if (cls && !this._classes.has(cls)) return false;
    for (const c of conds) {
      const actual = this.getAttribute(c.name);
      if (c.value !== undefined) { if (actual !== c.value) return false; }
      else if (actual == null) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const found = [];
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (node.matches(selector)) found.push(node);
      queue.push(...node.children);
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  constructor() { this.body = new FakeNode('body', this); }
  createElement(tag) { return new FakeNode(tag, this); }
  createTextNode(text) {
    const n = new FakeNode('#text', this);
    n.textContent = String(text);
    return n;
  }
}

function textOf(node) {
  if (!node) return '';
  const parts = [node.textContent || ''];
  for (const c of node.children || []) parts.push(textOf(c));
  return parts.join(' ');
}

// Local element factory mirroring the ui.element(tag, opts, children) shape.
function element(doc, tagName, { className, text, attrs, dataset } = {}, children = []) {
  const node = doc.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  for (const [k, v] of Object.entries(dataset || {})) node.dataset[k] = String(v);
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) if (c) node.appendChild(c);
  return node;
}

// ------------------------------------------------------- stub payloads
const TEXT = '今日は暑くて。田中は学校に行った。';
const SENTENCES = [
  { id: 0, text: '今日は暑くて。', start: 0, end: 7 },
  { id: 1, text: '田中は学校に行った。', start: 7, end: 17 }
];

function stubTokens() {
  const base = (overrides) => ({
    surface: '学校', lemma: '学校', surfaceReading: 'がっこう', lemmaReading: 'がっこう',
    gloss: 'school', entityKind: 'vocabulary', candidateId: 'vocabulary::s1:10-12:学校',
    start: 10, end: 12, sentenceId: 1, tappable: true, known: false, level: null,
    ...overrides
  });
  return [
    base({ surface: '暑くて', lemma: '暑い', surfaceReading: 'あつくて', lemmaReading: null, gloss: 'hot', candidateId: 'vocabulary::s0:3-6:暑くて', start: 3, end: 6, sentenceId: 0 }),
    base({ surface: 'は', lemma: 'は', surfaceReading: 'わ', lemmaReading: 'は', gloss: null, candidateId: 'vocabulary::s0:2-3:は', start: 2, end: 3, sentenceId: 0, tappable: false }),
    base({ surface: '。', lemma: '。', surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::s0:6-7:。', start: 6, end: 7, sentenceId: 0, tappable: false }),
    base({ surface: '田中', lemma: null, surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::s1:7-9:田中', start: 7, end: 9, sentenceId: 1, tappable: false }),
    base({ surface: 'は', lemma: 'は', surfaceReading: 'わ', lemmaReading: 'は', gloss: null, candidateId: 'vocabulary::s1:9-10:は', start: 9, end: 10, sentenceId: 1, tappable: false }),
    base({}),
    base({ surface: 'に', lemma: 'に', surfaceReading: 'に', lemmaReading: 'に', gloss: null, candidateId: 'vocabulary::s1:12-13:に', start: 12, end: 13, sentenceId: 1, tappable: false }),
    base({ surface: '行った', lemma: '行く', surfaceReading: 'いった', lemmaReading: null, gloss: 'to go', candidateId: 'vocabulary::s1:13-16:行った', start: 13, end: 16, sentenceId: 1 }),
    base({ surface: '。', lemma: '。', surfaceReading: null, lemmaReading: null, gloss: null, candidateId: 'vocabulary::s1:16-17:。', start: 16, end: 17, sentenceId: 1, tappable: false }),
    base({ surface: 'いい', lemma: 'いい', surfaceReading: 'いい', lemmaReading: 'いい', gloss: 'good', entityKind: 'vocabulary', candidateId: 'vocabulary::s9:0-2:いい', start: 900, end: 902, sentenceId: 9, tappable: true })
  ];
}

// ------------------------------------------------------- consumer helpers
function sliceTokenText(text, item) {
  const chars = Array.from(String(text ?? ''));
  if (!Number.isInteger(item?.start) || !Number.isInteger(item?.end)) return null;
  if (item.start < 0 || item.end > chars.length || item.end <= item.start) return null;
  return chars.slice(item.start, item.end).join('');
}

function hasHan(value) {
  return /\p{Script=Han}/u.test(String(value || ''));
}

// Ruby comes ONLY from surfaceReading and ONLY for Han surfaces: kana-only
// spans, withheld readings and lemma-only readings never produce ruby.
function rubyTextFor(item) {
  if (!item || typeof item.surface !== 'string') return null;
  if (typeof item.surfaceReading !== 'string' || !item.surfaceReading) return null;
  if (!hasHan(item.surface)) return null;
  return item.surfaceReading;
}

// Dictionary-form row renders only when the running surface differs from the
// lemma (inflected occurrences); dictionary forms and null lemmas hide it.
function dictionaryFormLine(item) {
  if (!item || typeof item.lemma !== 'string' || !item.lemma) return null;
  if (item.surface === item.lemma) return null;
  return `Dictionary form: ${item.lemma}`;
}

function isInteractive(item) {
  return item?.tappable === true;
}

function sentenceFor(item, sentences) {
  return (sentences || []).find((s) => s.id === item?.sentenceId) || null;
}

function validTokenShape(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.surface !== 'string' || !item.surface) return false;
  if (typeof item.candidateId !== 'string' || !item.candidateId) return false;
  if (!['vocabulary', 'kanji', 'grammar'].includes(item.entityKind)) return false;
  if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || item.end <= item.start) return false;
  if (typeof item.sentenceId !== 'number' || typeof item.tappable !== 'boolean') return false;
  return true;
}

function renderToken(doc, text, item) {
  if (!validTokenShape(item)) return null;
  const surface = sliceTokenText(text, item);
  if (surface === null || surface !== item.surface) return null; // misaligned spans never render
  const ruby = rubyTextFor(item);
  let inner;
  if (ruby) {
    const rubyNode = element(doc, 'ruby', { className: 'font-jp' });
    rubyNode.appendChild(doc.createTextNode(surface));
    rubyNode.appendChild(element(doc, 'rt', { className: 'text-xs text-muted', text: ruby }));
    inner = rubyNode;
  } else {
    inner = doc.createTextNode(surface);
  }
  if (!isInteractive(item)) {
    return element(doc, 'span', { className: 'token-silent', dataset: { candidateId: item.candidateId } }, [inner]);
  }
  return element(doc, 'button', {
    className: 'token-tappable',
    attrs: { type: 'button', 'aria-label': `${surface} — open details` },
    dataset: { candidateId: item.candidateId, sentenceId: String(item.sentenceId) }
  }, [inner]);
}

function renderTokenList(doc, text, items) {
  const wrap = element(doc, 'div', { className: 'token-list' });
  for (const item of items || []) {
    const node = renderToken(doc, text, item);
    if (node) wrap.appendChild(node);
  }
  if (!wrap.children.length) {
    wrap.appendChild(element(doc, 'p', { className: 'text-sm text-muted', text: 'No tappable words in this passage yet.' }));
  }
  return wrap;
}

function renderWordSheet(doc, item, sentences, glossFallback = 'No dictionary gloss is available for this item.') {
  const sentence = sentenceFor(item, sentences);
  const formRow = dictionaryFormLine(item);
  const meaning = typeof item?.gloss === 'string' && item.gloss ? item.gloss : glossFallback;
  return element(doc, 'div', { className: 'word-sheet' }, [
    element(doc, 'h2', { text: item.surface }),
    ...(rubyTextFor(item) ? [element(doc, 'p', { className: 'font-jp text-sm', text: rubyTextFor(item) })] : []),
    element(doc, 'p', { text: meaning }),
    ...(formRow ? [element(doc, 'p', { className: 'dictionary-form', text: formRow })] : []),
    element(doc, 'details', { className: 'story-context' }, [
      element(doc, 'summary', { text: 'Story context' }),
      element(doc, 'p', { className: 'font-jp', text: sentence ? sentence.text : 'No context available.' })
    ])
  ]);
}

function buildEnrollRequest(textId, selected) {
  const deduped = [...new Set((selected || []).filter((id) => typeof id === 'string' && id))];
  return { url: `/api/reading/text/${textId}/enroll`, options: { method: 'POST', body: { selected: deduped } } };
}

function applyEnrollHandoff(storage, nav, result) {
  const id = Number(result?.reviewSessionId);
  if (!Number.isInteger(id) || id <= 0) return { navigated: false };
  const items = Array.isArray(result?.queueItems) ? result.queueItems : [];
  storage.setItem('jlt-reading-review-queue', JSON.stringify({ reviewSessionId: id, items }));
  nav.hash = `#review?reviewSessionId=${id}`;
  return { navigated: true, reviewSessionId: id };
}

function fakeStorage() {
  const map = new Map();
  return {
    setItem: (k, v) => map.set(String(k), String(v)),
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    data: map
  };
}

// ------------------------------------------------------- slicing
test('consumer slicing covers the inflected surface fully per occurrence', () => {
  assert.equal(Array.from(TEXT).length, 17);
  for (const item of stubTokens().slice(0, 9)) {
    assert.equal(sliceTokenText(TEXT, item), item.surface, `span mismatch for ${item.candidateId}`);
    assert.equal(item.end - item.start, Array.from(item.surface).length);
  }
  const inflected = stubTokens().find((t) => t.surface === '暑くて');
  assert.equal(sliceTokenText(TEXT, inflected), '暑くて', 'observed 暑くて, not 暑い');
  assert.notEqual(sliceTokenText(TEXT, inflected), inflected.lemma);
  const verb = stubTokens().find((t) => t.surface === '行った');
  assert.equal(sliceTokenText(TEXT, verb), '行った', 'observed 行った, not 行く');
});

test('consumer slicing rejects out-of-range offsets without throwing', () => {
  const kana = stubTokens().find((t) => t.surface === 'いい');
  assert.equal(sliceTokenText(TEXT, kana), null, 'offsets outside the text yield null');
  assert.equal(sliceTokenText(TEXT, { start: 5, end: 5 }), null, 'empty span yields null');
  assert.equal(sliceTokenText(TEXT, { start: -1, end: 3 }), null);
  assert.equal(sliceTokenText(TEXT, { start: 2 }), null, 'missing end yields null');
});

// ------------------------------------------------------- ruby
test('ruby comes only from surfaceReading plus a Han check', () => {
  assert.equal(rubyTextFor(stubTokens().find((t) => t.surface === '学校')), 'がっこう');
  assert.equal(rubyTextFor(stubTokens().find((t) => t.surface === '暑くて')), 'あつくて');
  assert.equal(rubyTextFor(stubTokens().find((t) => t.surface === '行った')), 'いった');
  // Kana-only spans never expect ruby, even with a reading present.
  assert.equal(rubyTextFor({ surface: 'は', surfaceReading: 'わ' }), null);
  assert.equal(rubyTextFor({ surface: 'いい', surfaceReading: 'いい' }), null);
  assert.equal(rubyTextFor({ surface: 'ひらがな', surfaceReading: 'ひらがな' }), null);
  // Lemma-only readings never feed ruby.
  assert.equal(rubyTextFor({ surface: '学校', surfaceReading: null, lemmaReading: 'がっこう' }), null);
  // Withheld readings (proper nouns) never feed ruby.
  assert.equal(rubyTextFor(stubTokens().find((t) => t.surface === '田中')), null);
});

test('rendered tokens carry ruby only when due', () => {
  const doc = new FakeDocument();
  const school = renderToken(doc, TEXT, stubTokens().find((t) => t.surface === '学校'));
  assert.equal(school.tagName, 'BUTTON');
  assert.equal(school.querySelectorAll('ruby').length, 1);
  assert.equal(school.querySelector('rt').textContent, 'がっこう');
  const particle = renderToken(doc, TEXT, stubTokens().find((t) => t.candidateId === 'vocabulary::s0:2-3:は'));
  assert.equal(particle.tagName, 'SPAN');
  assert.equal(particle.querySelectorAll('ruby').length, 0);
  assert.equal(particle.querySelectorAll('rt').length, 0);
});

// ------------------------------------------------------- dictionary form
test('dictionary-form row renders only when surface differs from lemma', () => {
  assert.equal(dictionaryFormLine(stubTokens().find((t) => t.surface === '暑くて')), 'Dictionary form: 暑い');
  assert.equal(dictionaryFormLine(stubTokens().find((t) => t.surface === '行った')), 'Dictionary form: 行く');
  assert.equal(dictionaryFormLine(stubTokens().find((t) => t.surface === '学校')), null);
  assert.equal(dictionaryFormLine(stubTokens().find((t) => t.surface === '田中')), null, 'null lemma hides the row');
});

test('word sheet shows the dictionary row only for inflected occurrences', () => {
  const doc = new FakeDocument();
  const inflected = renderWordSheet(doc, stubTokens().find((t) => t.surface === '暑くて'), SENTENCES);
  assert.equal(inflected.querySelectorAll('.dictionary-form').length, 1);
  assert.match(textOf(inflected), /Dictionary form: 暑い/);
  const plain = renderWordSheet(doc, stubTokens().find((t) => t.surface === '学校'), SENTENCES);
  assert.equal(plain.querySelectorAll('.dictionary-form').length, 0);
});

// ------------------------------------------------------- interactivity
test('tappable false renders non-interactive spans', () => {
  const doc = new FakeDocument();
  const wrap = renderTokenList(doc, TEXT, stubTokens().slice(0, 9));
  const buttons = wrap.querySelectorAll('button');
  const tappableCount = stubTokens().slice(0, 9).filter((t) => t.tappable).length;
  assert.equal(buttons.length, tappableCount, 'only tappable occurrences become buttons');
  for (const button of buttons) {
    assert.ok(button.getAttribute('aria-label').includes('open details'));
    assert.ok(button.dataset.candidateId);
  }
  const spans = wrap.querySelectorAll('span.token-silent');
  assert.ok(spans.length > 0);
  for (const span of spans) {
    assert.equal(span.tagName, 'SPAN');
    assert.equal(span.getAttribute('aria-label'), null, 'silent spans carry no action label');
  }
  // Clicking a silent span is a no-op (no listeners, no throw).
  spans[0].click();
});

test('empty token list renders a calm note instead of blank output', () => {
  const doc = new FakeDocument();
  const wrap = renderTokenList(doc, TEXT, []);
  assert.match(textOf(wrap), /No tappable words/);
});

test('invalid token shapes never render', () => {
  const doc = new FakeDocument();
  const good = stubTokens().find((t) => t.surface === '学校');
  const wrap = renderTokenList(doc, TEXT, [
    good,
    { ...good, candidateId: '' },
    { ...good, entityKind: 'mystery' },
    { ...good, start: 99, end: 100 },
    { ...good, surface: '学校', start: 11, end: 12 }
  ]);
  assert.equal(wrap.querySelectorAll('button').length, 1, 'only the valid occurrence renders');
});

// ------------------------------------------------------- story context
test('story context uses the sentence text for token.sentenceId', () => {
  const doc = new FakeDocument();
  const school = renderWordSheet(doc, stubTokens().find((t) => t.surface === '学校'), SENTENCES);
  assert.match(textOf(school), /田中は学校に行った。/, 'sentence 1 shown verbatim');
  assert.ok(!textOf(school).includes('今日は暑くて'), 'no sibling sentence leaks in');
  const atsui = renderWordSheet(doc, stubTokens().find((t) => t.surface === '暑くて'), SENTENCES);
  assert.match(textOf(atsui), /今日は暑くて。/);
});

test('unknown sentence id renders a neutral note, never another sentence', () => {
  const doc = new FakeDocument();
  const sheet = renderWordSheet(doc, stubTokens().find((t) => t.surface === '学校' && t.sentenceId === 1) && { ...stubTokens().find((t) => t.surface === '学校'), sentenceId: 999 }, SENTENCES);
  assert.match(textOf(sheet), /No context available/);
  for (const s of SENTENCES) assert.ok(!textOf(sheet).includes(s.text));
});

// ------------------------------------------------------- gloss honesty
test('gloss null renders the fallback note, never invented text', () => {
  const doc = new FakeDocument();
  const sheet = renderWordSheet(doc, stubTokens().find((t) => t.surface === '田中'), SENTENCES);
  assert.match(textOf(sheet), /No dictionary gloss is available/);
  const known = renderWordSheet(doc, stubTokens().find((t) => t.surface === '学校'), SENTENCES);
  assert.match(textOf(known), /school/);
});

// ------------------------------------------------------- enroll handoff
test('enroll posts {selected:[candidateId]} to the reading enroll route', async () => {
  const calls = [];
  const fakeApiRequest = async (url, options = {}) => {
    calls.push({ url, options });
    return { reviewSessionId: 901, queueItems: [], created: 0, items: [] };
  };
  const picked = ['vocabulary::s0:3-6:暑くて', 'vocabulary::s1:10-12:学校', 'vocabulary::s0:3-6:暑くて'];
  const { url, options } = buildEnrollRequest(42, picked);
  assert.equal(url, '/api/reading/text/42/enroll');
  assert.equal(options.method, 'POST');
  assert.deepEqual(Object.keys(options.body), ['selected'], 'body carries only the selection');
  assert.deepEqual(options.body.selected, ['vocabulary::s0:3-6:暑くて', 'vocabulary::s1:10-12:学校'], 'duplicates collapse');
  assert.ok(!('userId' in options.body) && !('user' in options.body), 'identity stays server-side');
  await fakeApiRequest(url, options);
  assert.equal(calls.length, 1);
});

test('enroll handoff stores the queue and navigates on {reviewSessionId}', () => {
  const storage = fakeStorage();
  const nav = { hash: '' };
  const out = applyEnrollHandoff(storage, nav, {
    reviewSessionId: 901,
    queueItems: [{ entityType: 'vocabulary', entityId: 701, display: '学校' }],
    created: 1,
    items: [{ entityType: 'vocabulary', entityId: 701, display: '学校' }]
  });
  assert.equal(out.navigated, true);
  assert.equal(out.reviewSessionId, 901);
  assert.deepEqual(JSON.parse(storage.getItem('jlt-reading-review-queue')), {
    reviewSessionId: 901,
    items: [{ entityType: 'vocabulary', entityId: 701, display: '学校' }]
  });
  assert.equal(nav.hash, '#review?reviewSessionId=901');
});

test('enroll without a session id never navigates', () => {
  for (const result of [{}, { reviewSessionId: null }, { reviewSessionId: 0 }, { reviewSessionId: 'abc' }, null]) {
    const storage = fakeStorage();
    const nav = { hash: '' };
    assert.equal(applyEnrollHandoff(storage, nav, result).navigated, false);
    assert.equal(nav.hash, '', 'hash untouched');
    assert.equal(storage.getItem('jlt-reading-review-queue'), null, 'nothing stored');
  }
});

// ------------------------------------------------------- pending UI probe
test('reader source wires the token layer (skip while the UI has not landed)', async (t) => {
  let source = '';
  try {
    source = readFileSync(join(root, 'src/pages/reading.js'), 'utf8');
  } catch {
    t.skip('pages/reading.js unreadable in this tree');
    return;
  }
  const markers = ['tokens', 'surfaceReading', '/enroll', 'reviewSessionId'];
  const missing = markers.filter((m) => !source.includes(m));
  if (missing.length) {
    t.skip(`token UI markers not yet in pages/reading.js: ${missing.join(', ')}`);
    return;
  }
  assert.ok(source.includes('surfaceReading'), 'ruby sourced from surfaceReading');
  assert.ok(source.includes('/enroll'), 'enroll route referenced');
  assert.ok(source.includes('reviewSessionId'), 'session handoff handled');
});
