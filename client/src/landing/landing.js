import './landing.css';
import wordmarkLight from '../assets/Logo_Modo_Claro.png';
import wordmarkDark from '../assets/Logo_Modo_Oscuro.png';
import { createLandingMarkup } from './sections.js';
import { initEstimateRotation, initKanjiSequence, initLandingInteractions } from './interactions.js';
import { ensureFonts } from '../fonts.js';
import { initLandingSmoothScroll } from './smoothScroll.js';
import { initAndroidDownload } from './androidRelease.js';

// Canonical Auth entry: public Sign in/up CTAs open the modal over the
// Landing instead of navigating away. Anchors keep their /app?auth=… hrefs
// as a no-JS fallback; with JS the click is intercepted. Auth failures of
// the dynamic import fall back to plain navigation.
function initAuthModalTriggers(root) {
  if (!root || typeof root.addEventListener !== 'function') return;
  root.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('[data-auth-open]');
    if (!trigger || !root.contains(trigger)) return;
    event.preventDefault();
    const view = trigger.dataset.authOpen === 'sign-up' ? 'sign-up' : 'sign-in';
    import('../authModal.js').then(({ openAuthModal }) => {
      openAuthModal({
        host: document.body,
        background: root,
        initialView: view,
        trigger,
        onAuthenticated: () => window.location.assign('/app')
      });
    }).catch(() => {
      window.location.href = trigger.getAttribute('href') || '/app';
    });
  });
}
import {
  applyLandingTheme,
  persistLandingTheme,
  readStoredLandingTheme,
  resolveLandingTheme,
  watchLandingSystemTheme,
  wordmarkForTheme,
} from './theme.js';

const root = document.getElementById('landing-root');

if (root) {
  document.documentElement.classList.add('landing-js');
  const themeAssets = { lightSrc: wordmarkLight, darkSrc: wordmarkDark };
  const initialTheme = resolveLandingTheme();
  // Boot landing theme before markup paint where practical: dataset +
  // colorScheme + meta theme-color. Pre-paint dataset is also set by
  // theme-init.js; this re-syncs meta/wordmark/toggle state.
  applyLandingTheme(initialTheme, themeAssets);
  ensureFonts(document);
  document.title = 'NippoTrack — Bring your Japanese learning together';
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    'Organize what you learn, understand Japanese in context, and keep a clear view of your progress.'
  );
  document.body.classList.add('has-landing');
  root.innerHTML = createLandingMarkup(wordmarkForTheme(initialTheme, themeAssets), themeAssets);
  applyLandingTheme(initialTheme, themeAssets);
  root.querySelectorAll('[data-landing-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const current = document.documentElement.dataset.nippotrackTheme === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      persistLandingTheme(next, localStorage);
      applyLandingTheme(next, themeAssets);
    });
  });
  // Follow the OS theme only while the visitor has no explicit stored choice.
  watchLandingSystemTheme((systemTheme) => {
    try {
      if (readStoredLandingTheme(localStorage)) return;
    } catch {
      return;
    }
    applyLandingTheme(systemTheme, themeAssets);
  });
  initLandingInteractions(root);
  initKanjiSequence(root);
  initEstimateRotation(root);
  initAuthModalTriggers(root);
  try { initAndroidDownload(root)?.catch?.(() => {}); } catch { /* download skeleton stays static */ }
  // v5.1-E.3 Lenis: public landing only, fail-open, reduced-motion native.
  try { initLandingSmoothScroll(root)?.catch?.(() => {}); } catch { /* native scroll */ }
  const anchor = window.location.hash.slice(1);
  if (['features', 'how-it-works', 'final-cta', 'faq'].includes(anchor)) {
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }
}
