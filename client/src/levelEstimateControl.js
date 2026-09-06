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
// - Narrow viewports use a lightweight FLIP morph instead: the shell is
//   pinned over the collapsed trigger rect, then inline geometry animates to
//   a computed viewport sheet while .is-open transitions the visual styles;
//   close reverses the same rects in the same fixed coordinate space and
//   restores normal positioning only on the shell transitionend. The sheet
//   covers neighboring header controls without reflowing them.
// - Detail content reuses the CACHED model: opening never fetches. Refresh
//   happens on initial load and on `jlt-review-complete` only. Analyzer
//   analysis and unreviewed imports cannot change the estimate, so nothing
//   listens for them.
// - Zero JS timers: visibility is handled with a delayed `visibility`
//   transition, so `prefers-reduced-motion` (global reset + explicit rule)
//   makes state changes instant without breaking functionality.

import { levelEstimateModel } from './levelEstimate.js';

export const LEVEL_ESTIMATE_MORPH_CLASS = 'level-estimate-morph';

// Narrow-viewport FLIP geometry: the expanded sheet insets. The collapsed
// trigger rect is the source of truth for the animation origin.
const FLIP_MEDIA = '(max-width: 640px)';
const FLIP_INSET = 12;

// computeExpandedRect(trigger, viewport) -> viewport-safe expanded rect.
// Pure and unit-testable: full usable width with safe insets, top at the
// trigger origin, bottom inset preserved.
export function computeExpandedRect(trigger, viewport) {
  const width = Math.max(0, viewport.width - FLIP_INSET * 2);
  const top = Math.max(0, Math.min(trigger.top, viewport.height - FLIP_INSET - 1));
  const height = Math.max(0, viewport.height - top - FLIP_INSET);
  return { top, left: FLIP_INSET, width, height };
}

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

  function viewportSize() {
    const width = Number(win && win.innerWidth) || 0;
    const height = Number(win && win.innerHeight) || 0;
    return { width, height };
  }

  // FLIP morph is used only where the trigger-anchored popover cannot fit.
  // Everywhere else (desktop, reduced motion, unknown environment) the
  // legacy class-driven morph runs unchanged.
  function useFlipMorph() {
    if (prefersReducedMotion()) return false;
    if (!win || typeof win.matchMedia !== 'function') return false;
    try {
      return Boolean(win.matchMedia(FLIP_MEDIA).matches);
    } catch {
      return false;
    }
  }

  function measureTrigger(parts) {
    const node = parts && parts.face;
    if (node && typeof node.getBoundingClientRect === 'function') {
      const rect = node.getBoundingClientRect();
      if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) && (rect.width > 0 || rect.height > 0)) {
        return { top: rect.top || 0, left: rect.left || 0, width: rect.width || 0, height: rect.height || 0 };
      }
    }
    return null;
  }

  function applyInlineGeometry(morph, rect) {
    if (!morph || !morph.style) return;
    morph.style.position = 'fixed';
    morph.style.top = `${rect.top}px`;
    morph.style.left = `${rect.left}px`;
    morph.style.width = `${rect.width}px`;
    morph.style.height = `${rect.height}px`;
    morph.style.maxHeight = 'none';
    morph.style.margin = '0';
  }

  function clearInlineGeometry(morph) {
    if (!morph || !morph.style) return;
    for (const key of ['position', 'top', 'left', 'width', 'height', 'maxHeight', 'margin']) morph.style[key] = '';
  }

  function teardownFlip(parts) {
    if (!parts) return;
    clearInlineGeometry(parts.morph);
    parts.morph.classList.remove('is-flip');
    parts.morph.classList.remove('is-closing');
    delete parts.flipTop;
  }

  // Closing lifecycle: removing .is-open reverts the shell geometry, but on
  // mobile it also drops the viewport-fixed positioning instantly — the
  // still-expanded surface used to snap back into the header and collapse
  // there as a tall, narrow pill. close() therefore commits the expanded
  // geometry first (add .is-closing, flush), then removes .is-open so the
  // contraction animates in place; .is-closing is removed only when the
  // shell geometry transition ends. No timers: transitionend drives it, and
  // any subsequent open/destroy/load finishes it early.
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
      const previous = state.partsByHost.get(state.openHost);
      setOpen(state.openHost, false);
      teardownFlip(previous);
    }
    state.openHost = host;
    const parts = state.partsByHost.get(host);
    if (parts && useFlipMorph()) openFlip(host, parts);
    else {
      renderOpenContent();
      setOpen(host, true);
    }
    doc.addEventListener('click', onDocumentClick);
    doc.addEventListener('keydown', onDocumentKeydown);
    syncFaces();
  }

  // Narrow-viewport FLIP open: pin the shell over the collapsed trigger
  // rect, commit that frame, then animate inline geometry to the SUMMARY
  // rect (content-measured, not viewport-filling) while .is-open transitions
  // the visual styles. The shell covers neighboring header controls (higher
  // stacking, no reflow) and owns interaction in its region until it closes.
  function openFlip(host, parts) {
    const viewport = viewportSize();
    const trigger = measureTrigger(parts);
    if (!viewport.width || !viewport.height || !trigger) {
      renderOpenContent();
      setOpen(host, true);
      return;
    }
    renderOpenContent();
    wireDetailsToggle(parts);
    const sheet = computeExpandedRect(trigger, viewport);
    parts.flipTop = sheet.top;
    const summaryHeight = measureOpenHeight(parts, viewport, sheet.top) ?? sheet.height;
    parts.morph.classList.add('is-flip');
    applyInlineGeometry(parts.morph, trigger);
    void parts.morph.offsetWidth;
    parts.morph.classList.add('is-open');
    applyInlineGeometry(parts.morph, { ...sheet, height: summaryHeight });
  }

  // Content-measured open height: face + currently visible detail content +
  // shell padding, capped at the viewport-safe maximum. Because the fresh
  // <details> starts closed, this is the compact summary height on open;
  // after a toggle it is the expanded (or re-compacted) height. Returns
  // null when layout cannot be measured (caller falls back to full sheet).
  function measureOpenHeight(parts, viewport, top) {
    try {
      const faceHeight = parts.face.getBoundingClientRect().height;
      const contentHeight = parts.detailInner.scrollHeight;
      let padding = 30;
      if (win && typeof win.getComputedStyle === 'function') {
        const styles = win.getComputedStyle(parts.morph);
        const paddingTop = parseFloat(styles.paddingTop);
        const paddingBottom = parseFloat(styles.paddingBottom);
        if (Number.isFinite(paddingTop) && Number.isFinite(paddingBottom)) padding = paddingTop + paddingBottom;
      }
      if (!Number.isFinite(faceHeight) || !Number.isFinite(contentHeight)) return null;
      const maxHeight = Math.max(0, viewport.height - top - FLIP_INSET);
      return Math.max(0, Math.min(faceHeight + contentHeight + padding, maxHeight));
    } catch {
      return null;
    }
  }

  function wireDetailsToggle(parts) {
    const details = parts.detailInner.querySelector && parts.detailInner.querySelector('details');
    if (!details || typeof details.addEventListener !== 'function') return;
    details.addEventListener('toggle', () => onDetailsToggle(parts));
  }

  // B <-> C: animate the shell block-size to the newly required content
  // height (downward expansion, upward contraction). Capped at the viewport
  // maximum — beyond that the shell stops growing and the inner detail
  // region scrolls instead.
  function onDetailsToggle(parts) {
    if (!state.openHost || state.closing) return;
    if (!parts.morph.classList.contains('is-flip')) return;
    const viewport = viewportSize();
    if (!viewport.width || !viewport.height) return;
    const top = Number.isFinite(parts.flipTop) ? parts.flipTop : 0;
    const target = measureOpenHeight(parts, viewport, top) ?? Math.max(0, viewport.height - top - FLIP_INSET);
    parts.morph.style.height = `${target}px`;
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
    if (parts && parts.morph.classList.contains('is-flip') && !prefersReducedMotion()) {
      closeFlip(host, parts);
    } else if (parts && !prefersReducedMotion()) {
      // Legacy path: commit the expanded frame first (see design notes),
      // then contract with expanded positioning retained via .is-closing.
      parts.morph.classList.add('is-closing');
      void parts.morph.offsetWidth;
      setOpen(host, false);
      watchClosing(parts.morph, () => parts.morph.classList.remove('is-closing'));
    } else {
      // Legacy or reduced-motion path: also drop any stranded FLIP state
      // (e.g. reduced motion enabled mid-session) before collapsing.
      if (parts) teardownFlip(parts);
      setOpen(host, false);
    }
    doc.removeEventListener('click', onDocumentClick);
    doc.removeEventListener('keydown', onDocumentKeydown);
    syncFaces();
  }

  // Narrow-viewport FLIP close: the exact reverse of openFlip. Geometry
  // animates back to the CURRENT trigger rect in the same fixed coordinate
  // space; only the geometry transitionend restores normal positioning.
  function closeFlip(host, parts) {
    const trigger = measureTrigger(parts);
    if (!trigger) {
      teardownFlip(parts);
      setOpen(host, false);
      return;
    }
    parts.morph.classList.add('is-closing');
    void parts.morph.offsetWidth;
    parts.morph.classList.remove('is-open');
    applyInlineGeometry(parts.morph, trigger);
    watchClosing(parts.morph, () => teardownFlip(parts));
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
      const parts = state.partsByHost.get(state.openHost);
      setOpen(state.openHost, false);
      state.openHost = null;
      teardownFlip(parts);
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
