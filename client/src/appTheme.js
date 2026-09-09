/* NippoTrack app theme preference (Part A unification).
 *
 * Canonical key: `nippotrack-theme` (shared with the public landing).
 * Legacy key: `jlt-theme` (never deleted; left in place for old readers).
 *
 * Resolution order (resolveAppTheme):
 *   1. stored canonical `nippotrack-theme`, if light|dark → use it.
 *   2. stored legacy `jlt-theme`, if light|dark → accept it AND migrate by
 *      writing the canonical key (legacy key left intact).
 *   3. OS `prefers-color-scheme` (dark → dark).
 *   4. light fallback.
 * Arbitrary strings are rejected at every step (allowlist light|dark only).
 *
 * Writes (persistAppTheme / setTheme paths) always set BOTH keys so legacy
 * readers stay consistent. The `data-theme` attribute name, the
 * `jlt-theme-change` event name, and chart refresh consumers are unchanged
 * (backward compat).
 */

export const APP_THEME_KEY = 'nippotrack-theme';
export const LEGACY_THEME_KEY = 'jlt-theme';
export const APP_THEMES = ['light', 'dark'];
export const APP_THEME_META = { light: '#F5F0E8', dark: '#1C1A18' };

export function isAllowedAppTheme(value) {
  return value === 'light' || value === 'dark';
}

function safeGet(storage, key) {
  try {
    const value = storage?.getItem?.(key);
    return isAllowedAppTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage?.setItem?.(key, value);
    return true;
  } catch {
    return false;
  }
}

function defaultMatchMediaFn() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia.bind(window);
  }
  return null;
}

export function resolveAppTheme(options = {}) {
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : undefined;
  const canonical = safeGet(storage, APP_THEME_KEY);
  if (canonical) return canonical;
  const legacy = safeGet(storage, LEGACY_THEME_KEY);
  if (legacy) {
    // Migrate forward without deleting history: adopt the legacy choice
    // and persist it under the canonical key for next boot.
    safeSet(storage, APP_THEME_KEY, legacy);
    return legacy;
  }
  try {
    const matchMediaFn = options.matchMediaFn !== undefined ? options.matchMediaFn : defaultMatchMediaFn();
    if (typeof matchMediaFn === 'function') {
      const query = matchMediaFn('(prefers-color-scheme: dark)');
      if (query && query.matches) return 'dark';
    }
  } catch {
    // Broken matchMedia falls through to light.
  }
  return 'light';
}

export function persistAppTheme(theme, storage) {
  if (!isAllowedAppTheme(theme)) return false;
  try {
    // Write BOTH keys (canonical + legacy) so old readers stay consistent.
    // Legacy is never deleted.
    storage?.setItem?.(APP_THEME_KEY, theme);
    storage?.setItem?.(LEGACY_THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function wordmarkForAppTheme(theme, assets = {}) {
  const { lightSrc = '', darkSrc = '' } = assets;
  return theme === 'dark' ? darkSrc || lightSrc : lightSrc || darkSrc;
}

// Keep BOTH root theme attributes synchronized on every app theme change.
// Shared tokens activate dark mode when EITHER attribute is dark, so writing
// only `data-theme` (and leaving a stale `data-nippotrack-theme`) desyncs the
// UI (dark toggle appearing broken). Returns false for invalid themes.
export function applyAppThemeAttributes(theme, doc) {
  if (!isAllowedAppTheme(theme)) return false;
  try {
    const root =
      doc?.documentElement ??
      (typeof document !== 'undefined' ? document.documentElement : undefined);
    if (!root?.dataset) return false;
    root.dataset.theme = theme;
    root.dataset.nippotrackTheme = theme;
    return true;
  } catch {
    return false;
  }
}
