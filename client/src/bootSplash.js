// Brand boot splash v2: ember into ink. The hanko-orange pass draws alone
// on the warm canvas (fully visible — no overlap to swallow it), holds on
// the complete mark, then resolves into the crisp static ink mark and the
// splash fades. Replaces the "Checking your session…" text splash (the copy
// survives as screen-reader-only status).
//
// Why v2: white-background MP4s carry no alpha channel, so stacking both
// passes with multiply turned orange-over-black into black — the orange
// draw was invisible. One visible pass plus an ink resolve reads clean.
//
// Reduced motion: static mark only, short floor. Fail-open everywhere:
// blocked autoplay, missing files, or slow session checks resolve to the
// app or the auth gate, never a stuck splash.
export const BOOT_ORANGE_SRC = '/videos/logo-draw-orange.mp4';
export const BOOT_MIN_MS = 3000;
export const BOOT_MAX_MS = 9000;
export const BOOT_RATE = 1.5;
// Full orange pass at BOOT_RATE plus margin: the resolve waits out the draw,
// then the floor waits out the brand beat.
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
  let mark = null;
  if (markUrl) {
    mark = doc.createElement('img');
    setAttrs(mark, { src: markUrl, alt: '', class: 'boot-mark', width: '200', height: '200' });
    stage.appendChild(mark);
  }
  if (!reducedMotion) {
    orange = doc.createElement('video');
    setAttrs(orange, {
      class: 'boot-video boot-orange', src: BOOT_ORANGE_SRC, muted: '',
      playsinline: '', preload: 'auto', disablepictureinpicture: ''
    });
    stage.appendChild(orange);
  }
  root.appendChild(stage);
  return { root, stage, orange, mark };
}

function tryPlay(video, rate) {
  try {
    if (!video || typeof video.play !== 'function') return false;
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
    return true;
  } catch {
    // Autoplay blocked: resolve straight to the static mark.
    return false;
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
    // Static fallback: stages still resolve without animation classes.
  }
}

export function runBootSplash({
  stage = null,
  orange = null,
  mark = null,
  reducedMotion = false,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  let cancelled = false;
  const started = now();
  const done = (async () => {
    if (!reducedMotion && orange) {
      const playing = tryPlay(orange, BOOT_RATE);
      if (playing) {
        // Ember draws alone for the full pass; ink resolves beneath it.
        await delay(BOOT_DRAW_MS);
        if (cancelled) return;
        addClass(stage, 'boot-resolved');
        await delay(BOOT_HOLD_MS);
        if (cancelled) return;
      } else if (mark) {
        addClass(stage, 'boot-resolved');
      }
    } else if (mark) {
      addClass(stage, 'boot-resolved');
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
