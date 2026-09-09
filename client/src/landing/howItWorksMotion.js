// NippoTrack /how-it-works scripted motion.
// Presentation-only: single IntersectionObserver drives every chapter once.
// Reuses the landing interactions architecture (visible -> short delay ->
// play once -> remain final). No fetch, no Supabase, no backend, no quiz
// logic, no writes. Counters are deterministic; charts/connectors animate
// via CSS (transform/opacity/stroke-dashoffset) toggled by .is-playing.

import { counterValue } from './interactions.js';

export const HIW_ENTER_DELAY_MS = 250;
export const HIW_HERO_TOTAL_MS = 3000;
export const HIW_PLACEMENT_TOTAL_MS = 3800;
export const HIW_ENCOUNTER_TOTAL_MS = 3100;
export const HIW_ANALYZER_TOTAL_MS = 3900;
export const HIW_AUTOFILL_TOTAL_MS = 3300;
export const HIW_CONNECTIONS_TOTAL_MS = 3300;
export const HIW_SESSION_TOTAL_MS = 2800;
export const HIW_REVIEW_TOTAL_MS = 2800;
export const HIW_PROGRESS_COUNT_MS = 1600;
export const HIW_PROGRESS_CHART_MS = 1900;
export const HIW_PROGRESS_TOTAL_MS = 3400;

export const HIW_DEMO_TO_NODE = {
  placement: 'start',
  encounter: 'encounter',
  analyzer: 'understand',
  autofill: 'keep',
  connections: 'connect',
  session: 'track',
  review: 'review',
  progress: 'see',
};

export function hiwCounterValue(target, elapsed, duration) {
  return counterValue(target, elapsed, duration);
}

function isReducedMotion() {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

function finalTextFor(node) {
  const target = node.getAttribute('data-hiw-count') ?? '';
  const suffix = node.getAttribute('data-hiw-suffix') ?? '';
  return `${target}${suffix}`;
}

function setFinalCounters(scope) {
  scope.querySelectorAll('[data-hiw-count]').forEach((node) => {
    node.textContent = finalTextFor(node);
  });
}

function animateHiwCounters(scope) {
  const nodes = [...scope.querySelectorAll('[data-hiw-count]')];
  if (nodes.length === 0) return () => {};
  const targets = nodes.map((node) => Number(node.getAttribute('data-hiw-count')));
  const suffixes = nodes.map((node) => node.getAttribute('data-hiw-suffix') ?? '');
  if (targets.some((value) => !Number.isFinite(value))) {
    setFinalCounters(scope);
    return () => {};
  }
  nodes.forEach((node) => {
    node.textContent = '0';
  });
  let frame = 0;
  let stopped = false;
  const startedAt = performance.now();
  const tick = (now) => {
    if (stopped) return;
    // When the tab is hidden, hold the current frame; resume on visible.
    try {
      if (typeof document !== 'undefined' && document.hidden) {
        frame = requestAnimationFrame(tick);
        return;
      }
    } catch {
      // Visibility guard is progressive enhancement.
    }
    const elapsed = now - startedAt;
    nodes.forEach((node, index) => {
      node.textContent = `${hiwCounterValue(targets[index], elapsed, HIW_PROGRESS_COUNT_MS)}${suffixes[index]}`;
    });
    if (elapsed < HIW_PROGRESS_COUNT_MS) {
      frame = requestAnimationFrame(tick);
    } else {
      nodes.forEach((node, index) => {
        node.textContent = `${targets[index]}${suffixes[index]}`;
      });
    }
  };
  frame = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    try {
      cancelAnimationFrame(frame);
    } catch {
      // Cleanup is careful and quiet.
    }
  };
}

function activateHiwTarget(target, root, options = {}) {
  if (!target || target.dataset.played === 'true') return () => {};
  target.dataset.played = 'true';
  target.classList.add('is-playing');
  const key = target.getAttribute('data-hiw-demo');
  if (key && HIW_DEMO_TO_NODE[key]) {
    try {
      const node = root.querySelector(`[data-hiw-thread] [data-hiw-node="${HIW_DEMO_TO_NODE[key]}"]`);
      node?.classList.add('is-active');
    } catch {
      // Thread activation is decorative enhancement.
    }
  }
  if (key === 'progress' && !options.reducedMotion) {
    return animateHiwCounters(target);
  }
  if (key === 'progress' && options.reducedMotion) {
    setFinalCounters(target);
  }
  return () => {};
}

export function initHowItWorksMotion(root, options = {}) {
  const noop = () => {};
  if (!root || typeof root.querySelectorAll !== 'function') return noop;
  const reducedMotion = options.reducedMotion ?? isReducedMotion();
  const targets = [...root.querySelectorAll('[data-hiw-hero-journey], [data-hiw-demo]')];
  if (targets.length === 0) return noop;

  const cleanups = [];
  const timers = new Set();
  const later = (fn, ms) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

  // Reduced motion: every demo is immediately final, no delays or counters.
  if (reducedMotion || !('IntersectionObserver' in window)) {
    try {
      root.classList.add('hiw-reduced-motion');
    } catch {
      // Class flag is enhancement.
    }
    targets.forEach((target) => activateHiwTarget(target, root, { reducedMotion: true }));
    return noop;
  }

  // Pause the subtle hero ambient loop while the tab is hidden.
  const onVisibility = () => {
    try {
      const hidden = document.hidden;
      targets.forEach((target) => target.classList.toggle('hiw-paused', hidden));
    } catch {
      // Visibility pause is progressive enhancement.
    }
  };
  try {
    document.addEventListener('visibilitychange', onVisibility);
  } catch {
    // Listener is enhancement.
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const target = entry.target;
        observer.unobserve(target);
        later(() => {
          const cancel = activateHiwTarget(target, root, { reducedMotion: false });
          if (typeof cancel === 'function') cleanups.push(cancel);
        }, HIW_ENTER_DELAY_MS);
      });
    },
    { threshold: 0.35 }
  );
  targets.forEach((target) => observer.observe(target));

  const cleanup = () => {
    try {
      observer.disconnect();
    } catch {
      // Disconnect is careful.
    }
    timers.forEach((id) => {
      try {
        window.clearTimeout(id);
      } catch {
        // Clear is careful.
      }
    });
    timers.clear();
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch {
        // Cleanup is careful.
      }
    });
    try {
      document.removeEventListener('visibilitychange', onVisibility);
    } catch {
      // Removal is careful.
    }
    try {
      window.removeEventListener('pagehide', cleanup);
    } catch {
      // Removal is careful.
    }
  };
  try {
    window.addEventListener('pagehide', cleanup, { once: true });
  } catch {
    // pagehide guard is progressive enhancement.
  }
  return cleanup;
}
