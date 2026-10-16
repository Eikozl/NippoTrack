// TEMP-DISPLAY-PREVIEW — remove before merge to master (with its test,
// injected styles, entry.js wiring, and the losing family from the font
// URL once the user picks a winner).
// Dev-only A/B preview for the V6 display typeface. Default experience is
// Fraunces (via --font-display); choosing "newsreader" sets
// data-display-preview="newsreader" on <html> so the alternate stack
// applies. Activated by ?display= in the URL or a stored choice; the
// floating toggle only renders while active so production markup stays
// clean even if this file is forgotten (but it must still be deleted).
export const DISPLAY_PREVIEW_PARAM = 'display';
export const DISPLAY_PREVIEW_KEY = 'nt-display-preview';
export const DISPLAY_PREVIEW_CHOICES = ['fraunces', 'newsreader'];
export const DISPLAY_PREVIEW_DEFAULT = 'fraunces';

export function resolveDisplayChoice(search, stored) {
  const fromUrl = String(search || '').toLowerCase();
  if (DISPLAY_PREVIEW_CHOICES.includes(fromUrl)) return fromUrl;
  const fromStored = String(stored || '').toLowerCase();
  if (DISPLAY_PREVIEW_CHOICES.includes(fromStored)) return fromStored;
  return null;
}

function readParam(location) {
  try {
    const search = location?.search || '';
    const params = new URLSearchParams(search);
    return params.get(DISPLAY_PREVIEW_PARAM);
  } catch {
    return null;
  }
}

function readStored(storage) {
  try {
    return storage?.getItem?.(DISPLAY_PREVIEW_KEY) ?? null;
  } catch {
    return null;
  }
}

export function applyDisplayChoice(doc, choice) {
  try {
    const root = doc?.documentElement;
    if (!root) return false;
    if (!choice || choice === DISPLAY_PREVIEW_DEFAULT) {
      delete root.dataset.displayPreview;
      root.removeAttribute('data-display-preview');
    } else {
      root.dataset.displayPreview = choice;
    }
    return true;
  } catch {
    return false;
  }
}

function injectToggleStyles(doc) {
  if (doc.getElementById('nt-display-preview-styles')) return;
  const style = doc.createElement('style');
  style.id = 'nt-display-preview-styles';
  style.textContent = [
    '.nt-display-preview{position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;gap:6px;align-items:center;padding:6px;border-radius:12px;background:#1c1a18;color:#f5f0e8;box-shadow:0 4px 16px rgb(0 0 0 / .3);font:500 12px/1 Inter,system-ui,sans-serif}',
    '.nt-display-preview button{border:1px solid #3a3530;border-radius:8px;background:#2b2723;color:#f5f0e8;padding:6px 10px;cursor:pointer;font:inherit}',
    '.nt-display-preview button[aria-pressed="true"]{background:#b3402e;border-color:#b3402E;color:#fff}',
  ].join('');
  doc.head.append(style);
}

export function initDisplayPreview({ doc, location, storage } = {}) {
  try {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef) return null;
    const choice = resolveDisplayChoice(
      readParam(location || (typeof window !== 'undefined' ? window.location : null)),
      readStored(storage || (typeof localStorage !== 'undefined' ? localStorage : null))
    );
    if (!choice) return null;
    applyDisplayChoice(documentRef, choice);
    injectToggleStyles(documentRef);
    const bar = documentRef.createElement('div');
    bar.className = 'nt-display-preview';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Display typeface preview (temporary)');
    const label = documentRef.createElement('span');
    label.textContent = 'Display:';
    bar.append(label);
    for (const name of DISPLAY_PREVIEW_CHOICES) {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.textContent = name === 'fraunces' ? 'Fraunces' : 'Newsreader';
      button.setAttribute('aria-pressed', String(choice === name));
      button.addEventListener('click', () => {
        try {
          (storage || localStorage)?.setItem?.(DISPLAY_PREVIEW_KEY, name);
        } catch { /* preview only */ }
        applyDisplayChoice(documentRef, name);
        bar.querySelectorAll('button[data-choice]').forEach((other) => {
          other.setAttribute('aria-pressed', String(other.getAttribute('data-choice') === name));
        });
      });
      button.setAttribute('data-choice', name);
      bar.append(button);
    }
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Hide typeface preview');
    close.addEventListener('click', () => {
      try {
        (storage || localStorage)?.removeItem?.(DISPLAY_PREVIEW_KEY);
      } catch { /* preview only */ }
      applyDisplayChoice(documentRef, null);
      bar.remove();
    });
    bar.append(close);
    documentRef.body.append(bar);
    return choice;
  } catch {
    return null;
  }
}
