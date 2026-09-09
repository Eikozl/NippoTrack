// v5.1-B landing KanjiVG showcase contract: one scripted, non-interactive
// stage, dynamically loading only its three curated assets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  KANJI_SEQUENCE,
  KANJI_SEQ_TRANSITION_MS,
  playKanjiSequence
} from '../src/landing/interactions.js';

const sections = readFileSync(new URL('../src/landing/sections.js', import.meta.url), 'utf8');
const interactions = readFileSync(new URL('../src/landing/interactions.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/landing/landing.css', import.meta.url), 'utf8');

test('landing uses one stage for the 日 → 空 → 深 scripted sequence', () => {
  assert.deepEqual(KANJI_SEQUENCE.map(({ character }) => character), ['日', '空', '深']);
  assert.equal((sections.match(/data-kanji-seq-stage/g) || []).length, 1, 'one visual stage');
  assert.equal((sections.match(/data-kanji-seq-glyph/g) || []).length, 1, 'one glyph mount point');
  assert.ok(sections.includes('data-kanji-seq-readings'), 'readings update with the stage');
  const stageCss = css.slice(css.indexOf('.kanji-sequence'), css.indexOf('.review-demo'));
  assert.ok(!stageCss.includes('grid-template-columns: repeat(3, 1fr)'), 'the stage is not a three-column card grid');
  assert.ok(css.includes('.kanji-seq-stage.is-transitioning'), 'calm fade/translate transition exists');
  assert.ok(KANJI_SEQ_TRANSITION_MS >= 200 && KANJI_SEQ_TRANSITION_MS <= 400, 'transition remains restrained');
});

test('landing removes meanings, JLPT labels, and the unnecessary disclaimer', () => {
  for (const forbidden of [
    'sun/day', 'sky/empty', '>deep<', 'reference N5 range', 'reference N4 range',
    'reference N3 range', 'levels approximate, not official'
  ]) {
    assert.ok(!sections.includes(forbidden), `omits ${forbidden}`);
  }
  for (const reading of ['ニチ・ジツ', 'ひ・か', 'クウ', 'そら・あく', 'シン', 'ふか・い']) {
    assert.ok(interactions.includes(reading), `retains ${reading}`);
  }
});

test('landing preserves the safe lazy KanjiVG loader and one-time behavior', () => {
  assert.ok(interactions.includes("import('../strokeOrder.js')"), 'stroke parser remains dynamically imported');
  assert.ok(!interactions.includes("from '../strokeOrder.js'"), 'no eager stroke-module import');
  assert.ok(!interactions.includes('strokeAssetIndex'), 'landing does not load the full asset index');
  assert.ok(interactions.includes('kanjiPlayed'), 'one-time guard remains');
  assert.ok(interactions.includes('createElementNS'), 'SVG paths are recreated safely');
  const codeOnly = interactions.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(!codeOnly.includes('innerHTML'), 'no source SVG markup injection');
});

test('a second play call makes no further asset requests', async () => {
  const container = { dataset: { kanjiPlayed: 'true' } };
  const result = await playKanjiSequence(container, {
    loadPaths: () => { throw new Error('must not fetch after the first play'); }
  });
  assert.deepEqual(result, { status: 'skipped', settled: [] });
});

test('one stage sequentially loads and settles 日, 空, then 深 without stale glyphs', async () => {
  class Node {
    constructor() { this.children = []; this.attributes = new Map(); this.style = {}; this.classList = { add() {}, remove() {} }; this._text = ''; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
    getTotalLength() { return 100; }
  }
  const glyph = new Node();
  const readings = new Node();
  const stage = new Node();
  stage.querySelector = (selector) => selector.includes('readings') ? readings : glyph;
  stage.getBoundingClientRect = () => ({});
  const container = new Node();
  container.dataset = {};
  container.querySelector = () => stage;
  const doc = { createElementNS: () => new Node() };
  const calls = [];
  let time = 0;
  const result = await playKanjiSequence(container, {
    doc,
    loadPaths: async (character) => { calls.push(character); return ['M0 0L1 1']; },
    raf: (callback) => { time += 10; callback(time); return time; },
    wait: async () => {},
    drawMs: 1,
    pauseMs: 0,
    settleMs: 0,
    transitionMs: 0,
    prefersReducedMotion: () => false
  });
  assert.deepEqual(calls, ['日', '空', '深'], 'only the curated three assets load in order');
  assert.deepEqual(result.settled, ['日', '空', '深']);
  assert.equal(glyph.getAttribute('data-kanji-seq-glyph'), '深', 'the final stage is 深');
  assert.equal(readings.textContent, 'シン\nふか・い', 'readings update with the final kanji');
  assert.equal(glyph.children.length, 1, 'one final SVG replaces the static glyph');
});
