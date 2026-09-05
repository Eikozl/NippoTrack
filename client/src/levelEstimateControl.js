// Phase 9 UX refinement — compact header level-estimate control.
//
// The estimate logic/API is untouched: this module renders the existing
// GET /api/level/estimate payload (via levelEstimateModel) as a collapsed
// pill in the application header that expands into a floating panel.
// Conceptually inspired by an expandable compact status surface; visually
// plain JLT (surface card, status pills, native <details>).
//
// Design notes:
// - Dependency-injected DOM (`createElement`) and window/fetch so the full
//   interaction is unit-testable without a browser. Production passes the
//   shared `element` helper from ui.js.
// - One panel node exists; it is reparented into whichever header host
//   opened it (desktop / mobile headers each get a collapsed button, only
//   one is ever visible — same precedent as the theme toggles).
// - Panel content reuses the CACHED model: opening never fetches. Refresh
//   happens on initial load and on `jlt-review-complete` only. Analyzer
//   analysis and unreviewed imports cannot change the estimate, so nothing
//   listens for them.
// - CSS-only animation (~300ms ease-out, transform/opacity/border-radius);
//   `prefers-reduced-motion` expands/collapses without motion.

import { levelEstimateModel } from './levelEstimate.js';

export const LEVEL_ESTIMATE_PANEL_ID = 'level-estimate-panel';
export const PANEL_TRANSITION_MS = 300;

export function levelControlLabel(model) {
  if (!model) return 'JLT estimated study level';
  if (model.status === 'estimated' && model.level) return `JLT estimated study level: ${model.level}`;
  return 'JLT estimated study level: not enough evidence yet';
}

export function levelControlShortText(model) {
  if (model && model.status === 'estimated' && model.level) return model.level;
  return '—';
}

function prefersReducedMotion(win) {
  try {
    return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function bulletList(h, items) {
  return h('ul', { className: 'level-estimate-list' }, items.map((text) => h('li', { text })));
}

// Renders the expanded panel body from the cached model. Pure w.r.t. the
// injected element factory; called on open so content is always current.
export function renderLevelPanel(h, model) {
  const pills = h('div', { className: 'level-estimate-pills' }, model.bandRows.map((row) =>
    h('span', { className: 'status-pill', text: `${row.band} · ${row.eligible} reviewed` })
  ));
  const details = h('details', { className: 'level-estimate-details' }, [
    h('summary', { text: 'How this is estimated' }),
    h('h3', { text: 'Evidence used' }),
    bulletList(h, model.evidenceLines),
    h('h3', { text: 'Explicitly not used' }),
    bulletList(h, model.notUsedLines),
    ...(model.limitationLines.length
      ? [h('h3', { text: 'Limitations' }), bulletList(h, model.limitationLines)]
      : [])
  ]);
  return [
    h('p', { className: 'eyebrow', text: 'JLT study estimate' }),
    h('h2', { text: model.headline }),
    h('p', { className: 'level-estimate-subline', text: model.subline }),
    ...(model.status === 'estimated' ? [h('p', { className: 'level-estimate-confidence', text: model.metricNote }), pills] : []),
    details,
    h('p', { className: 'level-estimate-disclaimer', text: model.disclaimer })
  ];
}

export function createLevelEstimateControl({ fetchEstimate, createElement, doc, win }) {
  const h = createElement;
  const state = {
    model: null,
    loaded: false,
    loading: false,
    stale: false,
    open: false,
    activeHost: null,
    hosts: [],
    buttonByHost: new Map(),
    panel: null,
    closeTimer: null
  };

  function panel() {
    if (!state.panel) {
      state.panel = h('section', {
        className: 'level-estimate-panel hidden',
        attrs: { id: LEVEL_ESTIMATE_PANEL_ID, role: 'region', 'aria-label': 'Estimated study level details' }
      });
    }
    return state.panel;
  }

  function syncButtons() {
    for (const button of state.buttonByHost.values()) {
      const label = button.querySelector('[data-level-text]');
      if (label) label.textContent = levelControlShortText(state.model);
      button.setAttribute('aria-label', levelControlLabel(state.model));
      button.setAttribute('aria-expanded', String(state.open));
    }
  }

  function setHostsVisible(visible) {
    for (const host of state.hosts) {
      if (visible) host.classList.remove('hidden');
      else host.classList.add('hidden');
    }
  }

  function isOutside(target) {
    if (!target || typeof target.closest !== 'function') return true;
    if (target.closest(`#${LEVEL_ESTIMATE_PANEL_ID}`)) return false;
    for (const button of state.buttonByHost.values()) {
      if (button === target || (typeof button.contains === 'function' && button.contains(target))) return false;
    }
    return true;
  }

  function onDocumentClick(event) {
    if (state.open && isOutside(event && event.target)) close();
  }

  function onDocumentKeydown(event) {
    if (state.open && event && event.key === 'Escape') {
      close();
      if (state.activeHost && state.buttonByHost.has(state.activeHost)) {
        const button = state.buttonByHost.get(state.activeHost);
        if (button && typeof button.focus === 'function') button.focus();
      }
    }
  }

  function open(host) {
    if (!state.model || state.open) return;
    state.open = true;
    state.activeHost = host;
    const node = panel();
    node.replaceChildren(...renderLevelPanel(h, state.model));
    if (node.parentNode !== host) host.appendChild(node);
    node.classList.remove('hidden');
    if (state.closeTimer) { win.clearTimeout(state.closeTimer); state.closeTimer = null; }
    // Unhide-then-class ordering lets the CSS transition run on open.
    win.setTimeout(() => { if (state.open) node.classList.add('is-open'); }, 20);
    doc.addEventListener('click', onDocumentClick);
    doc.addEventListener('keydown', onDocumentKeydown);
    syncButtons();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    const node = state.panel;
    doc.removeEventListener('click', onDocumentClick);
    doc.removeEventListener('keydown', onDocumentKeydown);
    if (node) {
      node.classList.remove('is-open');
      const hide = () => node.classList.add('hidden');
      if (prefersReducedMotion(win)) hide();
      else {
        if (state.closeTimer) win.clearTimeout(state.closeTimer);
        state.closeTimer = win.setTimeout(hide, PANEL_TRANSITION_MS);
      }
    }
    syncButtons();
  }

  function toggle(host, event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    if (state.open) close();
    else open(host);
  }

  async function load() {
    if (state.loading) { state.stale = true; return; }
    state.loading = true;
    try {
      const payload = await fetchEstimate();
      state.model = levelEstimateModel(payload);
      state.loaded = true;
      // Fetch failure degrades to hidden: never show a stale or
      // placeholder estimate in the header.
      setHostsVisible(Boolean(state.model));
      if (!state.model && state.open) close();
      if (state.open && state.model) panel().replaceChildren(...renderLevelPanel(h, state.model));
      syncButtons();
    } catch {
      state.model = null;
      setHostsVisible(false);
      if (state.open) close();
    } finally {
      state.loading = false;
      if (state.stale) { state.stale = false; load(); }
    }
  }

  function mount(host, { position = 'prepend' } = {}) {
    const wrapper = h('div', { className: 'level-estimate-host hidden' });
    const button = h('button', {
      className: 'level-estimate-toggle',
      attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': LEVEL_ESTIMATE_PANEL_ID, 'aria-label': levelControlLabel(null) }
    }, [
      h('span', { className: 'level-estimate-dot', text: '◎', attrs: { 'aria-hidden': 'true' } }),
      h('span', { attrs: { 'data-level-text': 'true' }, text: '—' })
    ]);
    button.addEventListener('click', (event) => toggle(wrapper, event));
    wrapper.appendChild(button);
    if (position === 'prepend' && typeof host.prepend === 'function') host.prepend(wrapper);
    else host.appendChild(wrapper);
    state.hosts.push(wrapper);
    state.buttonByHost.set(wrapper, button);
    return wrapper;
  }

  function reset() {
    close();
    state.model = null;
    state.loaded = false;
    setHostsVisible(false);
    syncButtons();
  }

  function destroy() {
    close();
    doc.removeEventListener('click', onDocumentClick);
    doc.removeEventListener('keydown', onDocumentKeydown);
    if (state.panel && state.panel.parentNode && typeof state.panel.parentNode.removeChild === 'function') {
      state.panel.parentNode.removeChild(state.panel);
    }
    state.panel = null;
    state.hosts = [];
    state.buttonByHost.clear();
  }

  function onReviewComplete() {
    if (state.loaded) load();
  }

  // Freshness contract: initial load + review evidence only. Deliberately
  // NOT subscribed to analyzer/import/session events — those cannot change
  // the estimate (unreviewed kanji are not evidence).
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('jlt-review-complete', onReviewComplete);
  }

  return {
    mount,
    load,
    refresh: load,
    open,
    close,
    toggle,
    reset,
    destroy,
    isOpen: () => state.open,
    getModel: () => state.model,
    isLoaded: () => state.loaded
  };
}
