import { resolveExperience } from './landing/routing.js';

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
