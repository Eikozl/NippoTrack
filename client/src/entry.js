import { resolveExperience } from './landing/routing.js';

const experience = resolveExperience(window.location);
const landingRoot = document.getElementById('landing-root');

if (experience === 'app') {
  if (landingRoot) landingRoot.hidden = true;
  document.title = 'Japanese Learning Tracker';
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
