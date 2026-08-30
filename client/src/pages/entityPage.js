import { apiRequest, queryString } from '../api';
import {
  debounce,
  confirmDialog,
  element,
  emptyState,
  errorState,
  field,
  loadingState,
  openDialog,
  pageHeader,
  paginationControls,
  showToast
} from '../ui';

const JLPT_OPTIONS = [
  { value: '', label: 'Any / not set' },
  ...['N5', 'N4', 'N3', 'N2', 'N1'].map((value) => ({ value, label: value }))
];
const STATUS_OPTIONS = ['New', 'Learning', 'Familiar', 'Mastered'].map((value) => ({ value, label: value }));

export const ENTITY_CONFIGS = {
  vocabulary: {
    endpoint: '/api/vocabulary',
    idKey: 'id_vocabulary',
    eyebrow: 'Lexicon',
    title: 'Vocabulary',
    singular: 'vocabulary entry',
    description: 'Capture words, readings, meanings and learning status.',
    searchPlaceholder: 'Search words, readings, romaji, or meanings…',
    empty: 'Add the first word you want to retain.',
    primary: (item) => item.word,
    secondary: (item) => item.reading || 'Reading not recorded',
    detail: (item) => item.meaning,
    renderDetail: (item, actions) => element('div', { className: 'sm:col-span-2' }, [
      element('dl', { className: 'grid gap-3 text-sm sm:grid-cols-2' }, [
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Reading' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.reading || 'Not recorded' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Meaning' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.meaning })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'JLPT level' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.jlpt_level || 'Not set' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Status' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.status || 'New' })])
      ]),
      ...(item.notes ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Notes' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.notes })])] : []),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [
        element('h3', { className: 'font-semibold text-ink', text: 'Related kanji' }),
        item.kanji?.length ? element('ul', { className: 'mt-2 flex flex-wrap gap-2' }, item.kanji.map((kanji) => element('li', { className: 'status-pill', text: `${kanji.character_kanji} · ${kanji.meaning}` }))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No kanji linked.' })
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [
        element('div', { className: 'flex items-center justify-between gap-3' }, [element('h3', { className: 'font-semibold text-ink', text: 'Example usage' }), element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Add example', attrs: { type: 'button', 'data-example-action': 'add' } })]),
        item.examples?.length ? element('div', { className: 'mt-3 grid gap-3' }, item.examples.map((example) => element('article', { className: 'rounded-md bg-paper p-3' }, [
          element('p', { className: 'whitespace-pre-wrap text-sm leading-6 text-ink', text: example.sentence }),
          ...(example.translation ? [element('p', { className: 'mt-2 text-sm text-muted', text: example.translation })] : []),
          element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: 'Edit example', attrs: { type: 'button', 'data-example-action': 'edit', 'data-example-id': example.id_usage_example } })
        ]))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No examples recorded yet.' })
      ])
    ]),
    fields: [
      { name: 'word', label: 'Word', required: true, maxLength: 100 },
      { name: 'reading', label: 'Reading', maxLength: 150 },
      { name: 'meaning', label: 'Meaning', required: true, maxLength: 255, wide: true },
      { name: 'example_sentence', label: 'Example sentence', type: 'textarea', maxLength: 2000, wide: true, createOnly: true, section: 'example' },
      { name: 'example_translation', label: 'Translation', type: 'textarea', maxLength: 2000, createOnly: true, section: 'example' },
      { name: 'example_notes', label: 'Example notes', type: 'textarea', maxLength: 1500, createOnly: true, section: 'example' },
      { name: 'jlpt_level', label: 'JLPT level', options: JLPT_OPTIONS },
      { name: 'status', label: 'Status', options: STATUS_OPTIONS, defaultValue: 'New' },
      { name: 'notes', label: 'Entry notes', type: 'textarea', maxLength: 1500, wide: true }
    ]
  },
  kanji: {
    endpoint: '/api/kanji',
    idKey: 'id_kanji',
    eyebrow: 'Characters',
    title: 'Kanji',
    singular: 'kanji entry',
    description: 'Track character meanings, readings and familiarity.',
    searchPlaceholder: 'Search kanji, readings, romaji, or meanings…',
    empty: 'Add the first character you are studying.',
    primary: (item) => item.character_kanji,
    secondary: (item) => [item.onyomi, item.kunyomi].filter(Boolean).join(' · ') || 'Readings not recorded',
    detail: (item) => item.meaning,
    renderDetail: (item) => element('div', { className: 'sm:col-span-2' }, [
      element('dl', { className: 'grid gap-3 text-sm sm:grid-cols-2' }, [
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Meaning' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.meaning })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Onyomi' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.onyomi || 'Not recorded' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Kunyomi' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.kunyomi || 'Not recorded' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'JLPT level' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.jlpt_level || 'Not set' })])
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Related vocabulary' }), item.vocabulary?.length ? element('ul', { className: 'mt-3 grid gap-2' }, item.vocabulary.map((word) => element('li', { className: 'text-sm text-ink/80', text: `${word.word} · ${word.reading || 'reading not recorded'} · ${word.meaning}` }))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No vocabulary linked.' })]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Usage through related words' }), item.usageExamples?.length ? element('div', { className: 'mt-3 grid gap-3' }, item.usageExamples.map((example) => element('article', { className: 'rounded-md bg-paper p-3' }, [element('p', { className: 'text-xs font-semibold text-vermilion', text: `${example.word} · ${example.reading || 'reading not recorded'}` }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm text-ink', text: example.sentence }), ...(example.translation ? [element('p', { className: 'mt-2 text-sm text-muted', text: example.translation })] : [])]))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'Add examples to linked vocabulary to see real reading usage here.' })])
    ]),
    fields: [
      { name: 'character_kanji', label: 'Character', required: true, maxLength: 4 },
      { name: 'meaning', label: 'Meaning', required: true, maxLength: 255 },
      { name: 'onyomi', label: 'Onyomi', maxLength: 255 },
      { name: 'kunyomi', label: 'Kunyomi', maxLength: 255 },
      { name: 'jlpt_level', label: 'JLPT level', options: JLPT_OPTIONS },
      { name: 'status', label: 'Status', options: STATUS_OPTIONS, defaultValue: 'New' },
      { name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, wide: true }
    ]
  },
  grammar: {
    endpoint: '/api/grammar',
    idKey: 'id_grammar',
    eyebrow: 'Patterns',
    title: 'Grammar',
    singular: 'grammar point',
    description: 'Keep structures, examples and mastery status in one place.',
    searchPlaceholder: 'Search grammar, romaji, or meanings…',
    empty: 'Add the first grammar pattern you want to review.',
    primary: (item) => item.grammar_point,
    secondary: (item) => item.structure || 'Structure not recorded',
    detail: (item) => item.meaning,
    renderDetail: (item) => element('div', { className: 'sm:col-span-2' }, [
      element('dl', { className: 'grid gap-3 text-sm sm:grid-cols-2' }, [
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Grammar point' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.grammar_point })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Meaning' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.meaning })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'JLPT level' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.jlpt_level || 'Not set' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Status' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.status || 'New' })])
      ]),
      ...(item.structure ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Structure' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.structure })])] : []),
      ...(item.example ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Example' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.example })])] : []),
      ...(item.notes ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Notes' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.notes })])] : [])
    ]),
    fields: [
      { name: 'grammar_point', label: 'Grammar point', required: true, maxLength: 100 },
      { name: 'meaning', label: 'Meaning', required: true, maxLength: 255 },
      { name: 'structure', label: 'Structure', type: 'textarea', maxLength: 2000, wide: true },
      { name: 'example', label: 'Example', type: 'textarea', maxLength: 2000, wide: true },
      { name: 'jlpt_level', label: 'JLPT level', options: JLPT_OPTIONS },
      { name: 'status', label: 'Status', options: STATUS_OPTIONS, defaultValue: 'New' },
      { name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, wide: true }
    ]
  }
};

function buildFields(config, record = {}) {
  const visibleDefinitions = config.fields.filter((definition) => !definition.createOnly || !record[config.idKey]);
  const createField = (definition) => {
    const input = field({
      ...definition,
      value: record[definition.name] ?? definition.defaultValue ?? ''
    });
    if (definition.wide) input.classList.add('sm:col-span-2');
    return input;
  };
  const regularFields = visibleDefinitions.filter((definition) => definition.section !== 'example').map(createField);
  const exampleFields = visibleDefinitions.filter((definition) => definition.section === 'example').map(createField);

  if (!exampleFields.length) return regularFields;

  const insertionIndex = Math.min(3, regularFields.length);
  regularFields.splice(insertionIndex, 0, element('section', { className: 'rounded-lg border border-stone bg-paper/40 p-4 sm:col-span-2' }, [
    element('h3', { className: 'font-semibold text-ink', text: 'Example usage (optional)' }),
    element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Save the first natural sentence together with this vocabulary entry.' }),
    element('div', { className: 'mt-4 grid gap-4 sm:grid-cols-2' }, exampleFields)
  ]));
  return regularFields;
}

function formPayload(form, config) {
  const formData = new FormData(form);
  return Object.fromEntries(config.fields.map(({ name }) => [name, formData.get(name) ?? '']));
}

function recordCard(item, config, onView, onEdit, onDelete) {
  const viewButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'View', attrs: { type: 'button' } });
  const editButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Edit', attrs: { type: 'button' } });
  const deleteButton = element('button', { className: 'button-danger', text: 'Delete', attrs: { type: 'button' } });
  viewButton.addEventListener('click', () => onView(item));
  editButton.addEventListener('click', () => onEdit(item));
  deleteButton.addEventListener('click', () => onDelete(item));

  return element('article', { className: 'surface flex min-h-48 flex-col p-5' }, [
    element('div', { className: 'flex items-start justify-between gap-4' }, [
      element('div', {}, [
        element('h2', { className: 'text-lg font-semibold text-ink', text: config.primary(item) }),
        element('p', { className: 'mt-1 text-sm text-muted', text: config.secondary(item) })
      ]),
      element('span', { className: 'status-pill shrink-0', text: item.status || 'New' })
    ]),
    element('p', { className: 'mt-4 line-clamp-3 text-sm leading-6 text-ink/80', text: config.detail(item) }),
    element('div', { className: 'mt-auto flex items-end justify-between gap-3 pt-5' }, [
      element('span', { className: 'text-xs font-semibold text-muted', text: item.jlpt_level || 'JLPT not set' }),
      element('div', { className: 'flex gap-2' }, [viewButton, editButton, deleteButton])
    ])
  ]);
}

export function renderEntityPage(container, config) {
  const pageSize = 30;
  let currentPage = 1;
  let loadSequence = 0;
  const addButton = element('button', { className: 'button-primary', text: `Add ${config.singular}`, attrs: { type: 'button' } });
  const search = element('input', { className: 'field-control', attrs: { type: 'search', placeholder: config.searchPlaceholder, 'aria-label': `Search ${config.title}` } });
  const jlpt = element('select', { className: 'field-control', attrs: { 'aria-label': 'Filter by JLPT level' } }, JLPT_OPTIONS.map((option) => element('option', { text: option.label, attrs: { value: option.value } })));
  const status = element('select', { className: 'field-control', attrs: { 'aria-label': 'Filter by status' } }, [
    element('option', { text: 'Any status', attrs: { value: '' } }),
    ...STATUS_OPTIONS.map((option) => element('option', { text: option.label, attrs: { value: option.value } }))
  ]);
  const results = element('div');
  const filterBar = element('div', { className: 'surface mb-5 grid gap-3 p-4 sm:grid-cols-[minmax(14rem,1fr)_10rem_11rem]' }, [search, jlpt, status]);
  const page = element('section', {}, [
    pageHeader({ eyebrow: config.eyebrow, title: config.title, description: config.description, action: addButton }),
    filterBar,
    results
  ]);

  container.replaceChildren(page);

  async function load() {
    const sequence = ++loadSequence;
    results.replaceChildren(loadingState(`Loading ${config.title.toLowerCase()}…`));
    try {
      const data = await apiRequest(`${config.endpoint}${queryString({
        search: search.value,
        jlpt: jlpt.value,
        status: status.value,
        page: currentPage,
        limit: pageSize
      })}`);
      if (sequence !== loadSequence) return;
      const { items, pagination } = data;
      if (!items.length && currentPage > 1 && pagination.totalPages > 0) {
        currentPage = pagination.totalPages;
        await load();
        return;
      }
      if (!items.length) {
        results.replaceChildren(emptyState({ title: `No ${config.title.toLowerCase()} found`, description: config.empty }));
        return;
      }
      const pager = paginationControls(pagination, (pageNumber) => {
          currentPage = pageNumber;
          load();
        });
      results.replaceChildren(
        element('div', { className: 'grid gap-4 md:grid-cols-2 xl:grid-cols-3' }, items.map((item) => recordCard(item, config, viewRecord, editRecord, deleteRecord))),
        ...[pager].filter(Boolean)
      );
    } catch (error) {
      if (sequence !== loadSequence) return;
      results.replaceChildren(errorState(error, load));
    }
  }

  async function saveRecord(record, form, close) {
    const id = record?.[config.idKey];
    await apiRequest(id ? `${config.endpoint}/${id}` : config.endpoint, {
      method: id ? 'PUT' : 'POST',
      body: formPayload(form, config)
    });
    close();
    showToast(id ? `${config.title} record updated.` : `${config.title} record created.`);
    if (!id) currentPage = 1;
    await load();
  }

  function openRecordDialog(record = {}) {
    openDialog({
      title: record[config.idKey] ? `Edit ${config.singular}` : `Add ${config.singular}`,
      content: buildFields(config, record),
      submitLabel: record[config.idKey] ? 'Save changes' : 'Create record',
      onSubmit: (form, close) => saveRecord(record, form, close)
    });
  }

  async function editRecord(item) {
    try {
      openRecordDialog(await apiRequest(`${config.endpoint}/${item[config.idKey]}`));
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function viewRecord(item) {
    try {
      const record = await apiRequest(`${config.endpoint}/${item[config.idKey]}`);
      const openExampleForm = (example = null) => openDialog({
        title: example ? 'Edit usage example' : 'Add usage example',
        content: [
          field({ name: 'sentence', label: 'Sentence', type: 'textarea', required: true, maxLength: 2000, value: example?.sentence || '' }),
          field({ name: 'translation', label: 'Translation', type: 'textarea', maxLength: 2000, value: example?.translation || '' }),
          field({ name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, value: example?.notes || '' })
        ],
        submitLabel: example ? 'Save example' : 'Add example',
        onSubmit: async (form, close) => {
          const data = new FormData(form);
          const path = example ? `${config.endpoint}/${record[config.idKey]}/examples/${example.id_usage_example}` : `${config.endpoint}/${record[config.idKey]}/examples`;
          await apiRequest(path, { method: example ? 'PUT' : 'POST', body: { sentence: data.get('sentence'), translation: data.get('translation'), notes: data.get('notes') } });
          close();
          showToast(example ? 'Usage example updated.' : 'Usage example added.');
          await viewRecord(record);
        }
      });
      const content = config.renderDetail ? config.renderDetail(record, { openExampleForm }) : element('div', { className: 'sm:col-span-2 text-sm text-muted', text: 'A detailed preview is not available for this record yet.' });
      content.querySelector('[data-example-action="add"]')?.addEventListener('click', () => openExampleForm());
      content.querySelectorAll('[data-example-action="edit"]').forEach((button) => button.addEventListener('click', () => openExampleForm(record.examples.find((example) => example.id_usage_example === Number(button.dataset.exampleId)))));
      openDialog({ title: `${config.title} detail`, content: [content], submitLabel: 'Close', onSubmit: async (form, close) => close() });
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function deleteRecord(item) {
    confirmDialog({
      title: `Delete ${config.singular}?`,
      description: `This will permanently delete this ${config.singular}. This cannot be undone.`,
      onConfirm: async () => { await apiRequest(`${config.endpoint}/${item[config.idKey]}`, { method: 'DELETE' }); showToast(`${config.title} record deleted.`); await load(); }
    });
  }

  addButton.addEventListener('click', () => openRecordDialog());
  const resetAndLoad = () => {
    currentPage = 1;
    load();
  };
  const debouncedLoad = debounce(resetAndLoad);
  search.addEventListener('input', () => {
    loadSequence += 1;
    debouncedLoad();
  });
  jlpt.addEventListener('change', resetAndLoad);
  status.addEventListener('change', resetAndLoad);
  load();
}
