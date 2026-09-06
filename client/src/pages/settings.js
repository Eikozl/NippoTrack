import { apiRequest } from '../api';
import { element, pageHeader, showToast, withPendingAction } from '../ui';
import { getLocale, setLocale } from '../i18n';

export async function renderSettings(container) {
  const current = document.documentElement.dataset.theme || 'light';
  const light = element('button', { className: `theme-option ${current === 'light' ? 'button-primary' : 'button-secondary'}`, text: 'Light mode', attrs: { type: 'button', 'aria-pressed': String(current === 'light') } });
  const dark = element('button', { className: `theme-option ${current === 'dark' ? 'button-primary' : 'button-secondary'}`, text: 'Dark mode', attrs: { type: 'button', 'aria-pressed': String(current === 'dark') } });
  const setTheme = (theme) => { localStorage.setItem('jlt-theme', theme); document.documentElement.dataset.theme = theme; window.dispatchEvent(new CustomEvent('jlt-theme-change', { detail: theme })); showToast(`${theme === 'dark' ? 'Dark' : 'Light'} theme selected.`); renderSettings(container); };
  light.addEventListener('click', () => setTheme('light'));
  dark.addEventListener('click', () => setTheme('dark'));
  const locale = getLocale();
  const english = element('button', { className: `theme-option ${locale === 'en' ? 'button-primary' : 'button-secondary'}`, text: 'English', attrs: { type: 'button', 'aria-pressed': String(locale === 'en') } });
  const spanish = element('button', { className: `theme-option ${locale === 'es' ? 'button-primary' : 'button-secondary'}`, text: 'Spanish', attrs: { type: 'button', 'aria-pressed': String(locale === 'es') } });
  english.addEventListener('click', () => setLocale('en'));
  spanish.addEventListener('click', () => setLocale('es'));
  const exportButton = element('button', { className: 'button-secondary mt-5', text: 'Export backup', attrs: { type: 'button' } });
  exportButton.addEventListener('click', () => {
    withPendingAction(exportButton, async () => {
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
    }, { pendingLabel: 'Preparing…' }).catch((error) => {
      showToast(error.message || 'Unable to export backup.', 'error');
    });
  });
  container.replaceChildren(element('section', {}, [
    pageHeader({ eyebrow: 'Preferences', title: 'Settings', description: 'Personal interface preferences stored only in this browser.' }),
    element('article', { className: 'surface max-w-5xl p-6' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: 'Appearance' }),
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: 'Choose a deliberate light or dark neumorphic surface. Your choice is remembered locally.' }),
      element('div', { className: 'mt-5 flex flex-wrap gap-3' }, [light, dark])
    ]),
    element('article', { className: 'surface mt-5 max-w-5xl p-6' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: 'Language' }),
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: 'Choose the interface language. Study content, Japanese text, and your own entries are never translated.' }),
      element('div', { className: 'mt-5 flex flex-wrap gap-3' }, [english, spanish])
    ]),
    element('article', { className: 'surface mt-5 max-w-5xl p-6' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: 'Study loop' }),
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: 'A simple cycle for building consistent study habits: study, record what you learned, review it later, and measure your progress over time.' }),
      exportButton
    ]),
    element('article', { className: 'surface mt-5 max-w-5xl p-6' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: 'Data sources' }),
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: 'JLPT reference data provided in part by OpenJLPT and its upstream sources.' }),
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: 'JLPT classifications are community/reference data and are not an official JLPT syllabus.' }),
      element('a', {
        className: 'mt-4 inline-flex text-sm font-semibold text-vermilion transition hover:text-vermilion-dark',
        text: 'Third-Party Notices',
        attrs: {
          href: 'https://github.com/Eikozl/Japanese-Learning-Tracker/blob/dddabb5/THIRD_PARTY_NOTICES.md',
          target: '_blank',
          rel: 'noreferrer'
        }
      })
    ]),
    element('article', { className: 'surface mt-5 max-w-5xl p-6' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: 'Keyboard shortcuts' }),
      element('dl', { className: 'mt-4 grid gap-3 text-sm sm:grid-cols-2' }, [
        element('div', {}, [element('dt', { className: 'font-semibold text-ink', text: '/' }), element('dd', { className: 'mt-1 text-muted', text: 'Focus global search' })]),
        element('div', {}, [element('dt', { className: 'font-semibold text-ink', text: 'Esc' }), element('dd', { className: 'mt-1 text-muted', text: 'Close search or dialog' })]),
        element('div', {}, [element('dt', { className: 'font-semibold text-ink', text: 'G + D' }), element('dd', { className: 'mt-1 text-muted', text: 'Open Dashboard' })]),
        element('div', {}, [element('dt', { className: 'font-semibold text-ink', text: 'G + R' }), element('dd', { className: 'mt-1 text-muted', text: 'Open Review' })])
      ])
    ])
  ]));
}
