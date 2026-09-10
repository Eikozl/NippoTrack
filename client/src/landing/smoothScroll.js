// v5.1-E.3 Lenis smooth scroll — PUBLIC landing experience only.
// Never imported by the authenticated app (main.js/entry app branch).
// Fail-open: any import/runtime failure keeps native scrolling.
// Reduced-motion users always keep native behavior.
//
// Preserved: anchor navigation, URL/hash behavior, keyboard scrolling,
// touch behavior (Lenis smooths wheel only; touch stays native), browser
// history expectations, focus behavior, IntersectionObserver reveals
// (Lenis emits native scroll positions; IO thresholds untouched).

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

export async function initLandingSmoothScroll(scope) {
  const noop = () => {};
  if (!shouldEnhanceScroll()) return noop;
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop;
  let lenis = null;
  let rafId = 0;
  let stopped = false;
  const cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);

  try {
    const module = await import('lenis');
    if (stopped) return noop;
    const Lenis = module?.default || module?.Lenis;
    if (typeof Lenis !== 'function') return noop;
    // Restrained feel: subtle smoothing only. Low lerp keeps wheel response
    // immediate; no scroll-jacking, no cinematic inertia.
    lenis = new Lenis({ lerp: 0.12, smoothWheel: true });
    const raf = (time) => {
      if (stopped) return;
      try { lenis.raf(time); } catch { /* smoothing is enhancement */ }
      rafId = window.requestAnimationFrame(raf);
    };
    rafId = window.requestAnimationFrame(raf);
    onCleanup(() => {
      try { window.cancelAnimationFrame(rafId); } catch { /* noop */ }
      try { lenis.destroy(); } catch { /* noop */ }
    });
  } catch {
    return noop;
  }

  // Anchor navigation: smooth-scroll to in-page targets, then sync the hash
  // via history (no jump) and move focus for keyboard/screen-reader users.
  // External links, new-tab links, and non-in-page hashes are untouched.
  const root = scope && typeof scope.querySelectorAll === 'function' ? scope : document;
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
      lenis.scrollTo(target, { offset: -8, duration: 1.0, onComplete: done });
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
