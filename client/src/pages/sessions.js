import { apiRequest, queryString } from '../api';
import { destroyCharts } from '../chartRegistry';
import { icon, iconTile } from '../icons';
import {
  buildSessionSubmitPayload,
  sessionCardModel
} from '../sessionHistory';
import {
  buildKanjiImportPayload,
  formatKanjiContextEntry,
  getDiscoveryKanji,
  getDiscoveryState,
  getImportableKanji,
  summarizeImportResults
} from '../vocabularyReading';
import {
  confirmDialog,
  element,
  emptyState,
  errorState,
  field,
  formatDate,
  isActionPending,
  loadingState,
  openDialog,
  pageHeader,
  paginationControls,
  setActionPending,
  showToast,
  withGlobalLoading,
  withPendingAction
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
  const model = sessionCardModel(session);
  const viewButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'View', attrs: { type: 'button' } });
  const editButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Edit', attrs: { type: 'button' } });
  viewButton.addEventListener('click', () => onView(session));
  editButton.addEventListener('click', () => onEdit(session));

  return element('article', { className: 'surface p-5' }, [
    element('div', { className: 'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between' }, [
      element('div', { className: 'flex min-w-0 items-start gap-3' }, [
        iconTile('sessions', { className: 'preview-icon shrink-0' }),
        element('div', { className: 'min-w-0' }, [
          element('div', { className: 'flex flex-wrap items-center gap-2' }, [
            element('span', { className: 'status-pill', text: model.badge }),
            ...(model.durationLabel ? [element('span', { className: 'text-sm text-muted', text: model.durationLabel })] : []),
            ...(model.dateValue ? [element('span', { className: 'text-sm text-muted', text: `· ${formatDate(model.dateValue)}` })] : [])
          ]),
          element('h2', { className: 'mt-2 break-words font-semibold text-ink', text: model.title }),
          ...(model.preview ? [element('p', { className: 'mt-1 line-clamp-2 text-sm leading-6 text-muted', text: model.preview })] : []),
          ...(model.meta.length ? [element('ul', { className: 'mt-2 flex flex-wrap items-center gap-x-4 gap-y-1' }, model.meta.map((row, index) => (
            // Separator lives inside its item (not as a loose flex child) so
            // it wraps together with the item and can never dangle alone or
            // collapse against the previous item's text.
            element('li', { className: 'flex shrink-0 items-baseline gap-x-1 text-xs text-muted' }, [
              ...(index > 0 ? [element('span', { className: 'shrink-0', text: '·', attrs: { 'aria-hidden': 'true' } })] : []),
              element('span', { className: 'font-medium text-ink/70', text: `${row.label}: ` }),
              element('span', { text: row.text })
            ])
          )))] : [])
        ])
      ]),
      element('div', { className: 'flex shrink-0 items-center gap-2' }, [viewButton, editButton, sessionOverflowMenu(() => onDelete(session))])
    ])
  ]);
}

// Secondary overflow menu for destructive/secondary card actions. Delete
// keeps its confirmation flow via the onDelete callback (confirmDialog).
let openSessionMenuCloser = null;

function sessionOverflowMenu(onDelete) {
  const deleteItem = element('button', {
    className: 'flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium text-red-700 transition hover:bg-red-50',
    text: 'Delete',
    attrs: { type: 'button', role: 'menuitem' }
  });
  const menu = element('div', {
    className: 'absolute right-0 top-[calc(100%+.25rem)] z-20 min-w-36 rounded-lg border border-stone bg-paper p-1 shadow-lg',
    attrs: { role: 'menu', hidden: '' }
  }, [deleteItem]);
  const toggle = element('button', {
    className: 'button-secondary min-h-9 px-2.5 py-1.5',
    attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More actions', title: 'More actions' }
  }, [icon('menu', { size: 18 })]);
  const close = () => {
    menu.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', 'false');
    if (openSessionMenuCloser === close) openSessionMenuCloser = null;
  };
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = menu.hasAttribute('hidden');
    openSessionMenuCloser?.();
    if (willOpen) {
      menu.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      openSessionMenuCloser = close;
      deleteItem.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      toggle.focus();
    }
  });
  deleteItem.addEventListener('click', () => {
    close();
    onDelete();
  });
  if (!sessionOverflowMenu.listenerInstalled) {
    sessionOverflowMenu.listenerInstalled = true;
    document.addEventListener('pointerdown', (event) => {
      if (openSessionMenuCloser && !event.target.closest('[data-session-menu]')) openSessionMenuCloser();
    });
  }
  return element('div', { className: 'relative', attrs: { 'data-session-menu': '' } }, [toggle, menu]);
}

// Visible Session form field order is defined in ../sessionHistory.js
// (SESSION_FORM_FIELD_ORDER: Basic → Resource → Writing → Notes).
// Manual linking controls (vocabulary/kanji/grammar) and Writing notes are
// intentionally hidden from the form and never submitted, so the backend
// preserves existing relationships and writing notes on edit.

function selectedNumbers(select) {
  return Array.from(select.selectedOptions, (option) => Number(option.value));
}

// Preserved for compatibility: manual session-linking helpers. The linking
// UI is intentionally hidden from the Session form, but these loaders stay
// available (backend contracts, junction tables, and stored relationships
// are untouched).

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
    if (!setActionPending(addButton, true, { pendingLabel: 'Loading…' })) return;
    try {
      // Visible order: Basic → Resource → Writing → Notes.
      // Manual linking controls and Writing notes are intentionally hidden
      // from this form (see buildSessionSubmitPayload), but the underlying
      // linking system, API contracts, and stored data are fully preserved.
      const notesField = field({ name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, value: record.notes || '', description: 'Reflections, observations, reminders.' });
      notesField.classList.add('sm:col-span-2');
      const formFields = [
        field({ name: 'category', label: 'Session type', required: true, value: record.category || 'Vocabulary', options: CATEGORIES.map((value) => ({ value, label: value })) }),
        field({ name: 'session_date', label: 'Date', type: 'date', required: true, value: String(record.session_date || '').slice(0, 10) }),
        field({ name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', required: true, value: record.duration_minutes || 30 }),
        field({ name: 'resource', label: 'Resource', maxLength: 255, value: record.resource || '', placeholder: 'Genki, NHK, conversation…', description: 'What you studied with. For a media diary, use Content Log.' }),
        element('section', { className: 'rounded-lg border border-stone bg-paper/40 p-4 sm:col-span-2' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Writing' }),
          element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Your study output — the content you created.' }),
          element('div', { className: 'mt-4 grid gap-4 sm:grid-cols-2' }, [
            field({ name: 'writing_title', label: 'Writing title', maxLength: 150, value: record.writing?.title || '' }),
            element('div', { className: 'sm:col-span-2' }, [field({ name: 'writing_content', label: 'Writing content', type: 'textarea', maxLength: 10000, value: record.writing?.content || '' })])
          ])
        ]),
        notesField
      ];

      openDialog({
        title: record.id_session ? 'Edit study session' : 'Add study session',
        content: formFields,
        submitLabel: record.id_session ? 'Save changes' : 'Create session',
        onSubmit: async (form, close) => {
          const formData = new FormData(form);
          const payload = buildSessionSubmitPayload({
            category: formData.get('category'),
            session_date: formData.get('session_date'),
            duration_minutes: formData.get('duration_minutes'),
            resource: formData.get('resource'),
            writing_title: formData.get('writing_title'),
            writing_content: formData.get('writing_content'),
            notes: formData.get('notes')
          });
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
      setActionPending(addButton, false);
    }
  }

  async function editSession(session) {
    try {
      // Edit forms wait on a fetch; the overlay covers slow loads only.
      await openSessionDialog(await withGlobalLoading(
        () => apiRequest(`/api/sessions/${session.id_session}`),
        { label: 'Loading study session…' }
      ));
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function viewSession(session) {
    try {
      // Detail dialogs wait on a fetch; the overlay covers slow loads only.
      const record = await withGlobalLoading(
        () => apiRequest(`/api/sessions/${session.id_session}`),
        { label: 'Loading study session…' }
      );
      // Phase 6 — Kanji discovery: deterministic per-character states over
      // the session writing content. Discovery only — nothing is added here.
      const discovered = getDiscoveryKanji(record).map(formatKanjiContextEntry).filter(Boolean);
      const discoveryPill = (kanji) => {
        const state = getDiscoveryState(kanji);
        if (state === 'alreadyInCollection') return 'In your collection';
        if (state === 'availableToAdd') return 'Available from reference';
        return 'No reference data';
      };
      // Phase 7 — Batch import: explicit checkbox selection over reference-
      // backed discoveries only. Imports reuse POST /api/kanji sequentially
      // (per-item 201/409/422); already-collected and no-reference entries
      // can never be selected.
      const rawDiscoveryByChar = new Map(getDiscoveryKanji(record).map((entry) => [entry.character, entry]));
      const importable = getImportableKanji(discovered);
      const selectedChars = new Set(importable.map((kanji) => kanji.character));
      const addSelectedButton = element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: `Add selected Kanji (${selectedChars.size})`, attrs: { type: 'button' } });
      const syncAddButton = () => {
        // While the batch runs the helper owns the button label (progress);
        // selection toggles still update the set for the post-import refresh.
        if (isActionPending(addSelectedButton)) return;
        addSelectedButton.textContent = `Add selected Kanji (${selectedChars.size})`;
        addSelectedButton.disabled = selectedChars.size === 0;
      };
      const selectionRows = importable.map((kanji) => {
        const checkbox = element('input', { className: 'mt-0.5 size-4 accent-vermilion', attrs: { type: 'checkbox', value: kanji.character } });
        checkbox.checked = true;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedChars.add(kanji.character);
          else selectedChars.delete(kanji.character);
          syncAddButton();
        });
        return element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm font-normal transition hover:bg-paper' }, [
          checkbox,
          element('span', { className: 'min-w-0 leading-5' }, [
            element('span', { className: 'block text-lg font-medium text-ink', text: kanji.character }),
            ...(kanji.referenceMeanings ? [element('span', { className: 'block text-xs text-muted', text: kanji.referenceMeanings })] : [])
          ])
        ]);
      });
      syncAddButton();
      addSelectedButton.addEventListener('click', () => {
        const targets = [...selectedChars];
        if (!targets.length) return;
        withPendingAction(addSelectedButton, async ({ setProgress }) => {
          // Sequential (never parallel): protects the small runtime pool and
          // keeps per-item feedback deterministic. Snapshot targets up front
          // so mid-import selection toggles cannot resubmit or skip items.
          const outcomes = [];
          let index = 0;
          for (const character of targets) {
            index += 1;
            setProgress(index, targets.length);
            const payload = buildKanjiImportPayload(rawDiscoveryByChar.get(character));
            if (!payload) continue;
            try {
              await apiRequest('/api/kanji', { method: 'POST', body: payload });
              outcomes.push({ character, ok: true, status: 'added' });
            } catch (error) {
              // 409 = already learning (e.g. added in another tab): benign
              // skip, refresh flips the card to "In your Kanji collection".
              if (error?.status === 409) outcomes.push({ character, ok: true, status: 'already' });
              else outcomes.push({ character, ok: false, status: 'failed' });
            }
          }
          const summary = summarizeImportResults(outcomes);
          const parts = [];
          if (summary.added) parts.push(`${summary.added} added`);
          if (summary.already) parts.push(`${summary.already} already in collection`);
          showToast(parts.length ? `${parts.join(' · ')}.` : 'Nothing was added.');
          if (summary.failed.length) showToast(`Could not add: ${summary.failed.join(', ')}.`, 'error');
          // Refresh from a fresh fetch: imported kanji flip to "In your
          // collection" and selection clears. Session content untouched.
          await viewSession(session);
        }, { pendingLabel: 'Adding…', progressLabel: (done, total) => `Adding ${done}/${total}…` });
      });
      const discoverySection = element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [
        element('h3', { className: 'font-semibold text-ink', text: `Kanji discovered${discovered.length ? ` (${discovered.length})` : ''}` }),
        discovered.length
          ? element('ul', { className: 'mt-3 grid gap-2 sm:grid-cols-2' }, discovered.map((kanji) => {
            const detail = kanji.inUserCollection ? kanji.meaning : kanji.referenceMeanings;
            return element('li', { className: 'text-sm' }, [
              element('span', { className: 'text-lg font-medium text-ink', text: kanji.character }),
              element('span', { className: 'status-pill ml-2 shrink-0 text-xs', text: discoveryPill(kanji) }),
              ...(detail ? [element('p', { className: 'mt-1 text-muted', text: detail })] : [])
            ]);
          }))
          : element('p', { className: 'mt-2 text-sm text-muted', text: 'No kanji characters found in this writing.' }),
        ...(discovered.length ? [element('p', { className: 'mt-3 text-xs text-muted', text: 'Detected as individual characters present in the writing content. Reference data is context only — nothing has been added.' })] : []),
        ...(importable.length ? [element('div', { className: 'mt-4 border-t border-stone pt-4' }, [
          element('h4', { className: 'font-semibold text-ink', text: 'Add to your Kanji collection' }),
          element('p', { className: 'mt-1 text-xs text-muted', text: 'Select reference-backed kanji to import. Already-collected kanji and kanji without reference data cannot be added here.' }),
          element('div', { className: 'mt-2 grid gap-1 sm:grid-cols-2' }, selectionRows),
          addSelectedButton
        ])] : [])
      ]);
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
        ...((record.writing && record.kanjiDiscovery) ? [discoverySection] : []),
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
