import { apiRequest, queryString } from '../api';
import { attachDigitGuard, isValidTargetAmount, TARGET_AMOUNT_ERROR } from '../goalValidation';
import { t } from '../i18n';
import { iconForTitle, iconTile } from '../icons';
import { confirmDialog, debounce, element, emptyState, errorState, field, formatDate,
loadingState, openDialog, pageHeader, paginationControls, searchableMultiSelect, showToast, withGlobalLoading } from '../ui';
import { openEnrollDialog } from './stories.js';

const options = (values, blank = 'Not set') => [{ value: '', label: blank }, ...values.map((value) => ({ value, label: value }))];
const jlpt = options(['N5', 'N4', 'N3', 'N2', 'N1']);
const status = options(['New', 'Learning', 'Familiar', 'Mastered']);
const measureOptions = [
  { value: 'study_minutes', label: 'Study Minutes' },
  { value: 'vocabulary_count', label: 'New vocabulary entries' },
  { value: 'kanji_count', label: 'New kanji' },
  { value: 'grammar_count', label: 'New grammar entries' }
];
const periodOptions = [
  { value: 'weekly', label: 'Current week' },
  { value: 'cumulative', label: 'From start date onward' },
  { value: 'by_deadline', label: 'From start date to deadline' }
];
// Stored period enum values are unchanged; only display labels were
// clarified. Helpers mirror the backend counting windows exactly:
// weekly counts from the start of the current week, cumulative from the
// start date (up to the deadline when one is set), by_deadline between
// the start date and the required deadline.
const PERIOD_HELPERS = {
  weekly: 'Counts matching activity from the start of the current week.',
  cumulative: 'Counts matching activity from the selected start date onward (up to the deadline, if one is set).',
  by_deadline: 'Counts matching activity between the start date and deadline.'
};
// Target Amount contract lives in ../goalValidation (DOM-free and
// unit-tested): whole numbers 1–999, never silently clamped.
const measureLabels = Object.fromEntries(measureOptions.map(({ value, label }) => [value, label]));
const periodLabels = Object.fromEntries(periodOptions.map(({ value, label }) => [value, label]));
// Stored note categories use compact values; display the human-readable label.
function noteCategoryLabel(category) {
  if (category === 'JapaneseQuestion') return 'Japanese question';
  return category;
}
const sharedLinkGroups = ['sessions', 'vocabulary', 'kanji', 'grammar'];

export const CONFIGS = {
  goals: {
    endpoint: '/api/goals', id: 'id_goal', eyebrow: 'Plan', title: 'Goals', singular: 'goal', description: 'Set measurable targets; progress is calculated from your real records.', emptyDescription: 'Goals help you turn study intentions into measurable targets. Progress updates automatically from your sessions and library entries.',
    fields: [
      { name: 'title', label: 'Title', required: true, maxLength: 120 },
      { name: 'goal_type', label: 'Measure', required: true, options: [{ value: '', label: 'Choose a measure' }, ...measureOptions] },
      { name: 'target_value', label: 'Target amount', type: 'text', required: true, maxLength: 3, inputmode: 'numeric', autocomplete: 'off', description: 'Whole number from 1 to 999 — minutes for Study Minutes, entries otherwise.' },
      { name: 'period_type', label: 'Time period', required: true, options: [{ value: '', label: 'Choose a time period' }, ...periodOptions] },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'due_date', label: 'Due date', type: 'date' },
      { name: 'target_jlpt_level', label: 'Limit counting to JLPT level', description: 'Optional per-goal filter. Leave blank to count every level. Does not change the Target JLPT level in Statistics.', options: jlpt },
      { name: 'target_status', label: 'Only count entries with this status', description: 'Optional. A newly added entry normally starts as New, so it will not count toward Familiar or Mastered.', options: status },
      { name: 'is_active', label: 'Active', editOnly: true, options: [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }] }
    ],
    card: (item) => [
      `${item.progress} / ${item.target_value} ${measureLabels[item.goal_type] || item.goal_type}`,
      `${periodLabels[item.period_type] || item.period_type} · starts ${formatDate(item.start_date)}${item.due_date ? ` · due ${formatDate(item.due_date)}` : ''}${item.target_jlpt_level ? ` · ${item.target_jlpt_level} only` : ''}${item.target_status ? ` · ${item.target_status} only` : ''}`,
      item.isComplete ? 'Complete' : item.is_active ? 'In progress' : 'Inactive'
    ]
  },
  content: {
    endpoint: '/api/content', id: 'id_content_entry', eyebrow: 'Log', title: 'Content Log', singular: 'content entry', description: 'Record what you watched, read, listened to, or used for study. Sessions record focused study time.', emptyDescription: 'Content entries record the Japanese media or conversations you spend time with, so you can remember what you studied and how it felt.',
    linkGroups: ['sessions'],
    // Stories link to study sessions from the Content Log UX (user-approved
    // V5.6 addition). Backend link endpoints, relation tables, and stored
    // relationships are fully preserved.
    fields: [
      { name: 'title', label: 'Title', required: true, maxLength: 255 },
      { name: 'content_type', label: 'Type', required: true, options: options(['Anime', 'Manga', 'Book', 'Article', 'YouTube', 'Podcast', 'Game', 'Conversation'], 'Choose a type') },
      { name: 'content_date', label: 'Date', type: 'date', required: true },
      { name: 'perceived_difficulty', label: 'Difficulty (1–5)', type: 'number' },
      { name: 'comprehension_percent', label: 'Comprehension %', type: 'number' },
      { name: 'new_words_count', label: 'New words', type: 'number' },
      { name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, wide: true }
    ],
    card: (item) => [
      `${item.content_type} · ${formatDate(item.content_date)}`,
      [item.perceived_difficulty ? `Difficulty ${item.perceived_difficulty}/5` : null, item.comprehension_percent !== null ? `${item.comprehension_percent}% understood` : null, item.new_words_count !== null ? `${item.new_words_count} new words` : null].filter(Boolean).join(' · '),
      item.notes ? [item.notes] : []
    ]
  },
  notes: {
    endpoint: '/api/notes', id: 'id_note', eyebrow: 'Capture', title: 'Notes', singular: 'note', description: 'Save questions, corrections, resources and free-form study notes.', emptyDescription: 'Notes give you a place to keep explanations, questions, corrections and useful resources outside a single vocabulary or grammar entry.',
    // Manual vocabulary/kanji/grammar linking is hidden from the normal
    // Notes UX; session linking stays. Backend link endpoints, relation
    // tables, and stored relationships are fully preserved.
    linkGroups: ['sessions'],
    fields: [
      { name: 'title', label: 'Title', maxLength: 150 },
      { name: 'category', label: 'Category', required: true, options: [{ value: '', label: 'Choose a category' }, { value: 'Grammar', label: 'Grammar' }, { value: 'Vocabulary', label: 'Vocabulary' }, { value: 'JapaneseQuestion', label: 'Japanese question' }, { value: 'Correction', label: 'Correction' }, { value: 'Resource', label: 'Resource' }, { value: 'General', label: 'General' }] },
      { name: 'body', label: 'Note', type: 'textarea', required: true, maxLength: 10000, wide: true }
    ],
    card: (item) => [noteCategoryLabel(item.category), item.body, item.updated_at ? `Updated ${formatDate(item.updated_at)}` : '']
  },
  tags: {
    endpoint: '/api/tags', id: 'id_tag', eyebrow: 'Organize', title: 'Tags', singular: 'tag', description: 'Create reusable labels for the V2 relationship features.', emptyDescription: 'Tags are short reusable labels—such as “Genki”, “N5” or “travel”—that will help you group and find related study records as relationships are added.',
    linkGroups: sharedLinkGroups,
    fields: [{ name: 'name', label: 'Name', required: true, maxLength: 60 }],
    card: (item) => [item.normalized_name, '', '']
  }
};

function formFields(config, record = {}) {
  return config.fields.filter((definition) => !definition.editOnly || record[config.id]).map((definition) => {
    const control = field({ ...definition, value: record[definition.name] ?? (definition.name === 'is_active' ? '1' : '') });
    if (definition.wide) control.classList.add('sm:col-span-2');
    const input = control.querySelector('input');
    if (input && definition.name === 'comprehension_percent') { input.min = '0'; input.max = '100'; }
    if (input && definition.name === 'perceived_difficulty') { input.min = '1'; input.max = '5'; }
    if (input && definition.name === 'new_words_count') input.min = '0';
    return control;
  });
}

function payload(form, config) {
  const data = new FormData(form);
  return Object.fromEntries(config.fields.filter(({ name }) => form.elements[name]).map(({ name }) => [name, data.get(name) ?? '']));
}

function selectedNumbers(select) {
  return Array.from(select.selectedOptions, (option) => Number(option.value));
}

function linkOption(kind, item) {
  if (kind === 'sessions') return { value: item.id_session, label: `${item.category} · ${formatDate(item.session_date)}`, chipLabel: `${item.category} · ${formatDate(item.session_date)}`, meta: `${item.duration_minutes} min`, description: item.resource || 'No resource recorded' };
  if (kind === 'vocabulary') return { value: item.id_vocabulary, label: item.word, chipLabel: item.word, meta: item.reading || '', description: item.meaning };
  if (kind === 'kanji') return { value: item.id_kanji, label: item.character_kanji, chipLabel: item.character_kanji, description: item.meaning };
  return { value: item.id_grammar, label: item.grammar_point, chipLabel: item.grammar_point, description: item.meaning };
}

async function loadLinkOptions(kind) {
  if (kind === 'sessions') return (await apiRequest('/api/sessions?limit=100')).items.map((item) => linkOption(kind, item));
  const data = await apiRequest(`/api/${kind}/options?limit=100`);
  return data.items.map((item) => linkOption(kind, item));
}

function mergeLinkOptions(options, linked, kind) {
  const merged = new Map(options.map((option) => [String(option.value), option]));
  linked.forEach((item) => {
    const option = linkOption(kind, item);
    if (!merged.has(String(option.value))) merged.set(String(option.value), option);
  });
  return Array.from(merged.values());
}

export function renderV2Page(container, kind) {
  const config = CONFIGS[kind];
  const addButton = element('button', { className: 'button-primary', text: `Add ${config.singular}`, attrs: { type: 'button' } });
  const search = element('input', { className: 'field-control max-w-md', attrs: { type: 'search', placeholder: `Search ${config.title.toLowerCase()}…`, 'aria-label': `Search ${config.title}` } });
  const records = element('div');
  let page = 1;

  container.replaceChildren(element('section', {}, [
    pageHeader({ eyebrow: config.eyebrow, title: config.title, description: config.description, action: addButton }),
    search,
    element('div', { className: 'mt-5' }, [records])
  ]));

  function openRecord(record = null) {
    const fields = formFields(config, record || {});
    // Goals-only helpers: a dynamic period explanation plus hiding the
    // due-date field for weekly goals (the backend weekly window ignores
    // due dates). Hidden fields still submit, so stored data is preserved.
    if (kind === 'goals') attachGoalHelpers(fields);
    // Stories live inside the Content Log: source URL + pasted text ride
    // along with the generic fields and submit through the same endpoint.
    if (kind === 'content') {
      fields.push(
        field({ name: 'source_url', label: 'Source URL (optional)', value: record?.source_url || '', maxLength: 2000 }),
        field({ name: 'source_text', label: 'Source text (optional, up to 5000 characters)', type: 'textarea', value: record?.source_text || '', maxLength: 5000 })
      );
    }
    openDialog({ title: `${record ? 'Edit' : 'Add'} ${config.singular}`, content: fields, onSubmit: async (form, close) => {
      if (kind === 'goals') {
        const raw = new FormData(form).get('target_value');
        if (!isValidTargetAmount(raw)) { showToast(TARGET_AMOUNT_ERROR, 'error'); return; }
      }
      const body = payload(form, config);
      if (kind === 'content') {
        const data = new FormData(form);
        body.source_url = data.get('source_url') ?? '';
        body.source_text = data.get('source_text') ?? '';
      }
      await apiRequest(record ? `${config.endpoint}/${record[config.id]}` : config.endpoint, { method: record ? 'PUT' : 'POST', body });
      close(); showToast(`${config.singular} saved.`); await load();
    } });
  }

  // Dynamic per-period helper + weekly due-date hiding for the goal form.
  function attachGoalHelpers(fields) {
    const periodHolder = fields.find((node) => node.querySelector && node.querySelector('select[name="period_type"]'));
    const dueHolder = fields.find((node) => node.querySelector && node.querySelector('input[name="due_date"]'));
    if (!periodHolder) return;
    const periodSelect = periodHolder.querySelector('select[name="period_type"]');
    const helper = element('span', { className: 'text-xs font-normal leading-5 text-muted', text: PERIOD_HELPERS[periodSelect.value] || '' });
    periodHolder.appendChild(helper);
    const sync = () => {
      helper.textContent = t(PERIOD_HELPERS[periodSelect.value] || '');
      if (dueHolder) dueHolder.hidden = periodSelect.value === 'weekly';
    };
    periodSelect.addEventListener('change', sync);
    sync();
    const targetInput = fields
      .map((node) => (node.querySelector ? node.querySelector('input[name="target_value"]') : null))
      .find(Boolean);
    if (targetInput) attachDigitGuard(targetInput, { maxDigits: 3 });
  }

  async function openLinks(record) {
    try {
      // Links need several reads before the dialog can render; the overlay
      // covers the wait and never flashes on fast loads (reveal delay).
      const { linked, optionsByGroup } = await withGlobalLoading(async () => {
        const loaded = await apiRequest(`${config.endpoint}/${record[config.id]}/links`);
        const groups = config.linkGroups || [];
        const options = Object.fromEntries(await Promise.all(groups.map(async (group) => [group, mergeLinkOptions(await loadLinkOptions(group), loaded[group] || [], group)])));
        return { linked: loaded, optionsByGroup: options };
      }, { label: `Loading ${config.singular} links…` });
      const groups = config.linkGroups || [];
      const labels = { sessions: 'Related study sessions', vocabulary: 'Related vocabulary', kanji: 'Related kanji', grammar: 'Related grammar' };
      const linkFields = groups.map((group) => {
        const selector = searchableMultiSelect({ name: group, label: labels[group], options: optionsByGroup[group], value: (linked[group] || []).map((item) => linkOption(group, item).value), placeholder: `Search ${labels[group].toLowerCase()}…`, emptyMessage: `No ${labels[group].toLowerCase()} found.` });
        selector.classList.add('sm:col-span-2');
        return selector;
      });
      openDialog({
        title: `Link ${config.singular}`,
        content: linkFields,
        submitLabel: 'Save links',
        onSubmit: async (form, close) => {
          const body = Object.fromEntries(groups.map((group) => [group, selectedNumbers(form.elements[group])]));
          await apiRequest(`${config.endpoint}/${record[config.id]}/links`, { method: 'PUT', body });
          close(); showToast('Links saved.'); await load();
        }
      });
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function remove(record) {
    confirmDialog({
      title: `Delete ${config.singular}?`,
      description: `This will permanently delete this ${config.singular}. This cannot be undone.`,
      onConfirm: async () => { await apiRequest(`${config.endpoint}/${record[config.id]}`, { method: 'DELETE' }); showToast(`${config.singular} deleted.`); await load(); }
    });
  }

  function card(record) {
    const [meta, detail, footer] = config.card(record);
    const edit = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Edit', attrs: { type: 'button' } }); edit.addEventListener('click', () => openRecord(record));
    const links = config.linkGroups?.length ? element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Links', attrs: { type: 'button' } }) : null;
    links?.addEventListener('click', () => openLinks(record));
    const extract = kind === 'content' ? element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Extract', attrs: { type: 'button', 'aria-label': `Extract linguistic value from ${record.title || 'entry'}` } }) : null;
    if (extract) extract.addEventListener('click', async () => {
      // Cold engine init can take ~30s: visible progress so the click never
      // feels dead. Restored in finally, success or failure.
      const original = extract.textContent;
      extract.disabled = true;
      extract.textContent = 'Extracting…';
      try {
        const result = await apiRequest(`/api/stories/${record[config.id]}/extract`, { method: 'POST' });
        openEnrollDialog(record[config.id], record.title, result?.extracted, {
          sourceText: record.source_text || null,
          sourceUrl: record.source_url || null
        });
      } catch (error) {
        showToast(error?.message || 'Story has no text to extract from.', 'error');
      } finally {
        extract.disabled = false;
        extract.textContent = original;
      }
    });
    const del = element('button', { className: 'button-danger', text: 'Delete', attrs: { type: 'button' } }); del.addEventListener('click', () => remove(record));
    const actions = [links, extract, del, edit].filter(Boolean);
    return element('article', { className: 'surface flex min-h-44 flex-col p-5' }, [
      element('div', { className: 'flex items-start justify-between gap-3' }, [element('div', { className: 'flex min-w-0 items-start gap-3' }, [iconTile(iconForTitle(config.title), { className: 'preview-icon shrink-0' }), element('h2', { className: 'break-words text-lg font-semibold text-ink', text: record.title || record.name })]), element('span', { className: 'status-pill', text: meta })]),
      ...(detail ? [element('p', { className: 'mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: detail })] : []),
      ...(Array.isArray(footer) ? footer.map((line) => element('p', { className: 'mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: line })) : []),
      element('div', { className: 'mt-auto flex items-end justify-start gap-3 pt-5' }, [element('div', { className: 'flex shrink-0 flex-nowrap gap-2' }, actions), ...(Array.isArray(footer) || !footer ? [] : [element('span', { className: footer === 'Complete' ? 'status-pill goal-complete ml-auto' : 'ml-auto text-xs font-semibold text-muted', text: footer })])])
    ]);
  }

  async function load() {
    records.replaceChildren(loadingState(`Loading ${config.title.toLowerCase()}…`));
    try {
      const data = await apiRequest(`${config.endpoint}${queryString({ page, limit: 24, search: search.value })}`);
      if (!data.items.length) records.replaceChildren(emptyState({ title: `No ${config.title.toLowerCase()} yet`, description: config.emptyDescription }));
      else records.replaceChildren(...[element('div', { className: 'grid gap-4 lg:grid-cols-2 xl:grid-cols-3' }, data.items.map(card)), paginationControls(data.pagination, (nextPage) => { page = nextPage; load(); })].filter(Boolean));
    } catch (error) { records.replaceChildren(errorState(error, load)); }
  }
  addButton.addEventListener('click', () => openRecord());
  const debouncedSearch = debounce(() => { page = 1; load(); }, 250);
  search.addEventListener('input', debouncedSearch);
  return load();
}
