// v5.1-B.2 KanjiVG-supported stroke-order animation — one shared implementation for both
// detail surfaces (Reference page + owned dialog via the shared kanjiDetail
// builder). Client-only: assets are static SVGs under `stroke/kanji/`
// (vendored KanjiVG, never bundled). Eligibility comes only from the generated
// local asset index; this module remains a lazy chunk.
//
// Autoplay by design: a supported mount fetches immediately and draws without
// any trigger gesture (no trigger button, no Close, Escape does nothing —
// the animation is persistent, not an overlay to dismiss). ONE Replay
// button appears only after the first completion. While the animated SVG
// is present the static font glyph hides, so the finished stroke SVG is
// the single clean final rendering (no ghost, no double-render).
//
// Security core: the fetched SVG is NEVER injected via innerHTML. The text
// is parsed with DOMParser and ONLY `<path>` `d` attributes (document
// order) are re-created programmatically via createElementNS — ids,
// kvg:* attributes, groups, styles and everything else are dropped.

import {
  hasStrokeAssetCodePoint,
  strokeAssetCodePoints
} from './strokeAssetIndex.js';

export { strokeAssetCodePoints };

export const STROKE_SVG_NS = 'http://www.w3.org/2000/svg';
export const STROKE_SVG_VIEWBOX = '0 0 109 109';
// Calm pacing: ~400ms per stroke with a short inter-stroke pause.
export const STROKE_DRAW_MS = 400;
export const STROKE_PAUSE_MS = 90;
export const STROKE_SLOT_SELECTOR = '[data-kanji-stroke-slot]';

export function hasStrokeAsset(character) {
  if (typeof character !== 'string' || [...character].length !== 1) return false;
  return hasStrokeAssetCodePoint(character.codePointAt(0));
}

// Ghost discipline: the animated SVG and the static font glyph must never
// paint together. While the stroke view is present the sibling
// `.kanji-glyph-large` hides (attribute + property so real DOM and test
// doubles stay in sync); failures and cleanups restore it so the static
// glyph always stands alone outside the animation.
function glyphForSlot(slot) {
  try {
    const parent = slot?.parentElement ?? slot?.parentNode ?? null;
    return parent?.querySelector?.('.kanji-glyph-large') ?? null;
  } catch {
    return null;
  }
}

function hideGlyph(slot) {
  const glyph = glyphForSlot(slot);
  if (!glyph) return;
  try {
    glyph.setAttribute?.('hidden', '');
    glyph.setAttribute?.('aria-hidden', 'true');
  } catch {
    // Presentational hiding must never throw.
  }
  try {
    glyph.hidden = true;
  } catch {
    // Test-double safety.
  }
}

function restoreGlyph(slot) {
  const glyph = glyphForSlot(slot);
  if (!glyph) return;
  try {
    glyph.removeAttribute?.('hidden');
    glyph.removeAttribute?.('aria-hidden');
  } catch {
    // Presentational restore must never throw.
  }
  try {
    glyph.hidden = false;
  } catch {
    // Test-double safety.
  }
}

// KanjiVG file naming: lowercase hex of the code point, left-padded to at
// least 5 digits (`05b66.svg` = 学 U+5B66, `20b9f.svg` = 𠮟 U+20B9F).
export function strokeFileName(character) {
  if (!hasStrokeAsset(character)) return null;
  const codePoint = character.codePointAt(0);
  return `${codePoint.toString(16).padStart(5, '0')}.svg`;
}

// Relative to the app base. The app serves at root `/` (dev + Vercel, no
// `<base>` tag, hash routing never changes the document path), so the
// relative `stroke/...` URL resolves to `/stroke/kanji/<hex>.svg` in every
// deployment. An explicit base covers hypothetical subpath serving.
export function strokeAssetUrl(character, base = '') {
  const file = strokeFileName(character);
  if (!file) return null;
  const prefix = base ? `${String(base).replace(/\/*$/, '')}/` : '';
  return `${prefix}stroke/kanji/${file}`;
}

// Pure extraction: ONLY `<path>` `d` attributes in document order.
// Groups/structure elements are ignored by construction (querySelectorAll
// finds paths wherever they nest); empty/invalid `d` values are dropped.
export function extractStrokePathsFromDocument(svgDocument) {
  const nodes = Array.from(svgDocument?.querySelectorAll?.('path') || []);
  return nodes
    .map((node) => (typeof node.getAttribute === 'function' ? node.getAttribute('d') : null))
    .filter((d) => typeof d === 'string' && d.trim().length > 0);
}

function defaultParseSvgText(svgText) {
  return new DOMParser().parseFromString(String(svgText), 'image/svg+xml');
}

function hasParserError(svgDocument) {
  try {
    if (typeof svgDocument?.getElementsByTagName === 'function') {
      return svgDocument.getElementsByTagName('parsererror').length > 0;
    }
  } catch {
    return false;
  }
  return false;
}

// Autoplay by design: called immediately on mount, never on a gesture.
// Rejects on fetch failure, parse failure, or zero extracted paths →
// caller degrades to the static fallback.
export async function loadStrokePaths(character, options = {}) {
  const { fetchFn = globalThis.fetch, parseFn = null, signal = null } = options;
  const url = strokeAssetUrl(character);
  if (!url) throw new Error('No stroke asset for this character.');
  if (typeof fetchFn !== 'function') throw new Error('Fetch is unavailable.');
  const response = await fetchFn(url, signal ? { signal } : undefined);
  if (!response || response.ok === false) {
    throw new Error(`Stroke asset unavailable (${response?.status ?? 'network'}).`);
  }
  const svgText = await response.text();
  let svgDocument = null;
  try {
    svgDocument = parseFn ? await parseFn(svgText) : defaultParseSvgText(svgText);
  } catch {
    throw new Error('Stroke asset unreadable.');
  }
  if (!svgDocument || hasParserError(svgDocument)) throw new Error('Stroke asset unreadable.');
  const paths = extractStrokePathsFromDocument(svgDocument);
  if (!paths.length) throw new Error('Stroke asset has no paths.');
  return paths;
}

function defaultPrefersReducedMotion() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

function buildAnimatedSvg(doc, pathData, character) {
  const svg = doc.createElementNS(STROKE_SVG_NS, 'svg');
  svg.setAttribute('viewBox', STROKE_SVG_VIEWBOX);
  svg.setAttribute('class', 'stroke-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Stroke order for ${character}: ${pathData.length} strokes`);
  // Presentation attributes are OURS — only `d` is copied from the asset.
  // Never copy id / kvg:* / transform / style from the source file.
  const paths = pathData.map((d) => {
    const path = doc.createElementNS(STROKE_SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '4.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return path;
  });
  return { svg, paths };
}

function pathLength(path, fallback = 300) {
  try {
    const measured = path.getTotalLength?.();
    if (Number.isFinite(measured) && measured > 0) return measured;
  } catch {
    // Detached or fake DOM — fall back to a nominal length.
  }
  return fallback;
}

function setDrawn(path, length, drawn) {
  path.style.strokeDasharray = String(length);
  path.style.strokeDashoffset = drawn ? '0' : String(length);
}

// Sequential draw driven by rAF timestamps (pauses folded into per-stroke
// slots). Returns a cancel function. Reduced-motion callers skip this and
// render the final state directly.
function playSequential(paths, options = {}) {
  const {
    drawMs = STROKE_DRAW_MS,
    pauseMs = STROKE_PAUSE_MS,
    raf = globalThis.requestAnimationFrame?.bind(globalThis),
    caf = globalThis.cancelAnimationFrame?.bind(globalThis),
    onDone = () => {}
  } = options;
  const lengths = paths.map((path) => pathLength(path));
  paths.forEach((path, index) => setDrawn(path, lengths[index], false));
  if (typeof raf !== 'function') {
    paths.forEach((path, index) => setDrawn(path, lengths[index], true));
    onDone();
    return () => {};
  }
  const slotMs = drawMs + pauseMs;
  const totalMs = paths.length * slotMs - pauseMs;
  let cancelled = false;
  let rafId = 0;
  let startTime = 0;
  const finish = () => {
    paths.forEach((path, index) => setDrawn(path, lengths[index], true));
    onDone();
  };
  const frame = (timestamp) => {
    if (cancelled) return;
    const now = Number.isFinite(timestamp) ? timestamp : 0;
    if (!startTime) startTime = now;
    const elapsed = now - startTime;
    if (elapsed >= totalMs) {
      finish();
      return;
    }
    const active = Math.min(paths.length - 1, Math.floor(elapsed / slotMs));
    for (let index = 0; index < active; index += 1) setDrawn(paths[index], lengths[index], true);
    const within = Math.min(1, (elapsed - active * slotMs) / drawMs);
    setDrawn(paths[active], lengths[active], within >= 1);
    if (within < 1) {
      paths[active].style.strokeDashoffset = String(lengths[active] * (1 - within));
    }
    rafId = raf(frame);
  };
  rafId = raf(frame);
  return () => {
    cancelled = true;
    try {
      if (typeof caf === 'function') caf(rafId);
      else clearTimeout(rafId);
    } catch {
      // Cleanup must never throw.
    }
  };
}

// Mounts the stroke autoplay into a B.1 `.kanji-stroke-slot`.
// - Unsupported: slot left empty/static (no control, no fetch), aria-hidden
//   restored — zero visual trace, the static font glyph stands alone.
// - Supported: fetch starts immediately on mount and the sequence auto-plays
//   (no trigger button is ever rendered, no Close, Escape does nothing —
//   the animation is persistent, not an overlay to dismiss). ONE Replay
//   button appears only after the first completion and replays on demand.
// Ghost discipline: the static font glyph stays visible only while
// loading; once the animated SVG opens, the glyph hides so the SVG is the
// SOLE rendering during the draw and remains the single clean final image
// after completion (no swap-back, no dim duplicate, no overlay artifacts).
// Autoplay never moves focus; Replay is a plain keyboard-reachable button
// with a visible focus ring and a self-explanatory aria-label.
// Returns a cleanup (abort fetch, cancel animation, remove listeners,
// restore the glyph) that is also stored on the slot so remounts never
// accumulate.
export function mountStrokeOrder(slot, options = {}) {
  if (slot?.__strokeCleanup) {
    try {
      slot.__strokeCleanup();
    } catch {
      // A stale cleanup must never block the fresh mount.
    }
    slot.__strokeCleanup = null;
  }
  const character = options.character
    ?? slot?.dataset?.kanjiStrokeSlot
    ?? (typeof slot?.getAttribute === 'function' ? slot.getAttribute('data-kanji-stroke-slot') : null)
    ?? '';
  const doc = options.doc ?? slot?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!slot || !doc || !hasStrokeAsset(character)) {
    if (slot && typeof slot.replaceChildren === 'function') {
      slot.replaceChildren();
      slot.setAttribute?.('aria-hidden', 'true');
      slot.removeAttribute?.('data-stroke-state');
    }
    restoreGlyph(slot);
    return () => {};
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const parseFn = options.parseFn ?? null;
  const raf = options.raf ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const caf = options.caf ?? globalThis.cancelAnimationFrame?.bind(globalThis);
  const prefersReducedMotion = options.prefersReducedMotion ?? defaultPrefersReducedMotion;
  const drawMs = options.drawMs ?? STROKE_DRAW_MS;
  const pauseMs = options.pauseMs ?? STROKE_PAUSE_MS;

  let disposed = false;
  let runToken = 0;
  let aborter = null;
  let cancelPlay = null;
  let state = 'loading'; // loading | playing | done | failed
  let strokePaths = [];
  let replayButton = null;
  let view = null;

  // Detached slots (dialog closed / reference re-rendered) stop work on the
  // next boundary instead of leaking into a new kanji.
  const isAlive = () => !disposed && slot.isConnected !== false;

  const showFailure = () => {
    if (!isAlive()) return;
    state = 'failed';
    slot.setAttribute?.('data-stroke-state', 'failed');
    restoreGlyph(slot);
    const note = doc.createElement('p');
    note.setAttribute('class', 'stroke-note');
    note.setAttribute('role', 'status');
    note.textContent = 'Stroke order unavailable';
    slot.replaceChildren(note);
  };

  const showReplay = () => {
    if (!replayButton) return;
    replayButton.disabled = false;
    try {
      replayButton.removeAttribute?.('hidden');
    } catch {
      // Visibility restore must never throw.
    }
    try {
      replayButton.hidden = false;
    } catch {
      // Test-double safety.
    }
  };

  const hideReplay = () => {
    if (!replayButton) return;
    replayButton.disabled = true;
    try {
      replayButton.setAttribute?.('hidden', '');
    } catch {
      // Visibility hiding must never throw.
    }
    try {
      replayButton.hidden = true;
    } catch {
      // Test-double safety.
    }
  };

  const renderFinal = () => {
    strokePaths.forEach((path) => setDrawn(path, pathLength(path), true));
    state = 'done';
    slot.setAttribute?.('data-stroke-state', 'done');
    showReplay();
  };

  const replay = () => {
    if ((state !== 'playing' && state !== 'done') || !strokePaths.length || !isAlive()) return;
    const run = runToken;
    cancelPlay?.();
    cancelPlay = null;
    hideReplay();
    if (prefersReducedMotion()) {
      renderFinal();
      return;
    }
    state = 'playing';
    slot.setAttribute?.('data-stroke-state', 'playing');
    cancelPlay = playSequential(strokePaths, {
      drawMs,
      pauseMs,
      raf,
      caf,
      onDone: () => {
        if (run !== runToken || !isAlive()) return;
        renderFinal();
      }
    });
  };

  const openView = (pathData, run) => {
    if (run !== runToken || !isAlive()) return;
    view = doc.createElement('div');
    view.setAttribute('class', 'stroke-view');
    const { svg, paths } = buildAnimatedSvg(doc, pathData, character);
    strokePaths = paths;

    replayButton = doc.createElement('button');
    replayButton.setAttribute('type', 'button');
    replayButton.setAttribute('class', 'button-secondary stroke-replay');
    replayButton.setAttribute('aria-label', `Replay stroke order for ${character}`);
    replayButton.textContent = 'Replay';
    const controls = doc.createElement('div');
    controls.setAttribute('class', 'stroke-controls');
    controls.appendChild(replayButton);
    view.appendChild(svg);
    view.appendChild(controls);
    slot.replaceChildren(view);
    // Ghost fix: the static font glyph hides the moment the animated SVG
    // takes over, so only the strokes ever paint. It stays hidden after
    // completion — the finished SVG is the single final rendering.
    hideGlyph(slot);
    hideReplay();

    const onReplayClick = () => replay();
    replayButton.addEventListener('click', onReplayClick);
    listeners.push(() => replayButton?.removeEventListener?.('click', onReplayClick));
    // Intentionally no Escape handling and no focus moves: autoplay is
    // persistent (nothing to dismiss) and must never steal focus.

    if (prefersReducedMotion()) {
      renderFinal();
      return;
    }
    state = 'playing';
    slot.setAttribute?.('data-stroke-state', 'playing');
    cancelPlay = playSequential(strokePaths, {
      drawMs,
      pauseMs,
      raf,
      caf,
      onDone: () => {
        if (run !== runToken || !isAlive()) return;
        renderFinal();
      }
    });
  };

  const listeners = [];
  // Autoplay on mount: fetch immediately (no trigger button, no user
  // gesture, no focus change). A polite loading note holds the slot while
  // the static font glyph stays visible underneath.
  state = 'loading';
  slot.setAttribute?.('data-stroke-state', 'loading');
  slot.removeAttribute?.('aria-hidden');
  const loadingNote = doc.createElement('p');
  loadingNote.setAttribute('class', 'stroke-note');
  loadingNote.setAttribute('role', 'status');
  loadingNote.textContent = 'Loading stroke order…';
  slot.replaceChildren(loadingNote);
  const run = (runToken += 1);
  if (typeof AbortController !== 'undefined') {
    aborter = new AbortController();
  }
  // Captured synchronously: a remount in the same tick still hands the
  // request the (then-aborted) signal instead of a nulled one.
  const mountSignal = aborter?.signal ?? null;
  Promise.resolve()
    .then(() => loadStrokePaths(character, { fetchFn, parseFn, signal: mountSignal }))
    .then((pathData) => openView(pathData, run))
    .catch(() => {
      if (run !== runToken || !isAlive()) return;
      showFailure();
    });

  const cleanup = () => {
    disposed = true;
    runToken += 1;
    cancelPlay?.();
    cancelPlay = null;
    aborter?.abort?.();
    aborter = null;
    listeners.forEach((remove) => {
      try {
        remove();
      } catch {
        // Cleanup must never throw.
      }
    });
    listeners.length = 0;
    restoreGlyph(slot);
  };
  slot.__strokeCleanup = cleanup;
  return cleanup;
}

// Mounts every B.1 slot under root (both surfaces render the same slot
// markup). Fail-open: a missing/unsupported DOM never throws.
export function mountStrokeSlots(root, options = {}) {
  try {
    const slots = Array.from(root?.querySelectorAll?.(STROKE_SLOT_SELECTOR) ?? []);
    return slots.map((slot) => mountStrokeOrder(slot, {
      ...options,
      character: options.character
        ?? slot?.dataset?.kanjiStrokeSlot
        ?? (typeof slot?.getAttribute === 'function' ? slot.getAttribute('data-kanji-stroke-slot') : null)
    }));
  } catch {
    return [];
  }
}
