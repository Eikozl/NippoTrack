import './landing.css';
import wordmark from '../assets/Logo_Modo_Claro.png';
import { createLandingMarkup } from './sections.js';
import { initLandingInteractions } from './interactions.js';

const root = document.getElementById('landing-root');

if (root) {
  document.documentElement.classList.add('landing-js');
  document.documentElement.style.colorScheme = 'light';
  const fontStylesheet = document.createElement('link');
  fontStylesheet.rel = 'stylesheet';
  fontStylesheet.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap';
  document.head.append(fontStylesheet);
  document.title = 'NippoTrack \u2014 Bring your Japanese learning together';
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    'Organize what you learn, understand Japanese in context, and keep a clear view of your progress.'
  );
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#F5F0E8');
  document.body.classList.add('has-landing');
  root.innerHTML = createLandingMarkup(wordmark);
  initLandingInteractions(root);
  const anchor = window.location.hash.slice(1);
  if (['features', 'how-it-works', 'final-cta', 'faq'].includes(anchor)) {
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
  }
}
