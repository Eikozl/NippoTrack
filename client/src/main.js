import './styles.css';
import { destroyCharts } from './charts';
import { apiRequest } from './api';
import { renderDashboard } from './pages/dashboard';
import { ENTITY_CONFIGS, renderEntityPage } from './pages/entityPage';
import { renderSessions } from './pages/sessions';
import { renderStatistics } from './pages/statistics';
import { renderV2Page } from './pages/v2Pages';
import { renderReview } from './pages/review';
import { showToast } from './ui';

const content = document.getElementById('app-content');
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
  statistics: () => renderStatistics(content)
};

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
  content.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

navigationButtons.forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
document.getElementById('open-navigation').addEventListener('click', openNavigation);
document.getElementById('close-navigation').addEventListener('click', closeNavigation);
backdrop.addEventListener('click', closeNavigation);
window.addEventListener('hashchange', () => navigate(window.location.hash.slice(1), { updateHash: false }));
document.getElementById('export-data').addEventListener('click', async (event) => {
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

navigate(window.location.hash.slice(1) || 'dashboard', { updateHash: false });
