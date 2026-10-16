// V6 bespoke glyph contract: NippoTrack-authored module marks render on
// the same 24-grid with the same stroke discipline as the kept Lucide set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CUSTOM_GLYPHS, icon } from '../src/icons.js';

const root = new URL('..', import.meta.url);
const readSource = (path) => readFileSync(new URL(path, root), 'utf8');

const EXPECTED = ['dashboard', 'review', 'sessions', 'vocabulary', 'kanji', 'grammar', 'analyzer', 'statistics'];
const TAGS = new Set(['rect', 'line', 'circle', 'polyline']);
const NUMERIC = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'width', 'height']);

test('bespoke set covers the eight primary modules', () => {
  assert.deepEqual(Object.keys(CUSTOM_GLYPHS).sort(), [...EXPECTED].sort());
});

test('glyphs use only grid primitives inside the 24-box', () => {
  for (const [name, nodes] of Object.entries(CUSTOM_GLYPHS)) {
    if (nodes && nodes.__text) {
      assert.equal(typeof nodes.__text, 'string', `${name}: text glyph carries a character`);
      assert.ok(Number(nodes.x) >= 0 && Number(nodes.x) <= 24, `${name}: text centered on grid`);
      assert.ok(Number(nodes.y) >= 0 && Number(nodes.y) <= 24, `${name}: text baseline on grid`);
      assert.ok(Number(nodes.fontSize) >= 10 && Number(nodes.fontSize) <= 20, `${name}: text sized for 20px rendering`);
      assert.ok(String(nodes.fontFamily).length > 0, `${name}: text declares its serif stack`);
      continue;
    }
    assert.ok(Array.isArray(nodes) && nodes.length >= 2, `${name} composes at least two primitives`);
    for (const [tag, attrs] of nodes) {
      assert.ok(TAGS.has(tag), `${name}: known primitive ${tag}`);
      assert.ok(attrs && typeof attrs === 'object', `${name}: attrs object`);
      for (const [key, value] of Object.entries(attrs)) {
        if (NUMERIC.has(key)) {
          const n = Number(value);
          assert.ok(Number.isFinite(n) && n >= 0 && n <= 24, `${name}.${tag}.${key}=${value} inside the grid`);
        }
        if (key === 'stroke-width') {
          const n = Number(value);
          assert.ok(n >= 2.2 && n <= 2.6, `${name}: emphasis stroke restrained (${value})`);
        }
        if (key === 'fill') assert.equal(value, 'currentColor', `${name}: fills only seal dots`);
      }
      if (attrs.fill === 'currentColor') assert.equal(attrs.stroke, 'none', `${name}: seal dots carry no stroke`);
    }
  }
});

test('glyphs serialize through the shared renderer with stub DOM', () => {
  const stubEl = (tag) => ({
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
  });
  const stubDoc = { createElementNS: (ns, tag) => stubEl(`${ns}|${tag}`) };
  const previous = globalThis.document;
  globalThis.document = stubDoc;
  try {
    for (const name of EXPECTED) {
      const svg = icon(name, { size: 20 });
      assert.ok(svg.tag.endsWith('|svg'), `${name} renders an svg root`);
      assert.equal(svg.attrs.width, '20', `${name} honors size`);
      assert.equal(svg.attrs.viewBox, '0 0 24 24', `${name} keeps the 24 grid`);
      const spec = CUSTOM_GLYPHS[name];
      if (spec && spec.__text) {
        assert.equal(svg.children.length, 1, `${name} emits its character`);
        assert.ok(svg.children[0].tag.endsWith('|text'), `${name} uses a real text element`);
        assert.equal(svg.children[0].textContent, spec.__text, `${name} carries the requested character`);
        continue;
      }
      assert.equal(svg.attrs['stroke-width'], '1.75', `${name} inherits the monoline`);
      assert.equal(svg.children.length, spec.length, `${name} emits every primitive`);
    }
  } finally {
    globalThis.document = previous;
  }
});

test('glyphs stay monochrome: no literal colors, no gradients', () => {
  const source = readSource('src/icons.js');
  const block = source.slice(source.indexOf('CUSTOM_GLYPHS'), source.indexOf('const ICONS'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}/, 'no hex inside the set');
  assert.ok(!block.includes('gradient'), 'no gradients');
});

test('primary modules wire to bespoke glyphs, clichés retired', () => {
  const source = readSource('src/icons.js');
  for (const name of EXPECTED) {
    assert.ok(source.includes(`${name}: CUSTOM_GLYPHS.${name}`), `${name} wired bespoke`);
  }
  for (const retired of ['LayoutDashboard', 'Languages', 'ScanText', 'MessagesSquare', 'RefreshCw', 'Zap']) {
    assert.ok(!source.includes(retired), `retired from the set: ${retired}`);
  }
  assert.ok(source.includes("book: BookOpen"), 'shared book-family glyph kept for secondary surfaces');
});
