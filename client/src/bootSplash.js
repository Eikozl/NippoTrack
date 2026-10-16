// Brand boot splash v3: ember draws alone, with sound. The hanko-orange
// pass draws once on the warm canvas (white-background video composited
// with multiply — white turns transparent, ember stays fully visible),
// carrying its muxed ink-wash audio; then a short hold and the splash
// fades. Replaces the "Checking your session…" text splash (the copy
// survives as screen-reader-only status).
//
// Sound policy: the video plays UNMUTED first so the ink wash sounds on
// platforms that allow it (installed PWA, engaged origins). Where autoplay
// with sound is blocked, the play() rejection falls back to muted and the
// draw continues silent — never a stuck splash, never a silent failure
// loop. Reduced motion: static mark, no video, no sound.
export const BOOT_ORANGE_SRC = '/videos/logo-draw-orange.mp4';
export const BOOT_MIN_MS = 3000;
export const BOOT_MAX_MS = 9000;
export const BOOT_RATE = 1.5;
// Full orange pass at BOOT_RATE plus margin: the hold waits out the draw.
export const BOOT_DRAW_MS = 2100;
export const BOOT_HOLD_MS = 300;
export const BOOT_FADE_MS = 260;

export function isReducedMotion(matchMediaFn) {
  try {
    return !!matchMediaFn?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch {
    return false;
  }
}

function setAttrs(node, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    try {
      node.setAttribute(name, value);
    } catch {
      // Stub-DOM safe: structure first, attributes best-effort.
    }
  }
  return node;
}

export function createBootSplash(doc, { markUrl = null, reducedMotion = false } = {}) {
  const root = doc.createElement('div');
  setAttrs(root, { class: 'auth-boot-note boot-splash', role: 'status' });
  const sr = doc.createElement('p');
  setAttrs(sr, { class: 'visually-hidden' });
  try {
    sr.textContent = 'Checking your session…';
  } catch {
    // Text is enhancement; the container still announces via role=status.
  }
  root.appendChild(sr);
  const stage = doc.createElement('div');
  setAttrs(stage, { class: 'boot-stage', 'aria-hidden': 'true' });
  let orange = null;
  if (reducedMotion && markUrl) {
    const img = doc.createElement('img');
    setAttrs(img, { src: markUrl, alt: '', class: 'boot-mark', width: '200', height: '200' });
    stage.appendChild(img);
  } else if (!reducedMotion) {
    orange = doc.createElement('video');
    setAttrs(orange, {
      class: 'boot-video boot-orange', src: BOOT_ORANGE_SRC,
      playsinline: '', preload: 'auto', disablepictureinpicture: ''
    });
    stage.appendChild(orange);
  }
  root.appendChild(stage);
  return { root, stage, orange };
}

// Attempts the pass WITH sound; falls back to muted on autoplay block.
// Resolves 'loud', 'muted', or 'blocked' (no playable video at all).
export function playBootPass(video, rate) {
  try {
    if (!video || typeof video.play !== 'function') return Promise.resolve('blocked');
    try {
      video.playbackRate = rate;
    } catch {
      // Default rate still draws; speed is enhancement.
    }
    const played = video.play();
    if (played && typeof played.then === 'function') {
      return played.then(
        () => 'loud',
        () => {
          try {
            video.muted = true;
          } catch {
            // Property is best-effort; attribute path below still applies.
          }
          try {
            const retry = video.play();
            if (retry && typeof retry.catch === 'function') retry.catch(() => {});
          } catch {
            // Silent draw continues; sound is enhancement.
          }
          return 'muted';
        }
      );
    }
    return Promise.resolve('loud');
  } catch {
    return Promise.resolve('blocked');
  }
}

function tryPause(video) {
  try {
    video?.pause?.();
  } catch {
    // Already gone; nothing to stop.
  }
}

function addClass(node, name) {
  try {
    node?.classList?.add?.(name);
  } catch {
    // Static fallback: the splash still dismisses on schedule.
  }
}

export function runBootSplash({
  orange = null,
  reducedMotion = false,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  let cancelled = false;
  const started = now();
  const done = (async () => {
    if (!reducedMotion && orange) {
      await playBootPass(orange, BOOT_RATE);
      if (cancelled) return;
      await delay(BOOT_DRAW_MS);
      if (cancelled) return;
      await delay(BOOT_HOLD_MS);
      if (cancelled) return;
    }
    const elapsed = now() - started;
    if (elapsed < BOOT_MIN_MS && !cancelled) await delay(BOOT_MIN_MS - elapsed);
  })();
  const capped = Promise.race([done, delay(BOOT_MAX_MS)]);
  return {
    done: capped,
    cancel: () => {
      cancelled = true;
      tryPause(orange);
    }
  };
}

export function dismissBootSplash(root, { delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  addClass(root, 'is-leaving');
  return delay(BOOT_FADE_MS).then(() => {
    try {
      root?.remove?.();
    } catch {
      // Host already replaced the node; nothing to detach.
    }
  });
}
