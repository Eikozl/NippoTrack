import { apiRequest, queryString } from '../api';
import { applyPristineKanjiAutofill, changedKanjiReferenceFields, existingKanjiFromDuplicateError, isSingleHanCodePoint, transliteratedValue } from '../kanjiReference';
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
import { iconForTitle, iconTile } from '../icons';

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
    japaneseTextFields: { word: 'hiragana', reading: 'hiragana', example_sentence: 'hiragana' },
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
    japaneseTextFields: { onyomi: 'katakana', kunyomi: 'hiragana' },
renderDetail: (item) => {
      const ref = item.reference || null;
      const review = item.review || null;
      const encounters = item.encounters || { count: 0, firstEncounteredAt: null, lastEncounteredAt: null, bySource: [], recent: [] };
      const vocab = item.vocabulary || [];
      const usageExamples = item.usageExamples || [];
      const notes = item.notes || null;
      const status = item.status || 'New';

      const refMeanings = ref?.meanings?.length ? ref.meanings : [];
      const refOnyomi = ref?.onyomi?.length ? ref.onyomi : [];
      const refKunyomi = ref?.kunyomi?.length ? ref.kunyomi : [];
      const refJlpt = ref?.jlptLevel || null;
      const refStrokeCount = ref?.strokeCount || null;

      const userOnyomi = item.onyomi || null;
      const userKunyomi = item.kunyomi || null;

      const formatDate = (iso) => {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      };

      const formatDateTime = (iso) => {
        if (!iso) return '—';
        const d = new Date(iso);
        return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      };

      const statusColors = {
        New: 'bg-sky text-sky-foreground',
        Learning: 'bg-amber text-amber-foreground',
        Familiar: 'bg-emerald text-emerald-foreground',
        Mastered: 'bg-violet text-violet-foreground'
      };

      return element('div', { className: 'sm:col-span-2 space-y-5' }, [
        // 1. Hero / Identity
        element('section', { className: 'kanji-intel-hero' }, [
          element('div', { className: 'kanji-glyph-panel-large', attrs: { role: 'img', 'aria-label': `Selected kanji: ${item.character_kanji}` } }, [
            element('span', { className: 'kanji-glyph-large', text: item.character_kanji, attrs: { lang: 'ja' } })
          ]),
          element('div', { className: 'kanji-hero-meta' }, [
            element('h2', { className: 'text-2xl font-semibold text-ink' }, refMeanings.length ? refMeanings.join(' · ') : (item.meaning || 'Meaning not recorded')),
            element('div', { className: 'mt-2 flex flex-wrap items-center gap-2' }, [
              refJlpt && element('span', { className: 'status-pill status-jlpt', text: `JLPT ${refJlpt} (Reference)` }),
              element('span', { className: `status-pill ${statusColors[status] || 'bg-stone text-stone-foreground'}`, text: status }),
              refStrokeCount && element('span', { className: 'status-pill bg-stone text-stone-foreground', text: `${refStrokeCount} strokes (Ref)` })
            ]),
            element('p', { className: 'mt-2 text-sm text-muted', text: `Character: ${item.character_kanji}` })
          ])
        ]),

        // 2. Readings
        element('section', { className: 'rounded-lg border border-stone p-4' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Readings' }),
          element('div', { className: 'mt-3 grid gap-4 sm:grid-cols-2' }, [
            element('div', {}, [
              element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'On\'yomi (Reference)' }),
              element('p', { className: 'mt-1 text-sm text-ink/80' }, refOnyomi.length ? refOnyomi.join(' · ') : '—')
            ]),
            element('div', {}, [
              element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'On\'yomi (Your record)' }),
              element('p', { className: 'mt-1 text-sm text-ink/80' }, userOnyomi || 'Not recorded')
            ]),
            element('div', {}, [
              element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Kun\'yomi (Reference)' }),
              element('p', { className: 'mt-1 text-sm text-ink/80' }, refKunyomi.length ? refKunyomi.join(' · ') : '—')
            ]),
            element('div', {}, [
              element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Kun\'yomi (Your record)' }),
              element('p', { className: 'mt-1 text-sm text-ink/80' }, userKunyomi || 'Not recorded')
            ])
          ])
        ]),

        // 3. SRS Review
        element('section', { className: 'rounded-lg border border-stone p-4' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'SRS Review' }),
          review ? element('dl', { className: 'mt-3 grid gap-3 text-sm sm:grid-cols-2' }, [
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Next Review' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDate(review.dueOn) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Interval' }), element('dd', { className: 'mt-1 font-medium text-ink', text: `${review.intervalDays || 0} days` })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Last Reviewed' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDateTime(review.lastReviewedAt) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Last Result' }), element('dd', { className: 'mt-1 font-medium text-ink', text: review.lastResult || '—' })])
          ]) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No review scheduled' })
        ]),

        // 4. Encounter Intelligence
        element('section', { className: 'rounded-lg border border-stone p-4' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Encounter Intelligence' }),
          element('div', { className: 'mt-3 grid gap-4 sm:grid-cols-2' }, [
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Total Encounters' }), element('dd', { className: 'mt-1 font-medium text-ink', text: String(encounters.count) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'First Seen' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDate(encounters.firstEncounteredAt) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Last Seen' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDate(encounters.lastEncounteredAt) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Vocabulary Sources' }), element('dd', { className: 'mt-1 font-medium text-ink', text: String(encounters.bySource.find(s => s.sourceType === 'vocabulary')?.count || 0) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Session Writing Sources' }), element('dd', { className: 'mt-1 font-medium text-ink', text: String(encounters.bySource.find(s => s.sourceType === 'session_writing')?.count || 0) })])
          ]),
          encounters.recent?.length ? element('div', { className: 'mt-4' }, [
            element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Recent Encounters (max 5)' }),
            element('ul', { className: 'mt-2 grid gap-2' }, encounters.recent.map((enc) => element('li', { className: 'text-sm text-ink/80 flex items-center gap-2' }, [
              element('span', { className: 'status-pill text-xs', text: enc.sourceType === 'vocabulary' ? 'Vocab' : 'Writing' }),
              element('span', { text: enc.sourceTitle || `Source #${enc.sourceId}` }),
              element('span', { className: 'text-muted ml-auto', text: formatDateTime(enc.encounteredAt) })
            ])))
          ]) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No encounters yet' })
        ]),

        // 5. Connected Vocabulary
        element('section', { className: 'rounded-lg border border-stone p-4' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Connected Vocabulary' }),
          vocab.length ? element('div', { className: 'mt-3 grid gap-3' }, vocab.map((word) => {
            const wordExamples = usageExamples.filter((ex) => ex.id_vocabulary === word.id_vocabulary);
            return element('article', { className: 'rounded-md bg-paper p-3' }, [
              element('div', { className: 'flex items-start justify-between gap-3' }, [
                element('div', {}, [
                  element('p', { className: 'font-medium text-ink', text: word.word }),
                  element('p', { className: 'text-sm text-muted', text: word.reading || 'Reading not recorded' }),
                  element('p', { className: 'mt-1 text-sm text-ink/80', text: word.meaning })
                ]),
                element('div', { className: 'flex flex-col items-end gap-1' }, [
                  word.jlpt_level && element('span', { className: 'status-pill status-jlpt text-xs', text: word.jlpt_level }),
                  element('span', { className: `status-pill text-xs ${statusColors[word.status] || 'bg-stone text-stone-foreground'}`, text: word.status || 'New' })
                ])
              ]),
              wordExamples.length ? element('div', { className: 'mt-3 grid gap-2' }, wordExamples.map((ex) => element('div', { className: 'rounded bg-white/50 p-2 text-xs' }, [
                element('p', { className: 'whitespace-pre-wrap text-ink', text: ex.sentence }),
                ex.translation && element('p', { className: 'mt-1 text-muted', text: ex.translation })
              ]))) : null
            ]);
          })) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No connected vocabulary yet' })
        ]),

        // 6. Personal Notes
        element('section', { className: 'rounded-lg border border-stone p-4' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Personal Notes' }),
          notes ? element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: notes }) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No personal notes' })
        ])
      ]);
    },
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
    japaneseTextFields: { grammar_point: 'hiragana', structure: 'hiragana', example: 'hiragana' },
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

function inputFor(content, name) {
  return content.map((item) => item.matches?.(`[name="${name}"]`) ? item : item.querySelector?.(`[name="${name}"]`)).find(Boolean);
}

function enableRomajiConversion(content, config) {
  Object.entries(config.japaneseTextFields || {}).forEach(([name, script]) => {
    const input = inputFor(content, name);
    if (!input) return;
    input.addEventListener('blur', async () => {
      const original = input.value.trim();
      if (!original) return;
      try {
        const result = await apiRequest(`/api/kanji/reference?search=${encodeURIComponent(original)}&limit=1`);
        const converted = transliteratedValue(result.transliteration, script);
        if (converted && input.value.trim() === original) input.value = converted;
      } catch {
        // Leave the user's value unchanged when the reference service is unavailable.
      }
    });
  });
}

function enableKanjiReferenceAutofill(content) {
  const fieldNames = ['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level'];
  const fields = Object.fromEntries(fieldNames.map((name) => [
    name,
    inputFor(content, name)
  ]));
  const characterField = fields.character_kanji;
  if (!characterField) return;

  const status = element('p', {
    className: 'kanji-reference-status hidden sm:col-span-2',
    text: 'Looking up kanji reference…',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  content.unshift(status);
  const candidates = element('div', {
    className: 'kanji-reference-candidates hidden sm:col-span-2',
    attrs: { role: 'listbox', 'aria-label': 'Kanji reference matches' }
  });
  content.unshift(candidates);

  const setLoading = (loading) => {
    ['meaning', 'onyomi', 'kunyomi', 'jlpt_level'].forEach((name) => {
      const field = fields[name];
      field?.closest('.field')?.classList.toggle('field-autofill-loading', loading);
      if (loading) field?.setAttribute('aria-busy', 'true');
      else field?.removeAttribute('aria-busy');
    });
    status.classList.toggle('hidden', !loading);
  };
  const setJlptLocked = (locked) => {
    const field = fields.jlpt_level;
    if (!field) return;
    field.classList.toggle('field-reference-locked', locked);
    field.setAttribute('aria-disabled', String(locked));
    field.tabIndex = locked ? -1 : 0;
    field.closest('.field')?.classList.toggle('field-reference-locked', locked);
  };
  const clearCandidates = () => {
    candidates.classList.add('hidden');
    candidates.replaceChildren();
  };
  const showCandidates = (items, transliteration) => {
    if (!items.length) return clearCandidates();
    const reading = [transliteratedValue(transliteration, 'hiragana'), transliteratedValue(transliteration, 'katakana')].filter(Boolean).join(' / ');
    candidates.replaceChildren(
      element('p', { className: 'px-1 text-xs font-semibold text-muted', text: 'Matching kanji' }),
      ...(reading ? [element('p', { className: 'px-1 text-xs text-muted', text: reading })] : []),
      ...items.map((reference) => {
        const button = element('button', {
          className: 'kanji-reference-candidate',
          text: `${reference.character} · ${reference.meanings.join(', ')} · ${reference.jlptLevel || 'JLPT not set'}`,
          attrs: { type: 'button', role: 'option', 'aria-label': `Select ${reference.character}` }
        });
        button.addEventListener('click', () => {
          characterField.value = reference.character;
          applyPristineKanjiAutofill(fields, dirtyFields, reference);
          clearCandidates();
        });
        return button;
      })
    );
    candidates.classList.remove('hidden');
  };
  ['pointerdown', 'keydown'].forEach((eventName) => {
    fields.jlpt_level?.addEventListener(eventName, (event) => {
      if (!fields.jlpt_level.classList.contains('field-reference-locked')) return;
      event.preventDefault();
    });
  });
  setJlptLocked(true);

  const dirtyFields = new Set();
  ['meaning', 'onyomi', 'kunyomi', 'jlpt_level'].forEach((name) => {
    fields[name]?.addEventListener('input', () => dirtyFields.add(name));
    fields[name]?.addEventListener('change', () => dirtyFields.add(name));
  });

  let requestSequence = 0;
  const lookup = debounce(async () => {
    const character = characterField.value.trim();
    const sequence = ++requestSequence;
    if (!character) return clearCandidates();
    setLoading(true);

    try {
      if (isSingleHanCodePoint(character)) {
        const reference = await apiRequest(`/api/kanji/lookup/${encodeURIComponent(character)}`);
        if (sequence !== requestSequence || characterField.value.trim() !== character) return;
        clearCandidates();
        applyPristineKanjiAutofill(fields, dirtyFields, reference);
      } else {
        const result = await apiRequest(`/api/kanji/reference?search=${encodeURIComponent(character)}&limit=8`);
        if (sequence !== requestSequence || characterField.value.trim() !== character) return;
        showCandidates(result.items, result.transliteration);
      }
    } catch (error) {
      if (error.status !== 404) return;
    } finally {
      if (sequence === requestSequence) setLoading(false);
    }
  }, 300);

  characterField.addEventListener('input', () => {
    requestSequence += 1;
    setLoading(false);
    clearCandidates();
    lookup();
  });
}

function enableKanjiReferenceEditWarning(content, record) {
  const fields = Object.fromEntries(['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level'].map((name) => [
    name,
    inputFor(content, name)
  ]));
  const warning = element('p', {
    className: 'kanji-reference-warning hidden sm:col-span-2',
    text: 'You are changing reference-derived kanji data. Verify the character, meaning, readings, and JLPT level before saving.',
    attrs: { role: 'status', 'aria-live': 'polite' }
  });
  content.unshift(warning);
  const updateWarning = () => {
    const values = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field?.value ?? '']));
    warning.classList.toggle('hidden', changedKanjiReferenceFields(record, values).length === 0);
  };
  Object.values(fields).forEach((field) => field?.addEventListener('input', updateWarning));
  fields.jlpt_level?.addEventListener('change', updateWarning);
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
      element('div', { className: 'flex items-start gap-3' }, [
        iconTile(iconForTitle(config.title), { className: 'preview-icon shrink-0' }),
        element('div', {}, [
          element('h2', { className: 'text-lg font-semibold text-ink', text: config.primary(item) }),
          element('p', { className: 'mt-1 text-sm text-muted', text: config.secondary(item) })
        ])
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

  async function saveRecord(record, form, close, { onDuplicateKanji } = {}) {
    const id = record?.[config.idKey];
    try {
      await apiRequest(id ? `${config.endpoint}/${id}` : config.endpoint, {
        method: id ? 'PUT' : 'POST',
        body: formPayload(form, config)
      });
    } catch (error) {
      const existingKanji = config === ENTITY_CONFIGS.kanji && !id ? existingKanjiFromDuplicateError(error) : null;
      if (existingKanji) onDuplicateKanji?.(existingKanji);
      throw error;
    }
    close();
    showToast(id ? `${config.title} record updated.` : `${config.title} record created.`);
    if (!id) currentPage = 1;
    await load();
  }

  function openRecordDialog(record = {}) {
    const content = buildFields(config, record);
    let closeDialog = () => {};
    const duplicateNotice = element('div', {
      className: 'kanji-duplicate-notice hidden sm:col-span-2',
      attrs: { role: 'status', 'aria-live': 'polite' }
    });
    const showDuplicateKanji = (existingKanji) => {
      const viewButton = element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: 'View Kanji', attrs: { type: 'button' } });
      viewButton.addEventListener('click', async () => {
        closeDialog();
        await viewRecord({ id_kanji: existingKanji.idKanji });
      });
      duplicateNotice.replaceChildren(
        element('p', { className: 'font-semibold', text: 'Already learning this kanji.' }),
        element('p', { className: 'mt-1', text: `${existingKanji.character} · ${existingKanji.meaning || 'Meaning not recorded'}${existingKanji.jlptLevel ? ` · ${existingKanji.jlptLevel}` : ''}` }),
        viewButton
      );
      duplicateNotice.classList.remove('hidden');
    };
    enableRomajiConversion(content, config);
    if (config === ENTITY_CONFIGS.kanji && !record[config.idKey]) {
      content.unshift(duplicateNotice);
      enableKanjiReferenceAutofill(content);
    } else if (config === ENTITY_CONFIGS.kanji) {
      enableKanjiReferenceEditWarning(content, record);
    }
    closeDialog = openDialog({
      title: record[config.idKey] ? `Edit ${config.singular}` : `Add ${config.singular}`,
      content,
      submitLabel: record[config.idKey] ? 'Save changes' : 'Create record',
      onSubmit: (form, close) => saveRecord(record, form, close, { onDuplicateKanji: showDuplicateKanji })
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
