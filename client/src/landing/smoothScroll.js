// v5.1-E corrective Lenis smooth scroll — PUBLIC landing experience only.
// Never imported by the authenticated app (main.js/entry app branch).
// Production fails open AND stays silent; development/diagnosis exposes
// state via `?jlt-lenis-debug=1` (marker + console) so init failure can be
// triaged instead of guessed. Reduced-motion users always keep native.
//
// Preserved: anchor navigation, URL/hash behavior, keyboard scrolling,
// touch behavior (Lenis smooths wheel only; touch stays native), browser
// history expectations, focus behavior, IntersectionObserver reveals
// (Lenis emits native scroll positions; IO thresholds untouched).

// Tuned feel: NOTICEABLE but controlled — smooth, responsive, slightly
// inertial. Lower lerp = heavier glide; upstream default is 0.1 and the
// first E pass used 0.12 (≈ native, imperceptible). 0.09 sits clearly above
// the perception threshold without floaty lag (never below ~0.06).
export const LANDING_LENIS_LERP = 0.09;
export const LANDING_LENIS_ANCHOR_DURATION = 1.0;
export const LANDING_LENIS_ANCHOR_OFFSET = -8;

export function shouldEnhanceScroll() {
  try {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    // Touch-first viewports keep native momentum scrolling.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return false;
    return true;
  } catch {
    return false;
  }
}

// Dev/diagnosis channel. True in Vite dev or with ?jlt-lenis-debug=1.
// Guarded for DOM-free unit tests (no window / no import.meta.env).
export function isLenisDebug() {
  try {
    if (typeof window !== 'undefined' && typeof window.location?.search === 'string' && window.location.search.includes('jlt-lenis-debug')) return true;
  } catch {
    // Query check is best-effort.
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta?.env?.DEV) return true;
  } catch {
    // import.meta access throws outside ESM — ignore.
  }
  return false;
}

function debugLog(...args) {
  if (!isLenisDebug()) return;
  try { console.debug('[jlt-lenis]', ...args); } catch { /* logging is best-effort */ }
}

function markState(state) {
  // Observable in DevTools: documentElement[data-jlt-lenis] + handle.
  // States: on | off (gate/native) | error (import/runtime failure).
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      if (state) document.documentElement.dataset.jltLenis = state;
      else delete document.documentElement.dataset.jltLenis;
    }
  } catch {
    // Marking is best-effort.
  }
  try {
    if (typeof window !== 'undefined') {
      if (state === 'on') return; // handle assigned at init; keep it live.
      try { delete window.__jltLenis; } catch { /* handle cleanup is best-effort */ }
    }
  } catch {
    // Handle cleanup is best-effort.
  }
}

const defaultLoadLenis = () => import('lenis');

export async function initLandingSmoothScroll(scope, { loadLenis = defaultLoadLenis } = {}) {
  const noop = () => {};
  if (!shouldEnhanceScroll()) { debugLog('native: gate (reduced-motion or touch-first)'); markState('off'); return noop; }
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop;
  let lenis = null;
  let rafId = 0;
  let stopped = false;
  const cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);

  try {
    const module = await loadLenis();
    if (stopped) return noop;
    const Lenis = module?.default || module?.Lenis;
    if (typeof Lenis !== 'function') { debugLog('error: lenis module has no constructor'); markState('error'); return noop; }
    lenis = new Lenis({ lerp: LANDING_LENIS_LERP, smoothWheel: true });
    debugLog(`on: lerp=${LANDING_LENIS_LERP}`);
    try {
      if (typeof window !== 'undefined') window.__jltLenis = lenis;
    } catch {
      // Handle is best-effort.
    }
    markState('on');
    const raf = (time) => {
      if (stopped) return;
      try { lenis.raf(time); } catch { /* smoothing is enhancement */ }
      rafId = window.requestAnimationFrame(raf);
    };
    rafId = window.requestAnimationFrame(raf);
    onCleanup(() => {
      try { window.cancelAnimationFrame(rafId); } catch { /* noop */ }
      try { lenis.destroy(); } catch { /* noop */ }
      markState(null);
    });
  } catch (error) {
    debugLog('error: load/init failed, native fallback', error?.message || error);
    markState('error');
    return noop;
  }

  // Anchor navigation: smooth-scroll to in-page targets, then sync the hash
  // via history (no jump) and move focus for keyboard/screen-reader users.
  // External links, new-tab links, and non-in-page hashes are untouched.
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.('a[href^="#"]');
    if (!anchor) return;
    const hash = anchor.getAttribute('href');
    if (!hash || hash.length < 2) return;
    const target = document.getElementById(hash.slice(1));
    if (!target) return;
    event.preventDefault();
    const done = () => {
      try { window.history.pushState(null, '', hash); } catch { /* hash sync is enhancement */ }
      try {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      } catch { /* focus is enhancement */ }
    };
    try {
      lenis.scrollTo(target, { offset: LANDING_LENIS_ANCHOR_OFFSET, duration: LANDING_LENIS_ANCHOR_DURATION, onComplete: done });
    } catch {
      try { target.scrollIntoView(); } catch { /* native fallback */ }
      done();
    }
  };
  document.addEventListener('click', onClick);
  onCleanup(() => {
    try { document.removeEventListener('click', onClick); } catch { /* noop */ }
  });

  const cleanup = () => {
    stopped = true;
    cleanups.forEach((fn) => {
      try { fn(); } catch { /* cleanup is best-effort */ }
    });
  };
  try {
    window.addEventListener('pagehide', cleanup, { once: true });
  } catch { /* pagehide guard is progressive enhancement */ }
  return cleanup;
}
