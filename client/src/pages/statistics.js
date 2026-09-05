import { apiRequest } from '../api';
import { destroyCharts } from '../chartRegistry';
import { distributionChart, weeklyChart } from '../charts';
import { iconTile } from '../icons';
import { jlptProgressModel } from '../jlptProgress';
import { element, errorState, loadingState, pageHeader } from '../ui';

export async function renderStatistics(container) {
  destroyCharts();
  const content = element('div');
  const progressSlot = element('div', { className: 'mt-5' });
  container.replaceChildren(element('section', {}, [
    pageHeader({
      eyebrow: 'Measure',
      title: 'Statistics',
      description: 'Small, useful signals from your recorded study time—without invented progress scores.'
    }),
    content,
    progressSlot
  ]));
  content.replaceChildren(loadingState('Calculating study statistics…'));
  progressSlot.replaceChildren(loadingState('Loading reference Kanji progress…'));

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

  async function loadProgress() {
    try {
      const payload = await apiRequest('/api/level/progress');
      const model = jlptProgressModel(payload);
      // Hide gracefully on failure, mirroring the Phase 9 estimate section.
      if (!model) {
        progressSlot.replaceChildren();
        return;
      }
      progressSlot.replaceChildren(referenceKanjiProgressPanel(model));
    } catch {
      progressSlot.replaceChildren();
    }
  }

  await load();
  await loadProgress();
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

// Phase 10 — Reference Kanji Progress panel. One compact row per band with
// an explicit "reviewed / reference" numerator and denominator; cumulative
// coverage and the disclaimer travel in the same panel.
function referenceKanjiProgressPanel(model) {
  const rows = model.rows.map((row) => {
    const notes = [];
    if (row.repeated > 0) notes.push(`${row.repeated} reviewed more than once`);
    if (row.unreviewedCollected > 0) notes.push(`${row.unreviewedCollected} collected, not yet reviewed`);
    return element('div', { className: 'jlpt-progress-row' }, [
      element('div', { className: 'flex items-baseline justify-between gap-3' }, [
        element('p', { className: 'text-sm font-semibold text-ink', text: row.band }),
        element('p', { className: 'text-sm tabular-nums text-muted', text: row.countLine })
      ]),
      element('div', {
        className: 'jlpt-progress-track',
        attrs: {
          role: 'progressbar',
          'aria-label': `${row.band} reviewed reference Kanji ${row.reviewed} of ${row.referenceTotal}`,
          'aria-valuemin': '0',
          'aria-valuemax': String(row.referenceTotal),
          'aria-valuenow': String(row.reviewed)
        }
      }, [
        element('div', { className: 'jlpt-progress-fill', attrs: { style: `width: ${row.barPercent}%` } })
      ]),
      ...(notes.length ? [element('p', { className: 'mt-1 text-xs text-muted', text: notes.join(' · ') })] : [])
    ]);
  });
  return element('article', { className: 'surface p-5 sm:p-6' }, [
    element('div', { className: 'flex items-center gap-3' }, [
      iconTile('distribution', { className: 'panel-icon' }),
      element('h2', { className: 'font-semibold text-ink', text: 'Reference Kanji Progress' })
    ]),
    element('p', { className: 'mt-1 text-sm text-muted', text: 'Reviewed kanji counted against the shared reference set — not exam readiness.' }),
    element('div', { className: 'mt-4 grid gap-4' }, rows),
    element('p', { className: 'mt-4 text-sm text-muted', text: `Reference Kanji coverage through each band — ${model.cumulative.map((entry) => entry.line).join(' · ')}` }),
    ...(model.unclassifiedReviewed > 0
      ? [element('p', { className: 'mt-2 text-xs text-muted', text: `${model.unclassifiedReviewed} reviewed kanji have no reference JLPT classification and are excluded from band counts.` })]
      : []),
    element('p', { className: 'mt-3 text-xs text-muted', text: model.limitationLines.join(' ') }),
    element('p', { className: 'mt-1 text-xs text-muted', text: model.disclaimer })
  ]);
}
