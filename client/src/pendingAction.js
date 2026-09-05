// Async-action feedback: local pending state for the exact control that was
// triggered (never a blocking overlay). Centralizes disabled state,
// aria-busy, spinner insertion/removal, pending-label swap with original
// restoration, and double-submission guarding. Safe on detached nodes and
// repeated calls; always settle in a finally via withPendingAction.
//
// Dependency-free (no DOM globals at import time) so it stays unit-testable
// under node; re-exported through ui.js alongside the other UI primitives.

const pendingActions = new WeakMap();

function pendingDocument(button) {
  return button?.ownerDocument || (typeof document !== 'undefined' ? document : null);
}

export function isActionPending(button) {
  return pendingActions.has(button);
}

// Shows or clears pending state on a button. Returns true when the state
// changed, false when the call was a safe no-op (already pending, not
// pending, or no usable DOM). pendingLabel null keeps the original label
// and only adds the spinner.
export function setActionPending(button, pending, { pendingLabel = 'Saving…' } = {}) {
  if (!button || (typeof button !== 'object' && typeof button !== 'function')) return false;
  const doc = pendingDocument(button);
  if (!doc) return false;
  try {
    if (pending) {
      if (pendingActions.has(button)) return false;
      pendingActions.set(button, { disabled: Boolean(button.disabled), html: button.innerHTML });
      button.disabled = true;
      if (typeof button.setAttribute === 'function') button.setAttribute('aria-busy', 'true');
      const spinner = doc.createElement('span');
      spinner.className = 'spinner spinner-inline';
      spinner.setAttribute('aria-hidden', 'true');
      button.innerHTML = '';
      button.appendChild(spinner);
      const label = doc.createElement('span');
      label.className = 'pending-label';
      if (pendingLabel === null || pendingLabel === undefined) {
        // Keep the original visible label: restore plain text from the
        // snapshot (icons inside buttons are decorative here).
        const snapshot = pendingActions.get(button).html;
        const text = typeof snapshot === 'string' ? snapshot.replace(/<[^>]*>/g, '').trim() : '';
        label.textContent = text;
      } else {
        label.textContent = String(pendingLabel);
      }
      button.appendChild(label);
      pendingActions.get(button).labelNode = label;
      return true;
    }
    const original = pendingActions.get(button);
    if (!original) return false;
    pendingActions.delete(button);
    const spinner = typeof button.querySelector === 'function' ? button.querySelector('.spinner-inline') : null;
    if (spinner && typeof spinner.remove === 'function') spinner.remove();
    if (typeof original.html === 'string') button.innerHTML = original.html;
    button.disabled = original.disabled;
    if (typeof button.removeAttribute === 'function') button.removeAttribute('aria-busy');
    return true;
  } catch {
    // Detached or grafted nodes must never break the action flow.
    return false;
  }
}

// Updates the visible pending label of a button that is currently pending
// (batch progress, e.g. `Adding 2/5…`). No-op otherwise.
export function setPendingLabel(button, text) {
  try {
    const state = pendingActions.get(button);
    if (!state || !state.labelNode) return false;
    state.labelNode.textContent = String(text ?? '');
    return true;
  } catch {
    return false;
  }
}

// Runs an async action with pending feedback and guaranteed cleanup.
// Returns undefined immediately when the button is already pending, which
// prevents double submission from double-clicks. The action receives
// `{ setProgress(done, total) }`; pass `progressLabel` to render batch
// progress, otherwise the pending label stays unchanged.
export async function withPendingAction(button, action, { pendingLabel = 'Saving…', progressLabel = null } = {}) {
  if (!setActionPending(button, true, { pendingLabel })) return undefined;
  try {
    return await action({
      setProgress: (done, total) => {
        if (typeof progressLabel === 'function') setPendingLabel(button, progressLabel(done, total));
      }
    });
  } finally {
    setActionPending(button, false);
  }
}
