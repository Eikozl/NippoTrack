// App icon draw-in animation — shown once on first open while assets load.
// Draws the NippoTrack app icon (stylized katakana ン, "n") as SVG strokes
// traced on screen, then fades out and yields to the real app shell.
// Fail-open: any failure resolves immediately so the app is never trapped.

const ICON_SEEN_KEY = 'jlt-app-icon-animated';
const DRAW_MS = 1100;

export function hasSeenAppIconAnimation() {
  try { return localStorage.getItem(ICON_SEEN_KEY) === '1'; } catch { return true; }
}
export function markAppIconAnimationSeen() {
  try { localStorage.setItem(ICON_SEEN_KEY, '1'); } catch { /* best-effort */ }
}

// Stylized katakana ン (n) — two strokes:
//   1. Vertical down (short)
//   2. Curve: starts top-right, sweeps down-left through the base, ends
//      pointing up-right — forming the open loop characteristic of ン.
const SVG = `
<svg class="app-icon-svg" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-label="NippoTrack app icon">
  <defs>
    <style>
      .icon-stroke { fill: none; stroke: currentColor; stroke-width: 3.4; stroke-linecap: round; stroke-linejoin: round; }
    </style>
  </defs>
  <g class="icon-stroke">
    <!-- Stroke 1: short vertical on the left -->
    <path d="M 20 18 L 20 44" />
    <!-- Stroke 2: the sweeping loop of ン -->
    <path d="M 44 18 Q 20 18 20 44 Q 20 54 30 54 Q 40 54 44 44 L 48 36" />
  </g>
</svg>
`;

export function mountAppIconAnimation(container) {
  return new Promise((resolveAnim) => {
    const wrap = document.createElement('div');
    wrap.className = 'app-icon-animation-wrap';
    wrap.innerHTML = `<div class="app-icon-inner">${SVG}</div>`;
    container.appendChild(wrap);

    const paths = wrap.querySelectorAll('.icon-stroke path');
    let resolved = false;

    function resolve() {
      if (resolved) return;
      resolved = true;
      wrap.classList.add('app-icon-animation-wrap--done');
      setTimeout(() => { wrap.remove(); markAppIconAnimationSeen(); resolveAnim(); }, DRAW_MS);
    }

    paths.forEach((path) => {
      try {
        const len = path.getTotalLength ? path.getTotalLength() : 100;
        path.style.strokeDasharray = len;
        path.style.strokeDashoffset = len;
        path.style.animation = `app-icon-draw ${DRAW_MS / 1000}s ease-out forwards`;
      } catch {
        path.style.strokeDasharray = '100';
        path.style.strokeDashoffset = '100';
        path.style.animation = `app-icon-draw ${DRAW_MS / 1000}s ease-out forwards`;
      }
    });

    const timer = setTimeout(resolve, DRAW_MS + 300);
    const last = paths[paths.length - 1];
    if (last) {
      last.addEventListener('animationend', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

export function createAppIconAnimationStyles() {
  const style = document.createElement('style');
  style.textContent = `
.app-icon-animation-wrap {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  background: var(--jlt-bg);
  transition: opacity 400ms ease;
}
.app-icon-animation-wrap--done { opacity: 0; pointer-events: none; }
.app-icon-inner {
  width: min(96px, 34vw);
  height: auto;
  display: grid;
  place-items: center;
}
.app-icon-svg { width: 100%; height: auto; color: var(--jlt-primary); }
@keyframes app-icon-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .icon-stroke path { animation: none !important; stroke-dashoffset: 0 !important; }
  .app-icon-animation-wrap { opacity: 0 !important; pointer-events: none !important; }
}
`;
  return style;
}