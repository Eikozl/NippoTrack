import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVEAL_DELAY_MS,
  isGlobalLoading,
  showGlobalLoading,
  withGlobalLoading
} from '../src/globalLoading.js';
import { withPendingAction } from '../src/pendingAction.js';

class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.innerHTML = '';
    this.parentNode = null;
    this.removed = false;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  remove() {
    this.removed = true;
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  querySelector(selector) {
    const wanted = String(selector).startsWith('.') ? String(selector).slice(1) : String(selector);
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (String(node.className || '').split(' ').includes(wanted)) return node;
      queue.push(...node.children);
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeNode('body', this);
  }
  createElement(tag) {
    return new FakeNode(tag, this);
  }
}

function installDocument() {
  const doc = new FakeDocument();
  globalThis.document = doc;
  return doc;
}

function uninstallDocument() {
  delete globalThis.document;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const overlaysOf = (doc) => doc.body.children.filter((node) => node.className === 'global-loading-overlay');

test('global loader: reveal delay default is ~150–200ms', () => {
  assert.equal(DEFAULT_REVEAL_DELAY_MS, 180);
});

test('global loader: fast operation finishes before delay, overlay never appears', async () => {
  const doc = installDocument();
  try {
    const result = await withGlobalLoading(async () => 'fast', { delayMs: 40 });
    assert.equal(result, 'fast');
    await sleep(60);
    assert.deepEqual(overlaysOf(doc), []);
    assert.equal(isGlobalLoading(), false);
  } finally {
    uninstallDocument();
  }
});

test('global loader: slow operation reveals overlay, completion hides it', async () => {
  const doc = installDocument();
  try {
    const pending = withGlobalLoading(async () => {
      await sleep(60);
      return 'slow';
    }, { label: 'Loading session…', delayMs: 10 });
    await sleep(30);
    const visible = overlaysOf(doc);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].getAttribute('role'), 'status');
    assert.equal(visible[0].getAttribute('aria-live'), 'polite');
    assert.equal(visible[0].getAttribute('aria-busy'), 'true');
    assert.ok(visible[0].querySelector('.global-loading-spinner'));
    assert.equal(visible[0].querySelector('.global-loading-label').textContent, 'Loading session…');
    assert.equal(await pending, 'slow');
    assert.deepEqual(overlaysOf(doc), []);
    assert.equal(isGlobalLoading(), false);
  } finally {
    uninstallDocument();
  }
});

test('global loader: failure hides the overlay and propagates the error', async () => {
  const doc = installDocument();
  try {
    await assert.rejects(
      withGlobalLoading(async () => {
        await sleep(30);
        throw new Error('network down');
      }, { delayMs: 5 }),
      /network down/
    );
    await sleep(10);
    assert.deepEqual(overlaysOf(doc), []);
    assert.equal(isGlobalLoading(), false);
  } finally {
    uninstallDocument();
  }
});

test('global loader: overlapping operations keep the overlay until both finish', async () => {
  const doc = installDocument();
  try {
    let releaseB;
    const first = withGlobalLoading(async () => { await sleep(50); }, { delayMs: 5 });
    await sleep(20);
    assert.equal(overlaysOf(doc).length, 1);
    const secondGate = withGlobalLoading(async () => {
      await new Promise((resolve) => { releaseB = resolve; });
    }, { delayMs: 5 });
    await sleep(10);
    await first;
    await sleep(10);
    // Request A finished but B is still pending: overlay must remain, single node.
    assert.equal(overlaysOf(doc).length, 1);
    assert.equal(isGlobalLoading(), true);
    releaseB();
    await secondGate;
    assert.deepEqual(overlaysOf(doc), []);
    assert.equal(isGlobalLoading(), false);
  } finally {
    uninstallDocument();
  }
});

test('global loader: direct leases are idempotent and reference-counted', async () => {
  const doc = installDocument();
  try {
    const releaseA = showGlobalLoading({ delayMs: 5 });
    const releaseB = showGlobalLoading({ delayMs: 5 });
    await sleep(20);
    assert.equal(overlaysOf(doc).length, 1);
    releaseA();
    releaseA();
    assert.equal(overlaysOf(doc).length, 1);
    releaseB();
    assert.deepEqual(overlaysOf(doc), []);
    assert.equal(isGlobalLoading(), false);
  } finally {
    uninstallDocument();
  }
});

test('global loader: view/edit-style drivers show the overlay during slow fetches', async () => {
  const doc = installDocument();
  try {
    const fetchRecord = (ms) => withGlobalLoading(async () => {
      await sleep(ms);
      return { id: 1 };
    }, { label: 'Loading study session…', delayMs: 10 });
    const view = fetchRecord(50);
    await sleep(25);
    assert.equal(overlaysOf(doc).length, 1);
    assert.equal((await view).id, 1);
    assert.deepEqual(overlaysOf(doc), []);
    // Fast edit-form load never flashes.
    const edit = await fetchRecord(0);
    await sleep(30);
    assert.equal(edit.id, 1);
    assert.deepEqual(overlaysOf(doc), []);
  } finally {
    uninstallDocument();
  }
});

test('global loader: save flow keeps local button state, overlay only when slow', async () => {
  const doc = installDocument();
  const button = new FakeNode('button', doc);
  button.innerHTML = 'Save changes';
  try {
    // Fast save: button pending cycled, overlay never appeared.
    await withGlobalLoading(async () => {
      await withPendingAction(button, async () => 'saved', { pendingLabel: 'Saving…' });
    }, { delayMs: 40 });
    await sleep(60);
    assert.equal(button.innerHTML, 'Save changes');
    assert.equal(button.disabled, false);
    assert.deepEqual(overlaysOf(doc), []);
    // Slow save: both button pending and overlay visible together.
    const slow = withGlobalLoading(async () => {
      await withPendingAction(button, async () => { await sleep(50); }, { pendingLabel: 'Saving…' });
    }, { delayMs: 5 });
    await sleep(20);
    assert.equal(button.disabled, true);
    assert.equal(overlaysOf(doc).length, 1);
    await slow;
    assert.equal(button.disabled, false);
    assert.deepEqual(overlaysOf(doc), []);
  } finally {
    uninstallDocument();
  }
});

test('global loader: detached DOM never leaves a stale overlay behind', async () => {
  const doc = installDocument();
  try {
    const pending = withGlobalLoading(async () => { await sleep(40); }, { delayMs: 5 });
    await sleep(15);
    assert.equal(overlaysOf(doc).length, 1);
    // Simulate a re-render ripping the node out mid-flight.
    overlaysOf(doc)[0].remove();
    await pending;
    assert.deepEqual(overlaysOf(doc), []);
    // Next operation builds a fresh node, exactly one.
    const next = withGlobalLoading(async () => { await sleep(30); }, { delayMs: 5 });
    await sleep(15);
    assert.equal(overlaysOf(doc).length, 1);
    await next;
    assert.deepEqual(overlaysOf(doc), []);
  } finally {
    uninstallDocument();
  }
});

test('global loader: works without a DOM and never throws', async () => {
  const release = showGlobalLoading();
  release();
  assert.equal(isGlobalLoading(), false);
  assert.equal(await withGlobalLoading(async () => 42), 42);
});

test('global loader: existing button pending helper still works', async () => {
  const doc = installDocument();
  const button = new FakeNode('button', doc);
  button.innerHTML = 'Delete';
  try {
    await assert.rejects(withPendingAction(button, async () => { throw new Error('nope'); }, { pendingLabel: 'Deleting…' }), /nope/);
    assert.equal(button.innerHTML, 'Delete');
    assert.equal(button.disabled, false);
  } finally {
    uninstallDocument();
  }
});
