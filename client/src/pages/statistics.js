import { apiRequest } from '../api';
import { destroyCharts, distributionChart, weeklyChart } from '../charts';
import { iconTile } from '../icons';
import { element, errorState, loadingState, pageHeader } from '../ui';

export async function renderStatistics(container) {
  destroyCharts();
  const content = element('div');
  container.replaceChildren(element('section', {}, [
    pageHeader({
      eyebrow: 'Measure',
      title: 'Statistics',
      description: 'Small, useful signals from your recorded study time—without invented progress scores.'
    }),
    content
  ]));
  content.replaceChildren(loadingState('Calculating study statistics…'));

  async function load() {
    try {
      const data = await apiRequest('/api/dashboard');
      const activeDays = data.weeklyActivity.filter((item) => Number(item.minutes) > 0).length;
      const categories = data.studyDistribution.filter((item) => Number(item.minutes) > 0).length;
      const weeklyCanvas = element('canvas', { attrs: { 'aria-label': 'Weekly minutes chart', role: 'img' } });
      const distributionCanvas = element('canvas', { attrs: { 'aria-label': 'Category minutes chart', role: 'img' } });

      content.replaceChildren(
        element('div', { className: 'grid gap-4 sm:grid-cols-3' }, [
          summary('week', 'Weekly minutes', data.minutesThisWeek, 'Total recorded this week'),
          summary('sessions', 'Active days', activeDays, 'Days with recorded study'),
          summary('distribution', 'Categories', categories, 'Categories represented')
        ]),
        element('div', { className: 'mt-5 grid gap-5 xl:grid-cols-2' }, [
          chartPanel('activity', 'Last seven days', 'Daily study minutes from real session data.', weeklyCanvas),
          chartPanel('distribution', 'Category balance', 'Recorded minutes grouped by study category.', distributionCanvas)
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

function summary(iconName, label, value, note) {
  return element('article', { className: 'surface p-5' }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'metric-icon' }), element('p', { className: 'text-sm font-medium text-muted', text: label })]),
    element('p', { className: 'mt-2 text-3xl font-semibold text-ink', text: value }),
    element('p', { className: 'mt-2 text-xs text-muted', text: note })
  ]);
}

function chartPanel(iconName, title, description, canvas) {
  return element('article', { className: 'surface min-h-96 p-5 sm:p-6' }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: title })]),
    element('p', { className: 'mt-1 text-sm text-muted', text: description }),
    element('div', { className: 'mt-6 h-72' }, [canvas])
  ]);
}
