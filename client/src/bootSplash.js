// Brand boot splash: the brush mark draws in black, then draws over in
// hanko orange while black hands over. Replaces the "Checking your session…"
// text splash (the copy survives as screen-reader-only status).
//
// Staging: both passes are white-background MP4s (no alpha channel), so
// they composite with mix-blend-mode: multiply over the warm canvas —
// white turns transparent, ink stays ink. Same 480px geometry in both
// files, so the orange pass traces the black one exactly.
//
// Reduced motion: no video at all, static mark instead, short floor.
// Fail-open everywhere: blocked autoplay, missing files, or slow session
// checks resolve to the app or the auth gate, never a stuck splash.
export const BOOT_BLACK_SRC = '/videos/logo-draw-black.mp4';
export const BOOT_ORANGE_SRC = '/videos/logo-draw-orange.mp4';
export const BOOT_MIN_MS = 3600;
export const BOOT_MAX_MS = 9000;
export const BOOT_RATE = 1.5;
export const BOOT_ORANGE_DELAY_MS = 1300;
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
  let black = null;
  let orange = null;
  if (reducedMotion && markUrl) {
    const img = doc.createElement('img');
    setAttrs(img, { src: markUrl, alt: '', class: 'boot-mark', width: '160', height: '160' });
    stage.appendChild(img);
  } else if (!reducedMotion) {
    black = doc.createElement('video');
    setAttrs(black, {
      class: 'boot-video boot-black', src: BOOT_BLACK_SRC, muted: '',
      playsinline: '', preload: 'auto', disablepictureinpicture: ''
    });
    orange = doc.createElement('video');
    setAttrs(orange, {
      class: 'boot-video boot-orange', src: BOOT_ORANGE_SRC, muted: '',
      playsinline: '', preload: 'auto', disablepictureinpicture: ''
    });
    stage.appendChild(black);
    stage.appendChild(orange);
  }
  root.appendChild(stage);
  return { root, stage, black, orange };
}

function tryPlay(video, rate) {
  try {
    if (!video || typeof video.play !== 'function') return;
    try {
      video.muted = true;
    } catch {
      // Attribute already carries muted; property is best-effort.
    }
    try {
      video.playbackRate = rate;
    } catch {
      // Default rate still draws; speed is enhancement.
    }
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  } catch {
    // Autoplay blocked: the first frame still shows as a static mark.
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
    // Static fallback: no handover animation, videos still play.
  }
}

export function runBootSplash({
  stage = null,
  black = null,
  orange = null,
  reducedMotion = false,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  let cancelled = false;
  const started = now();
  const done = (async () => {
    if (!reducedMotion) {
      tryPlay(black, BOOT_RATE);
      await delay(BOOT_ORANGE_DELAY_MS);
      if (cancelled) return;
      // Orange traces the same stroke while black hands over beneath it.
      addClass(stage, 'boot-handover');
      tryPlay(orange, BOOT_RATE);
    }
    const elapsed = now() - started;
    if (elapsed < BOOT_MIN_MS && !cancelled) await delay(BOOT_MIN_MS - elapsed);
  })();
  const capped = Promise.race([done, delay(BOOT_MAX_MS)]);
  return {
    done: capped,
    cancel: () => {
      cancelled = true;
      tryPause(black);
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
