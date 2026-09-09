export function counterValue(target, elapsed, duration) {
  const progress = Math.min(Math.max(elapsed / duration, 0), 1);
  return Math.round(target * progress);
}

export const HERO_TYPE_MS_PER_CHAR = 28;
export const HERO_ERASE_MS_PER_CHAR = 9;
export const HERO_HOLD_MAIN_FIRST = 2200;
export const HERO_HOLD_ALT_ONE = 1650;
export const HERO_HOLD_ALT_TWO = 1750;
export const HERO_HOLD_MAIN = 5000;
export const HERO_HEADLINES = [
  'Bring your Japanese learning together.',
  'Learn everywhere. Keep it connected.',
  'Understand what you encounter. Track what matters.',
];
export const HERO_HOLDS_IN_ORDER = [
  HERO_HOLD_MAIN_FIRST,
  HERO_HOLD_ALT_ONE,
  HERO_HOLD_ALT_TWO,
  HERO_HOLD_MAIN,
];

export function heroHoldForLine(lineIndex, isFirstMain = false) {
  if (lineIndex === 0) return isFirstMain ? HERO_HOLD_MAIN_FIRST : HERO_HOLD_MAIN;
  if (lineIndex === 1) return HERO_HOLD_ALT_ONE;
  return HERO_HOLD_ALT_TWO;
}

// Starting-estimate rotation (landing + how-it-works share this helper).
// Presentation-only: cycles example levels, never a diagnosis. The visible
// value stays aria-hidden with a static sr-only example label in markup;
// width-lock + fade live in landing.css (.estimate-value).
export const ESTIMATE_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
export const ESTIMATE_ROTATE_MS = 1600;
export const ESTIMATE_FADE_MS = 240;
export const ONBOARDING_STAGED_TOTAL_MS = 5500;

export function shuffledEstimateLevels(excludeFirst) {
  const pool = [...ESTIMATE_LEVELS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (excludeFirst != null && pool[0] === excludeFirst && pool.length > 1) {
    const k = 1 + Math.floor(Math.random() * (pool.length - 1));
    [pool[0], pool[k]] = [pool[k], pool[0]];
  }
  return pool;
}

export function initEstimateRotation(scope, options = {}) {
  const noop = () => {};
  if (!scope || typeof scope.querySelectorAll !== 'function') return noop;
  try {
    const prefersReduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (options.reducedMotion ?? prefersReduced) return noop;
  } catch {
    return noop;
  }
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return noop;
  const nodes = [...scope.querySelectorAll('[data-estimate-value]')];
  if (nodes.length === 0) return noop;
  const cleanups = [];
  let visible = true;
  try {
    visible = typeof document === 'undefined' ? true : !document.hidden;
  } catch {
    visible = true;
  }
  const onVisibility = () => {
    try {
      visible = !document.hidden;
    } catch {
      visible = true;
    }
  };
  try {
    document.addEventListener('visibilitychange', onVisibility);
  } catch {
    // Gating is progressive enhancement.
  }
  cleanups.push(() => {
    try {
      document.removeEventListener('visibilitychange', onVisibility);
    } catch {
      // Removal is careful.
    }
  });
  nodes.forEach((node) => {
    let order = shuffledEstimateLevels((node.textContent || '').trim() || undefined);
    let index = 0;
    let timer = 0;
    let delayTimer = 0;
    let started = false;
    let intersecting = false;
    const step = () => {
      if (!visible || !intersecting) return;
      try {
        if (typeof document !== 'undefined' && document.hidden) return;
      } catch {
        // Visibility guard is progressive enhancement.
      }
      try {
        node.classList.add('is-switching');
      } catch {
        // Class toggle is enhancement.
      }
      window.setTimeout(() => {
        if (!visible) {
          try {
            node.classList.remove('is-switching');
          } catch {
            // Cleanup is careful.
          }
          return;
        }
        const next = order[index % order.length];
        index += 1;
        if (index % order.length === 0) order = shuffledEstimateLevels(next);
        try {
          node.textContent = next;
        } catch {
          // Text swap is careful.
        }
        try {
          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => {
              try {
                node.classList.remove('is-switching');
              } catch {
                // Cleanup is careful.
              }
            });
          } else {
            node.classList.remove('is-switching');
          }
        } catch {
          // Cleanup is careful.
        }
      }, ESTIMATE_FADE_MS);
    };
    const begin = () => {
      if (started) return;
      started = true;
      timer = window.setInterval(step, ESTIMATE_ROTATE_MS);
      cleanups.push(() => {
        try {
          window.clearInterval(timer);
        } catch {
          // Clear is careful.
        }
      });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          intersecting = !!entry.isIntersecting;
          if (!intersecting) return;
          const delay = Number(node.getAttribute('data-estimate-delay') || '0') || 0;
          if (delay > 0 && !started) {
            delayTimer = window.setTimeout(begin, delay);
            cleanups.push(() => {
              try {
                window.clearTimeout(delayTimer);
              } catch {
                // Clear is careful.
              }
            });
          } else {
            begin();
          }
        });
      },
      { threshold: 0.35 }
    );
    try {
      observer.observe(node);
    } catch {
      // Observe is enhancement.
    }
    cleanups.push(() => {
      try {
        observer.disconnect();
      } catch {
        // Disconnect is careful.
      }
    });
  });
  try {
    window.addEventListener(
      'pagehide',
      () => {
        cleanups.forEach((fn) => {
          try {
            fn();
          } catch {
            // Cleanup is careful.
          }
        });
      },
      { once: true }
    );
  } catch {
    // pagehide guard is progressive enhancement.
  }
  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch {
        // Cleanup is careful.
      }
    });
  };
}

export function initHeroTyping(root) {
  const noop = () => {};
  try {
    const stack = root?.querySelector?.('[data-hero-title-stack]');
    const typing = root?.querySelector?.('[data-hero-typing]');
    if (!stack || !typing) return noop;
    const lines = [...typing.querySelectorAll('[data-hero-line]')];
    if (lines.length !== HERO_HEADLINES.length) return noop;
    let reducedMotion = false;
    try {
      reducedMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reducedMotion = false;
    }
    if (reducedMotion) return noop;

    const fullTexts = lines.map((line, index) => HERO_HEADLINES[index] ?? line.textContent ?? '');
    // Reserve height from all lines, then start from a fully-rendered main headline.
    lines.forEach((line, index) => {
      line.textContent = fullTexts[index];
      line.classList.toggle('is-active', index === 0);
    });
    stack.classList.add('is-typing');

    let timer = 0;
    let stopped = false;
    const later = (fn, ms) => {
      if (stopped) return;
      timer = window.setTimeout(() => {
        if (stopped) return;
        fn();
      }, ms);
    };
    const setActive = (index) => {
      lines.forEach((line, position) => line.classList.toggle('is-active', position === index));
    };

    let current = 0;
    let cycleCount = 0;

    function typeChars(line, text, position, done) {
      if (stopped) return;
      if (position > text.length) {
        done();
        return;
      }
      line.textContent = text.slice(0, position);
      later(() => typeChars(line, text, position + 1, done), HERO_TYPE_MS_PER_CHAR);
    }

    function eraseChars(line, text, position, done) {
      if (stopped) return;
      if (position < 0) {
        done();
        return;
      }
      line.textContent = text.slice(0, position);
      later(() => eraseChars(line, text, position - 1, done), HERO_ERASE_MS_PER_CHAR);
    }

    // Hold order: main-first 2200 → alt1 1650 → alt2 1750 → main 5000 → repeat.
    // The first main hold differs from every later main hold; mains dominate.
    function showWithCycle() {
      if (stopped) return;
      const hold =
        current === 0 && cycleCount === 0 ? HERO_HOLD_MAIN_FIRST
        : current === 0 ? HERO_HOLD_MAIN
        : current === 1 ? HERO_HOLD_ALT_ONE
        : HERO_HOLD_ALT_TWO;
      later(() => {
        if (stopped) return;
        eraseChars(lines[current], fullTexts[current], fullTexts[current].length, () => {
          if (stopped) return;
          current = (current + 1) % lines.length;
          if (current === 0) cycleCount += 1;
          setActive(current);
          lines.forEach((line, index) => {
            if (index !== current) line.textContent = fullTexts[index];
          });
          typeChars(lines[current], fullTexts[current], 0, () => {
            if (stopped) return;
            showWithCycle();
          });
        });
      }, hold);
    }

    showWithCycle();

    const cleanup = () => {
      stopped = true;
      try {
        window.clearTimeout(timer);
      } catch {
        // Cleanup is best-effort.
      }
      try {
        window.removeEventListener('pagehide', cleanup);
      } catch {
        // Cleanup is best-effort.
      }
    };
    try {
      window.addEventListener('pagehide', cleanup, { once: true });
    } catch {
      // pagehide guard is progressive enhancement.
    }
    return cleanup;
  } catch {
    return noop;
  }
}

function animateCounters(section) {
  const counters = [...section.querySelectorAll('[data-counter]')];
  const duration = 1600;
  const startedAt = performance.now();
  counters.forEach((counter) => { counter.textContent = '0'; });

  function frame(now) {
    const elapsed = now - startedAt;
    counters.forEach((counter) => {
      const target = Number(counter.dataset.counter);
      counter.textContent = String(counterValue(target, elapsed, duration));
    });
    if (elapsed < duration) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

export function initLandingInteractions(root) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stopHeroTyping = initHeroTyping(root);
  try {
    window.addEventListener('pagehide', () => {
      try {
        stopHeroTyping?.();
      } catch {
        // Cleanup is best-effort.
      }
    }, { once: true });
  } catch {
    // pagehide guard is progressive enhancement.
  }
  const header = root.querySelector('[data-landing-header]');
  const menuButton = root.querySelector('[data-menu-button]');
  const mobileMenu = root.querySelector('[data-mobile-menu]');

  const syncHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 32);
  syncHeader();
  window.addEventListener('scroll', syncHeader, { passive: true });

  function closeMenu({ refocus = false } = {}) {
    if (!menuButton || !mobileMenu) return;
    mobileMenu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Open menu');
    if (refocus) menuButton.focus();
  }

  menuButton?.addEventListener('click', () => {
    const opening = mobileMenu.hidden;
    mobileMenu.hidden = !opening;
    menuButton.setAttribute('aria-expanded', String(opening));
    menuButton.setAttribute('aria-label', opening ? 'Close menu' : 'Open menu');
  });
  mobileMenu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => closeMenu()));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobileMenu && !mobileMenu.hidden) closeMenu({ refocus: true });
  });

  const animated = [...root.querySelectorAll('[data-demo], [data-reveal-group]')];
  const activate = (section) => {
    if (section.dataset.played === 'true') return;
    section.dataset.played = 'true';
    section.classList.add('is-playing');
    if (section.dataset.demo === 'progress' && !reducedMotion) animateCounters(section);
  };

  if (reducedMotion || !('IntersectionObserver' in window)) {
    root.classList.add('landing-reduced-motion');
    animated.forEach(activate);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      window.setTimeout(() => activate(entry.target), 300);
    });
  }, { threshold: 0.4 });
  animated.forEach((section) => observer.observe(section));
}

// Kanji stroke-sequence showcase (landing only, presentational).
// One visual stage progresses 日 → 空 → 深 with restrained Japanese readings.
// Bounded by construction: exactly these three local SVGs are ever
// fetched (never the 2136 set). Parsing reuses the app-safe path via a
// dynamic import of `../strokeOrder.js`, so the landing initial bundle
// never absorbs the app stroke code or its availability index. Rendering
// is createElementNS with `d`-only paths (no innerHTML). The panel stays
// aria-hidden presentational; there is deliberately NO replay affordance
// (no other landing showcase has one). Plays once, then rests.
export const KANJI_SEQUENCE = [
  { character: '日', readings: 'ニチ・ジツ\nひ・か' },
  { character: '空', readings: 'クウ\nそら・あく' },
  { character: '深', readings: 'シン\nふか・い' },
];
// Demo pacing is landing-specific and faster than the app's calm ~400ms
// study pacing: the full A→B→C arc lands around ~5.5s, matching the
// placement showcase arc. Reduced-motion skips drawing entirely.
export const KANJI_SEQ_DRAW_MS = 150;
export const KANJI_SEQ_PAUSE_MS = 60;
export const KANJI_SEQ_SETTLE_MS = 500;
export const KANJI_SEQ_TRANSITION_MS = 280;
export const KANJI_SEQ_SVG_NS = 'http://www.w3.org/2000/svg';
export const KANJI_SEQ_VIEWBOX = '0 0 109 109';

function defaultKanjiSeqReducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// Dynamic import on purpose: the landing chunk must not statically absorb
// the app stroke module (eligibility table + animation stay out of the
// initial landing JS; the full asset set stays out of ALL JS).
function defaultKanjiSeqLoadPaths(character, { signal } = {}) {
  return import('../strokeOrder.js').then((module) => module.loadStrokePaths(character, { signal }));
}

function measureSeqPath(path, fallback = 300) {
  try {
    const measured = path.getTotalLength?.();
    if (Number.isFinite(measured) && measured > 0) return measured;
  } catch {
    // Detached or fake DOM — fall back to a nominal length.
  }
  return fallback;
}

function setSeqDrawn(path, length, drawn) {
  path.style.strokeDasharray = String(length);
  path.style.strokeDashoffset = drawn ? '0' : String(length);
}

function buildKanjiSeqSvg(doc, pathData) {
  const svg = doc.createElementNS(KANJI_SEQ_SVG_NS, 'svg');
  svg.setAttribute('viewBox', KANJI_SEQ_VIEWBOX);
  svg.setAttribute('class', 'kanji-seq-svg');
  // Presentation attributes are OURS — only `d` is copied from the asset.
  const paths = pathData.map((d) => {
    const path = doc.createElementNS(KANJI_SEQ_SVG_NS, 'path');
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

function drawStrokesSequential(paths, { drawMs, pauseMs, raf } = {}) {
  const lengths = paths.map((path) => measureSeqPath(path));
  paths.forEach((path, index) => setSeqDrawn(path, lengths[index], false));
  if (typeof raf !== 'function') {
    paths.forEach((path, index) => setSeqDrawn(path, lengths[index], true));
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const slotMs = drawMs + pauseMs;
    const totalMs = paths.length * slotMs - pauseMs;
    let startTime = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      paths.forEach((path, index) => setSeqDrawn(path, lengths[index], true));
      resolve();
    };
    const frame = (timestamp) => {
      const now = Number.isFinite(timestamp) ? timestamp : 0;
      if (!startTime) startTime = now;
      const elapsed = now - startTime;
      if (elapsed >= totalMs) {
        finish();
        return;
      }
      const active = Math.min(paths.length - 1, Math.floor(elapsed / slotMs));
      for (let index = 0; index < active; index += 1) setSeqDrawn(paths[index], lengths[index], true);
      const within = Math.min(1, (elapsed - active * slotMs) / drawMs);
      if (within >= 1) setSeqDrawn(paths[active], lengths[active], true);
      else {
        paths[active].style.strokeDasharray = String(lengths[active]);
        paths[active].style.strokeDashoffset = String(lengths[active] * (1 - within));
      }
      raf(frame);
    };
    raf(frame);
  });
}

function addSeqClass(node, cls) {
  if (!node) return;
  try {
    if (typeof node.classList?.add === 'function') {
      node.classList.add(cls);
      return;
    }
    const current = typeof node.getAttribute === 'function' ? node.getAttribute('class') : '';
    const parts = String(current || '').split(/\s+/).filter(Boolean);
    if (!parts.includes(cls)) {
      parts.push(cls);
      node.setAttribute?.('class', parts.join(' '));
    }
  } catch {
    // State classes are enhancement only.
  }
}

function removeSeqClass(node, cls) {
  try {
    node?.classList?.remove?.(cls);
  } catch {
    // State classes are enhancement only.
  }
}

function stageForSequence(container) {
  return container?.querySelector?.('[data-kanji-seq-stage]') ?? null;
}

function setSequenceStage(stage, entry) {
  const glyph = stage?.querySelector?.('[data-kanji-seq-glyph]') ?? null;
  const readings = stage?.querySelector?.('[data-kanji-seq-readings]') ?? null;
  if (!glyph) return null;
  glyph.textContent = entry.character;
  glyph.setAttribute?.('data-kanji-seq-glyph', entry.character);
  if (readings) readings.textContent = entry.readings;
  return glyph;
}

// Runs the scripted sequence inside one `[data-kanji-sequence]` stage.
// Once-only: a second call returns `{ status: 'skipped' }` without any fetch.
// Fail-open per item: an unresolvable SVG holds its static glyph, then the
// sequence calmly continues to the next character.
export async function playKanjiSequence(container, options = {}) {
  if (!container || container.dataset?.kanjiPlayed === 'true') return { status: 'skipped', settled: [] };
  try {
    container.dataset.kanjiPlayed = 'true';
  } catch {
    // Dataset guard is best-effort.
  }
  const doc = options.doc ?? container.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  const loadPaths = options.loadPaths ?? defaultKanjiSeqLoadPaths;
  const prefersReducedMotion = options.prefersReducedMotion ?? defaultKanjiSeqReducedMotion;
  const raf = options.raf ?? (typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : undefined);
  const drawMs = options.drawMs ?? KANJI_SEQ_DRAW_MS;
  const pauseMs = options.pauseMs ?? KANJI_SEQ_PAUSE_MS;
  const settleMs = options.settleMs ?? KANJI_SEQ_SETTLE_MS;
  const transitionMs = options.transitionMs ?? KANJI_SEQ_TRANSITION_MS;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const signal = options.signal ?? null;
  let reduced = false;
  try {
    reduced = prefersReducedMotion() === true;
  } catch {
    reduced = false;
  }

  const stage = stageForSequence(container);
  if (!stage || !doc) return { status: 'skipped', settled: [] };
  const sequence = reduced ? [KANJI_SEQUENCE.at(-1)] : KANJI_SEQUENCE;
  const settled = [];

  for (let index = 0; index < sequence.length; index += 1) {
    const entry = sequence[index];
    if (index > 0) {
      addSeqClass(stage, 'is-transitioning');
      if (transitionMs > 0) await wait(transitionMs);
    }
    const glyph = setSequenceStage(stage, entry);
    stage.getBoundingClientRect?.();
    removeSeqClass(stage, 'is-transitioning');
    let pathData = null;
    try {
      pathData = await loadPaths(entry.character, { signal });
    } catch {
      pathData = null;
    }
    if (!glyph || !Array.isArray(pathData) || !pathData.length) {
      if (!reduced && index < sequence.length - 1 && settleMs > 0) await wait(settleMs);
      continue;
    }
    const { svg, paths } = buildKanjiSeqSvg(doc, pathData);
    glyph.textContent = '';
    glyph.replaceChildren(svg);
    if (reduced) {
      const lengths = paths.map((path) => measureSeqPath(path));
      paths.forEach((path, pathIndex) => setSeqDrawn(path, lengths[pathIndex], true));
    } else {
      await drawStrokesSequential(paths, { drawMs, pauseMs, raf });
    }
    settled.push(entry.character);
    if (!reduced && index < sequence.length - 1 && settleMs > 0) await wait(settleMs);
  }
  if (reduced) {
    addSeqClass(container, 'is-complete');
    return { status: 'final', settled };
  }
  addSeqClass(container, 'is-complete');
  return { status: 'played', settled };
}

// One-shot viewport wiring for the kanji sequence: plays once when the
// kanji section enters the viewport (same 0.4 threshold + 300ms enter
// wait as the shared demo observer), then disconnects. Reduced-motion or
// no-IntersectionObserver renders the final resting state immediately.
export function initKanjiSequence(root, options = {}) {
  const noop = () => {};
  const container = root?.querySelector?.('[data-kanji-sequence]') ?? null;
  if (!container) return noop;
  let reduced = false;
  try {
    reduced = (options.reducedMotion ?? defaultKanjiSeqReducedMotion()) === true;
  } catch {
    reduced = false;
  }
  const run = () => {
    try {
      const result = playKanjiSequence(container, {
        ...options,
        prefersReducedMotion: () => (options.reducedMotion ?? defaultKanjiSeqReducedMotion()) === true
      });
      if (result?.catch) result.catch(() => {});
    } catch {
      // Presentational and fail-open.
    }
  };
  if (reduced) {
    run();
    return noop;
  }
  const Observer = options.observerClass
    ?? (typeof window !== 'undefined' ? window.IntersectionObserver : undefined)
    ?? globalThis.IntersectionObserver;
  if (typeof Observer !== 'function') {
    run();
    return noop;
  }
  let section = null;
  try {
    let node = container.parentElement ?? container.parentNode ?? null;
    while (node) {
      let isKanjiDemo = false;
      try {
        if (typeof node.matches === 'function') isKanjiDemo = node.matches('[data-demo="kanji"]');
        else if (typeof node.matchesSelector === 'function') isKanjiDemo = node.matchesSelector('[data-demo="kanji"]');
      } catch {
        isKanjiDemo = false;
      }
      if (isKanjiDemo) {
        section = node;
        break;
      }
      node = node.parentElement ?? node.parentNode ?? null;
    }
  } catch {
    section = null;
  }
  const target = section ?? container;
  let observer = null;
  try {
    observer = new Observer((entries) => {
      for (const entry of entries ?? []) {
        if (!entry?.isIntersecting) continue;
        try {
          observer?.unobserve?.(target);
        } catch {
          // Unobserve is best-effort.
        }
        try {
          observer?.disconnect?.();
        } catch {
          // Disconnect is best-effort.
        }
        const delay = options.enterDelayMs ?? 300;
        if (delay > 0 && typeof setTimeout === 'function') setTimeout(run, delay);
        else run();
        break;
      }
    }, { threshold: 0.4 });
  } catch {
    run();
    return noop;
  }
  try {
    observer.observe(target);
  } catch {
    run();
    return noop;
  }
  const cleanup = () => {
    try {
      observer?.disconnect?.();
    } catch {
      // Cleanup is best-effort.
    }
  };
  try {
    window.addEventListener('pagehide', cleanup, { once: true });
  } catch {
    // pagehide guard is progressive enhancement.
  }
  return cleanup;
}
