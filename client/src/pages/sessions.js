import { apiRequest, queryString } from '../api';
import { destroyCharts } from '../charts';
import {
  element,
  emptyState,
  errorState,
  field,
  formatDate,
  loadingState,
  openDialog,
  pageHeader,
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

function sessionCard(session, onEdit, onDelete) {
  const editButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Edit', attrs: { type: 'button' } });
  const deleteButton = element('button', { className: 'button-danger', text: 'Delete', attrs: { type: 'button' } });
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
      element('div', { className: 'flex shrink-0 gap-2' }, [editButton, deleteButton])
    ])
  ]);
}

function selectedNumbers(select) {
  return Array.from(select.selectedOptions, (option) => Number(option.value));
}

export function renderSessions(container) {
  destroyCharts();
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
      const sessions = await apiRequest(`/api/sessions${queryString({
        category: category.value,
        ...dates
      })}`);
      results.replaceChildren(sessions.length
        ? element('div', { className: 'grid gap-4' }, sessions.map((session) => sessionCard(session, editSession, deleteSession)))
        : emptyState({ title: 'No sessions found', description: 'Record a study session or adjust the current filters.' }));
    } catch (error) {
      results.replaceChildren(errorState(error, load));
    }
  }

  async function loadRelationshipOptions() {
    const [vocabulary, kanji, grammar] = await Promise.all([
      apiRequest('/api/vocabulary'),
      apiRequest('/api/kanji'),
      apiRequest('/api/grammar')
    ]);
    return {
      vocabulary: vocabulary.map((item) => ({ value: item.id_vocabulary, label: `${item.word}${item.reading ? ` · ${item.reading}` : ''}` })),
      kanji: kanji.map((item) => ({ value: item.id_kanji, label: `${item.character_kanji} · ${item.meaning}` })),
      grammar: grammar.map((item) => ({ value: item.id_grammar, label: `${item.grammar_point} · ${item.meaning}` }))
    };
  }

  async function openSessionDialog(record = {}) {
    addButton.disabled = true;
    const previousLabel = addButton.textContent;
    addButton.textContent = 'Loading…';
    try {
      const options = await loadRelationshipOptions();
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
        searchableMultiSelect({
          name: 'vocabulary_ids',
          label: 'Related vocabulary',
          options: options.vocabulary,
          value: (record.vocabulary || []).map((item) => item.id_vocabulary),
          placeholder: 'Search vocabulary…',
          emptyMessage: 'No vocabulary records yet. Add vocabulary before linking it to this session.',
          createLabel: 'Add vocabulary',
          onCreate: () => goToLibrary('vocabulary')
        }),
        searchableMultiSelect({
          name: 'kanji_ids',
          label: 'Related kanji',
          options: options.kanji,
          value: (record.kanji || []).map((item) => item.id_kanji),
          placeholder: 'Search kanji…',
          emptyMessage: 'No kanji records yet. Add kanji before linking it to this session.',
          createLabel: 'Add kanji',
          onCreate: () => goToLibrary('kanji')
        }),
        searchableMultiSelect({
          name: 'grammar_ids',
          label: 'Related grammar',
          options: options.grammar,
          value: (record.grammar || []).map((item) => item.id_grammar),
          placeholder: 'Search grammar…',
          emptyMessage: 'No grammar records yet. Add grammar before linking it to this session.',
          createLabel: 'Add grammar',
          onCreate: () => goToLibrary('grammar')
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
          await apiRequest(record.id_session ? `/api/sessions/${record.id_session}` : '/api/sessions', {
            method: record.id_session ? 'PUT' : 'POST',
            body: payload
          });
          close();
          showToast(record.id_session ? 'Study session updated.' : 'Study session created.');
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

  async function deleteSession(session) {
    if (!window.confirm('Delete this study session? Its material links will also be removed.')) return;
    try {
      await apiRequest(`/api/sessions/${session.id_session}`, { method: 'DELETE' });
      showToast('Study session deleted.');
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  addButton.addEventListener('click', () => openSessionDialog());
  category.addEventListener('change', load);
  period.addEventListener('change', () => {
    updateCustomRangeVisibility();
    load();
  });
  fromDate.addEventListener('change', () => {
    toDate.min = fromDate.value;
    load();
  });
  toDate.addEventListener('change', () => {
    fromDate.max = toDate.value;
    load();
  });
  clearButton.addEventListener('click', () => {
    category.value = '';
    period.value = 'all';
    fromDate.value = '';
    toDate.value = '';
    fromDate.removeAttribute('max');
    toDate.removeAttribute('min');
    updateCustomRangeVisibility();
    load();
  });
  updateCustomRangeVisibility();
  load();
}
