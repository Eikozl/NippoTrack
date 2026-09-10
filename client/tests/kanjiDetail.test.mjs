// v5.1-B.1 Kanji Detail desktop redesign — shared identity builder contract.
// Runtime tests use the dependency-free builder (element factory injected);
// static assertions pin the composition, hooks, and preservation checklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKanjiIdentity,
  normalizeKanjiOwnedIdentity,
  normalizeKanjiReferenceIdentity
} from '../src/kanjiDetail.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (path) => readFileSync(join(root, path), 'utf8');

// --- minimal element stub (ui.element signature, no DOM) ---------------------

function stub(tag, { className = '', text = null, attrs = {} } = {}, children = []) {
  const list = Array.isArray(children) ? children : [children];
  return { tag, className, text, attrs, children: list.filter(Boolean) };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function texts(node) {
  const out = [];
  walk(node, (n) => { if (n.text !== null && n.text !== undefined) out.push(String(n.text)); });
  return out;
}

function classes(node) {
  const out = [];
  walk(node, (n) => { if (n.className) out.push(n.className); });
  return out.join(' ');
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (n) => { if (predicate(n)) out.push(n); });
  return out;
}

// --- normalize: reference ----------------------------------------------------

test('normalizeKanjiReferenceIdentity keeps every reference datum', () => {
  const normalized = normalizeKanjiReferenceIdentity({
    character: '日', meanings: ['day', 'sun'], onyomi: ['ニチ', 'ジツ'], kunyomi: ['ひ', 'か'], jlptLevel: 'N5', strokeCount: 4
  });
  assert.equal(normalized.character, '日');
  assert.equal(normalized.headline, 'day, sun');
  assert.deepEqual(normalized.meanings, ['day', 'sun']);
  assert.deepEqual(normalized.onyomiRef, ['ニチ', 'ジツ']);
  assert.deepEqual(normalized.kunyomiRef, ['ひ', 'か']);
  assert.equal(normalized.jlptLevel, 'N5');
  assert.equal(normalized.strokeCount, 4);
  assert.equal(normalized.variant, 'reference');
});

test('normalizeKanjiReferenceIdentity falls back without dropping the row', () => {
  const normalized = normalizeKanjiReferenceIdentity({ character: '日', meanings: [], onyomi: [], kunyomi: [] });
  assert.equal(normalized.headline, 'Not recorded');
  assert.deepEqual(normalized.meanings, []);
  assert.equal(normalized.jlptLevel, null);
  assert.equal(normalized.strokeCount, null);
});

// --- normalize: owned --------------------------------------------------------

test('normalizeKanjiOwnedIdentity prefers reference headline, keeps user record', () => {
  const normalized = normalizeKanjiOwnedIdentity({
    character_kanji: '食', meaning: 'eat', onyomi: 'ショク', kunyomi: 'たべる', status: 'Learning',
    reference: { meanings: ['eat', 'food'], onyomi: ['ショク'], kunyomi: ['たべる'], jlptLevel: 'N5', strokeCount: 9 }
  });
  assert.equal(normalized.character, '食');
  assert.equal(normalized.headline, 'eat · food');
  assert.equal(normalized.userMeaning, 'eat');
  assert.deepEqual(normalized.onyomiRef, ['ショク']);
  assert.equal(normalized.onyomiUser, 'ショク');
  assert.equal(normalized.jlptLevel, 'N5');
  assert.equal(normalized.strokeCount, 9);
  assert.equal(normalized.status, 'Learning');
  assert.equal(normalized.variant, 'owned');
});

test('normalizeKanjiOwnedIdentity falls back to the user meaning without reference', () => {
  const normalized = normalizeKanjiOwnedIdentity({ character_kanji: '込', meaning: 'crowded', onyomi: '', kunyomi: 'こむ', status: 'New' });
  assert.equal(normalized.headline, 'crowded');
  assert.equal(normalized.jlptLevel, null);
  assert.equal(normalized.strokeCount, null);
});

// --- builder: reference surface ----------------------------------------------

test('builder renders the reference identity with pills, readings, facts', () => {
  const tree = buildKanjiIdentity(normalizeKanjiReferenceIdentity({
    character: '日', meanings: ['day', 'sun'], onyomi: ['ニチ'], kunyomi: ['ひ'], jlptLevel: 'N5', strokeCount: 4
  }), stub);
  const body = texts(tree).join('\n');
  for (const expected of ['day, sun', 'day', 'sun', 'On’yomi', 'ニチ', 'Kun’yomi', 'ひ', 'JLPT level', 'N5', 'Strokes', '4']) {
    assert.ok(body.includes(expected), `reference identity shows "${expected}"`);
  }
  assert.ok(classes(tree).includes('kanji-identity'), 'shared identity hook');
  assert.ok(tree.attrs['aria-label'].includes('日'), 'identity labelled by character');
});

test('builder keeps reference empty states (nothing dropped)', () => {
  const tree = buildKanjiIdentity(normalizeKanjiReferenceIdentity({ character: '日', meanings: [], onyomi: [], kunyomi: [] }), stub);
  const body = texts(tree).join('\n');
  assert.ok(body.includes('Not recorded'), 'missing meanings/readings stay visible');
  assert.ok(body.includes('Not set'), 'missing JLPT/strokes stay visible');
});

// --- builder: owned surface ---------------------------------------------------

test('builder renders the owned identity with the Reference/Your-record split', () => {
  const tree = buildKanjiIdentity(normalizeKanjiOwnedIdentity({
    character_kanji: '食', meaning: 'to eat (personal)', onyomi: 'ショク', kunyomi: '', status: 'Learning',
    reference: { meanings: ['eat', 'food'], onyomi: ['ショク'], kunyomi: ['たべる'], jlptLevel: 'N5', strokeCount: 9 }
  }), stub);
  const body = texts(tree).join('\n');
  for (const expected of [
    'eat · food', 'Your record: to eat (personal)',
    "On'yomi (Reference)", 'ショク', "On'yomi (Your record)",
    "Kun'yomi (Reference)", 'たべる', "Kun'yomi (Your record)", 'Not recorded',
    'JLPT N5 (Reference)', 'Learning', '9 strokes (Ref)', 'Character: 食'
  ]) {
    assert.ok(body.includes(expected), `owned identity shows "${expected}"`);
  }
  const statusPill = findAll(tree, (n) => (n.className || '').includes('status-pill') && texts(n).join('').includes('Learning'));
  assert.ok(statusPill.length > 0, 'status pill rendered');
  assert.equal(statusPill[0].attrs.title, 'Self-reported status', 'status never color-only');
});

test('builder hides the redundant Your-record line when it matches reference', () => {
  const tree = buildKanjiIdentity(normalizeKanjiOwnedIdentity({
    character_kanji: '日', meaning: 'day, sun', onyomi: '', kunyomi: '', status: 'New',
    reference: { meanings: ['day', 'sun'], onyomi: [], kunyomi: [], jlptLevel: 'N5', strokeCount: 4 }
  }), stub);
  assert.ok(!texts(tree).join('\n').includes('Your record:'), 'no duplicate meaning line');
  assert.ok(texts(tree).join('\n').includes('—'), 'missing reference readings use the em-dash');
});

// --- builder: square panel + B.2 mount point ----------------------------------

test('builder glyph panel is square-hooked with a clean B.2 slot', () => {
  const tree = buildKanjiIdentity(normalizeKanjiOwnedIdentity({ character_kanji: '日', meaning: 'day' }), stub);
  const panels = findAll(tree, (n) => (n.className || '').includes('kanji-identity-glyph'));
  assert.equal(panels.length, 1, 'exactly one glyph panel');
  assert.ok(panels[0].className.includes('kanji-glyph-panel-large'), 'existing surface treatment reused');
  assert.ok(panels[0].className.includes('kanji-identity-glyph--square'), 'square-panel hook present');
  assert.equal(panels[0].attrs.role, 'img', 'glyph stays labelled as an image');
  const slots = findAll(tree, (n) => (n.className || '').includes('kanji-stroke-slot'));
  assert.equal(slots.length, 1, 'exactly one B.2 mount point');
  assert.equal(slots[0].attrs['data-kanji-stroke-slot'], '日', 'slot keyed by character');
  assert.equal(slots[0].attrs['aria-hidden'], 'true', 'empty slot hidden from assistive tech');
  assert.deepEqual(slots[0].children, [], 'B.1 ships the slot empty (no animation)');
});

test('builder adds no interactive elements (keyboard/focus unchanged)', () => {
  for (const tree of [
    buildKanjiIdentity(normalizeKanjiReferenceIdentity({ character: '日', meanings: ['day'], onyomi: [], kunyomi: [] }), stub),
    buildKanjiIdentity(normalizeKanjiOwnedIdentity({ character_kanji: '日', meaning: 'day' }), stub)
  ]) {
    const interactive = findAll(tree, (n) => ['button', 'input', 'select', 'textarea', 'a'].includes(n.tag));
    assert.deepEqual(interactive, [], 'identity is presentational only');
    assert.ok(!classes(tree).includes('tabindex'), 'no tabindex changes');
  }
});

// --- both surfaces share the builder (no V2, same endpoints) ------------------

test('both detail surfaces consume the one shared builder', () => {
  const entity = readSource('src/pages/entityPage.js');
  const reference = readSource('src/pages/kanjiReference.js');
  assert.ok(entity.includes("from '../kanjiDetail.js'"), 'owned view imports the shared builder');
  assert.ok(reference.includes("from '../kanjiDetail.js'"), 'reference page imports the shared builder');
  assert.ok(entity.includes('buildKanjiIdentity(normalizeKanjiOwnedIdentity(item), element)'), 'owned hero built from normalized item');
  assert.ok(reference.includes('buildKanjiIdentity(normalizeKanjiReferenceIdentity(reference), element)'), 'reference hero built from normalized lookup');
  assert.ok(!readSource('src/kanjiDetail.js').includes('KanjiDetailV2'), 'no V2 duplicate');
  assert.ok(!entity.includes('KanjiDetailV2') && !reference.includes('KanjiDetailV2'), 'no V2 duplicate in surfaces');
  assert.ok(entity.includes("endpoint: '/api/kanji'"), 'owned endpoint unchanged');
  assert.ok(reference.includes('/api/kanji/lookup/'), 'reference endpoint unchanged');
});

// --- info preservation across the two surfaces --------------------------------

test('no info dropped: every pre-B.1 datum still renders from entityPage or the shared builder', () => {
  const owned = readSource('src/pages/entityPage.js') + '\n' + readSource('src/kanjiDetail.js');
  for (const expected of [
    "On'yomi (Reference)", "On'yomi (Your record)", "Kun'yomi (Reference)", "Kun'yomi (Your record)",
    '(Reference)', 'strokes (Ref)', 'Character: ', 'Next Review', 'Interval', 'Last Reviewed', 'Last Result',
    'Total Encounters', 'First Seen', 'Last Seen', 'Vocabulary Sources', 'Session Writing Sources',
    'Recent Encounters (max 5)', 'Connected Vocabulary', 'Kanji Notes', 'Linked Notes', 'Personal Notes',
    'No review scheduled', 'No encounters yet', 'No connected vocabulary yet', 'No personal notes', 'Not recorded'
  ]) {
    assert.ok(owned.includes(expected), `owned detail keeps "${expected}"`);
  }
  const reference = readSource('src/pages/kanjiReference.js') + '\n' + readSource('src/kanjiDetail.js');
  for (const expected of ['On’yomi', 'Kun’yomi', 'JLPT level', 'Strokes', 'Not set', 'Examples of use', 'not an official syllabus']) {
    assert.ok(reference.includes(expected), `reference page keeps "${expected}"`);
  }
});

// --- responsive + square hooks in CSS ------------------------------------------

test('CSS composes desktop/tablet/mobile with the square-panel hook', () => {
  const css = readSource('src/styles.css');
  assert.ok(css.includes('.kanji-identity'), 'shared identity grid exists');
  assert.ok(css.includes('grid-template-areas: "glyph" "copy"'), 'mobile stacks glyph above identity');
  assert.ok(css.includes('@media (min-width: 1024px)'), 'desktop breakpoint exists');
  const desktop = css.slice(css.indexOf('@media (min-width: 1024px)'));
  assert.ok(desktop.includes('grid-template-areas: "copy glyph"'), 'desktop places linguistic left, glyph right');
  assert.ok(desktop.includes('minmax(0, 1fr)'), 'desktop linguistic column shrinks without overflow');
  assert.ok(css.includes('@media (min-width: 640px) and (max-width: 1023.98px)'), 'tablet transition exists');
  assert.ok(css.includes('.kanji-identity-glyph--square'), 'square-panel hook styled');
  assert.ok(css.includes('aspect-ratio: 1 / 1'), 'glyph panel stays ~square');
  assert.ok(css.includes('.kanji-stroke-slot'), 'B.2 slot styled (zero footprint)');
  assert.ok(css.includes('.dialog-panel--kanji-detail'), 'kanji dialog width hook exists');
  assert.ok(desktop.includes('.dialog-panel--kanji-detail { max-width: 56rem; }'), 'desktop dialog widens without touching shared dialogs');
});

// --- dialog width plumbing -----------------------------------------------------

test('kanji detail opens in a wide spotlight modal without changing shared dialog behavior', () => {
  const ui = readSource('src/ui.js');
  assert.ok(ui.includes('panelClass'), 'openDialog accepts a panel class');
  assert.ok(ui.includes('openDetailModal'), 'spotlight detail primitive exists for read-first detail');
  const entity = readSource('src/pages/entityPage.js');
  // v5.1-E corrective: collection detail (incl. kanji) opens centered and
  // content-wide (kanji gets the wide canvas); editing stays an explicit
  // dialog action. The cramped side drawer is no longer the detail path.
  assert.ok(entity.includes('openDetailModal('), 'owned detail opens in the spotlight modal');
  assert.ok(entity.includes("size: config === ENTITY_CONFIGS.kanji ? 'kanji' : 'default'"), 'kanji detail requests the wide canvas');
  assert.ok(!entity.includes('openDrawer('), 'side drawer is not the detail path');
  assert.ok(!entity.includes('dialog-panel--vocabulary') && !entity.includes('dialog-panel--grammar'), 'vocabulary/grammar dialogs unchanged');
  assert.ok(ui.includes("event.key === 'Escape'") && ui.includes('document.activeElement === first'), 'focus trap + ESC intact');
});

// --- theme / motion / glyph-type discipline -------------------------------------

test('B.1 styling stays token-driven with the serif glyph and no motion', () => {
  const css = readSource('src/styles.css');
  const block = css.slice(css.indexOf('v5.1-B.1 Kanji Detail identity'));
  assert.ok(block.length > 0, 'B.1 block present');
  const rulesOnly = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rulesOnly, /#[0-9a-fA-F]{3,6}/, 'B.1 block uses tokens only (dark theme follows automatically)');
  assert.doesNotMatch(rulesOnly, /gradient\(/i, 'no gradients');
  assert.doesNotMatch(rulesOnly, /animation\s*:|transition\s*:/, 'no motion added (reduced-motion intact)');
  assert.ok(block.includes('var(--jlt-') || block.includes('var(--nt-'), 'token surfaces/borders used');
  const builder = readSource('src/kanjiDetail.js');
  assert.doesNotMatch(builder, /font-family/, 'glyph keeps the existing serif stack from CSS (never overridden in JS)');
});
