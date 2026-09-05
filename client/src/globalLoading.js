// Global loading overlay: full-viewport feedback for operations with
// noticeable latency (detail/edit dialogs waiting on API data, slow
// analysis). Complements the local button pending states in
// pendingAction.js — it never replaces them for direct mutations.
//
// Anti-flicker: the overlay reveals only if the operation is still pending
// after `delayMs` (default 180ms). Fast operations never flash.
//
// Concurrency: reference-counted. Overlapping operations each hold a lease;
// the overlay hides only when the last one settles, always via finally, on
// success, API errors, exceptions, rejections, and aborts.
//
// Dependency-free (no DOM globals at import time) so it stays unit-testable
// under node.

const DEFAULT_REVEAL_DELAY_MS = 180;

const state = {
  doc: null,
  node: null,
  labelNode: null,
  activeCount: 0,
  revealTimer: null
};

function resolveDocument() {
  return typeof document !== 'undefined' ? document : null;
}

function buildOverlay(doc, label) {
  const overlay = doc.createElement('div');
  overlay.className = 'global-loading-overlay';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-busy', 'true');
  const card = doc.createElement('div');
  card.className = 'global-loading-card';
  const spinner = doc.createElement('span');
  spinner.className = 'spinner global-loading-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = doc.createElement('span');
  text.className = 'global-loading-label';
  text.textContent = label;
  card.appendChild(spinner);
  card.appendChild(text);
  overlay.appendChild(card);
  return { overlay, labelNode: text };
}

function ensureDoc(doc) {
  if (state.doc !== doc) {
    cancelReveal();
    state.doc = doc;
    state.node = null;
    state.labelNode = null;
    state.activeCount = 0;
  }
}

function cancelReveal() {
  if (state.revealTimer === null) return;
  try { clearTimeout(state.revealTimer); } catch {
    // Timer cleanup must never break the action flow.
  }
  state.revealTimer = null;
}

function showNow(label) {
  const doc = state.doc;
  if (!doc || state.node) {
    if (state.labelNode && label) state.labelNode.textContent = label;
    return;
  }
  try {
    const built = buildOverlay(doc, label);
    state.node = built.overlay;
    state.labelNode = built.labelNode;
    const host = doc.body || doc.documentElement;
    host.appendChild(state.node);
  } catch {
    state.node = null;
    state.labelNode = null;
  }
}

function hideNow() {
  cancelReveal();
  if (!state.node) return;
  try {
    if (typeof state.node.remove === 'function') state.node.remove();
    else if (state.node.parentNode && typeof state.node.parentNode.removeChild === 'function') {
      state.node.parentNode.removeChild(state.node);
    }
  } catch {
    // Detached or re-rendered DOM must never leave a stuck overlay behind
    // nor throw during cleanup.
  } finally {
    state.node = null;
    state.labelNode = null;
  }
}

export function isGlobalLoading() {
  return state.activeCount > 0;
}

// Acquires one overlay lease. Shows the overlay (after the reveal delay)
// and returns a release function. Prefer withGlobalLoading, which settles
// the lease in a finally automatically.
export function showGlobalLoading({ label = 'Loading…', delayMs = DEFAULT_REVEAL_DELAY_MS } = {}) {
  const doc = resolveDocument();
  if (!doc) return () => {};
  ensureDoc(doc);
  state.activeCount += 1;
  if (state.activeCount === 1 && state.revealTimer === null && !state.node) {
    try {
      state.revealTimer = setTimeout(() => { state.revealTimer = null; showNow(label); }, delayMs);
    } catch {
      state.revealTimer = null;
    }
  } else if (state.node && label) {
    showNow(label);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (state.activeCount > 0) state.activeCount -= 1;
    if (state.activeCount === 0) hideNow();
  };
}

// Runs an async action under the global overlay. Fast actions resolve
// before the reveal delay and the overlay never appears. The overlay hides
// in a finally on every outcome; errors propagate to the caller so existing
// toast handling stays intact.
export async function withGlobalLoading(action, options = {}) {
  const release = showGlobalLoading(options);
  try {
    return await action();
  } finally {
    release();
  }
}

export { DEFAULT_REVEAL_DELAY_MS };
