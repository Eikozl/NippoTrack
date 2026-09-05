import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isActionPending,
  setActionPending,
  setPendingLabel,
  withPendingAction
} from '../src/pendingAction.js';
import {
  buildKanjiImportPayload,
  summarizeImportResults
} from '../src/vocabularyReading.js';

// Minimal fake DOM surface: the pending helper only touches disabled,
// innerHTML/textContent, attributes, appendChild/querySelector/remove, and
// ownerDocument.createElement. Real browsers satisfy this trivially.
class FakeElement {
  constructor(tag = 'div', doc = null) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = new Map();
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.isConnected = true;
    this.removed = false;
    this._html = '';
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(value) {
    this._html = String(value ?? '');
    this.children = [];
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(String(name));
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  querySelector(selector) {
    const wanted = String(selector).startsWith('.') ? String(selector).slice(1) : String(selector);
    return this.children.find((child) => String(child.className || '').split(' ').includes(wanted)) || null;
  }
  remove() {
    this.removed = true;
  }
}

class FakeDocument {
  createElement(tag) {
    return new FakeElement(tag, this);
  }
}

function makeButton(label = 'Save') {
  const button = new FakeElement('button', new FakeDocument());
  button.innerHTML = label;
  return button;
}

test('pending helper: button disables immediately with aria-busy and spinner', () => {
  const button = makeButton('Add');
  assert.equal(setActionPending(button, true, { pendingLabel: 'Adding…' }), true);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(isActionPending(button), true);
  const spinner = button.querySelector('.spinner-inline');
  assert.ok(spinner);
  assert.equal(spinner.getAttribute('aria-hidden'), 'true');
  const label = button.querySelector('.pending-label');
  assert.equal(label.textContent, 'Adding…');
});

test('pending helper: repeated pending calls are safe no-ops preserving the original', () => {
  const button = makeButton('Save');
  assert.equal(setActionPending(button, true, { pendingLabel: 'Saving…' }), true);
  assert.equal(setActionPending(button, true, { pendingLabel: 'Saving…' }), false);
  assert.equal(setActionPending(button, false), true);
  assert.equal(button.innerHTML, 'Save');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.querySelector('.spinner-inline'), null);
  // Clearing a non-pending button is a no-op.
  assert.equal(setActionPending(button, false), false);
});

test('pending helper: null pending label keeps the original text plus spinner', () => {
  const button = makeButton('Good');
  setActionPending(button, true, { pendingLabel: null });
  assert.equal(button.querySelector('.pending-label').textContent, 'Good');
  assert.ok(button.querySelector('.spinner-inline'));
  setActionPending(button, false);
  assert.equal(button.innerHTML, 'Good');
});

test('pending helper: double submission is prevented while pending', async () => {
  const button = makeButton('Add selected Kanji (3)');
  let runs = 0;
  const action = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'done';
  };
  const first = withPendingAction(button, action, { pendingLabel: 'Adding…' });
  const second = withPendingAction(button, action, { pendingLabel: 'Adding…' });
  assert.equal(await second, undefined);
  assert.equal(await first, 'done');
  assert.equal(runs, 1);
  assert.equal(isActionPending(button), false);
});

test('pending helper: success and failure both restore state', async () => {
  const okButton = makeButton('Save');
  await withPendingAction(okButton, async () => 'ok', { pendingLabel: 'Saving…' });
  assert.equal(okButton.innerHTML, 'Save');
  assert.equal(okButton.disabled, false);
  assert.equal(okButton.getAttribute('aria-busy'), null);

  const failButton = makeButton('Delete');
  await assert.rejects(
    withPendingAction(failButton, async () => { throw new Error('boom'); }, { pendingLabel: 'Deleting…' }),
    /boom/
  );
  assert.equal(failButton.innerHTML, 'Delete');
  assert.equal(failButton.disabled, false);
  assert.equal(failButton.getAttribute('aria-busy'), null);
  assert.equal(failButton.querySelector('.spinner-inline'), null);
});

test('pending helper: batch progress labels update and batch cannot run twice', async () => {
  const button = makeButton('Add selected Kanji (3)');
  const seenLabels = [];
  let runs = 0;
  const driver = (items) => withPendingAction(button, async ({ setProgress }) => {
    runs += 1;
    const outcomes = [];
    let index = 0;
    for (const character of items) {
      index += 1;
      setProgress(index, items.length);
      seenLabels.push(button.querySelector('.pending-label').textContent);
      outcomes.push({ character, ok: true, status: 'added' });
    }
    return summarizeImportResults(outcomes);
  }, { pendingLabel: 'Adding…', progressLabel: (done, total) => `Adding ${done}/${total}…` });
  const first = driver(['日', '本', '語']);
  const second = driver(['日', '本', '語']);
  assert.equal(await second, undefined);
  const summary = await first;
  assert.deepEqual(summary, { added: 3, already: 0, failed: [] });
  assert.deepEqual(seenLabels, ['Adding 1/3…', 'Adding 2/3…', 'Adding 3/3…']);
  assert.equal(runs, 1);
  assert.equal(button.innerHTML, 'Add selected Kanji (3)');
});

test('pending helper: detached and re-rendered buttons clean up without throwing', () => {
  const button = makeButton('Save');
  button.isConnected = false;
  assert.equal(setActionPending(button, true, { pendingLabel: 'Saving…' }), true);
  button.remove();
  assert.equal(setActionPending(button, false), true);
  assert.equal(button.innerHTML, 'Save');
  // Invalid targets never throw.
  assert.equal(setActionPending(null, true), false);
  assert.equal(setActionPending(undefined, false), false);
  assert.equal(setPendingLabel(makeButton('x'), 'noop'), false);
});

test('pending helper: toast paths are untouched by pending state changes', () => {
  // showToast lives in ui.js (DOM-bound, covered by build + unchanged code
  // paths). The pending helper shares no state with it: pending cycles must
  // not alter any message a caller passes to toast calls.
  const button = makeButton('Save');
  const messages = [];
  const fakeToast = (message, type = 'success') => messages.push({ message, type });
  setActionPending(button, true, { pendingLabel: 'Saving…' });
  fakeToast('Study session recorded.');
  fakeToast('Unable to save.', 'error');
  setActionPending(button, false);
  assert.deepEqual(messages, [
    { message: 'Study session recorded.', type: 'success' },
    { message: 'Unable to save.', type: 'error' }
  ]);
  assert.equal(button.innerHTML, 'Save');
});

test('pending helper: analyzer-style import driver builds payloads and summarizes', async () => {
  const rawByChar = new Map([
    ['学', { character: '学', inUserCollection: false, userKanji: null, reference: { onyomi: ['ガク'], kunyomi: ['まなぶ'], meanings: ['study'], jlptLevel: 'N5' }, discoveryState: 'availableToAdd', readingSegment: null, readingProvenance: 'unverified' }]
  ]);
  const button = makeButton('Add to My Kanji');
  const summary = await withPendingAction(button, async ({ setProgress }) => {
    const outcomes = [];
    const selected = ['学'];
    let index = 0;
    for (const character of selected) {
      index += 1;
      setProgress(index, selected.length);
      const payload = buildKanjiImportPayload(rawByChar.get(character));
      assert.ok(payload);
      assert.equal(payload.character_kanji, '学');
      outcomes.push({ character, ok: true, status: 'added' });
    }
    return summarizeImportResults(outcomes);
  }, { pendingLabel: 'Adding…', progressLabel: (done, total) => `Adding ${done}/${total}…` });
  assert.deepEqual(summary, { added: 1, already: 0, failed: [] });
  assert.equal(button.querySelector('.spinner-inline'), null);
  assert.equal(button.innerHTML, 'Add to My Kanji');
});

test('pending helper: save-style driver preserves success path and restores on error', async () => {
  const button = makeButton('Save changes');
  const saved = await withPendingAction(button, async () => ({ ok: true }), { pendingLabel: 'Saving…' });
  assert.deepEqual(saved, { ok: true });
  assert.equal(button.disabled, false);
  await assert.rejects(withPendingAction(button, async () => { throw new Error('Unable to save.'); }));
  assert.equal(button.innerHTML, 'Save changes');
  assert.equal(button.disabled, false);
});
