// Single source of truth for the NippoTrack webfont set (V6 identity).
// index.html carries the static <link> (pre-paint); landing entry points
// call ensureFonts() so dynamically-booted public routes never double-load.
export const NT_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600' +
  '&family=Inter:wght@400;500;600;700' +
  '&family=Newsreader:opsz,wght@6..72,500..600' +
  '&family=Noto+Sans+JP:wght@400;500;600;700' +
  '&display=swap';

export function ensureFonts(doc) {
  try {
    if (!doc || typeof doc.querySelector !== 'function' || typeof doc.createElement !== 'function') return false;
    if (doc.querySelector('link[data-nt-fonts]')) return true;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('data-nt-fonts', 'true');
    link.href = NT_FONTS_URL;
    (doc.head || doc.documentElement).append(link);
    return true;
  } catch {
    return false;
  }
}
