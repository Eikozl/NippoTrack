import './styles.css';
import lightBrandLogo from './assets/JLT_logo-png.png';
import darkBrandLogo from './assets/JLT_logo-png-dark-mode.png';
import { destroyCharts, refreshChartTheme } from './charts';
import { apiRequest } from './api';
import { renderDashboard } from './pages/dashboard';
import { ENTITY_CONFIGS, renderEntityPage } from './pages/entityPage';
import { renderSessions } from './pages/sessions';
import { renderStatistics } from './pages/statistics';
import { renderV2Page } from './pages/v2Pages';
import { renderReview } from './pages/review';
import { renderSettings } from './pages/settings';
import { icon, moduleIconMap } from './icons';
import { element } from './ui';

const content = document.getElementById('app-content');
const authRoot = document.getElementById('auth-root');
const appShell = document.getElementById('app-shell');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('mobile-backdrop');
const navigationButtons = Array.from(document.querySelectorAll('[data-page]'));
const pages = {
  dashboard: () => renderDashboard(content),
  sessions: () => renderSessions(content),
  vocabulary: () => renderEntityPage(content, ENTITY_CONFIGS.vocabulary),
  kanji: () => renderEntityPage(content, ENTITY_CONFIGS.kanji),
  grammar: () => renderEntityPage(content, ENTITY_CONFIGS.grammar),
  goals: () => renderV2Page(content, 'goals'),
  content: () => renderV2Page(content, 'content'),
  notes: () => renderV2Page(content, 'notes'),
  tags: () => renderV2Page(content, 'tags'),
  review: () => renderReview(content),
  statistics: () => renderStatistics(content),
  settings: () => renderSettings(content)
};

const searchInput = document.getElementById('global-search');
const searchResults = document.getElementById('global-search-results');
const sidebarStreak = document.getElementById('sidebar-streak');
const brandLogo = document.getElementById('brand-logo');
const themeToggle = document.getElementById('theme-toggle');
const mobileThemeToggle = document.getElementById('mobile-theme-toggle');
const logoutButtons = [document.getElementById('logout-button'), document.getElementById('mobile-logout-button')];
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const savedTheme = localStorage.getItem('jlt-theme') || 'light';
document.querySelectorAll('[data-jlt-icon]').forEach((holder) => {
  holder.appendChild(icon(moduleIconMap[holder.dataset.jltIcon] || holder.dataset.jltIcon, { size: 19 }));
});
document.documentElement.dataset.theme = savedTheme;
function updateThemeControls(theme) {
  const dark = theme === 'dark';
  document.documentElement.style.colorScheme = theme;
  themeColorMeta?.setAttribute('content', dark ? '#202428' : '#eef1f7');
  if (brandLogo) {
    brandLogo.src = dark ? darkBrandLogo : lightBrandLogo;
    brandLogo.classList.toggle('brand-logo-dark', dark);
  }
  [themeToggle, mobileThemeToggle].forEach((button) => {
    if (!button) return;
    button.setAttribute('aria-pressed', String(dark));
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    const iconHolder = button.querySelector('[id$="theme-toggle-icon"]');
    if (iconHolder) iconHolder.replaceChildren(icon(dark ? 'moon' : 'sun', { size: 19 }));
  });
}
function setTheme(theme) {
  localStorage.setItem('jlt-theme', theme);
  document.documentElement.dataset.theme = theme;
  updateThemeControls(theme);
  refreshChartTheme();
  window.dispatchEvent(new CustomEvent('jlt-theme-change', { detail: theme }));
}
updateThemeControls(savedTheme);
[themeToggle, mobileThemeToggle].forEach((button) => button?.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')));
window.addEventListener('jlt-theme-change', (event) => {
  updateThemeControls(event.detail || document.documentElement.dataset.theme);
  refreshChartTheme();
});

function renderAuthGate(message = '') {
  appShell.hidden = true;
  const password = element('input', { className: 'field-control', attrs: { id: 'jlt-login-password', name: 'password', type: 'password', required: '', autocomplete: 'current-password', placeholder: 'Password' } });
  const feedback = element('p', { className: `min-h-5 text-sm ${message ? 'text-red-700' : 'text-muted'}`, text: message, attrs: { 'aria-live': 'polite' } });
  const submit = element('button', { className: 'button-primary w-full', text: 'Sign in', attrs: { type: 'submit' } });
  const form = element('form', { className: 'mt-6 grid gap-4', attrs: { 'aria-label': 'Sign in to Japanese Learning Tracker' } }, [
    element('label', { className: 'field', attrs: { for: 'jlt-login-password' } }, [element('span', { text: 'Password' }), password]),
    feedback,
    submit
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    feedback.textContent = '';
    try {
      await apiRequest('/api/auth/login', { method: 'POST', body: { password: password.value }, notifyAuth: false });
      password.value = '';
      await bootstrapApp();
    } catch (error) {
      feedback.textContent = error?.status === 429 ? 'Too many attempts. Please wait before trying again.' : 'The password is incorrect.';
      submit.disabled = false;
      submit.textContent = 'Sign in';
      password.focus();
    }
  });
  authRoot.replaceChildren(element('main', { className: 'grid min-h-screen place-items-center px-4 py-8' }, [
    element('section', { className: 'surface w-full max-w-md p-6 sm:p-8', attrs: { 'aria-labelledby': 'login-title' } }, [
      element('p', { className: 'eyebrow', text: 'Private workspace' }),
      element('h1', { className: 'mt-2 text-2xl font-semibold tracking-tight text-ink', text: 'Japanese Learning Tracker', attrs: { id: 'login-title' } }),
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: 'Sign in to access your private study data.' }),
      form
    ])
  ]));
  password.focus();
}

async function bootstrapApp() {
  try {
    const session = await apiRequest('/api/auth/session', { notifyAuth: false });
    if (!session.authenticated) return renderAuthGate();
    authRoot.replaceChildren();
    appShell.hidden = false;
    await navigate(window.location.hash.slice(1) || 'dashboard', { updateHash: false });
  } catch {
    renderAuthGate('Authentication service is unavailable.');
  }
}

window.addEventListener('jlt-auth-required', () => renderAuthGate('Your session has ended. Please sign in again.'));
logoutButtons.forEach((button) => button?.addEventListener('click', async () => {
  try { await apiRequest('/api/auth/logout', { method: 'POST', notifyAuth: false }); } finally { renderAuthGate(); }
}));

async function loadSidebarStreak() {
  if (!sidebarStreak) return;
  try {
    const activity = await apiRequest('/api/dashboard/activity');
    const current = Number(activity.currentStreak || 0);
    const longest = Number(activity.longestStreak || 0);
    const activeDates = new Set((activity.calendar || []).map((item) => String(item.date).slice(0, 10)));
    const today = new Date();
    const weekDays = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - index));
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return { label: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getDay()], active: activeDates.has(key) };
    });
    sidebarStreak.replaceChildren(
      element('p', { className: 'streak-value text-2xl font-semibold tracking-tight text-ink', text: `${current} ${current === 1 ? 'day' : 'days'}` }),
      element('p', { className: 'mt-1 text-xs text-muted', text: `Current streak · best ${longest} ${longest === 1 ? 'day' : 'days'}` })
    );
    sidebarStreak.appendChild(element('div', { className: 'streak-week mt-4', attrs: { 'aria-label': 'Study activity for the last seven days' } }, weekDays.map((day) => element('div', { className: 'grid justify-items-center gap-1' }, [
      element('span', { className: `streak-day ${day.active ? 'is-active' : ''}`, text: day.active ? '✓' : '', attrs: { 'aria-hidden': 'true' } }),
      element('span', { className: 'text-[10px] font-medium text-muted', text: day.label })
    ]))));
  } catch {
    sidebarStreak.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Streak unavailable.' }));
  }
}
window.addEventListener('jlt-data-change', loadSidebarStreak);

function closeSearch() { searchResults.classList.add('hidden'); searchResults.replaceChildren(); }
async function globalSearch(query) {
  if (!query.trim()) return closeSearch();
  searchResults.classList.remove('hidden'); searchResults.className = 'absolute inset-x-0 top-[calc(100%+.6rem)] z-30 max-h-96 overflow-y-auto rounded-[18px] p-2 surface';
  searchResults.textContent = 'Searching…';
  try {
    const [vocabulary, kanji, grammar, sessions, notes] = await Promise.all([
      apiRequest(`/api/vocabulary?search=${encodeURIComponent(query)}&limit=5`), apiRequest(`/api/kanji?search=${encodeURIComponent(query)}&limit=5`), apiRequest(`/api/grammar?search=${encodeURIComponent(query)}&limit=5`), apiRequest(`/api/sessions?search=${encodeURIComponent(query)}&limit=5`).catch(() => ({ items: [] })), apiRequest(`/api/notes?search=${encodeURIComponent(query)}&limit=5`).catch(() => ({ items: [] }))
    ]);
    const groups = [['Vocabulary', vocabulary.items, 'vocabulary', (x) => `${x.word} · ${x.meaning}`], ['Kanji', kanji.items, 'kanji', (x) => `${x.character_kanji} · ${x.meaning}`], ['Grammar', grammar.items, 'grammar', (x) => `${x.grammar_point} · ${x.meaning}`], ['Sessions', sessions.items, 'sessions', (x) => `${x.category} · ${x.session_date}`], ['Notes', notes.items, 'notes', (x) => x.title || x.category]];
    searchResults.replaceChildren(...groups.filter(([, items]) => items?.length).map(([label, items, page, text]) => element('section', { className: 'p-2' }, [element('p', { className: 'eyebrow', text: label }), ...items.map((item) => { const button = element('button', { className: 'block w-full rounded-xl px-3 py-2 text-left text-sm text-ink hover:bg-paper', text: text(item), attrs: { type: 'button' } }); button.addEventListener('click', () => { closeSearch(); searchInput.value = ''; navigate(page); }); return button; })])));
    if (!searchResults.childNodes.length) searchResults.textContent = 'No matching study records.';
  } catch { searchResults.textContent = 'Unable to search right now.'; }
}
let searchTimer;
searchInput?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => globalSearch(searchInput.value), 220); });

function closeNavigation() {
  sidebar.classList.add('-translate-x-full');
  backdrop.classList.add('hidden');
}

function openNavigation() {
  sidebar.classList.remove('-translate-x-full');
  backdrop.classList.remove('hidden');
}

async function navigate(pageName, { updateHash = true } = {}) {
  const page = pages[pageName] ? pageName : 'dashboard';
  destroyCharts();
  navigationButtons.forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  closeNavigation();
  if (updateHash && window.location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  await pages[page]();
  loadSidebarStreak();
  content.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

navigationButtons.forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
document.getElementById('open-navigation').addEventListener('click', openNavigation);
document.getElementById('close-navigation').addEventListener('click', closeNavigation);
backdrop.addEventListener('click', closeNavigation);
window.addEventListener('hashchange', () => navigate(window.location.hash.slice(1), { updateHash: false }));
window.addEventListener('keydown', (event) => { const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName); if (event.key === 'Escape') closeSearch(); if (event.key === '/' && !typing) { event.preventDefault(); searchInput?.focus(); } if (!typing && event.key.toLowerCase() === 'g') { window.__jltGo = true; window.setTimeout(() => { window.__jltGo = false; }, 700); } else if (!typing && window.__jltGo && event.key.toLowerCase() === 'd') { window.__jltGo = false; navigate('dashboard'); } else if (!typing && window.__jltGo && event.key.toLowerCase() === 'r') { window.__jltGo = false; navigate('review'); } });
document.getElementById('export-data')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const backup = await apiRequest('/api/export');
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `jlt-backup-${backup.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    showToast('Backup exported.');
  } catch (error) {
    showToast(error.message || 'Unable to export backup.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Export backup';
  }
});

bootstrapApp();
