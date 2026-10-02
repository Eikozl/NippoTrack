// V5.3a Smart Goals — dashboard widget + settings section (vanilla JS).
// Both are self-loading and fail-open: any API trouble hides the widget /
// shows a muted note in settings, never blocking the host page. The backend
// owns every computation (heuristic engine in server/src/services/smartGoals.js);
// this module renders GET /api/goals/smart and saves PUT .../preferences.

import { apiRequest } from './api';
import { element, showToast } from './ui';

const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

export function smartGoalsWidget() {
  const wrap = element('section', { className: 'surface mt-5 p-5 sm:p-6', attrs: { 'aria-label': 'Smart goals' } });
  wrap.hidden = true;
  (async () => {
    try {
      const data = await apiRequest('/api/goals/smart');
      const goal = Number(data?.weeklyGoal || 0);
      const progress = Number(data?.weeklyProgress || 0);
      const percent = goal ? Math.min(100, Math.round((progress / goal) * 100)) : 0;
      const prediction = data?.prediction || {};
      const microGoals = Array.isArray(data?.microGoals) ? data.microGoals : [];
      wrap.replaceChildren(
        element('h2', { className: 'font-semibold text-ink', text: 'Smart goals' }),
        element('p', {
          className: 'mt-1 text-sm text-muted',
          text: `This week: ${progress} of ${goal} reviews · ${percent}%${Number(data?.autoAdjust ? data.preferences?.autoAdjust : data.preferences?.autoAdjust) ? ' · auto-adjust on' : ''}`
        }),
        element('div', { className: 'mt-3 h-2 overflow-hidden rounded-full bg-ink/10', attrs: { 'aria-hidden': 'true' } }, [
          element('div', { className: 'h-full rounded-full bg-ink', attrs: { style: `width:${percent}%` } })
        ]),
        element('p', {
          className: 'mt-3 text-sm text-muted',
          text: `Study run: ${Number(data?.streak || 0)} day(s)${Number(data?.graceUsed || 0) ? ' · grace day used' : ''}`
        }),
        ...(prediction.level ? [element('p', {
          className: 'mt-1 text-sm text-muted',
          text: prediction.weeks > 0
            ? `${prediction.level} pace: about ${prediction.weeks} week(s) at your current rate.`
            : `${prediction.level} kanji volume reached.`
        })] : []),
        ...(microGoals.length ? [element('ul', { className: 'mt-3 grid gap-1 text-sm text-muted' }, microGoals.map((microGoal) => element('li', {
          text: `${microGoal.count} ${microGoal.type}${microGoal.level ? ` (${microGoal.level})` : ''} by ${microGoal.deadline}`
        })))] : [])
      );
      wrap.hidden = false;
    } catch { /* fail-open: widget stays hidden */ }
  })();
  return wrap;
}

export function smartGoalsSettingsSection() {
  const wrap = element('section', {
    className: 'settings-section surface max-w-5xl p-5 sm:p-6',
    attrs: { 'aria-labelledby': 'smart-goals-heading' }
  });
  const heading = element('h2', { className: 'settings-title', text: 'Smart goals', attrs: { id: 'smart-goals-heading' } });
  const description = element('p', { className: 'mt-1 text-sm text-muted', text: 'Auto-adjust nudges your weekly review goal ±20% from recent activity. Grace days forgive missed days in your study run.' });
  const status = element('p', { className: 'mt-2 min-h-5 text-sm text-muted', attrs: { 'aria-live': 'polite' }, text: 'Loading smart goals…' });

  const autoToggle = element('input', { className: 'size-4 accent-vermilion', attrs: { type: 'checkbox', name: 'smart-auto-adjust' } });
  const graceSelect = element('select', { className: 'field-control max-w-24', attrs: { name: 'smart-grace-days', 'aria-label': 'Grace days per week' } }, [0, 1, 2].map((days) => element('option', { value: String(days), text: String(days) })));
  const targetSelect = element('select', { className: 'field-control max-w-32', attrs: { name: 'smart-target-jlpt', 'aria-label': 'Smart goal target JLPT' } }, [
    element('option', { value: '', text: 'No target' }),
    ...JLPT_LEVELS.map((level) => element('option', { value: level, text: level }))
  ]);
  const saveButton = element('button', { className: 'button-primary min-h-9 self-start px-4 py-2 text-sm', text: 'Save preferences', attrs: { type: 'button', disabled: '' } });

  (async () => {
    try {
      const data = await apiRequest('/api/goals/smart');
      const preferences = data?.preferences || {};
      autoToggle.checked = preferences.autoAdjust !== false;
      graceSelect.value = String(Number.isInteger(preferences.graceDays) ? preferences.graceDays : 1);
      if (preferences.targetJlpt && JLPT_LEVELS.includes(preferences.targetJlpt)) targetSelect.value = preferences.targetJlpt;
      status.textContent = `Current weekly goal: ${Number(data?.weeklyGoal || 0)} reviews.`;
      saveButton.disabled = false;
    } catch {
      status.textContent = 'Smart goals are unavailable right now.';
    }
  })();

  saveButton.addEventListener('click', () => {
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    apiRequest('/api/goals/smart/preferences', {
      method: 'PUT',
      body: { autoAdjust: Boolean(autoToggle.checked), graceDays: Number(graceSelect.value), targetJlpt: targetSelect.value || null }
    })
      .then(() => {
        status.textContent = '✓ Saved';
        showToast('Smart goal preferences saved.');
      })
      .catch(() => {
        status.textContent = 'Could not save. Please try again.';
        showToast('Unable to save smart goal preferences.', 'error');
      })
      .finally(() => { saveButton.disabled = false; });
  });

  wrap.append(
    heading,
    description,
    element('div', { className: 'mt-4 grid gap-4' }, [
      element('label', { className: 'flex items-center gap-2 text-sm font-medium text-ink', attrs: { for: 'smart-auto-adjust' } }, [autoToggle, element('span', { text: 'Auto-adjust weekly goal' })]),
      element('label', { className: 'grid max-w-56 gap-1 text-sm font-medium text-ink' }, [element('span', { text: 'Grace days per week' }), graceSelect]),
      element('label', { className: 'grid max-w-56 gap-1 text-sm font-medium text-ink' }, [element('span', { text: 'Target JLPT' }), targetSelect]),
      saveButton,
      status
    ])
  );
  return wrap;
}
