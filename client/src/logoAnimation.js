// Logo draw-in animation — shown on every session start (mobile).
// Renders the NippoTrack wordmark as an SVG whose strokes are drawn
// progressively (stroke-dashoffset), then fades out and yields to the
// normal PNG wordmark. Fail-open: any failure resolves immediately so the
// app shell is never trapped.

const LOGO_SEEN_KEY = 'jlt-logo-animated';
const ANIM_MS = 1400;

export function hasSeenLogoAnimation() {
  try { return localStorage.getItem(LOGO_SEEN_KEY) === '1'; } catch { return true; }
}
export function markLogoAnimationSeen() {
  try { localStorage.setItem(LOGO_SEEN_KEY, '1'); } catch { /* best-effort */ }
}

const SVG = `
<svg class="logo-animation-svg" viewBox="0 0 220 64" xmlns="http://www.w3.org/2000/svg" aria-label="NippoTrack">
  <defs>
    <style>
      .logo-word { fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
    </style>
  </defs>
  <g class="logo-word">
    <text x="12" y="42" font-family="Newsreader, 'Noto Serif JP', serif" font-size="34" font-weight="600" letter-spacing="-0.01em">Nippo</text>
    <text x="102" y="42" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="26" font-weight="700" letter-spacing="-0.02em">Track</text>
  </g>
</svg>
`;

export function mountLogoAnimation(container) {
  return new Promise((resolveAnim) => {
    const wrap = document.createElement('div');
    wrap.className = 'logo-animation-wrap';
    wrap.innerHTML = `<div class="logo-animation-inner">${SVG}</div>`;
    container.appendChild(wrap);

    const svg = wrap.querySelector('.logo-animation-svg');
    const paths = svg.querySelectorAll('.logo-word text');
    let resolved = false;

    function resolve() {
      if (resolved) return;
      resolved = true;
      wrap.classList.add('logo-animation-wrap--done');
      // Let the fade-out finish before removing from the DOM.
      setTimeout(() => { wrap.remove(); markLogoAnimationSeen(); resolveAnim(); }, ANIM_MS);
    }

    // Measure each text path's total length and drive its own draw animation.
    paths.forEach((text) => {
      try {
        const len = text.getComputedTextLength ? text.getComputedTextLength() : 260;
        text.style.strokeDasharray = len;
        text.style.strokeDashoffset = len;
        text.style.animation = `logo-draw ${ANIM_MS / 1000}s ease-out forwards`;
      } catch {
        text.style.strokeDasharray = '260';
        text.style.strokeDashoffset = '260';
        text.style.animation = `logo-draw ${ANIM_MS / 1000}s ease-out forwards`;
      }
    });

    // Fallback timer in case animation events never fire.
    const timer = setTimeout(resolve, ANIM_MS + 300);

    // Also resolve on animationend of the last path as a fallback.
    const last = paths[paths.length - 1];
    if (last) {
      last.addEventListener('animationend', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

export function createLogoAnimationStyles() {
  const style = document.createElement('style');
  style.textContent = `
.logo-animation-wrap {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: var(--jlt-bg);
  transition: opacity 300ms ease;
}
.logo-animation-wrap--done { opacity: 0; pointer-events: none; }
.logo-animation-inner {
  width: min(220px, 85vw);
  height: auto;
  display: grid;
  place-items: center;
}
.logo-animation-svg { width: 100%; height: auto; color: var(--jlt-primary); }
.logo-word text { stroke: currentColor; }
@keyframes logo-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .logo-word text { animation: none !important; stroke-dashoffset: 0 !important; }
  .logo-animation-wrap { opacity: 0 !important; pointer-events: none !important; }
}
`;
  return style;
}