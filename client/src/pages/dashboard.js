import { apiRequest } from '../api';
import { destroyCharts, distributionChart, weeklyChart } from '../charts';
import { element, errorState, formatDate, loadingState, pageHeader } from '../ui';

function metric(label, value, note) {
  return element('article', { className: 'surface p-5' }, [
    element('p', { className: 'text-xs font-semibold uppercase tracking-[0.13em] text-muted', text: label }),
    element('p', { className: 'mt-3 text-3xl font-semibold tracking-tight text-ink', text: value }),
    element('p', { className: 'mt-2 text-xs text-muted', text: note })
  ]);
}

function chartCard(title, description, canvas) {
  return element('article', { className: 'surface min-h-88 p-5 sm:p-6' }, [
    element('h2', { className: 'font-semibold text-ink', text: title }),
    element('p', { className: 'mt-1 text-sm text-muted', text: description }),
    element('div', { className: 'mt-6 h-64' }, [canvas])
  ]);
}

function recentSessions(items) {
  const body = items.length
    ? element('div', { className: 'divide-y divide-stone' }, items.map((session) => element('div', { className: 'flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0' }, [
        element('div', {}, [
          element('p', { className: 'text-sm font-semibold text-ink', text: session.category }),
          element('p', { className: 'mt-1 text-xs text-muted', text: formatDate(session.session_date) })
        ]),
        element('span', { className: 'status-pill', text: `${session.duration_minutes} min` })
      ])))
    : element('p', { className: 'py-10 text-center text-sm text-muted', text: 'No study sessions recorded yet.' });
  return element('article', { className: 'surface p-5 sm:p-6' }, [
    element('h2', { className: 'font-semibold text-ink', text: 'Recent sessions' }),
    element('p', { className: 'mt-1 text-sm text-muted', text: 'Your latest recorded study activity.' }),
    element('div', { className: 'mt-6' }, [body])
  ]);
}

export async function renderDashboard(container) {
  destroyCharts();
  const content = element('div');
  container.replaceChildren(element('section', {}, [
    pageHeader({
      eyebrow: 'Overview',
      title: 'Dashboard',
      description: 'A calm snapshot of your current Japanese study activity.'
    }),
    content
  ]));
  content.replaceChildren(loadingState('Loading your study overview…'));

  async function load() {
    try {
      const data = await apiRequest('/api/dashboard');
      const weeklyCanvas = element('canvas', { attrs: { 'aria-label': 'Weekly study activity chart', role: 'img' } });
      const distributionCanvas = element('canvas', { attrs: { 'aria-label': 'Study category distribution chart', role: 'img' } });
      content.replaceChildren(
        element('div', { className: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-5' }, [
          metric('Today', data.minutesToday, 'minutes studied'),
          metric('This week', data.minutesThisWeek, 'minutes studied'),
          metric('Vocabulary', data.vocabularyCount, 'saved words'),
          metric('Kanji', data.kanjiCount, 'tracked characters'),
          metric('Grammar', data.grammarCount, 'saved patterns')
        ]),
        element('div', { className: 'mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]' }, [
          chartCard('Weekly activity', 'Minutes recorded over the last seven days.', weeklyCanvas),
          recentSessions(data.recentSessions)
        ]),
        element('div', { className: 'mt-5 max-w-2xl' }, [
          chartCard('Study distribution', 'How recorded minutes are distributed by category.', distributionCanvas)
        ])
      );
      weeklyChart(weeklyCanvas, data.weeklyActivity);
      distributionChart(distributionCanvas, data.studyDistribution);
    } catch (error) {
      content.replaceChildren(errorState(error, load));
    }
  }

  await load();
}
