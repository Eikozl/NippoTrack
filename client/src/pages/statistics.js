import { apiRequest } from '../api';
import { destroyCharts } from '../chartRegistry';
import { distributionChart, weeklyChart } from '../charts';
import { iconTile } from '../icons';
import { jlptProgressModel } from '../jlptProgress';
import { estimateTargetLine, targetContextLine, targetLevelOptions } from '../jlptTarget';
import { element, errorState, loadingState, pageHeader } from '../ui';

export async function renderStatistics(container) {
  destroyCharts();
  const content = element('div');
  const progressSlot = element('div', { className: 'mt-5' });
  container.replaceChildren(element('section', {}, [
    pageHeader({
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
      // Non-visual equivalents for the canvas charts: concise summaries from
      // the same data, referenced via aria-describedby. No visible tables —
      // the numbers on screen stay the single visual source.
      const weeklySummary = element('p', { className: 'visually-hidden', attrs: { id: 'weekly-chart-summary' }, text: describeWeeklyActivity(data.weeklyActivity) });
      const distributionSummary = element('p', { className: 'visually-hidden', attrs: { id: 'distribution-chart-summary' }, text: describeDistribution(data.studyDistribution) });
      const weeklyCanvas = element('canvas', { attrs: { 'aria-label': 'Weekly minutes chart', role: 'img', 'aria-describedby': 'weekly-chart-summary' } });
      const distributionCanvas = element('canvas', { attrs: { 'aria-label': 'Category minutes chart', role: 'img', 'aria-describedby': 'distribution-chart-summary' } });

      content.replaceChildren(
        element('div', { className: 'grid gap-4 sm:grid-cols-3' }, [
          summary('week', 'Weekly minutes', data.minutesThisWeek, 'Total recorded this week'),
          summary('sessions', 'Active days', activeDays, 'Days with recorded study'),
          summary('distribution', 'Categories', categories, 'Categories represented')
        ]),
        element('div', { className: 'mt-5 grid gap-5 xl:grid-cols-2' }, [
          chartPanel('activity', 'Last seven days', 'Daily study minutes from real session data.', weeklyCanvas, weeklySummary),
          chartPanel('distribution', 'Category balance', 'Recorded minutes grouped by study category.', distributionCanvas, distributionSummary)
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
      const [progressPayload, targetPayload, estimatePayload] = await Promise.all([
        apiRequest('/api/level/progress'),
        apiRequest('/api/level/target'),
        apiRequest('/api/level/estimate')
      ]);
      const model = jlptProgressModel(progressPayload);
      // A failed or unusable progress load stays visible with a retry —
      // the panel must never silently disappear.
      if (!model) {
        progressSlot.replaceChildren(errorState(new Error('Reference Kanji progress is unavailable right now.'), loadProgress));
        return;
      }
      const target = targetPayload && typeof targetPayload.targetLevel === 'string'
        ? targetPayload.targetLevel
        : null;
      const estimateLevel = estimatePayload && estimatePayload.estimate
        ? estimatePayload.estimate.level
        : null;
      progressSlot.replaceChildren(referenceKanjiProgressPanel(model, {
        target,
        estimateLevel,
        onSelect: async (next) => {
          const saved = await apiRequest('/api/level/target', {
            method: 'PUT',
            body: { target_level: next }
          });
          return saved && typeof saved.targetLevel === 'string' ? saved.targetLevel : null;
        }
      }));
    } catch (error) {
      progressSlot.replaceChildren(errorState(error, loadProgress));
    }
  }

  await load();
  await loadProgress();
}

function summary(iconName, label, value, note) {
  return element('article', { className: 'surface p-5' }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'metric-icon' }), element('p', { className: 'text-sm font-medium text-muted', text: label })]),
    element('p', { className: 'mt-2 font-display text-3xl font-semibold text-ink', text: value }),
    element('p', { className: 'mt-2 text-xs text-muted', text: note })
  ]);
}

function chartPanel(iconName, title, description, canvas, summary = null) {
  return element('article', { className: 'surface min-h-96 p-5 sm:p-6' }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: title })]),
    element('p', { className: 'mt-1 text-sm text-muted', text: description }),
    element('div', { className: 'mt-6 h-72' }, [canvas]),
    summary
  ]);
}

function describeWeeklyActivity(weeklyActivity) {
  const days = Array.isArray(weeklyActivity) ? weeklyActivity : [];
  const total = days.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  const active = days.filter((item) => Number(item.minutes) > 0);
  if (!active.length) return 'Weekly minutes chart: no study minutes recorded in the last seven days.';
  const peak = active.reduce((best, item) => (Number(item.minutes) > Number(best.minutes) ? item : best), active[0]);
  return `Weekly minutes chart: ${total} minutes across ${active.length} active days in the last seven days. Most active: ${String(peak.date).slice(0, 10)} with ${Number(peak.minutes)} minutes.`;
}

function describeDistribution(studyDistribution) {
  const entries = Array.isArray(studyDistribution) ? studyDistribution.filter((item) => Number(item.minutes) > 0) : [];
  const total = entries.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  if (!entries.length) return 'Category balance chart: no categorized study minutes recorded.';
  const top = entries.reduce((best, item) => (Number(item.minutes) > Number(best.minutes) ? item : best), entries[0]);
  return `Category balance chart: ${total} minutes across ${entries.length} categories. Largest: ${top.category} with ${Number(top.minutes)} minutes.`;
}

// Phase 10 — Reference Kanji Progress panel. One compact row per band with
// an explicit "reviewed / reference" numerator and denominator; cumulative
// coverage and the disclaimer travel in the same panel.
// Phase 11 — the panel also hosts the "Target JLPT level" selector, which
// only highlights the matching cumulative progress (already-loaded data,
// no refetch) and never mutates study state.
function referenceKanjiProgressPanel(model, targetState = {}) {
  let currentTarget = typeof targetState.target === 'string' ? targetState.target : null;
  const estimateLevel = typeof targetState.estimateLevel === 'string' ? targetState.estimateLevel : null;
  const cumulativeByBand = Object.fromEntries(model.cumulative.map((entry) => [entry.band, entry]));
  const contextLine = element('p', {
    className: 'mt-2 text-sm text-muted',
    text: targetContextLine(currentTarget, cumulativeByBand[currentTarget]) || 'Choose a reference level when you have a JLPT study goal.'
  });
  const comparisonLine = element('p', {
    className: 'mt-2 text-sm text-muted',
    text: estimateTargetLine(estimateLevel, currentTarget) || ''
  });
  const saveError = element('p', { className: 'mt-1 hidden text-xs text-red-700', text: '' });
  const select = element('select', {
    className: 'field-control mt-2 max-w-56',
    attrs: { id: 'target-jlpt-level', 'aria-label': 'Target JLPT level' }
  }, targetLevelOptions().map((option) => element('option', {
    attrs: { value: option.value, ...(option.value === (currentTarget || '') ? { selected: 'selected' } : {}) },
    text: option.label
  })));
  select.addEventListener('change', async () => {
    const previous = currentTarget;
    const next = select.value === '' ? null : select.value;
    saveError.classList.add('hidden');
    try {
      const saved = targetState.onSelect ? await targetState.onSelect(next) : next;
      currentTarget = saved === null ? null : saved;
      contextLine.textContent = targetContextLine(currentTarget, cumulativeByBand[currentTarget])
        || 'Choose a reference level when you have a JLPT study goal.';
      comparisonLine.textContent = estimateTargetLine(estimateLevel, currentTarget) || '';
    } catch {
      select.value = previous || '';
      saveError.textContent = 'Could not save the target level. Please try again.';
      saveError.classList.remove('hidden');
    }
  });
  const targetBlock = element('div', { className: 'mt-4 border-t border-stone pt-4' }, [
    element('label', { className: 'text-sm font-semibold text-ink', attrs: { for: 'target-jlpt-level' }, text: 'Target JLPT level' }),
    element('p', { className: 'mt-1 text-xs text-muted', text: 'Your study goal — not your current level. Changing it only highlights different progress; it never changes your data.' }),
    select,
    saveError,
    contextLine,
    comparisonLine
  ]);
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
    // Permanent honesty line: the essential meaning stays visible next to
    // the coverage data; the longer explanation collapses below.
    element('p', { className: 'mt-1 text-sm text-muted', text: 'Reference Kanji coverage only — not official JLPT exam readiness.' }),
    element('div', { className: 'mt-4 grid gap-4' }, rows),
    element('details', { className: 'jlpt-progress-details' }, [
      element('summary', { text: 'How this coverage is calculated' }),
      element('p', { className: 'mt-3 text-sm text-muted', text: `Reference Kanji coverage through each band — ${model.cumulative.map((entry) => entry.line).join(' · ')}` }),
      ...(model.unclassifiedReviewed > 0
        ? [element('p', { className: 'mt-2 text-xs text-muted', text: `${model.unclassifiedReviewed} reviewed kanji have no reference JLPT classification and are excluded from band counts.` })]
        : []),
      element('p', { className: 'mt-3 text-xs text-muted', text: model.limitationLines.join(' ') }),
      element('p', { className: 'mt-1 text-xs text-muted', text: model.disclaimer }),
      element('p', { className: 'mt-1 text-xs text-muted', text: 'Review grades set scheduling only — they are not pass/fail certification.' })
    ]),
    targetBlock
  ]);
}
