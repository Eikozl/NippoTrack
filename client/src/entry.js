import { resolveExperience } from './landing/routing.js';
import { initNativeAuth } from './nativeAuth.js';
import { supabase } from './authClient.js';

// Production-web PWA only: never inside Capacitor (the native shell manages
// its own lifecycle) and never over insecure origins.
try {
  if (!window.Capacitor && window.location.protocol === 'https:' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js'); });
  }
} catch { /* best-effort enhancement */ }

// Sideloaded APK: email confirm/recovery links return via the
// nippotrack:// scheme instead of the browser. Registered before the app
// bundle loads so a cold start from a link still establishes the session.
initNativeAuth({
  supabase,
  onAuthenticated: () => {
    try { window.location.hash = '#dashboard'; } catch { /* navigation is best-effort */ }
  }
});

// Email links minted before the /app redirect (or pasted anywhere) still
// land on / or /how-it-works with Supabase tokens in the URL. Only the app
// bundle understands them (detectSessionInUrl), so forward the whole
// query+hash to /app instead of stranding the learner on the landing.
try {
  const search = window.location.search || '';
  const hash = window.location.hash || '';
  const looksLikeAuth = /[?#&](access_token|code|error)(=|&|$)/.test(`${search}${hash}`)
    || /(^|[?#&])type=(recovery|signup|invite|magiclink|email_change)(&|$)/.test(`${search}${hash}`);
  if (looksLikeAuth && window.location.pathname.replace(/\/+$/, '') !== '/app') {
    window.location.replace(`/app${search}${hash}`);
  }
} catch { /* forward is best-effort */ }

const experience = resolveExperience(window.location);
const landingRoot = document.getElementById('landing-root');

if (experience === 'app') {
  if (landingRoot) landingRoot.hidden = true;
  document.title = 'NippoTrack';
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    'A focused personal tracker for Japanese study sessions and learning material.'
  );
  import('./main.js');
} else if (experience === 'how-it-works') {
  document.getElementById('auth-root')?.setAttribute('hidden', '');
  document.getElementById('app-shell')?.setAttribute('hidden', '');
  document.querySelector('.skip-link')?.setAttribute('hidden', '');
  import('./landing/howItWorks.js');
} else {
  document.getElementById('auth-root')?.setAttribute('hidden', '');
  document.getElementById('app-shell')?.setAttribute('hidden', '');
  document.querySelector('.skip-link')?.setAttribute('hidden', '');
  import('./landing/landing.js');
}
