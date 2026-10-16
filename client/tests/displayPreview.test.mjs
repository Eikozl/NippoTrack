import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DISPLAY_PREVIEW_CHOICES,
  DISPLAY_PREVIEW_DEFAULT,
  DISPLAY_PREVIEW_KEY,
  DISPLAY_PREVIEW_PARAM,
  applyDisplayChoice,
  initDisplayPreview,
  resolveDisplayChoice,
} from '../src/displayPreview.js';
import { NT_FONTS_URL, ensureFonts } from '../src/fonts.js';

// TEMP-DISPLAY-PREVIEW — this whole file is deleted before merge to master.
// It exists so the temporary toggle cannot be forgotten silently: the
// removal checklist lives in the module header it asserts below.
const displayPreviewSource = readFileSync(new URL('../src/displayPreview.js', import.meta.url), 'utf8');

test('temporary toggle carries its own removal checklist', () => {
  assert.ok(displayPreviewSource.includes('TEMP-DISPLAY-PREVIEW'), 'temp marker present');
  assert.ok(displayPreviewSource.includes('remove before merge to master'), 'removal instruction present');
  assert.equal(DISPLAY_PREVIEW_PARAM, 'display');
  assert.equal(DISPLAY_PREVIEW_KEY, 'nt-display-preview');
  assert.deepEqual(DISPLAY_PREVIEW_CHOICES, ['fraunces', 'newsreader']);
  assert.equal(DISPLAY_PREVIEW_DEFAULT, 'fraunces');
});

test('resolveDisplayChoice prefers URL over storage, rejects unknown', () => {
  assert.equal(resolveDisplayChoice('newsreader', 'fraunces'), 'newsreader');
  assert.equal(resolveDisplayChoice('', 'newsreader'), 'newsreader');
  assert.equal(resolveDisplayChoice(null, null), null);
  assert.equal(resolveDisplayChoice(undefined, null), null);
  assert.equal(resolveDisplayChoice(undefined, 'newsreader'), 'newsreader');
  assert.equal(resolveDisplayChoice('comic-sans', 'newsreader'), 'newsreader');
  assert.equal(resolveDisplayChoice('FRAUNCES', null), 'fraunces');
  // Bare ?display (empty or unknown value) activates with the default.
  assert.equal(resolveDisplayChoice('', null), 'fraunces');
  assert.equal(resolveDisplayChoice('1', null), 'fraunces');
});

test('applyDisplayChoice toggles the dataset attribute fail-open', () => {
  const root = { dataset: {}, removeAttribute(name) { delete this.dataset[name === 'data-display-preview' ? 'displayPreview' : name]; } };
  assert.equal(applyDisplayChoice({ documentElement: root }, 'newsreader'), true);
  assert.equal(root.dataset.displayPreview, 'newsreader');
  assert.equal(applyDisplayChoice({ documentElement: root }, 'fraunces'), true);
  assert.equal('displayPreview' in root.dataset, false);
  assert.equal(applyDisplayChoice(null, 'newsreader'), false);
  assert.equal(applyDisplayChoice({}, 'newsreader'), false);
});

function fakeDocument() {
  const appended = [];
  return {
    head: { append: (node) => appended.push(['head', node]) },
    body: { append: (node) => appended.push(['body', node]) },
    documentElement: { dataset: {}, removeAttribute() {} },
    createElement: (tag) => ({
      tag, children: [], dataset: {},
      setAttribute() {}, addEventListener() {}, remove() {}, append(child) { this.children.push(child); },
      querySelectorAll: () => [],
    }),
    getElementById: () => null,
    querySelector: () => null,
    _appended: appended,
  };
}

test('initDisplayPreview stays dormant without param or stored choice', () => {
  const doc = fakeDocument();
  assert.equal(
    initDisplayPreview({ doc, location: { search: '' }, storage: { getItem: () => null } }),
    null
  );
  assert.equal(doc._appended.length, 0, 'no toggle UI injected while dormant');
});

test('initDisplayPreview activates from ?display= and renders the toggle', () => {
  const doc = fakeDocument();
  const choice = initDisplayPreview({ doc, location: { search: '?display=newsreader' }, storage: { getItem: () => null } });
  assert.equal(choice, 'newsreader');
  assert.equal(doc.documentElement.dataset.displayPreview, 'newsreader');
  assert.ok(doc._appended.some(([where]) => where === 'body'), 'toggle bar rendered');
});

test('initDisplayPreview activates from bare ?display with the default family', () => {
  const doc = fakeDocument();
  const choice = initDisplayPreview({ doc, location: { search: '?display' }, storage: { getItem: () => null } });
  assert.equal(choice, 'fraunces');
  assert.ok(doc._appended.some(([where]) => where === 'body'), 'toggle bar rendered');
});

test('font loader carries both preview families and never double-loads', () => {
  assert.ok(NT_FONTS_URL.includes('Fraunces'), 'Fraunces in the set');
  assert.ok(NT_FONTS_URL.includes('Newsreader'), 'Newsreader in the set');
  assert.ok(NT_FONTS_URL.includes('IBM+Plex+Mono'), 'mono in the set');
  assert.ok(!NT_FONTS_URL.includes('Plus+Jakarta'), 'slop display font dropped');
  const doc = fakeDocument();
  assert.equal(ensureFonts(doc), true);
  assert.ok(doc._appended.some(([, node]) => node.href === NT_FONTS_URL), 'stylesheet appended once');
  assert.equal(ensureFonts(null), false);
});
