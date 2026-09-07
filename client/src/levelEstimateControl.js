// Phase 9 UX refinement — morphing header level-estimate control.
//
// The estimate logic/API is untouched: this module renders the existing
// GET /api/level/estimate payload (via levelEstimateModel) as ONE surface
// in the application header that morphs between compact and expanded.
//
// Interaction principle (not visual copy): the collapsed pill — whose only
// visual identity is the level itself (N5…N1, or — when there is not enough
// evidence; no decorative icon) — smoothly grows into the detail surface
// and contracts back. There is deliberately NO detached dropdown, popover,
// modal, or second card: expansion toggles `.is-open` on the same
// `.level-estimate-morph` node, and CSS grid-template-rows + width +
// border-radius transitions do the morph. Detail content fades/slides in
// via opacity/transform on the inner wrapper.
//
// Design notes:
// - Dependency-injected DOM (`createElement`) and window/fetch so the full
//   interaction is unit-testable without a browser. Production passes the
//   shared `element` helper from ui.js.
// - Desktop / mobile headers each get one morph (only one header is ever
//   visible — same precedent as the theme toggles); at most one is ever
//   open. On desktop the morph is absolutely anchored inside its fixed-size
//   host, so expansion never pushes the theme/account buttons and always
//   originates from the exact pill location, growing leftward/downward.
// - Narrow viewports use the same connected surface with intrinsic document
//   layout. Mobile never measures or writes shell geometry; CSS owns the
//   natural expanded height.
//   The surface stays anchored to the trigger while its mobile height remains
//   intrinsic to the rendered content.
// - Detail content reuses the CACHED model: opening never fetches. Refresh
//   happens on initial load and on `jlt-review-complete` only. Analyzer
//   analysis and unreviewed imports cannot change the estimate, so nothing
//   listens for them.
// - Zero JS timers: visibility is handled with a delayed `visibility`
//   transition, so `prefers-reduced-motion` (global reset + explicit rule)
//   makes state changes instant without breaking functionality.

import { levelEstimateModel } from './levelEstimate.js';

export const LEVEL_ESTIMATE_MORPH_CLASS = 'level-estimate-morph';

export function levelControlLabel(model) {
  if (!model) return 'JLT estimated study level';
  if (model.status === 'estimated' && model.level) return `JLT estimated study level: ${model.level}`;
  return 'JLT estimated study level: not enough evidence yet';
}

export function levelControlShortText(model) {
  if (model && model.status === 'estimated' && model.level) return model.level;
  return '—';
}

function bulletList(h, items) {
  return h('ul', { className: 'level-estimate-list' }, items.map((text) => h('li', { text })));
}

// Renders the expandable detail body from the cached model. Pure w.r.t.
// the injected element factory; called on open so content is always
// current. The always-visible face (title + level) is built in mount, so
// detail starts with the confidence line — no duplicated level heading.
export function renderLevelDetail(h, model) {
  return [
    h('p', { className: 'level-estimate-subline', text: model.subline }),
    ...(model.status === 'estimated'
      ? [
        h('p', { className: 'level-estimate-confidence', text: model.metricNote }),
        h('div', { className: 'level-estimate-pills' }, model.bandRows.map((row) =>
          h('span', { className: 'status-pill', text: `${row.band} · ${row.eligible} reviewed` })
        ))
      ]
      : []),
    h('details', { className: 'level-estimate-details' }, [
      h('summary', { text: 'How this is estimated' }),
      h('h3', { text: 'Evidence used' }),
      bulletList(h, model.evidenceLines),
      h('h3', { text: 'Explicitly not used' }),
      bulletList(h, model.notUsedLines),
      ...(model.limitationLines.length
        ? [h('h3', { text: 'Limitations' }), bulletList(h, model.limitationLines)]
        : [])
    ]),
    h('p', { className: 'level-estimate-disclaimer', text: model.disclaimer })
  ];
}

let detailIdCounter = 0;

export function createLevelEstimateControl({ fetchEstimate, createElement, doc, win }) {
  const h = createElement;
  const state = {
    model: null,
    loaded: false,
    loading: false,
    stale: false,
    openHost: null,
    closing: null,
    hosts: [],
    partsByHost: new Map()
  };

  function prefersReducedMotion() {
    return Boolean(win) && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function isIntrinsicMobile() {
    if (!win || typeof win.matchMedia !== 'function') return false;
    try {
      return Boolean(win.matchMedia('(max-width: 640px)').matches);
    } catch {
      return false;
    }
  }

  // Desktop keeps a transitionend-driven closing lifecycle so the anchored
  // morph can contract in place. Mobile closes synchronously because its
  // expanded surface has no geometric animation to coordinate.
  function finishClosing() {
    const closing = state.closing;
    if (!closing) return;
    state.closing = null;
    closing.morph.removeEventListener('transitionend', closing.onTransitionEnd);
    if (typeof closing.done === 'function') closing.done();
  }

  function onClosingTransitionEnd(closing, event) {
    if (!closing || !event || event.target !== closing.morph) return;
    const name = event.propertyName;
    if (name !== 'width' && name !== 'height' && name !== 'grid-template-rows') return;
    finishClosing();
  }

  function watchClosing(morph, done) {
    finishClosing();
    const closing = { morph, done, onTransitionEnd: null };
    closing.onTransitionEnd = (event) => onClosingTransitionEnd(closing, event);
    morph.addEventListener('transitionend', closing.onTransitionEnd);
    state.closing = closing;
  }

  function syncFaces() {
    for (const [host, parts] of state.partsByHost.entries()) {
      if (parts.valueNode) parts.valueNode.textContent = levelControlShortText(state.model);
      parts.face.setAttribute('aria-label', levelControlLabel(state.model));
      parts.face.setAttribute('aria-expanded', String(state.openHost === host));
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
    // The morph surface (face + detail) is one connected node: anything
    // inside it is "inside", everything else collapses the control.
    return !target.closest(`.${LEVEL_ESTIMATE_MORPH_CLASS}`);
  }

  function onDocumentClick(event) {
    if (state.openHost && isOutside(event && event.target)) close();
  }

  function onDocumentKeydown(event) {
    if (state.openHost && event && event.key === 'Escape') {
      const parts = state.partsByHost.get(state.openHost);
      close();
      if (parts && parts.face && typeof parts.face.focus === 'function') parts.face.focus();
    }
  }

  function renderOpenContent() {
    const parts = state.openHost ? state.partsByHost.get(state.openHost) : null;
    if (parts && state.model) parts.detailInner.replaceChildren(...renderLevelDetail(h, state.model));
  }

  function open(host) {
    finishClosing();
    if (!state.model || !state.partsByHost.has(host)) return;
    if (state.openHost && state.openHost !== host) {
      setOpen(state.openHost, false);
    }
    state.openHost = host;
    renderOpenContent();
    setOpen(host, true);
    doc.addEventListener('click', onDocumentClick);
    doc.addEventListener('keydown', onDocumentKeydown);
    syncFaces();
  }

  function setOpen(host, isOpen) {
    const parts = state.partsByHost.get(host);
    if (!parts) return;
    if (isOpen) parts.morph.classList.add('is-open');
    else parts.morph.classList.remove('is-open');
  }

  function close() {
    if (!state.openHost) return;
    const host = state.openHost;
    const parts = state.partsByHost.get(host);
    state.openHost = null;
    if (parts && isIntrinsicMobile()) {
      // Mobile uses intrinsic document flow, so collapse immediately without
      // a geometric transition or a pending transitionend lifecycle.
      setOpen(host, false);
    } else if (parts && !prefersReducedMotion()) {
      // Desktop keeps the established anchored morph and transitionend
      // cleanup lifecycle.
      parts.morph.classList.add('is-closing');
      void parts.morph.offsetWidth;
      setOpen(host, false);
      watchClosing(parts.morph, () => parts.morph.classList.remove('is-closing'));
    } else {
      setOpen(host, false);
    }
    doc.removeEventListener('click', onDocumentClick);
    doc.removeEventListener('keydown', onDocumentKeydown);
    syncFaces();
  }

  function toggle(host, event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    // open() already collapses a different open host, so cross-header
    // activation transfers instead of just closing.
    if (state.openHost === host) close();
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
      if (!state.model && state.openHost) close();
      if (state.openHost && state.model) renderOpenContent();
      syncFaces();
    } catch {
      state.model = null;
      setHostsVisible(false);
      if (state.openHost) close();
    } finally {
      state.loading = false;
      if (state.stale) { state.stale = false; load(); }
    }
  }

  function mount(host, { position = 'prepend' } = {}) {
    detailIdCounter += 1;
    const detailId = `level-estimate-detail-${detailIdCounter}`;
    const wrapper = h('div', { className: 'level-estimate-host hidden' });
    const morph = h('section', { className: LEVEL_ESTIMATE_MORPH_CLASS });
    const face = h('button', {
      className: 'level-estimate-face',
      attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': detailId, 'aria-label': levelControlLabel(null) }
    }, [
      h('span', { className: 'level-estimate-title', text: 'Estimated study level' }),
      h('span', { className: 'level-estimate-value', attrs: { 'data-level-text': 'true' }, text: '—' })
    ]);
    const detailInner = h('div', { className: 'level-estimate-detail-inner' });
    const detail = h('div', {
      className: 'level-estimate-detail',
      attrs: { id: detailId, role: 'region', 'aria-label': 'Estimated study level details' }
    }, [detailInner]);
    face.addEventListener('click', (event) => toggle(wrapper, event));
    morph.appendChild(face);
    morph.appendChild(detail);
    wrapper.appendChild(morph);
    if (position === 'prepend' && typeof host.prepend === 'function') host.prepend(wrapper);
    else host.appendChild(wrapper);
    state.hosts.push(wrapper);
    state.partsByHost.set(wrapper, {
      morph,
      face,
      detail,
      detailInner,
      valueNode: face.querySelector('[data-level-text]')
    });
    return wrapper;
  }

  function reset() {
    close();
    state.model = null;
    state.loaded = false;
    setHostsVisible(false);
    syncFaces();
  }

  function destroy() {
    finishClosing();
    if (state.openHost) {
      setOpen(state.openHost, false);
      state.openHost = null;
    }
    doc.removeEventListener('click', onDocumentClick);
    doc.removeEventListener('keydown', onDocumentKeydown);
    for (const host of state.hosts) {
      if (host.parentNode && typeof host.parentNode.removeChild === 'function') host.parentNode.removeChild(host);
    }
    state.hosts = [];
    state.partsByHost.clear();
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
    isOpen: () => state.openHost !== null,
    getModel: () => state.model,
    isLoaded: () => state.loaded
  };
}
