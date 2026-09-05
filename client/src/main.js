import './styles.css';
import lightBrandLogo from './assets/JLT_logo-png.png';
import darkBrandLogo from './assets/JLT_logo-png-dark-mode.png';
import { destroyCharts, refreshChartTheme } from './chartRegistry';
import { apiRequest } from './api';
import { kanjiReferenceRoute, parseKanjiReferenceRoute } from './kanjiReference';
import { icon, moduleIconMap } from './icons';
import { confirmDialog, element, openDialog, showToast } from './ui';
import { authConfigured, localAuthBypass, localAuthBypassEmail, supabase } from './authClient';
import { getLocale, setLocale, t, translateDocument } from './i18n';

const content = document.getElementById('app-content');
const authRoot = document.getElementById('auth-root');
const appShell = document.getElementById('app-shell');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('mobile-backdrop');
const navigationButtons = Array.from(document.querySelectorAll('[data-page]'));
// Page modules load on first navigation so the initial chunk stays small.
// Entries resolve to their render functions; failed loads are evicted from the
// cache so a retry re-imports instead of reusing a rejected promise.
const pageModuleCache = new Map();
const pageLoaders = {
  dashboard: () => import('./pages/dashboard.js').then((module) => (container) => module.renderDashboard(container)),
  sessions: () => import('./pages/sessions.js').then((module) => (container) => module.renderSessions(container)),
  vocabulary: () => import('./pages/entityPage.js').then((module) => (container) => module.renderEntityPage(container, module.ENTITY_CONFIGS.vocabulary)),
  kanji: () => import('./pages/entityPage.js').then((module) => (container) => module.renderEntityPage(container, module.ENTITY_CONFIGS.kanji)),
  analyzer: () => import('./pages/analyzer.js').then((module) => (container) => module.renderAnalyzer(container)),
  grammar: () => import('./pages/entityPage.js').then((module) => (container) => module.renderEntityPage(container, module.ENTITY_CONFIGS.grammar)),
  goals: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'goals')),
  content: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'content')),
  notes: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'notes')),
  tags: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'tags')),
  review: () => import('./pages/review.js').then((module) => (container) => module.renderReview(container)),
  statistics: () => import('./pages/statistics.js').then((module) => (container) => module.renderStatistics(container)),
  settings: () => import('./pages/settings.js').then((module) => (container) => module.renderSettings(container))
};
function loadPage(page) {
  if (!pageModuleCache.has(page)) {
    pageModuleCache.set(page, pageLoaders[page]().catch((error) => { pageModuleCache.delete(page); throw error; }));
  }
  return pageModuleCache.get(page);
}
const pages = {
  dashboard: (container) => loadPage('dashboard').then((render) => render(container)),
  sessions: (container) => loadPage('sessions').then((render) => render(container)),
  vocabulary: (container) => loadPage('vocabulary').then((render) => render(container)),
  kanji: (container) => loadPage('kanji').then((render) => render(container)),
  analyzer: (container) => loadPage('analyzer').then((render) => render(container)),
  grammar: (container) => loadPage('grammar').then((render) => render(container)),
  goals: (container) => loadPage('goals').then((render) => render(container)),
  content: (container) => loadPage('content').then((render) => render(container)),
  notes: (container) => loadPage('notes').then((render) => render(container)),
  tags: (container) => loadPage('tags').then((render) => render(container)),
  review: (container) => loadPage('review').then((render) => render(container)),
  statistics: (container) => loadPage('statistics').then((render) => render(container)),
  settings: (container) => loadPage('settings').then((render) => render(container))
};
async function renderKanjiReferencePage(container, character) {
  const module = await import('./pages/kanjiReference.js');
  return module.renderKanjiReference(container, character);
}

const searchInput = document.getElementById('global-search');
const searchResults = document.getElementById('global-search-results');
const sidebarStreak = document.getElementById('sidebar-streak');
const brandLogo = document.getElementById('brand-logo');
const themeToggle = document.getElementById('theme-toggle');
const mobileThemeToggle = document.getElementById('mobile-theme-toggle');
const accountButtons = [document.getElementById('account-button'), document.getElementById('mobile-account-button')];
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
const savedTheme = localStorage.getItem('jlt-theme') || 'light';
document.querySelectorAll('[data-jlt-icon]').forEach((holder) => {
  holder.appendChild(icon(moduleIconMap[holder.dataset.jltIcon] || holder.dataset.jltIcon, { size: 19 }));
});
document.documentElement.dataset.theme = savedTheme;
document.documentElement.lang = getLocale();
translateDocument();
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
    const label = t(dark ? 'Switch to light mode' : 'Switch to dark mode');
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

let authMessage = '';
let authView = 'sign-in';
function renderAuthGate(message = '', view = 'sign-in') {
  authMessage = message;
  authView = view;
  appShell.hidden = true;
  if (!authConfigured) { authRoot.textContent = 'Supabase Auth configuration is required.'; return; }
  const email = element('input', { className: 'field-control', attrs: { type: 'email', required: '', autocomplete: 'email', placeholder: 'you@example.com' } });
  const password = element('input', { className: 'field-control', attrs: { type: 'password', required: '', autocomplete: view === 'sign-up' ? 'new-password' : 'current-password', placeholder: 'Password' } });
  const confirm = element('input', { className: 'field-control', attrs: { type: 'password', required: '', autocomplete: 'new-password', placeholder: 'Confirm password' } });
  const feedback = element('p', { className: `min-h-5 text-sm ${message ? 'text-red-700' : 'text-muted'}`, text: message, attrs: { 'aria-live': 'polite' } });
  const titles = { 'sign-in': 'Sign in', 'sign-up': 'Create your account', forgot: 'Reset your password', reset: 'Choose a new password' };
  const submit = element('button', { className: 'button-primary w-full', text: titles[view], attrs: { type: 'submit' } });
  const fields = [];
  if (view !== 'reset') fields.push(element('label', { className: 'field' }, [element('span', { text: 'Email' }), email]));
  if (view !== 'forgot') fields.push(element('label', { className: 'field' }, [element('span', { text: 'Password' }), password]));
  if (view === 'sign-up' || view === 'reset') fields.push(element('label', { className: 'field' }, [element('span', { text: 'Confirm password' }), confirm]));
  const form = element('form', { className: 'mt-6 grid gap-4', attrs: { 'aria-label': 'Sign in to Japanese Learning Tracker' } }, [
    ...fields, feedback, submit
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Please wait…';
    feedback.textContent = '';
    try {
      if ((view === 'sign-up' || view === 'reset') && password.value !== confirm.value) throw new Error('Passwords do not match.');
      if (view === 'sign-in') { const data = await apiRequest('/api/auth/sign-in', { method: 'POST', body: { email: email.value, password: password.value }, notifyAuth: false }); const { error } = await supabase.auth.setSession(data.session); if (error) throw error; return bootstrapApp(); }
      if (view === 'sign-up') { await apiRequest('/api/auth/sign-up', { method: 'POST', body: { email: email.value, password: password.value }, notifyAuth: false }); return renderAuthGate('Check your email to confirm your account before signing in.'); }
      if (view === 'forgot') { await apiRequest('/api/auth/forgot-password', { method: 'POST', body: { email: email.value }, notifyAuth: false }); return renderAuthGate('If an account exists, recovery instructions have been sent.'); }
      const { error } = await supabase.auth.updateUser({ password: password.value }); if (error) throw error; await supabase.auth.signOut(); return renderAuthGate('Password updated. Sign in with your new password.');
    } catch (error) {
      feedback.textContent = error?.status === 429 ? 'Too many attempts. Please wait before trying again.' : error?.message || 'Unable to complete that request.';
      submit.disabled = false;
      submit.textContent = titles[view];
      (view === 'forgot' ? email : password).focus();
    }
  });
  const switcher = element('p', { className: 'auth-switcher' }, view === 'sign-in' ? [linkButton('Create account', () => renderAuthGate('', 'sign-up')), linkButton('Forgot password?', () => renderAuthGate('', 'forgot'))] : [linkButton('Back to sign in', () => renderAuthGate())]);
  const formPanel = element('section', { className: 'auth-form-panel', attrs: { 'aria-labelledby': 'login-title' } }, [
    element('p', { className: 'eyebrow', text: 'Japanese Learning Tracker' }),
    element('h1', { className: 'auth-title', text: titles[view], attrs: { id: 'login-title' } }),
    element('p', { className: 'auth-description', text: view === 'sign-up' ? 'Confirm your email before accessing your private workspace.' : view === 'forgot' ? 'We will email recovery instructions if the account exists.' : 'Your personal space to build a steady Japanese study practice.' }), form, switcher
  ]);
  const localeMenu = element('div', { className: 'auth-locale-menu', attrs: { role: 'menu', hidden: '' } }, [
    ['en', 'English'], ['es', 'Spanish']
  ].map(([value, label]) => {
    const option = element('button', { className: 'auth-locale-option', text: label, attrs: { type: 'button', role: 'menuitem', 'aria-checked': String(getLocale() === value) } });
    option.addEventListener('click', () => setLocale(value));
    return option;
  }));
  const localeToggle = element('button', { className: 'auth-locale-toggle', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Language', title: 'Language' } }, [icon('kanji', { size: 20 })]);
  localeToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = localeMenu.hasAttribute('hidden');
    if (open) localeMenu.removeAttribute('hidden'); else localeMenu.setAttribute('hidden', '');
    localeToggle.setAttribute('aria-expanded', String(open));
  });
  const localeControl = element('div', { className: 'auth-locale-control' }, [localeToggle, localeMenu]);
  const brandPanel = element('aside', { className: 'auth-brand-panel', attrs: { 'aria-label': 'Japanese Learning Tracker' } }, [
    element('div', { className: 'auth-brand-glow', attrs: { 'aria-hidden': 'true' } }),
    element('div', { className: 'auth-brand-content' }, [
      element('img', { className: 'auth-brand-logo', attrs: { src: lightBrandLogo, alt: 'Japanese Learning Tracker logo' } }),
      element('p', { className: 'auth-brand-kicker', text: 'LEARN WITH INTENTION' }),
      element('p', { className: 'auth-brand-copy', text: 'Small sessions become lasting progress.' })
    ])
  ]);
  authRoot.replaceChildren(element('main', { className: 'auth-screen' }, [localeControl, element('div', { className: 'auth-shell' }, [formPanel, brandPanel]) ]));
  (view === 'forgot' || view === 'sign-up' ? email : password).focus();
}

function linkButton(text, action) { const button = element('button', { className: 'underline underline-offset-4', text, attrs: { type: 'button' } }); button.addEventListener('click', action); return button; }

async function bootstrapApp() {
  // Never leave the document blank while a stored session is checked remotely.
  renderAuthGate();
  try {
    if (!localAuthBypass) {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
    }
    const session = await apiRequest('/api/auth/session', { notifyAuth: false });
    if (!session.authenticated) return;
    authRoot.replaceChildren();
    appShell.hidden = false;
    await navigate(window.location.hash.slice(1) || 'dashboard', { updateHash: false });
  } catch {
    renderAuthGate('Authentication service is unavailable.');
  }
}

window.addEventListener('jlt-auth-required', (event) => renderAuthGate(event.detail?.code === 'EMAIL_UNVERIFIED' ? 'Please verify your email before continuing.' : 'Your session has ended. Please sign in again.'));

async function signOut() {
  try { await supabase.auth.signOut(); await apiRequest('/api/auth/logout', { method: 'POST', notifyAuth: false }); } finally { renderAuthGate(); }
}

function confirmSignOut() {
  confirmDialog({
    title: 'Sign out?',
    description: 'You will need to sign in again to access your private learning data.',
    confirmLabel: 'Sign out',
    onConfirm: signOut
  });
}

async function openAccountDialog() {
  let email = localAuthBypassEmail;
  if (!localAuthBypass) {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.email) throw error || new Error('Unable to load your account.');
    email = data.user.email;
  }
  let closeDialog = () => {};
  const signOutButton = element('button', { className: 'button-danger w-full sm:w-auto', text: 'Sign out', attrs: { type: 'button' } });
  signOutButton.addEventListener('click', () => {
    closeDialog();
    confirmSignOut();
  });
  closeDialog = openDialog({
    title: 'Your account',
    submitLabel: null,
    showFooter: false,
    showCloseButton: false,
    content: [element('section', { className: 'sm:col-span-2 grid gap-5' }, [
      element('div', { className: 'grid gap-1.5' }, [
        element('p', { className: 'text-sm font-semibold text-ink', text: 'Signed in as' }),
        element('p', { className: 'break-all text-sm text-muted', text: email })
      ]),
      element('div', { className: 'flex flex-col gap-3 sm:flex-row sm:items-center' }, [signOutButton])
    ])]
  });
}

accountButtons.forEach((button) => button?.addEventListener('click', () => {
  openAccountDialog().catch((error) => showToast(error.message || 'Unable to load your account.', 'error'));
}));
window.addEventListener('jlt-locale-change', () => {
  translateDocument();
  accountButtons.forEach((button) => {
    button?.setAttribute('aria-label', t('Manage account'));
    button?.setAttribute('title', t('Manage account'));
  });
  updateThemeControls(document.documentElement.dataset.theme);
  if (appShell.hidden) renderAuthGate(authMessage, authView);
  else navigate(window.location.hash.slice(1) || 'dashboard', { updateHash: false });
});
supabase?.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') renderAuthGate('', 'reset'); });

let sidebarActivitySnapshot = null;

async function loadSidebarStreak({ force = false } = {}) {
  if (!sidebarStreak) return;
  try {
    const cached = !force && sidebarActivitySnapshot && Date.now() - sidebarActivitySnapshot.loadedAt < 30_000;
    const activity = cached ? sidebarActivitySnapshot.activity : await apiRequest('/api/dashboard/activity');
    if (!cached) sidebarActivitySnapshot = { activity, loadedAt: Date.now() };
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
window.addEventListener('jlt-data-change', () => loadSidebarStreak({ force: true }));
window.addEventListener('jlt-sidebar-activity', (event) => {
  if (!event.detail) return;
  sidebarActivitySnapshot = { activity: event.detail, loadedAt: Date.now() };
  loadSidebarStreak();
});

function closeSearch() { searchResults.classList.add('hidden'); searchResults.replaceChildren(); searchSequence += 1; searchAbort?.abort(); }
let searchSequence = 0;
let searchAbort = null;
async function globalSearch(query, sequence) {
  if (!query.trim()) return closeSearch();
  searchResults.classList.remove('hidden'); searchResults.className = 'absolute inset-x-0 top-[calc(100%+.6rem)] z-30 max-h-96 overflow-y-auto rounded-[18px] p-2 surface';
  searchResults.textContent = 'Searching…';
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  try {
    const referenceRequest = apiRequest(`/api/kanji/reference?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
      .then((data) => data.items)
      .catch((error) => { if (error?.name === 'AbortError') throw error; return []; });
    const [vocabulary, kanji, grammar, sessions, notes, references] = await Promise.all([
      apiRequest(`/api/vocabulary?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }), apiRequest(`/api/kanji?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }), apiRequest(`/api/grammar?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }), apiRequest(`/api/sessions?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }).catch((error) => { if (error?.name === 'AbortError') throw error; return { items: [] }; }), apiRequest(`/api/notes?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }).catch((error) => { if (error?.name === 'AbortError') throw error; return { items: [] }; }), referenceRequest
    ]);
    if (sequence !== searchSequence || controller.signal.aborted) return;
    const groups = [
      ['Kanji reference', references, null, (x) => `${x.character} · ${x.meanings.join(', ')}`],
      ['Vocabulary', vocabulary.items, 'vocabulary', (x) => `${x.word} · ${x.meaning}`],
      ['Kanji', kanji.items, 'kanji', (x) => `${x.character_kanji} · ${x.meaning}`],
      ['Grammar', grammar.items, 'grammar', (x) => `${x.grammar_point} · ${x.meaning}`],
      ['Sessions', sessions.items, 'sessions', (x) => `${x.category} · ${x.session_date}`],
      ['Notes', notes.items, 'notes', (x) => x.title || x.category]
    ];
    searchResults.replaceChildren(...groups.filter(([, items]) => items?.length).map(([label, items, page, text]) => element('section', { className: 'p-2' }, [element('p', { className: 'eyebrow', text: label }), ...items.map((item) => { const button = element('button', { className: 'block w-full rounded-xl px-3 py-2 text-left text-sm text-ink hover:bg-paper', text: text(item), attrs: { type: 'button' } }); button.addEventListener('click', () => { closeSearch(); searchInput.value = ''; navigate(page || kanjiReferenceRoute(item.character)); }); return button; })])));
    if (!searchResults.childNodes.length) searchResults.textContent = 'No matching study records.';
  } catch (error) { if (error?.name === 'AbortError' || sequence !== searchSequence) return; searchResults.textContent = 'Unable to search right now.'; }
}
let searchTimer;
searchInput?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => globalSearch(searchInput.value, ++searchSequence), 220); });

function closeNavigation() {
  sidebar.classList.add('-translate-x-full');
  backdrop.classList.add('hidden');
}

function openNavigation() {
  sidebar.classList.remove('-translate-x-full');
  backdrop.classList.remove('hidden');
}

async function navigate(pageName, { updateHash = true } = {}) {
  const referenceCharacter = parseKanjiReferenceRoute(pageName);
  const page = referenceCharacter ? pageName : (pages[pageName] ? pageName : 'dashboard');
  destroyCharts();
  navigationButtons.forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  closeNavigation();
  if (updateHash && window.location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  if (referenceCharacter) await renderKanjiReferencePage(content, referenceCharacter);
  else await pages[page](content);
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
