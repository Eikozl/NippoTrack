export function counterValue(target, elapsed, duration) {
  const progress = Math.min(Math.max(elapsed / duration, 0), 1);
  return Math.round(target * progress);
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
