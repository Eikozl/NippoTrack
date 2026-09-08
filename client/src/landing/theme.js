export const LANDING_THEME_KEY = 'nippotrack-theme';
export const LANDING_THEMES = ['light', 'dark'];
export const LANDING_THEME_META = { light: '#F5F0E8', dark: '#1C1A18' };
export const LANDING_TOGGLE_LABELS = {
  light: 'Switch to dark mode',
  dark: 'Switch to light mode',
};

export function isAllowedLandingTheme(value) {
  return value === 'light' || value === 'dark';
}

export function pickLandingTheme(storedValue, prefersDark) {
  if (isAllowedLandingTheme(storedValue)) return storedValue;
  return prefersDark ? 'dark' : 'light';
}

export function readStoredLandingTheme(storage) {
  try {
    const value = storage?.getItem?.(LANDING_THEME_KEY);
    return isAllowedLandingTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistLandingTheme(theme, storage) {
  try {
    if (!isAllowedLandingTheme(theme)) return false;
    storage?.setItem?.(LANDING_THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function hasExplicitLandingTheme(storage) {
  return readStoredLandingTheme(storage) !== null;
}

function defaultMatchMediaFn() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia.bind(window);
  }
  return null;
}

export function resolveLandingTheme(options = {}) {
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : undefined;
  const stored = readStoredLandingTheme(storage);
  if (stored) return stored;
  try {
    const matchMediaFn = options.matchMediaFn !== undefined ? options.matchMediaFn : defaultMatchMediaFn();
    if (typeof matchMediaFn === 'function') {
      const query = matchMediaFn('(prefers-color-scheme: dark)');
      if (query && query.matches) return 'dark';
    }
  } catch {
    // Ignore unavailable/broken matchMedia and fall through to light.
  }
  return 'light';
}

export function landingToggleLabel(theme) {
  return theme === 'dark' ? LANDING_TOGGLE_LABELS.dark : LANDING_TOGGLE_LABELS.light;
}

export function wordmarkForTheme(theme, assets = {}) {
  const { lightSrc = '', darkSrc = '' } = assets;
  return theme === 'dark' ? darkSrc || lightSrc : lightSrc || darkSrc;
}

const preloadedLandingWordmarks = new Set();

function preloadLandingWordmark(src) {
  if (!src || preloadedLandingWordmarks.has(src)) return;
  preloadedLandingWordmarks.add(src);
  try {
    if (typeof Image !== 'undefined') {
      const image = new Image();
      image.decoding = 'async';
      image.src = src;
    }
  } catch {
    // Preload is best-effort; the swap below still applies.
  }
}

export function applyLandingTheme(theme, options = {}) {
  const next = isAllowedLandingTheme(theme) ? theme : 'light';
  const doc = options.documentRef ?? (typeof document !== 'undefined' ? document : null);
  const { lightSrc = '', darkSrc = '' } = options;
  if (!doc || !doc.documentElement) return next;

  doc.documentElement.dataset.nippotrackTheme = next;
  try {
    doc.documentElement.style.colorScheme = next;
  } catch {
    // colorScheme is progressive enhancement.
  }

  try {
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', LANDING_THEME_META[next]);
  } catch {
    // Meta update is best-effort.
  }

  const wordmarkSrc = wordmarkForTheme(next, { lightSrc, darkSrc });
  const alternateSrc = wordmarkForTheme(next === 'dark' ? 'light' : 'dark', { lightSrc, darkSrc });
  if (wordmarkSrc) {
    try {
      doc.querySelectorAll('img[data-landing-wordmark]').forEach((img) => {
        if (img.getAttribute('src') !== wordmarkSrc) img.setAttribute('src', wordmarkSrc);
      });
    } catch {
      // Wordmark swap is best-effort.
    }
  }
  if (alternateSrc && alternateSrc !== wordmarkSrc) preloadLandingWordmark(alternateSrc);

  const label = landingToggleLabel(next);
  try {
    doc.querySelectorAll('[data-landing-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-label', label);
      const sun = button.querySelector('[data-theme-icon="sun"]');
      const moon = button.querySelector('[data-theme-icon="moon"]');
      if (sun && moon) {
        // Light theme offers the moon (go dark); dark theme offers the sun (go light).
        if (next === 'dark') {
          sun.removeAttribute('hidden');
          moon.setAttribute('hidden', '');
        } else {
          moon.removeAttribute('hidden');
          sun.setAttribute('hidden', '');
        }
      }
    });
  } catch {
    // Toggle sync is best-effort.
  }

  return next;
}

export function watchLandingSystemTheme(onChange, options = {}) {
  const noop = () => {};
  try {
    const matchMediaFn = options.matchMediaFn !== undefined ? options.matchMediaFn : defaultMatchMediaFn();
    if (typeof matchMediaFn !== 'function') return noop;
    const query = matchMediaFn('(prefers-color-scheme: dark)');
    if (!query) return noop;
    const handler = (event) => {
      try {
        onChange(event?.matches ? 'dark' : 'light');
      } catch {
        // Listener errors must never break the page.
      }
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
      return () => {
        try {
          query.removeEventListener('change', handler);
        } catch {
          // Cleanup is best-effort.
        }
      };
    }
    if (typeof query.addListener === 'function') {
      query.addListener(handler);
      return () => {
        try {
          query.removeListener(handler);
        } catch {
          // Cleanup is best-effort.
        }
      };
    }
  } catch {
    return noop;
  }
  return noop;
}
