import { apiRequest, queryString } from '../api';
import { destroyCharts } from '../charts';
import {
  confirmDialog,
  element,
  emptyState,
  errorState,
  field,
  formatDate,
  loadingState,
  openDialog,
  pageHeader,
  paginationControls,
  searchableMultiSelect,
  showToast
} from '../ui';

const CATEGORIES = ['Grammar', 'Vocabulary', 'Kanji', 'Reading', 'Listening', 'Speaking', 'Writing', 'Mixed'];
const PERIODS = [
  { value: 'all', label: 'All dates' },
  { value: 'today', label: 'Today' },
  { value: 'last-7-days', label: 'Last 7 days' },
  { value: 'this-month', label: 'This month' },
  { value: 'custom', label: 'Custom range' }
];

function inputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function periodQuery(period, customFrom, customTo) {
  const today = new Date();
  const todayValue = inputDate(today);

  if (period === 'today') return { date: todayValue };
  if (period === 'last-7-days') {
    const firstDay = new Date(today);
    firstDay.setDate(firstDay.getDate() - 6);
    return { from: inputDate(firstDay), to: todayValue };
  }
  if (period === 'this-month') {
    return { from: inputDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: todayValue };
  }
  if (period === 'custom') return { from: customFrom, to: customTo };
  return {};
}

function sessionCard(session, onView, onEdit, onDelete) {
  const viewButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'View', attrs: { type: 'button' } });
  const editButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Edit', attrs: { type: 'button' } });
  const deleteButton = element('button', { className: 'button-danger', text: 'Delete', attrs: { type: 'button' } });
  viewButton.addEventListener('click', () => onView(session));
  editButton.addEventListener('click', () => onEdit(session));
  deleteButton.addEventListener('click', () => onDelete(session));

  return element('article', { className: 'surface p-5' }, [
    element('div', { className: 'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between' }, [
      element('div', {}, [
        element('div', { className: 'flex flex-wrap items-center gap-2' }, [
          element('h2', { className: 'font-semibold text-ink', text: session.category }),
          element('span', { className: 'status-pill', text: `${session.duration_minutes} min` })
        ]),
        element('p', { className: 'mt-2 text-sm text-muted', text: formatDate(session.session_date) }),
        element('p', { className: 'mt-3 text-sm text-ink/80', text: session.resource || 'No resource recorded' }),
        ...(session.notes ? [element('p', { className: 'mt-2 line-clamp-2 text-sm leading-6 text-muted', text: session.notes })] : [])
      ]),
      element('div', { className: 'flex shrink-0 gap-2' }, [viewButton, editButton, deleteButton])
    ])
  ]);
}

function selectedNumbers(select) {
  return Array.from(select.selectedOptions, (option) => Number(option.value));
}

function mergeOptions(loadedOptions, selectedRecords, mapRecord) {
  const merged = new Map(loadedOptions.map((option) => [String(option.value), option]));
  selectedRecords.forEach((record) => {
    const option = mapRecord(record);
    if (!merged.has(String(option.value))) merged.set(String(option.value), option);
  });
  return Array.from(merged.values());
}

function vocabularyOption(item) {
  return {
    value: item.id_vocabulary,
    label: item.word,
    chipLabel: item.word,
    meta: [item.reading, item.displayRomaji].filter(Boolean).join(' · '),
    description: item.meaning
  };
}

function kanjiOption(item) {
  const readings = [
    item.onyomi ? `On: ${item.onyomi}` : null,
    item.kunyomi ? `Kun: ${item.kunyomi}` : null,
    item.displayRomaji
  ].filter(Boolean);
  return {
    value: item.id_kanji,
    label: item.character_kanji,
    chipLabel: item.character_kanji,
    meta: readings.join(' · '),
    description: item.meaning
  };
}

function grammarOption(item) {
  return {
    value: item.id_grammar,
    label: item.grammar_point,
    chipLabel: item.grammar_point,
    meta: item.displayRomaji || '',
    description: item.meaning
  };
}

export function renderSessions(container) {
  destroyCharts();
  const pageSize = 20;
  const relationshipLimit = 20;
  let currentPage = 1;
  const addButton = element('button', { className: 'button-primary', text: 'Add session', attrs: { type: 'button' } });
  const category = element('select', { className: 'field-control', attrs: { 'aria-label': 'Filter by category' } }, [
    element('option', { text: 'Any category', attrs: { value: '' } }),
    ...CATEGORIES.map((value) => element('option', { text: value, attrs: { value } }))
  ]);
  const period = element('select', {
    className: 'field-control',
    attrs: { 'aria-label': 'Filter by period', 'aria-controls': 'session-custom-range' }
  }, PERIODS.map(({ value, label }) => element('option', { text: label, attrs: { value } })));
  const fromDate = element('input', { className: 'field-control', attrs: { type: 'date', 'aria-label': 'Filter from date' } });
  const toDate = element('input', { className: 'field-control', attrs: { type: 'date', 'aria-label': 'Filter to date' } });
  const clearButton = element('button', { className: 'button-secondary w-full lg:w-auto', text: 'Clear filters', attrs: { type: 'button' } });
  const customRange = element('div', {
    className: 'mt-4 hidden grid gap-3 border-t border-stone pt-4 sm:grid-cols-2',
    attrs: { id: 'session-custom-range', 'aria-hidden': 'true' }
  }, [
    element('label', { className: 'field' }, [
      element('span', { text: 'From' }),
      fromDate
    ]),
    element('label', { className: 'field' }, [
      element('span', { text: 'To' }),
      toDate
    ])
  ]);
  const results = element('div');

  container.replaceChildren(element('section', {}, [
    pageHeader({
      eyebrow: 'Record',
      title: 'Study sessions',
      description: 'Record focused time and connect it to the material you studied.',
      action: addButton
    }),
    element('div', { className: 'surface mb-5 p-4' }, [
      element('div', { className: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]' }, [
        element('label', { className: 'field' }, [
          element('span', { text: 'Category' }),
          category
        ]),
        element('label', { className: 'field' }, [
          element('span', { text: 'Period' }),
          period
        ]),
        element('div', { className: 'flex items-end sm:col-span-2 lg:col-span-1' }, [clearButton])
      ]),
      customRange
    ]),
    results
  ]));

  function updateCustomRangeVisibility() {
    const visible = period.value === 'custom';
    customRange.classList.toggle('hidden', !visible);
    customRange.setAttribute('aria-hidden', String(!visible));
    period.setAttribute('aria-expanded', String(visible));
  }

  async function load() {
    results.replaceChildren(loadingState('Loading study sessions…'));
    try {
      const dates = periodQuery(period.value, fromDate.value, toDate.value);
      const data = await apiRequest(`/api/sessions${queryString({
        category: category.value,
        page: currentPage,
        limit: pageSize,
        ...dates
      })}`);
      const { items, pagination } = data;
      if (!items.length && currentPage > 1 && pagination.totalPages > 0) {
        currentPage = pagination.totalPages;
        await load();
        return;
      }
      if (!items.length) {
        results.replaceChildren(emptyState({ title: 'No sessions found', description: 'Record a study session or adjust the current filters.' }));
        return;
      }
      const pager = paginationControls(pagination, (pageNumber) => {
        currentPage = pageNumber;
        load();
      });
      results.replaceChildren(
        element('div', { className: 'grid gap-4' }, items.map((session) => sessionCard(session, viewSession, editSession, deleteSession))),
        ...[pager].filter(Boolean)
      );
    } catch (error) {
      results.replaceChildren(errorState(error, load));
    }
  }

  async function loadVocabularyOptions(search = '') {
    const data = await apiRequest(`/api/vocabulary/options${queryString({ search, limit: relationshipLimit })}`);
    return data.items.map(vocabularyOption);
  }

  async function loadKanjiOptions(search = '') {
    const data = await apiRequest(`/api/kanji/options${queryString({ search, limit: relationshipLimit })}`);
    return data.items.map(kanjiOption);
  }

  async function loadGrammarOptions(search = '') {
    const data = await apiRequest(`/api/grammar/options${queryString({ search, limit: relationshipLimit })}`);
    return data.items.map(grammarOption);
  }

  async function loadRelationshipOptions(record) {
    const [vocabulary, kanji, grammar] = await Promise.all([
      loadVocabularyOptions(),
      loadKanjiOptions(),
      loadGrammarOptions()
    ]);
    return {
      vocabulary: mergeOptions(vocabulary, record.vocabulary || [], vocabularyOption),
      kanji: mergeOptions(kanji, record.kanji || [], kanjiOption),
      grammar: mergeOptions(grammar, record.grammar || [], grammarOption)
    };
  }

  async function openSessionDialog(record = {}) {
    addButton.disabled = true;
    const previousLabel = addButton.textContent;
    addButton.textContent = 'Loading…';
    try {
      const options = await loadRelationshipOptions(record);
      let closeDialog;
      const goToLibrary = (page) => {
        closeDialog?.();
        window.location.hash = `#${page}`;
      };
      const formFields = [
        field({ name: 'session_date', label: 'Date', type: 'date', required: true, value: String(record.session_date || '').slice(0, 10) }),
        field({ name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', required: true, value: record.duration_minutes || 30 }),
        field({ name: 'category', label: 'Category', required: true, value: record.category || 'Vocabulary', options: CATEGORIES.map((value) => ({ value, label: value })) }),
        field({ name: 'resource', label: 'Resource', maxLength: 255, value: record.resource || '', placeholder: 'Genki, NHK, conversation…' }),
        field({ name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, value: record.notes || '' }),
        element('section', { className: 'rounded-lg border border-stone bg-paper/40 p-4 sm:col-span-2' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Writing (optional)' }),
          element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Save a structured writing sample with this study session.' }),
          element('div', { className: 'mt-4 grid gap-4 sm:grid-cols-2' }, [
            field({ name: 'writing_title', label: 'Title', maxLength: 150, value: record.writing?.title || '' }),
            field({ name: 'writing_notes', label: 'Writing notes', type: 'textarea', maxLength: 1500, value: record.writing?.notes || '' }),
            element('div', { className: 'sm:col-span-2' }, [field({ name: 'writing_content', label: 'Writing content', type: 'textarea', maxLength: 10000, value: record.writing?.content || '' })])
          ])
        ]),
        searchableMultiSelect({
          name: 'vocabulary_ids',
          label: 'Related vocabulary',
          options: options.vocabulary,
          value: (record.vocabulary || []).map((item) => item.id_vocabulary),
          placeholder: 'Search vocabulary…',
          emptyMessage: 'No vocabulary records yet. Add vocabulary before linking it to this session.',
          createLabel: 'Add vocabulary',
          onCreate: () => goToLibrary('vocabulary'),
          loadOptions: loadVocabularyOptions
        }),
        searchableMultiSelect({
          name: 'kanji_ids',
          label: 'Related kanji',
          options: options.kanji,
          value: (record.kanji || []).map((item) => item.id_kanji),
          placeholder: 'Search kanji…',
          emptyMessage: 'No kanji records yet. Add kanji before linking it to this session.',
          createLabel: 'Add kanji',
          onCreate: () => goToLibrary('kanji'),
          loadOptions: loadKanjiOptions
        }),
        searchableMultiSelect({
          name: 'grammar_ids',
          label: 'Related grammar',
          options: options.grammar,
          value: (record.grammar || []).map((item) => item.id_grammar),
          placeholder: 'Search grammar…',
          emptyMessage: 'No grammar records yet. Add grammar before linking it to this session.',
          createLabel: 'Add grammar',
          onCreate: () => goToLibrary('grammar'),
          loadOptions: loadGrammarOptions
        })
      ];
      formFields[4].classList.add('sm:col-span-2');

      closeDialog = openDialog({
        title: record.id_session ? 'Edit study session' : 'Add study session',
        content: formFields,
        submitLabel: record.id_session ? 'Save changes' : 'Create session',
        onSubmit: async (form, close) => {
          const formData = new FormData(form);
          const payload = {
            session_date: formData.get('session_date'),
            duration_minutes: Number(formData.get('duration_minutes')),
            category: formData.get('category'),
            resource: formData.get('resource'),
            notes: formData.get('notes'),
            vocabulary_ids: selectedNumbers(form.elements.vocabulary_ids),
            kanji_ids: selectedNumbers(form.elements.kanji_ids),
            grammar_ids: selectedNumbers(form.elements.grammar_ids)
          };
          const writing = ['writing_title', 'writing_content', 'writing_notes'].map((name) => formData.get(name));
          if (writing.some((value) => String(value || '').trim())) {
            [payload.writing_title, payload.writing_content, payload.writing_notes] = writing;
          }
          await apiRequest(record.id_session ? `/api/sessions/${record.id_session}` : '/api/sessions', {
            method: record.id_session ? 'PUT' : 'POST',
            body: payload
          });
          close();
          showToast(record.id_session ? 'Study session updated.' : 'Study session created.');
          if (!record.id_session) currentPage = 1;
          await load();
        }
      });
    } catch (error) {
      showToast(error.message || 'Unable to prepare the session form.', 'error');
    } finally {
      addButton.disabled = false;
      addButton.textContent = previousLabel;
    }
  }

  async function editSession(session) {
    try {
      await openSessionDialog(await apiRequest(`/api/sessions/${session.id_session}`));
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function viewSession(session) {
    try {
      const record = await apiRequest(`/api/sessions/${session.id_session}`);
      const relatedList = (title, items, primary, secondary) => element('section', { className: 'rounded-lg border border-stone p-4' }, [
        element('h3', { className: 'font-semibold text-ink', text: title }),
        items.length
          ? element('ul', { className: 'mt-3 grid gap-2' }, items.map((item) => element('li', { className: 'text-sm text-ink/80' }, [
            element('span', { className: 'font-medium text-ink', text: primary(item) }),
            ...(secondary(item) ? [element('span', { className: 'text-muted', text: ` — ${secondary(item)}` })] : [])
          ])))
          : element('p', { className: 'mt-2 text-sm text-muted', text: 'None linked to this session.' })
      ]);
      const details = element('div', { className: 'sm:col-span-2' }, [
        element('dl', { className: 'grid gap-3 text-sm sm:grid-cols-2' }, [
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Date' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDate(record.session_date) })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Duration' }), element('dd', { className: 'mt-1 font-medium text-ink', text: `${record.duration_minutes} minutes` })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Category' }), element('dd', { className: 'mt-1 font-medium text-ink', text: record.category })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Resource' }), element('dd', { className: 'mt-1 font-medium text-ink', text: record.resource || 'Not recorded' })])
        ]),
        ...(record.notes ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Notes' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: record.notes })])] : []),
        ...(record.writing ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: record.writing.title || 'Writing content' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: record.writing.content }), ...(record.writing.notes ? [element('p', { className: 'mt-3 whitespace-pre-wrap text-sm text-muted', text: record.writing.notes })] : [])])] : []),
        element('div', { className: 'mt-5 grid gap-3 sm:grid-cols-3' }, [
          relatedList('Vocabulary', record.vocabulary, (item) => item.word, (item) => item.meaning),
          relatedList('Kanji', record.kanji, (item) => item.character_kanji, (item) => item.meaning),
          relatedList('Grammar', record.grammar, (item) => item.grammar_point, (item) => item.meaning)
        ])
      ]);
      openDialog({ title: 'Study session detail', content: [details], submitLabel: 'Close', onSubmit: async (form, close) => close() });
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function deleteSession(session) {
    confirmDialog({
      title: 'Delete study session?',
      description: 'This will permanently delete the session and its material links. This cannot be undone.',
      onConfirm: async () => { await apiRequest(`/api/sessions/${session.id_session}`, { method: 'DELETE' }); showToast('Study session deleted.'); await load(); }
    });
  }

  addButton.addEventListener('click', () => openSessionDialog());
  const resetAndLoad = () => {
    currentPage = 1;
    load();
  };
  category.addEventListener('change', resetAndLoad);
  period.addEventListener('change', () => {
    updateCustomRangeVisibility();
    resetAndLoad();
  });
  fromDate.addEventListener('change', () => {
    toDate.min = fromDate.value;
    resetAndLoad();
  });
  toDate.addEventListener('change', () => {
    fromDate.max = toDate.value;
    resetAndLoad();
  });
  clearButton.addEventListener('click', () => {
    category.value = '';
    period.value = 'all';
    fromDate.value = '';
    toDate.value = '';
    fromDate.removeAttribute('max');
    toDate.removeAttribute('min');
    updateCustomRangeVisibility();
    resetAndLoad();
  });
  updateCustomRangeVisibility();
  load();
}
