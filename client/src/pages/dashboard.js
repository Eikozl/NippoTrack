import { apiRequest, queryString } from '../api';
import { destroyCharts, distributionChart, weeklyChart } from '../charts';
import { iconTile } from '../icons';
import { element, errorState, field, formatDate, loadingState, pageHeader, searchableMultiSelect, showToast } from '../ui';

const CATEGORIES = ['Grammar', 'Vocabulary', 'Kanji', 'Reading', 'Listening', 'Speaking', 'Writing', 'Mixed'];
const todayInputValue = () => new Date().toLocaleDateString('en-CA');
const selectedNumbers = (select) => select ? Array.from(select.selectedOptions, (option) => Number(option.value)) : [];

function metric(iconName, label, value, note) {
  return element('article', { className: 'surface metric-card p-5' }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'metric-icon' }), element('p', { className: 'text-xs font-semibold uppercase tracking-[0.13em] text-muted', text: label })]),
    element('p', { className: 'mt-3 text-3xl font-semibold tracking-tight text-ink', text: value }),
    element('p', { className: 'mt-2 text-xs text-muted', text: note })
  ]);
}

function chartCard(iconName, title, description, canvas) {
  return element('article', { className: 'surface chart-card min-h-88 p-5 sm:p-6' }, [
    element('div', { className: 'flex items-center gap-3' }, [iconTile(iconName, { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: title })]),
    element('p', { className: 'mt-1 text-sm text-muted', text: description }),
    element('div', { className: 'mt-6 h-64' }, [canvas])
  ]);
}

function activityCalendar(items) {
  const minutesByDate = new Map(items.map((item) => [String(item.date).slice(0, 10), Number(item.minutes)]));
  const today = new Date();
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (34 - index));
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const minutes = minutesByDate.get(value) || 0;
    return element('div', { className: `activity-calendar-day grid aspect-square place-items-center rounded-md text-xs font-semibold ${minutes ? 'bg-vermilion' : 'bg-paper'}`, text: date.getDate(), attrs: { title: `${formatDate(value)} · ${minutes} minutes` } });
  });
  return element('article', { className: 'surface activity-calendar p-5 sm:p-6' }, [element('div', { className: 'flex items-center gap-3' }, [iconTile('sessions', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Activity calendar' })]), element('p', { className: 'mt-1 text-sm text-muted', text: 'The last 35 days. Highlighted days contain at least one study session.' }), element('div', { className: 'mt-5 grid grid-cols-7 gap-2' }, days)]);
}

function recentSessions(items) {
  const body = items.length ? element('div', { className: 'divide-y divide-stone' }, items.map((session) => element('div', { className: 'flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0' }, [
    element('div', {}, [element('p', { className: 'text-sm font-semibold text-ink', text: session.category }), element('p', { className: 'mt-1 text-xs text-muted', text: formatDate(session.session_date) })]),
    element('span', { className: 'status-pill', text: `${session.duration_minutes} min` })
  ]))) : element('p', { className: 'py-10 text-center text-sm text-muted', text: 'No study sessions recorded yet.' });
  return element('article', { className: 'surface p-5 sm:p-6' }, [element('div', { className: 'flex items-center gap-3' }, [iconTile('recent', { className: 'panel-icon' }), element('h2', { className: 'font-semibold text-ink', text: 'Recent sessions' })]), element('p', { className: 'mt-1 text-sm text-muted', text: 'Your latest recorded study activity.' }), element('div', { className: 'mt-6' }, [body])]);
}

function quickAddPanel(reload) {
  const form = element('form', { className: 'surface quick-add-card mb-5 p-5 sm:p-6' });
  const relationFields = element('div', { className: 'mt-4 grid gap-4 sm:grid-cols-3' });
  const visible = new Set();
  const submit = element('button', { className: 'button-primary shrink-0', text: 'Add session', attrs: { type: 'submit' } });
  const configs = {
    vocabulary: ['Vocabulary', '/api/vocabulary/options', 'vocabulary_ids', (x) => ({ value: x.id_vocabulary, label: x.word, chipLabel: x.word, meta: x.reading || '', description: x.meaning })],
    kanji: ['Kanji', '/api/kanji/options', 'kanji_ids', (x) => ({ value: x.id_kanji, label: x.character_kanji, chipLabel: x.character_kanji, meta: [x.onyomi, x.kunyomi].filter(Boolean).join(' · '), description: x.meaning })],
    grammar: ['Grammar', '/api/grammar/options', 'grammar_ids', (x) => ({ value: x.id_grammar, label: x.grammar_point, chipLabel: x.grammar_point, description: x.meaning })]
  };
  const buttons = Object.entries(configs).map(([key, [label, endpoint, name, map]]) => {
    const button = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: `+ ${label}`, attrs: { type: 'button', 'aria-expanded': 'false' } });
    button.addEventListener('click', async () => {
      if (visible.has(key)) return;
      visible.add(key); button.disabled = true; button.textContent = 'Loading…';
      try {
        const loadOptions = async (search = '') => (await apiRequest(`${endpoint}${queryString({ search, limit: 20 })}`)).items.map(map);
        relationFields.appendChild(searchableMultiSelect({ name, label: `Related ${label.toLowerCase()}`, options: await loadOptions(), placeholder: `Search ${label.toLowerCase()}…`, emptyMessage: `No ${label.toLowerCase()} records yet.`, loadOptions }));
        button.textContent = `${label} added`; button.setAttribute('aria-expanded', 'true');
      } catch (error) {
        visible.delete(key); button.disabled = false; button.textContent = `+ ${label}`; showToast(error.message || `Unable to load ${label.toLowerCase()}.`, 'error');
      }
    });
    return button;
  });
  form.append(
    element('div', { className: 'flex flex-wrap items-center justify-between gap-3' }, [element('div', {}, [element('h2', { className: 'font-semibold text-ink', text: 'Quick add session' }), element('p', { className: 'mt-1 text-sm text-muted', text: 'Record today’s study without opening the full form.' })]), element('span', { className: 'status-pill', text: 'Today' })]),
    element('div', { className: 'mt-5 grid gap-4 sm:grid-cols-3' }, [
      field({ name: 'category', label: 'Category', required: true, value: 'Vocabulary', options: CATEGORIES.map((value) => ({ value, label: value })) }),
      field({ name: 'duration_minutes', label: 'Duration', required: true, value: '30', options: [10, 15, 20, 30, 45, 60, 90, 120].map((value) => ({ value, label: `${value} min` })) }),
      field({ name: 'resource', label: 'Resource', maxLength: 255, placeholder: 'Optional resource' })
    ]),
    element('div', { className: 'mt-4' }, [field({ name: 'notes', label: 'Notes (optional)', maxLength: 1500, placeholder: 'What did you study?' })]),
    element('div', { className: 'mt-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between' }, [element('div', {}, [element('p', { className: 'text-sm font-medium text-ink', text: 'Related to' }), element('div', { className: 'mt-2 flex flex-wrap gap-2' }, buttons)]), submit]),
    relationFields
  );
  const quickAddHeading = form.firstElementChild?.firstElementChild;
  quickAddHeading?.classList.add('flex', 'items-start', 'gap-3');
  quickAddHeading?.prepend(iconTile('quickAdd', { className: 'panel-icon shrink-0' }));
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; submit.textContent = 'Adding…';
    try {
      const data = new FormData(form);
      await apiRequest('/api/sessions', { method: 'POST', body: { session_date: todayInputValue(), category: data.get('category'), duration_minutes: Number(data.get('duration_minutes')), resource: data.get('resource'), notes: data.get('notes'), vocabulary_ids: selectedNumbers(form.elements.vocabulary_ids), kanji_ids: selectedNumbers(form.elements.kanji_ids), grammar_ids: selectedNumbers(form.elements.grammar_ids) } });
      showToast('Study session recorded.'); window.dispatchEvent(new Event('jlt-data-change')); await reload();
    } catch (error) { showToast(error.message || 'Unable to record the session.', 'error'); submit.disabled = false; submit.textContent = 'Add session'; }
  });
  return form;
}

export async function renderDashboard(container) {
  destroyCharts();
  const content = element('div');
  container.replaceChildren(element('section', {}, [pageHeader({ eyebrow: 'Overview', title: 'Dashboard', description: 'A calm snapshot of your current Japanese study activity.' }), content]));
  content.replaceChildren(loadingState('Loading your study overview…'));
  async function load() {
    try {
      const [data, activity, review] = await Promise.all([apiRequest('/api/dashboard'), apiRequest('/api/dashboard/activity'), apiRequest('/api/review')]);
      const weeklyCanvas = element('canvas', { attrs: { 'aria-label': 'Weekly study activity chart', role: 'img' } });
      const distributionCanvas = element('canvas', { attrs: { 'aria-label': 'Study category distribution chart', role: 'img' } });
      content.replaceChildren(
        quickAddPanel(load),
        element('div', { className: 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4' }, [metric('today', 'Today', data.minutesToday, 'minutes studied'), metric('week', 'This week', data.minutesThisWeek, 'minutes studied'), metric('streak', 'Current streak', activity.currentStreak, 'consecutive active days'), metric('streak', 'Longest streak', activity.longestStreak, 'best run of active days'), metric('review', 'Due reviews', review.items.length, 'items ready to recall'), metric('vocabulary', 'Vocabulary', data.vocabularyCount, 'saved words'), metric('kanji', 'Kanji', data.kanjiCount, 'tracked characters'), metric('grammar', 'Grammar', data.grammarCount, 'saved patterns')]),
        element('div', { className: 'mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.8fr)]' }, [chartCard('activity', 'Weekly activity', 'Minutes recorded over the last seven days.', weeklyCanvas), recentSessions(data.recentSessions)]),
        element('div', { className: 'mt-5 grid gap-5 xl:grid-cols-2' }, [chartCard('distribution', 'Study distribution', 'How recorded minutes are distributed by category.', distributionCanvas), activityCalendar(activity.calendar)])
      );
      weeklyChart(weeklyCanvas, data.weeklyActivity); distributionChart(distributionCanvas, data.studyDistribution);
    } catch (error) { content.replaceChildren(errorState(error, load)); }
  }
  await load();
}
