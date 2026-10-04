// V5.4 Weekly insights — dashboard widget (vanilla JS). Self-loading and
// fail-open like smartGoalsWidget: any API trouble hides the widget, never
// blocking the dashboard. The backend owns every computation
// (server/src/services/weeklyInsights.js); this module renders
// GET /api/insights/weekly.

import { apiRequest } from './api';
import { element } from './ui';

export function weeklyInsightsWidget() {
  const wrap = element('section', { className: 'surface mt-5 p-5 sm:p-6', attrs: { 'aria-label': 'Weekly insights' } });
  wrap.hidden = true;
  (async () => {
    try {
      const data = await apiRequest('/api/insights/weekly');
      const summary = data?.summary || {};
      const predictions = data?.predictions || {};
      const jlpt = predictions.jlpt || {};
      const strengths = Array.isArray(data?.strengths) ? data.strengths : [];
      const weaknesses = Array.isArray(data?.weaknesses) ? data.weaknesses : [];
      const anomalies = Array.isArray(data?.anomalies) ? data.anomalies : [];
      const microGoals = Array.isArray(data?.microGoals) ? data.microGoals : [];
      wrap.replaceChildren(
        element('h2', { className: 'font-semibold text-ink', text: 'Weekly insights' }),
        element('p', {
          className: 'mt-1 text-sm text-muted',
          text: `${Number(summary.totalReviews || 0)} reviews · ${Number(summary.totalMinutes || 0)} minutes · run of ${Number(summary.streak || 0)} day(s)`
        }),
        ...(weaknesses.length ? [element('ul', { className: 'mt-3 grid gap-1 text-sm text-ink', attrs: { role: 'list' } }, weaknesses.map((weakness) => element('li', { text: `Focus: ${weakness.label}` })))] : []),
        ...(strengths.length ? [element('ul', { className: 'mt-2 grid gap-1 text-sm text-muted', attrs: { role: 'list' } }, strengths.map((strength) => element('li', { text: `Strong: ${strength.label}` })))] : []),
        ...(anomalies.length ? [element('ul', { className: 'mt-2 grid gap-1 text-sm font-medium text-ink', attrs: { role: 'list' } }, anomalies.map((anomaly) => element('li', { text: anomaly.message })))] : []),
        ...(jlpt.level ? [element('p', {
          className: 'mt-3 text-sm text-muted',
          text: jlpt.weeks > 0
            ? `${jlpt.level} pace: about ${jlpt.weeks} week(s) at your current rate.`
            : `${jlpt.level} kanji volume reached.`
        })] : []),
        ...(microGoals.length ? [element('ul', { className: 'mt-2 grid gap-1 text-sm text-muted' }, microGoals.map((microGoal) => element('li', {
          text: `${microGoal.count} ${microGoal.type}${microGoal.level ? ` (${microGoal.level})` : ''} by ${microGoal.deadline}`
        })))] : [])
      );
      wrap.hidden = false;
    } catch { /* fail-open: widget stays hidden */ }
  })();
  return wrap;
}
