// First-login tutorial video overlay (vanilla JS, zero dependencies beyond
// element()). Shown once to new accounts (onboarding incomplete + never
// seen): fullscreen takeover, responsive source (vertical for handsets,
// horizontal for desktops/tablets), and a single low-key exit — hold Skip
// for 3s (procedural left-to-right bar) or watch to the end. Fail-open:
// any video/load failure dismisses immediately onto the setup shell
// underneath, and the seen flag is still recorded so nobody is trapped.
import { element } from './ui.js';
import { icon } from './icons.js';

export const TUTORIAL_VIDEO_STORAGE_KEY = 'jlt-tutorial-seen';
export const TUTORIAL_SKIP_HOLD_MS = 1500;
export const TUTORIAL_MOBILE_QUERY = '(max-width: 767px)';
export const TUTORIAL_VIDEO_SOURCES = {
  desktop: '/videos/tutorial-horizontal.mp4',
  mobile: '/videos/tutorial-vertical.mp4'
};

// Pure source pick (unit-testable): handsets get the vertical cut,
// everything else (desktop + tablets, portrait or not) gets horizontal.
export function pickTutorialSource(isMobile) {
  return isMobile ? TUTORIAL_VIDEO_SOURCES.mobile : TUTORIAL_VIDEO_SOURCES.desktop;
}

function seenStorage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* storage blocked (private mode): fall through */ }
  return null;
}

export function hasSeenTutorialVideo() {
  try {
    return seenStorage()?.getItem?.(TUTORIAL_VIDEO_STORAGE_KEY) === '1';
  } catch {
    // Storage unreadable: treat as seen (fail-open toward the app rather
    // than replaying the takeover on every login).
    return true;
  }
}

export function markTutorialVideoSeen() {
  try {
    seenStorage()?.setItem?.(TUTORIAL_VIDEO_STORAGE_KEY, '1');
  } catch { /* best-effort persistence */ }
}

// Mounts the fullscreen takeover into host (document.body in production).
// Calls onDone after teardown. Returns a cleanup function.
export function mountTutorialVideo(host, { onDone = null } = {}) {
  const finish = () => {
    if (typeof onDone === 'function') {
      try { onDone(); } catch { /* host teardown is best-effort */ }
    }
  };
  const doc = host?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || !host || typeof host.appendChild !== 'function') {
    finish();
    return () => {};
  }

  const useMobile = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(TUTORIAL_MOBILE_QUERY).matches
    : false;

  const overlay = element('div', {
    className: 'fixed inset-0 z-[100] bg-black',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tutorial video' }
  });
  const video = doc.createElement('video');
  video.src = pickTutorialSource(useMobile);
  // The handset cut shows the whole frame (contain): cover-cropping the
  // vertical video hides its baked-in edges and reads as an unwanted zoom.
  // The desktop/tablet cut keeps fullscreen cover.
  video.className = `absolute inset-0 h-full w-full ${useMobile ? 'object-contain' : 'object-cover'}`;
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('preload', 'auto');
  video.setAttribute('aria-hidden', 'true');
  video.muted = true;
  try {
    const playing = video.play();
    if (playing && typeof playing.catch === 'function') playing.catch(() => { /* autoplay denied: Skip stays available */ });
  } catch { /* play() unavailable: Skip stays available */ }

  // Skip sits bottom-right at restrained opacity so it never outshines the
  // video; hover/focus restore full opacity for operability.
  const fill = element('span', { className: 'absolute inset-y-0 left-0 w-0 bg-white/25', attrs: { 'aria-hidden': 'true' } });
  const skip = element('button', {
    className: 'absolute bottom-5 right-5 overflow-hidden rounded-full border border-white/40 bg-black/30 px-5 py-2.5 text-sm font-medium text-white/80 opacity-60 backdrop-blur-sm transition hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white',
    attrs: { type: 'button', 'aria-label': 'Hold for 1.5 seconds to skip the tutorial' }
  }, [fill, element('span', { className: 'relative', text: 'Skip' })]);
  // Sound toggle (bottom-left, same low-key treatment): browsers forbid
  // autoplay with sound, so the video starts muted and this user gesture
  // is what legally unmutes it.
  const sound = element('button', {
    className: 'absolute bottom-5 left-5 grid size-11 place-items-center rounded-full border border-white/40 bg-black/30 text-white/80 opacity-60 backdrop-blur-sm transition hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-white',
    attrs: { type: 'button', 'aria-label': 'Unmute tutorial video', 'aria-pressed': 'false' }
  }, [icon('mute', { size: 20 })]);
  const paintSound = () => {
    const muted = video.muted;
    sound.setAttribute('aria-label', muted ? 'Unmute tutorial video' : 'Mute tutorial video');
    sound.setAttribute('aria-pressed', String(!muted));
    sound.replaceChildren(icon(muted ? 'mute' : 'volume', { size: 20 }));
  };
  sound.addEventListener('click', (event) => {
    event.stopPropagation();
    video.muted = !video.muted;
    if (!video.muted) {
      try {
        const playing = video.play();
        if (playing && typeof playing.catch === 'function') playing.catch(() => { /* stays paused: user can replay via toggle */ });
      } catch { /* play unavailable after gesture: toggle state still applies */ }
    }
    paintSound();
  });

  let rafId = 0;
  let holdStart = 0;
  const now = () => ((typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now());
  const cancelHold = () => {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
    try { fill.style.width = '0%'; } catch { /* paint is best-effort */ }
  };
  const paint = (timestamp) => {
    const ratio = Math.min(1, (timestamp - holdStart) / TUTORIAL_SKIP_HOLD_MS);
    try { fill.style.width = `${Math.round(ratio * 100)}%`; } catch { /* paint is best-effort */ }
    if (ratio >= 1) { complete(); return; }
    rafId = requestAnimationFrame(paint);
  };
  const startHold = (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    cancelHold();
    holdStart = now();
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(paint);
    else complete();
  };
  const onKeyDown = (event) => {
    if (event.repeat) return;
    if (event.key === 'Enter' || event.key === ' ') startHold(event);
  };

  let finished = false;
  function cleanup() {
    cancelHold();
    video.removeEventListener('ended', complete);
    video.removeEventListener('error', complete);
    skip.removeEventListener('pointerdown', startHold);
    skip.removeEventListener('pointerup', cancelHold);
    skip.removeEventListener('pointercancel', cancelHold);
    skip.removeEventListener('pointerleave', cancelHold);
    skip.removeEventListener('keydown', onKeyDown);
    skip.removeEventListener('keyup', cancelHold);
    // Sound button listeners die with the overlay subtree (no window-level
    // listeners involved), same as skip's once removed.
    try { video.pause(); } catch { /* pause is best-effort */ }
  }
  function complete() {
    if (finished) return;
    finished = true;
    cleanup();
    try { video.removeAttribute('src'); video.load(); } catch { /* release is best-effort */ }
    try { overlay.remove(); } catch { /* teardown is best-effort */ }
    markTutorialVideoSeen();
    finish();
  }

  skip.addEventListener('pointerdown', startHold);
  skip.addEventListener('pointerup', cancelHold);
  skip.addEventListener('pointercancel', cancelHold);
  skip.addEventListener('pointerleave', cancelHold);
  skip.addEventListener('keydown', onKeyDown);
  skip.addEventListener('keyup', cancelHold);
  // End card (only when the video finishes naturally — a skip-hold
  // dismisses straight away): Repeat replays, Continue dismisses. The
  // controls hide while choosing so the two options stay unambiguous.
  const repeat = element('button', {
    className: 'button-secondary',
    text: 'Repeat',
    attrs: { type: 'button' }
  });
  const cont = element('button', {
    className: 'button-primary',
    text: 'Continue',
    attrs: { type: 'button' }
  });
  const endCard = element('div', {
    className: 'absolute inset-0 grid place-items-center bg-black/60 p-6',
    attrs: { role: 'group', 'aria-label': 'Video finished' }
  }, [
    element('div', { className: 'flex flex-wrap items-center justify-center gap-3' }, [repeat, cont])
  ]);
  endCard.hidden = true;
  repeat.addEventListener('click', () => {
    endCard.hidden = true;
    skip.hidden = false;
    sound.hidden = false;
    try { video.currentTime = 0; } catch { /* seek is best-effort */ }
    try {
      const playing = video.play();
      if (playing && typeof playing.catch === 'function') playing.catch(() => { /* stays paused: toggle/skip remain */ });
    } catch { /* play unavailable: controls remain */ }
    try { skip.focus({ preventScroll: true }); } catch { try { skip.focus(); } catch { /* focus is best-effort */ } }
  });
  cont.addEventListener('click', () => complete());
  const showEndCard = () => {
    cancelHold();
    skip.hidden = true;
    sound.hidden = true;
    endCard.hidden = false;
    try { cont.focus({ preventScroll: true }); } catch { try { cont.focus(); } catch { /* focus is best-effort */ } }
  };
  video.addEventListener('ended', showEndCard);
  video.addEventListener('error', complete);
  overlay.append(video, sound, skip, endCard);
  try { host.appendChild(overlay); } catch {
    finish();
    return () => {};
  }
  try { skip.focus({ preventScroll: true }); } catch { try { skip.focus(); } catch { /* focus is best-effort */ } }
  return cleanup;
}
