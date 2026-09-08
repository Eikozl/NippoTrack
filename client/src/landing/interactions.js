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
