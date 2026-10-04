import './styles.css';
import lightBrandLogo from './assets/Logo_Modo_Claro_App.png';
import darkBrandLogo from './assets/Logo_Modo_Oscuro_App.png';
import { APP_THEME_META, applyAppThemeAttributes, isAllowedAppTheme, persistAppTheme, resolveAppTheme, wordmarkForAppTheme } from './appTheme';
import { destroyCharts, refreshChartTheme } from './chartRegistry';
import { apiRequest } from './api';
import { kanjiReferenceRoute, parseKanjiReferenceRoute } from './kanjiReference';
import { icon, moduleIconMap } from './icons';
import { confirmDialog, element, showToast } from './ui';
import { openAuthModal } from './authModal.js';
import { createLevelEstimateControl } from './levelEstimateControl';
import { authConfigured, localAuthBypass, localAuthBypassEmail, supabase } from './authClient';
import { profileStore } from './accountProfile.js';
import { getLocale, setLocale, t, translateDocument } from './i18n';
import { authViewFromSearch } from './landing/routing';

const content = document.getElementById('app-content');
const authRoot = document.getElementById('auth-root');
const appShell = document.getElementById('app-shell');
const initialAuthView = authViewFromSearch(window.location.search);
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
  immersion: () => import('./pages/immersion.js').then((module) => (container) => module.renderImmersion(container)),
  reading: () => import('./pages/reading.js').then((module) => (container) => module.renderReading(container)),
  grammar: () => import('./pages/entityPage.js').then((module) => (container) => module.renderEntityPage(container, module.ENTITY_CONFIGS.grammar)),
  goals: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'goals')),
  content: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'content')),
  notes: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'notes')),
  tags: () => import('./pages/v2Pages.js').then((module) => (container) => module.renderV2Page(container, 'tags')),
  review: () => import('./pages/review.js').then((module) => (container) => module.renderReview(container)),
  decks: () => import('./pages/decks.js').then((module) => (container) => module.renderDecks(container)),
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
  immersion: (container) => loadPage('immersion').then((render) => render(container)),
  reading: (container) => loadPage('reading').then((render) => render(container)),
  grammar: (container) => loadPage('grammar').then((render) => render(container)),
  goals: (container) => loadPage('goals').then((render) => render(container)),
  content: (container) => loadPage('content').then((render) => render(container)),
  notes: (container) => loadPage('notes').then((render) => render(container)),
  tags: (container) => loadPage('tags').then((render) => render(container)),
  review: (container) => loadPage('review').then((render) => render(container)),
  decks: (container) => loadPage('decks').then((render) => render(container)),
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
// Canonical app theme preference (`nippotrack-theme`, shared with public).
// Resolution: stored canonical → stored legacy `jlt-theme` (accepted AND
// migrated forward to canonical, legacy left intact) → OS
// prefers-color-scheme → light. Arbitrary strings rejected (allowlist).
// Writes persist BOTH keys; `data-theme` attr, `jlt-theme-change` event,
// and chart refresh consumers are unchanged (backward compat).
const savedTheme = resolveAppTheme();
const themeAssets = { lightSrc: lightBrandLogo, darkSrc: darkBrandLogo };
document.querySelectorAll('[data-jlt-icon]').forEach((holder) => {
  holder.appendChild(icon(moduleIconMap[holder.dataset.jltIcon] || holder.dataset.jltIcon, { size: 19 }));
});
document.documentElement.dataset.theme = savedTheme;
// Hotfix: prepaint sets BOTH attributes — runtime must keep them in sync or
// a stale data-nippotrack-theme keeps dark tokens active after toggling.
applyAppThemeAttributes(savedTheme);
document.documentElement.lang = getLocale();
translateDocument();
function updateThemeControls(theme) {
  const next = isAllowedAppTheme(theme) ? theme : 'light';
  const dark = next === 'dark';
  document.documentElement.style.colorScheme = next;
  themeColorMeta?.setAttribute('content', APP_THEME_META[next]);
  if (brandLogo) {
    // NippoTrack wordmarks: light ink on light canvas, ivory ink on dark.
    brandLogo.src = wordmarkForAppTheme(next, themeAssets);
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
  if (!isAllowedAppTheme(theme)) return;
  // Persist BOTH keys (canonical + legacy); legacy readers stay consistent.
  persistAppTheme(theme, localStorage);
  // Sync BOTH root attributes (data-theme + data-nippotrack-theme) so the
  // shared token layer flips together in either direction.
  applyAppThemeAttributes(theme);
  updateThemeControls(theme);
  refreshChartTheme();
  window.dispatchEvent(new CustomEvent('jlt-theme-change', { detail: theme }));
}
updateThemeControls(savedTheme);
[themeToggle, mobileThemeToggle].forEach((button) => button?.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')));
window.addEventListener('jlt-theme-change', (event) => {
  const next = event.detail || document.documentElement.dataset.theme;
  // External dispatchers (e.g. settings) write attributes themselves, but
  // re-sync here so a bare event can never leave the attributes split.
  applyAppThemeAttributes(next);
  updateThemeControls(next);
  refreshChartTheme();
});

let authMessage = '';
let authView = 'sign-in';
let currentAuthEmail = localAuthBypassEmail || null;
function renderAuthGate(message = '', view = 'sign-in') {
  // Legacy /app entry point. The canonical public interaction is the
  // Landing modal, but this route must keep working for protected-route
  // fallback, recovery links, and deep links — so it hosts the SAME modal
  // (same fields, calls, validation, messages, focus rules) over a plain
  // canvas. No separate login page, no divergent Auth implementation.
  authMessage = message;
  authView = view;
  appShell.hidden = true;
  if (!authConfigured) { authRoot.textContent = 'Supabase Auth configuration is required.'; return () => {}; }
  return openAuthModal({
    host: authRoot,
    background: null,
    initialView: view,
    message,
    messageKind: 'error',
    dismissible: true,
    trigger: null,
    onAuthenticated: () => bootstrapApp(),
    onClose: () => window.location.assign('/')
  });
}

// v5.1-A.2 first-experience session: set during the post-auth boot gate
// below, cleared when setup completes. Declared here (ahead of navigate)
// so the guard above and the boot path share one binding.
let firstExperienceSession = null;

async function bootstrapApp() {
  // Never leave the document blank while a stored session is checked remotely.
  const closeGate = renderAuthGate('', initialAuthView);
  try {
    if (!localAuthBypass) {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
    }
    const session = await apiRequest('/api/auth/session', { notifyAuth: false });
    if (!session.authenticated) return;
    currentAuthEmail = session.user?.email || localAuthBypassEmail || null;
    profileStore.setEmail(currentAuthEmail);
    // Session restore must retire the gate modal through its own teardown
    // (scroll lock, listeners, singleton) — never by dropping its nodes.
    try { closeGate?.('silent'); } catch { /* teardown is best-effort */ }
    authRoot.replaceChildren();
    appShell.hidden = false;
    // Profile identity is presentation-only and never blocks the shell. The
    // cached store is shared by the user menu and Settings so opening the menu
    // does not create a request per interaction.
    profileStore.load().then(() => syncUserMenus()).catch(() => syncUserMenus());
    levelEstimateControl.load();
    // v5.1-A.2 first-experience gate: an incomplete server-side onboarding
    // state swaps the normal workflow for the focused setup shell (rendered
    // into the normal content area, app chrome reused). FAIL-OPEN: any
    // fetch failure falls through to the normal app — setup must never
    // trap the user. notifyAuth is off here because the session was just
    // verified above; a 401/404 from this endpoint (e.g. backend not yet
    // deployed) must not log anyone out.
    try {
      const firstExperience = await apiRequest('/api/first-experience', { notifyAuth: false });
      if (firstExperience?.onboarding?.completed === false) {
        const module = await import('./firstExperience.js');
        firstExperienceSession = module.renderFirstExperience(content, {
          el: element,
          api: apiRequest,
          navigate,
          notify: (message, type) => showToast(message, type),
          onComplete: () => { firstExperienceSession?.finish(); navigate('dashboard'); },
          onEnterPlacement: () => { firstExperienceSession?.finish(); module.enterPlacement({ navigate }); }
        });
        return;
      }
    } catch {
      // Fail open to the normal app.
    }
    await navigate(window.location.hash.slice(1) || 'dashboard', { updateHash: false });
  } catch {
    renderAuthGate('Authentication service is unavailable.');
  }
}

window.addEventListener('jlt-auth-required', (event) => { levelEstimateControl.reset(); renderAuthGate(event.detail?.code === 'EMAIL_UNVERIFIED' ? 'Please verify your email before continuing.' : 'Your session has ended. Please sign in again.'); });

async function signOut() {
  // Existing logout completes normally (Supabase + API session invalidation
  // + local identity reset); the canonical destination is the public
  // Landing (/), never the Auth screen. '/' resolves to the Landing
  // experience, so this cannot loop back into Auth.
  try { await supabase.auth.signOut(); await apiRequest('/api/auth/logout', { method: 'POST', notifyAuth: false }); } finally { profileStore.reset(); currentAuthEmail = null; closeUserMenu(); window.location.assign('/'); }
}

function confirmSignOut() {
  confirmDialog({
    title: 'Sign out?',
    description: 'You will need to sign in again to access your private learning data.',
    confirmLabel: 'Sign out',
    onConfirm: signOut
  });
}

let openUserMenu = null;
const userMenus = [];

function rawAccountText(node, value) {
  node.textContent = value == null ? '' : String(value);
}

function createUserMenu(trigger, index) {
  if (!trigger?.parentElement) return null;
  const menuId = `account-menu-${index}`;
  const languagePanelId = `${menuId}-language`;
  const menu = element('div', { className: 'user-menu', attrs: { id: menuId, role: 'menu', hidden: '' } });
  const mark = element('span', { className: 'account-initials', attrs: { 'aria-hidden': 'true' } });
  const name = element('p', { className: 'truncate text-sm font-semibold text-ink' });
  const email = element('p', { className: 'truncate text-xs text-muted' });
  const identity = element('div', { className: 'user-menu-identity' }, [mark, element('div', { className: 'min-w-0' }, [name, email])]);
  const languageButton = element('button', { className: 'user-menu-item', attrs: { type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': languagePanelId } }, [element('span', { text: 'Language' }), element('span', { text: '›', attrs: { 'aria-hidden': 'true' } })]);
  const languagePanel = element('div', { className: 'user-menu-language-panel', attrs: { id: languagePanelId, role: 'menu', 'aria-label': 'Language options', hidden: '' } });
  const settingsButton = element('button', { className: 'user-menu-item', text: 'Settings', attrs: { type: 'button', role: 'menuitem' } });
  const signOutButton = element('button', { className: 'user-menu-item user-menu-signout', text: 'Sign out', attrs: { type: 'button', role: 'menuitem' } });
  menu.append(identity, element('div', { className: 'user-menu-divider', attrs: { 'aria-hidden': 'true' } }), element('div', { className: 'user-menu-language' }, [languageButton, languagePanel]), settingsButton, signOutButton);
  trigger.setAttribute('aria-controls', menuId);
  trigger.parentElement.appendChild(menu);

  function syncLanguage() {
    languagePanel.replaceChildren(...[['en', 'English'], ['es', 'Spanish']].map(([value, label]) => {
      const active = getLocale() === value;
      const option = element('button', { className: 'user-menu-option', attrs: { type: 'button', role: 'menuitemradio', 'aria-checked': String(active) } });
      option.textContent = `${active ? '✓ ' : ''}${t(label)}`;
      option.addEventListener('click', () => { setLocale(value); syncUserMenus(); });
      return option;
    }));
  }
  function setOpen(open) {
    if (open) {
      if (openUserMenu && openUserMenu !== menu) openUserMenu.close();
      openUserMenu = menu;
      menu.hidden = false;
      menu.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      syncLanguage();
    } else {
      menu.classList.remove('is-open');
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      languagePanel.hidden = true;
      languageButton.setAttribute('aria-expanded', 'false');
      if (openUserMenu === menu) openUserMenu = null;
    }
  }
  const close = (refocus = false) => { setOpen(false); if (refocus) trigger.focus(); };
  const toggle = (event) => { event?.stopPropagation?.(); setOpen(openUserMenu !== menu); };
  trigger.addEventListener('click', toggle);
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); settingsButton.focus(); }
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const items = Array.from(menu.querySelectorAll('button')).filter((item) => !item.hidden && !item.closest('[hidden]'));
    const at = items.indexOf(document.activeElement);
    if (at === -1) return;
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : event.key === 'Home' ? 0 : items.length - 1;
    items[next]?.focus();
  });
  menu.addEventListener('focusout', (event) => { if (!menu.contains(event.relatedTarget)) close(); });
  languageButton.addEventListener('click', () => {
    const open = languagePanel.hidden;
    languagePanel.hidden = !open;
    languageButton.setAttribute('aria-expanded', String(open));
    if (open) languagePanel.querySelector('button')?.focus();
  });
  settingsButton.addEventListener('click', () => { close(); navigate('settings'); });
  signOutButton.addEventListener('click', () => { close(); confirmSignOut(); });
  const update = () => {
    const profile = profileStore.get();
    const initials = profile?.initials || '';
    mark.replaceChildren();
    if (initials) rawAccountText(mark, initials);
    else mark.appendChild(icon('user', { size: 18 }));
    rawAccountText(name, profile?.displayName || t('Account'));
    rawAccountText(email, profile?.email || currentAuthEmail || '');
    rawAccountText(languageButton.firstElementChild, t('Language'));
    rawAccountText(settingsButton, t('Settings'));
    rawAccountText(signOutButton, t('Sign out'));
    trigger.setAttribute('aria-label', t('Manage account'));
    trigger.setAttribute('title', t('Manage account'));
    syncLanguage();
  };
  const api = { menu, close, update };
  userMenus.push(api);
  update();
  return api;
}

function syncUserMenus() { userMenus.forEach(({ update }) => update()); }
function closeUserMenu(refocus = false) { openUserMenu?.close(refocus); }

accountButtons.forEach((button, index) => createUserMenu(button, index));
document.addEventListener('click', () => closeUserMenu());

// Phase 9 refinement — single header level-estimate control. One controller
// manages both the desktop and mobile header morphs (only one header is
// ever visible); at most one morph is ever open. Freshness: initial load
// after sign-in plus review evidence only — analyzer/import/session events
// cannot change the estimate, so nothing subscribes to them.
const levelEstimateControl = createLevelEstimateControl({
  fetchEstimate: () => apiRequest('/api/level/estimate'),
  // Starting-level fallback while evidence is insufficient (presentation
  // only — the estimator still wins whenever it has evidence). Fail-open:
  // a first-experience fetch failure simply means no fallback.
  fetchStartingPoint: () => apiRequest('/api/first-experience', { notifyAuth: false }).catch(() => null),
  createElement: element,
  doc: document,
  win: window
});
if (themeToggle?.parentElement) levelEstimateControl.mount(themeToggle.parentElement);
if (mobileThemeToggle?.parentElement) levelEstimateControl.mount(mobileThemeToggle.parentElement);

// Header language control (desktop header only — it mounts into the desktop
// controls group, which is hidden below lg, so the compact mobile header
// gains no permanent button). Same locale mechanism as the auth gate and
// Settings: setLocale persists to localStorage and dispatches
// jlt-locale-change; switching language never touches the session.
/* Legacy standalone header language control removed in v5.1-C.
const localeWrap = element('span', { className: 'header-locale-wrap' });
const localeButton = element('button', { className: 'icon-button header-locale-button', text: 'EN', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('Language'), title: t('Language') } });
const localeOptions = [['en', 'English'], ['es', 'Spanish']].map(([value, label]) => {
  const option = element('button', { className: 'header-locale-option', text: label, attrs: { type: 'button', role: 'menuitemradio', 'aria-checked': 'false', 'data-locale': value } });
  option.addEventListener('click', () => { setLocale(value); syncLocaleControl(); closeLocaleMenu(); });
  return option;
});
const localeMenu = element('div', { className: 'header-locale-menu', attrs: { role: 'menu', hidden: '' } }, localeOptions);
localeWrap.append(localeButton, localeMenu);
function syncLocaleControl() {
  const current = getLocale();
  localeButton.textContent = current === 'es' ? 'ES' : 'EN';
  localeButton.setAttribute('aria-label', t('Language'));
  localeButton.setAttribute('title', t('Language'));
  localeOptions.forEach((option) => {
    const active = option.dataset.locale === current;
    option.setAttribute('aria-checked', String(active));
    option.textContent = t(option.dataset.locale === 'en' ? 'English' : 'Spanish');
  });
}
function closeLocaleMenu(refocus = false) {
  localeMenu.setAttribute('hidden', '');
  localeButton.setAttribute('aria-expanded', 'false');
  if (refocus) localeButton.focus();
}
localeButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (localeMenu.hasAttribute('hidden')) {
    localeMenu.removeAttribute('hidden');
    localeButton.setAttribute('aria-expanded', 'true');
  } else closeLocaleMenu();
});
localeWrap.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !localeMenu.hasAttribute('hidden')) { event.stopPropagation(); closeLocaleMenu(true); }
});
document.addEventListener('click', (event) => {
  if (!localeMenu.hasAttribute('hidden') && !localeWrap.contains(event.target)) closeLocaleMenu();
});
// Mount between the estimate control and the theme toggle:
// [ Estimate ] [ Language ] … [ Theme ] [ User ].
themeToggle?.before(localeWrap);
syncLocaleControl();
window.addEventListener('jlt-locale-change', () => syncLocaleControl());
*/
window.addEventListener('jlt-review-complete', () => levelEstimateControl.refresh());
window.addEventListener('jlt-locale-change', () => {
  translateDocument();
  syncUserMenus();
  accountButtons.forEach((button) => {
    button?.setAttribute('aria-label', t('Manage account'));
    button?.setAttribute('title', t('Manage account'));
  });
  mobileSearchButton?.setAttribute('aria-label', t(mobileSearchBar?.hidden === false ? 'Close search' : 'Open search'));
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
      const active = activeDates.has(key);
      return {
        label: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getDay()],
        active,
        stateLabel: `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}: ${active ? 'active' : 'no study activity'}`
      };
    });
    sidebarStreak.replaceChildren(
      element('p', { className: 'streak-value text-2xl font-semibold tracking-tight text-ink', text: `${current} ${current === 1 ? 'day' : 'days'}` }),
      element('p', { className: 'mt-1 text-xs text-muted', text: `Current streak · best ${longest} ${longest === 1 ? 'day' : 'days'}` })
    );
    sidebarStreak.appendChild(element('div', { className: 'streak-week mt-4', attrs: { 'aria-label': 'Study activity for the last seven days' } }, weekDays.map((day) => element('div', { className: 'grid justify-items-center gap-1', attrs: { role: 'img', 'aria-label': day.stateLabel } }, [
      element('span', { className: `streak-day ${day.active ? 'is-active' : ''}`, text: day.active ? '✓' : '', attrs: { 'aria-hidden': 'true' } }),
      element('span', { className: 'text-[10px] font-medium text-muted', text: day.label, attrs: { 'aria-hidden': 'true' } })
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

// Global search combobox: one controller per input/results pair (desktop
// header + mobile bar). Results render as listbox options with ArrowUp /
// ArrowDown / Enter keyboard support; mouse click keeps working.
function createSearch(inputEl, resultsEl, { onEscape = null } = {}) {
  if (!inputEl || !resultsEl) return null;
  const listId = resultsEl.id || 'search-results';
  let sequence = 0;
  let aborter = null;
  let timer = null;
  let options = [];
  let activeIndex = -1;

  function setExpanded(open) {
    inputEl.setAttribute('aria-expanded', String(open));
  }

  function close(clearQuery = false) {
    sequence += 1;
    aborter?.abort();
    aborter = null;
    options = [];
    activeIndex = -1;
    inputEl.removeAttribute('aria-activedescendant');
    setExpanded(false);
    resultsEl.classList.add('hidden');
    resultsEl.setAttribute('hidden', '');
    resultsEl.replaceChildren();
    if (clearQuery) inputEl.value = '';
  }

  function show() {
    resultsEl.classList.remove('hidden');
    resultsEl.removeAttribute('hidden');
  }

  function setActive(index) {
    activeIndex = index;
    const nodes = Array.from(resultsEl.querySelectorAll('[role="option"]'));
    nodes.forEach((node, position) => {
      const active = position === index;
      node.setAttribute('aria-selected', String(active));
      node.classList.toggle('search-option-active', active);
    });
    const current = nodes[index];
    if (current) {
      inputEl.setAttribute('aria-activedescendant', current.id);
      if (typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
    } else {
      inputEl.removeAttribute('aria-activedescendant');
    }
  }

  async function run(query, current) {
    if (!query.trim()) { close(); return; }
    show();
    setExpanded(false);
    resultsEl.textContent = 'Searching…';
    aborter?.abort();
    const controller = new AbortController();
    aborter = controller;
    try {
      const referenceRequest = apiRequest(`/api/kanji/reference?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal })
        .then((data) => data.items)
        .catch((error) => { if (error?.name === 'AbortError') throw error; return []; });
      const [vocabulary, kanji, grammar, sessions, notes, references] = await Promise.all([
        apiRequest(`/api/vocabulary?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }), apiRequest(`/api/kanji?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }), apiRequest(`/api/grammar?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }), apiRequest(`/api/sessions?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }).catch((error) => { if (error?.name === 'AbortError') throw error; return { items: [] }; }), apiRequest(`/api/notes?search=${encodeURIComponent(query)}&limit=5`, { signal: controller.signal }).catch((error) => { if (error?.name === 'AbortError') throw error; return { items: [] }; }), referenceRequest
      ]);
      if (current !== sequence || controller.signal.aborted) return;
      const groups = [
        ['Kanji reference', references, null, (x) => `${x.character} · ${x.meanings.join(', ')}`],
        ['Vocabulary', vocabulary.items, 'vocabulary', (x) => `${x.word} · ${x.meaning}`],
        ['Kanji', kanji.items, 'kanji', (x) => `${x.character_kanji} · ${x.meaning}`],
        ['Grammar', grammar.items, 'grammar', (x) => `${x.grammar_point} · ${x.meaning}`],
        ['Sessions', sessions.items, 'sessions', (x) => `${x.category} · ${x.session_date}`],
        ['Notes', notes.items, 'notes', (x) => x.title || x.category]
      ];
      resultsEl.replaceChildren();
      options = [];
      let counter = 0;
      groups.filter(([, items]) => items?.length).forEach(([label, items, page, text]) => {
        const group = element('div', { className: 'p-2', attrs: { role: 'group', 'aria-label': label } }, [
          element('p', { className: 'eyebrow', text: label, attrs: { 'aria-hidden': 'true' } })
        ]);
        items.forEach((item) => {
          counter += 1;
          const id = `${listId}-option-${counter}`;
          const activate = () => { close(true); navigate(page || kanjiReferenceRoute(item.character)); };
          const button = element('button', { className: 'search-option block w-full rounded-xl px-3 py-2 text-left text-sm text-ink hover:bg-paper', text: text(item), attrs: { type: 'button', role: 'option', id, tabindex: '-1', 'aria-selected': 'false' } });
          button.addEventListener('click', activate);
          options.push({ id, activate });
          group.appendChild(button);
        });
        resultsEl.appendChild(group);
      });
      if (!options.length) {
        resultsEl.textContent = 'No matching study records.';
        setExpanded(false);
      } else {
        setActive(-1);
        setExpanded(true);
      }
    } catch (error) { if (error?.name === 'AbortError' || current !== sequence) return; resultsEl.textContent = 'Unable to search right now.'; }
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(inputEl.value, ++sequence), 220);
  });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActive((activeIndex + 1) % options.length); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActive((activeIndex - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' && activeIndex >= 0 && options[activeIndex]) { event.preventDefault(); options[activeIndex].activate(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); if (typeof onEscape === 'function') onEscape(); }
  });
  return { close };
}

const desktopSearch = createSearch(searchInput, searchResults);
const mobileSearchInput = document.getElementById('mobile-search');
const mobileSearchResults = document.getElementById('mobile-search-results');
const mobileSearchBar = document.getElementById('mobile-search-bar');
const mobileSearchButton = document.getElementById('mobile-search-button');
function openMobileSearch() {
  if (!mobileSearchBar) return;
  mobileSearchBar.hidden = false;
  mobileSearchButton?.setAttribute('aria-expanded', 'true');
  mobileSearchButton?.setAttribute('aria-label', t('Close search'));
  mobileSearchInput?.focus();
}
function closeMobileSearch({ refocus = false } = {}) {
  mobileSearch?.close();
  if (mobileSearchBar) mobileSearchBar.hidden = true;
  mobileSearchButton?.setAttribute('aria-expanded', 'false');
  mobileSearchButton?.setAttribute('aria-label', t('Open search'));
  if (refocus) mobileSearchButton?.focus();
}
const mobileSearch = createSearch(mobileSearchInput, mobileSearchResults, { onEscape: () => closeMobileSearch({ refocus: true }) });
mobileSearchButton?.addEventListener('click', () => {
  if (mobileSearchBar?.hidden) openMobileSearch();
  else closeMobileSearch();
});

function closeNavigation({ refocus = false } = {}) {
  sidebar.classList.add('-translate-x-full');
  backdrop.classList.add('hidden');
  syncDrawerState();
  if (refocus) openNavigationButton?.focus();
}

function openNavigation() {
  sidebar.classList.remove('-translate-x-full');
  backdrop.classList.remove('hidden');
  syncDrawerState();
  // v5.1-E.1: move keyboard focus into the drawer so keyboard users do not
  // keep tabbing behind the backdrop. Focus return stays on close paths.
  const closeButton = document.getElementById('close-navigation');
  (closeButton || sidebar.querySelector('button[data-page]') || sidebar).focus?.();
}

// Mobile drawer focus hygiene: the trigger reports expanded state, Escape
// closes with focus return, and the off-canvas sidebar is inert on mobile
// widths only (it is permanently visible on desktop).
const openNavigationButton = document.getElementById('open-navigation');
const drawerMedia = window.matchMedia('(max-width: 1023px)');
function syncDrawerState() {
  const open = !sidebar.classList.contains('-translate-x-full');
  openNavigationButton?.setAttribute('aria-expanded', String(open));
  sidebar.inert = drawerMedia.matches && !open;
}
if (typeof drawerMedia.addEventListener === 'function') drawerMedia.addEventListener('change', syncDrawerState);
syncDrawerState();

async function navigate(pageName, { updateHash = true } = {}) {
  // v5.1-A.2 first-experience gate: while focused setup is active the full
  // workflow stays hidden — sidebar clicks, hash changes, and back/forward
  // re-show the current setup screen instead of rendering a page.
  if (firstExperienceSession?.active) { firstExperienceSession.reshow(); return; }
  const referenceCharacter = parseKanjiReferenceRoute(pageName);
  // Hash routes may carry a query suffix (e.g. `#review?reviewSessionId=…`
  // from the Immersion hand-off): the route key is the path before '?', the
  // full string stays in the hash so pages can read their parameters.
  const baseName = referenceCharacter ? pageName : String(pageName || '').split('?')[0];
  const page = referenceCharacter ? pageName : (pages[baseName] ? baseName : 'dashboard');
  destroyCharts();
  navigationButtons.forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  closeNavigation();
  // Preserve the incoming route (query included) in the hash when it already
  // resolves to a known page; only fallbacks collapse to the resolved page.
  const hashTarget = referenceCharacter || pages[baseName] ? pageName : page;
  if (updateHash && window.location.hash !== `#${pageName}`) history.pushState(null, '', `#${hashTarget}`);
  if (referenceCharacter) await renderKanjiReferencePage(content, referenceCharacter);
  else await pages[page](content);
  loadSidebarStreak();
  content.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

navigationButtons.forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
document.getElementById('open-navigation').addEventListener('click', openNavigation);
document.getElementById('close-navigation').addEventListener('click', closeNavigation);
backdrop.addEventListener('click', closeNavigation);
window.addEventListener('hashchange', () => navigate(window.location.hash.slice(1), { updateHash: false }));
window.addEventListener('keydown', (event) => { const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName); if (event.key === 'Escape') { desktopSearch?.close(); if (drawerMedia.matches && !sidebar.classList.contains('-translate-x-full')) closeNavigation({ refocus: true }); } if (event.key === '/' && !typing) { event.preventDefault(); searchInput?.focus(); } if (!typing && event.key.toLowerCase() === 'g') { window.__jltGo = true; window.setTimeout(() => { window.__jltGo = false; }, 700); } else if (!typing && window.__jltGo && event.key.toLowerCase() === 'd') { window.__jltGo = false; navigate('dashboard'); } else if (!typing && window.__jltGo && event.key.toLowerCase() === 'r') { window.__jltGo = false; navigate('review'); } });
document.getElementById('export-data')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const backup = await apiRequest('/api/export');
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `nippotrack-backup-${backup.exportedAt.slice(0, 10)}.json`;
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
