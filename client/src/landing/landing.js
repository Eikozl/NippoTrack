import './landing.css';
import wordmarkLight from '../assets/Logo_Modo_Claro.png';
import wordmarkDark from '../assets/Logo_Modo_Oscuro.png';
import { createLandingMarkup } from './sections.js';
import { initLandingInteractions } from './interactions.js';
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
  const fontStylesheet = document.createElement('link');
  fontStylesheet.rel = 'stylesheet';
  fontStylesheet.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap';
  document.head.append(fontStylesheet);
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
  const anchor = window.location.hash.slice(1);
  if (['features', 'how-it-works', 'final-cta', 'faq'].includes(anchor)) {
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }
}
