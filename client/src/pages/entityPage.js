import { apiRequest, queryString } from '../api';
import { enableVocabularyAutofill } from '../vocabularyAutofill.js';
import { enableGrammarReferenceAutofill, formatGrammarReferenceStructures } from '../grammarReferenceAutofill.js';
import { buildKanjiImportPayload, getContextKanji, getReadingContext, formatKanjiContextEntry, VOCAB_READING_NOTICE } from '../vocabularyReading.js';
import { applyPristineKanjiAutofill, changedKanjiReferenceFields, enableRomajiConversion, existingKanjiFromDuplicateError, isSingleHanCodePoint, transliteratedValue } from '../kanjiReference';
import { buildKanjiIdentity, normalizeKanjiOwnedIdentity } from '../kanjiDetail.js';
import {
  debounce,
  confirmDialog,
  element,
  emptyState,
  errorState,
  field,
  loadingState,
  openDetailModal,
  openDialog,
  pageHeader,
  paginationControls,
  showToast,
  withGlobalLoading,
  withPendingAction
} from '../ui';
import { iconForTitle, iconTile } from '../icons';
import { speakJapanese } from '../speech.js';
import { mountKanjiWriting } from '../kanjiWriting.js';

const JLPT_OPTIONS = [
  { value: '', label: 'Any / not set' },
  ...['N5', 'N4', 'N3', 'N2', 'N1'].map((value) => ({ value, label: value }))
];
const STATUS_OPTIONS = ['New', 'Learning', 'Familiar', 'Mastered'].map((value) => ({ value, label: value }));

// Shared SRS date formatters for every entity detail (kanji keeps its own
// local copies inside a richer layout; vocabulary/grammar reuse these).
function formatSrsDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatSrsDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const ENTITY_CONFIGS = {
  vocabulary: {
    endpoint: '/api/vocabulary',
    idKey: 'id_vocabulary',
    exampleIdKey: 'id_usage_example',
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
    renderDetail: (item, actions) => {
      // Phase 5 (Level A): authoritative word reading + contextual kanji
      // readings. Never split the word reading per kanji.
      const readingContext = getReadingContext(item);
      const contextKanji = getContextKanji(item).map(formatKanjiContextEntry).filter(Boolean);
      const wordReading = readingContext?.wordReading?.value ?? item.reading;
      const kanjiNotice = readingContext?.notice || VOCAB_READING_NOTICE;
      // SRS state (same shape as kanji detail, presentation only).
      const review = item.review || null;
      const srsSection = element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'aria-label': 'SRS review state' } }, [
        element('h3', { className: 'font-semibold text-ink', text: 'SRS Review' }),
        review ? element('dl', { className: 'mt-3 grid gap-3 text-sm sm:grid-cols-2' }, [
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Next Review' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatSrsDate(review.dueOn) })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Interval' }), element('dd', { className: 'mt-1 font-medium text-ink', text: `${review.intervalDays || 0} days` })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Last Reviewed' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatSrsDateTime(review.lastReviewedAt) })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Last Result' }), element('dd', { className: 'mt-1 font-medium text-ink', text: review.lastResult || '—' })])
        ]) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No review scheduled' })
      ]);
      // Phase 5 enhancement: import targets are entries with reference
      // meanings (kanji creation requires a meaning). "Add all" appears only
      // when at least two such missing kanji exist.
      const importableKanji = contextKanji.filter((kanji) => kanji.importable);
      return element('div', { className: 'sm:col-span-2' }, [
      element('dl', { className: 'grid gap-3 text-sm sm:grid-cols-2' }, [
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Word reading (authoritative for this entry)' }), element('dd', { className: 'mt-1 font-jp font-medium text-ink', text: wordReading || 'Not recorded', attrs: { lang: 'ja' } })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Meaning' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.meaning })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'JLPT tag' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.jlpt_level || 'Not set' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Status (self-reported)' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.status || 'New' })])
      ]),
      srsSection,
      ...(item.notes ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Notes' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.notes })])] : []),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'aria-label': 'Kanji reading context' } }, [
        element('div', { className: 'flex items-start justify-between gap-3' }, [
          element('div', {}, [
            element('h3', { className: 'font-semibold text-ink', text: 'Kanji reading context' }),
            element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Kanji context — not split from this word. Per-kanji alignment: unavailable (unverified).' })
          ]),
          ...(importableKanji.length > 1 ? [element('button', { className: 'button-secondary min-h-9 shrink-0 px-3 py-1.5', text: `Add all missing Kanji (${importableKanji.length})`, attrs: { type: 'button', 'data-kanji-add-all': 'true' } })] : [])
        ]),
        contextKanji.length ? element('div', { className: 'mt-3 grid gap-3' }, contextKanji.map((kanji) => {
          const title = kanji.meaning ? `${kanji.character} · ${kanji.meaning}` : (kanji.referenceMeanings ? `${kanji.character} · ${kanji.referenceMeanings} (reference)` : kanji.character);
          return element('article', { className: 'rounded-md bg-paper p-3' }, [
          element('div', { className: 'flex items-start justify-between gap-3' }, [
            element('div', {}, [
              element('p', { className: 'font-jp font-medium text-ink', text: title, attrs: { lang: 'ja' } }),
              element('p', { className: 'mt-1 text-xs text-muted', text: 'No per-kanji reading claimed for this word.' })
            ]),
            kanji.inUserCollection
              ? element('span', { className: 'status-pill shrink-0 text-xs', text: 'In your Kanji collection' })
              : (kanji.hasReference
                ? element('span', { className: 'status-pill shrink-0 text-xs', text: 'Not in your Kanji collection' })
                : element('span', { className: 'status-pill shrink-0 text-xs', text: 'No reference data' }))
          ]),
          element('dl', { className: 'mt-2 grid gap-2 text-sm sm:grid-cols-2' }, [
            element('div', {}, [element('dt', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Your on\u2019yomi (note \u2014 not from this word)' }), element('dd', { className: 'mt-1 text-ink/80', text: kanji.userOnyomi || 'Not recorded' })]),
            element('div', {}, [element('dt', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Your kun\u2019yomi (note \u2014 not from this word)' }), element('dd', { className: 'mt-1 text-ink/80', text: kanji.userKunyomi || 'Not recorded' })]),
            element('div', {}, [element('dt', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Reference on\u2019yomi (context only)' }), element('dd', { className: 'mt-1 text-ink/80', text: kanji.referenceOnyomi || '—' })]),
            element('div', {}, [element('dt', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Reference kun\u2019yomi (context only)' }), element('dd', { className: 'mt-1 text-ink/80', text: kanji.referenceKunyomi || '—' })])
          ]),
          ...(kanji.referenceMeanings ? [element('p', { className: 'mt-2 text-xs text-muted', text: `Reference meanings: ${kanji.referenceMeanings}${kanji.referenceJlptLevel ? ` · JLPT ${kanji.referenceJlptLevel} (Reference)` : ''}` })] : []),
          ...(!kanji.inUserCollection && kanji.importable ? [element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: 'Add to My Kanji', attrs: { type: 'button', 'data-kanji-add': kanji.character } })] : []),
          ...(!kanji.inUserCollection && !kanji.hasReference ? [element('p', { className: 'mt-2 text-xs text-muted', text: 'Add it manually from the Kanji tab.' })] : [])
        ])})) : element('p', { className: 'mt-2 text-sm text-muted', text: item.kanji?.length ? 'Kanji linked, but no reading context is available.' : 'No kanji linked.' }),
        element('p', { className: 'mt-3 text-xs leading-5 text-muted', text: kanjiNotice })
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [
        element('div', { className: 'flex items-center justify-between gap-3' }, [element('h3', { className: 'font-semibold text-ink', text: 'Example usage' }), element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Add example', attrs: { type: 'button', 'data-example-action': 'add' } })]),
        item.examples?.length ? element('div', { className: 'mt-3 grid gap-3' }, item.examples.map((example) => element('article', { className: 'rounded-md bg-paper p-3' }, [
          element('p', { className: 'whitespace-pre-wrap text-sm leading-6 text-ink', text: example.sentence }),
          ...(example.translation ? [element('p', { className: 'mt-2 text-sm text-muted', text: example.translation })] : []),
          element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: 'Edit example', attrs: { type: 'button', 'data-example-action': 'edit', 'data-example-id': example.id_usage_example } })
        ]))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No examples recorded yet.' })
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'data-vocab-cloze': 'true' } }, [
        element('h3', { className: 'font-semibold text-ink', text: 'Cloze Practice' }),
        element('p', { className: 'mt-2 text-sm text-muted', text: 'Loading cloze sentences from your saved examples…' })
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'data-vocab-tags': 'true' } }, [
        element('h3', { className: 'font-semibold text-ink', text: 'Tags' }),
        element('p', { className: 'mt-2 text-sm text-muted', text: 'Loading tags…' })
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'data-grammar-example-context': 'true' } }, [
        element('h3', { className: 'font-semibold text-ink', text: 'Grammar in your examples' }),
        element('p', { className: 'mt-2 text-sm text-muted', text: 'Loading grammar detected in saved examples…' })
      ])
    ])},
    fields: [
      { name: 'word', label: 'Word', required: true, maxLength: 100 },
      { name: 'reading', label: 'Reading', maxLength: 150 },
      { name: 'meaning', label: 'Meaning', required: true, maxLength: 255, wide: true },
      { name: 'example_sentence', label: 'Example sentence', type: 'textarea', maxLength: 2000, wide: true, createOnly: true, section: 'example' },
      { name: 'example_translation', label: 'Translation', type: 'textarea', maxLength: 2000, createOnly: true, section: 'example' },
      { name: 'example_notes', label: 'Example notes', type: 'textarea', maxLength: 1500, createOnly: true, section: 'example' },
      { name: 'jlpt_level', label: 'JLPT tag', options: JLPT_OPTIONS, description: 'Your label for filtering — not official reference data.' },
      { name: 'status', label: 'Status', options: STATUS_OPTIONS, defaultValue: 'New', description: 'Your personal status label — not review-verified.' },
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
      const review = item.review || null;
      const encounters = item.encounters || { count: 0, firstEncounteredAt: null, lastEncounteredAt: null, bySource: [], recent: [] };
      const vocab = item.vocabulary || [];
      const usageExamples = item.usageExamples || [];
      const notes = item.notes || null;
      const linkedNotes = item.linkedNotes || [];

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

      return element('div', { className: 'sm:col-span-2 kanji-detail-body space-y-5' }, [
        // 1. Identity — one shared builder (see ../kanjiDetail.js). Meaning
        // headline, On'yomi/Kun'yomi with the Reference-vs-Your-record split,
        // JLPT/strokes metadata, and status all live here.
        buildKanjiIdentity(normalizeKanjiOwnedIdentity(item), element),

        // Handwriting practice (MVP): stroke-order overlay + order-only
        // check in a modal. Lazy + fail-open like the stroke slots above.
        element('section', { className: 'kanji-detail-section surface p-5', attrs: { 'aria-label': 'Handwriting practice' } }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Handwriting Practice' }),
          element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Trace the character in stroke order. Only the order is checked.' }),
          element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: 'Practice writing', attrs: { type: 'button', 'data-writing-practice': 'true' } })
        ]),

        // 2 + 3. SRS Review + Encounter Intelligence side by side on wide
        // dialogs; stacked otherwise. Exposure stays exposure-only.
        element('div', { className: 'grid gap-4 lg:grid-cols-2' }, [
        element('section', { className: 'kanji-detail-section surface p-5' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'SRS Review' }),
          review ? element('dl', { className: 'mt-3 grid gap-3 text-sm sm:grid-cols-2' }, [
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Next Review' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDate(review.dueOn) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Interval' }), element('dd', { className: 'mt-1 font-medium text-ink', text: `${review.intervalDays || 0} days` })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Last Reviewed' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatDateTime(review.lastReviewedAt) })]),
            element('div', { className: 'kanji-fact' }, [element('dt', { className: 'text-muted', text: 'Last Result' }), element('dd', { className: 'mt-1 font-medium text-ink', text: review.lastResult || '—' })])
          ]) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No review scheduled' })
        ]),

        // 4. Encounter Intelligence — exposure only, never review evidence.
        element('section', { className: 'kanji-detail-section surface p-5' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Encounter Intelligence' }),
          element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Seen in your words and writings — exposure only, not review evidence.' }),
          element('dl', { className: 'mt-3 grid gap-4 sm:grid-cols-2' }, [
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
        ]),

        // 5. Connected Vocabulary
        element('section', { className: 'kanji-detail-section surface p-5' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Connected Vocabulary' }),
          vocab.length ? element('div', { className: 'mt-3 grid gap-3 sm:grid-cols-2' }, vocab.map((word) => {
            const wordExamples = usageExamples.filter((ex) => ex.id_vocabulary === word.id_vocabulary);
            return element('article', { className: 'detail-panel p-3' }, [
              element('div', { className: 'flex items-start justify-between gap-3' }, [
                element('div', {}, [
                  element('p', { className: 'font-jp font-medium text-ink', text: word.word }),
                  element('p', { className: 'font-jp text-sm text-muted', text: word.reading || 'Reading not recorded' }),
                  element('p', { className: 'mt-1 text-sm text-ink/80', text: word.meaning })
                ]),
                element('div', { className: 'flex flex-col items-end gap-1' }, [
                  word.jlpt_level && element('span', { className: 'status-pill status-jlpt text-xs', text: word.jlpt_level }),
                  element('span', { className: `status-pill text-xs ${statusColors[word.status] || 'bg-stone text-stone-foreground'}`, text: word.status || 'New' })
                ])
              ]),
              wordExamples.length ? element('div', { className: 'mt-3 grid gap-2' }, wordExamples.map((ex) => element('div', { className: 'detail-panel p-2 text-xs' }, [
                element('p', { className: 'whitespace-pre-wrap text-ink', text: ex.sentence }),
                ex.translation && element('p', { className: 'mt-1 text-muted', text: ex.translation })
              ]))) : element('p', { className: 'mt-2 text-xs text-muted', text: 'No examples recorded yet.' })
            ]);
          })) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No connected vocabulary yet' })
        ]),

        // 6. Personal Notes
        element('section', { className: 'kanji-detail-section surface p-5' }, [
          element('h3', { className: 'font-semibold text-ink', text: 'Personal Notes' }),
          notes ? element('div', { className: 'mt-2' }, [
            element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Kanji Notes' }),
            element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: notes })
          ]) : null,
          linkedNotes.length ? element('div', { className: 'mt-4' }, [
            element('h4', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Linked Notes' }),
            element('div', { className: 'mt-2 grid gap-2' }, linkedNotes.map((note) => element('article', { className: 'detail-panel p-3' }, [
              element('h5', { className: 'font-medium text-ink', text: note.title || 'Untitled' }),
              element('p', { className: 'mt-1 text-sm text-muted', text: note.category }),
              element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: note.body })
            ])))
          ]) : null,
          !notes && !linkedNotes.length ? element('p', { className: 'mt-2 text-sm text-muted', text: 'No personal notes' }) : null
        ])
      ]);
    },
    fields: [
      { name: 'character_kanji', label: 'Character', required: true, maxLength: 4 },
      { name: 'meaning', label: 'Meaning', required: true, maxLength: 255 },
      { name: 'onyomi', label: 'Onyomi', maxLength: 255 },
      { name: 'kunyomi', label: 'Kunyomi', maxLength: 255 },
      { name: 'jlpt_level', label: 'JLPT tag', options: JLPT_OPTIONS, description: 'Your label for filtering — not official reference data.' },
      { name: 'status', label: 'Status', options: STATUS_OPTIONS, defaultValue: 'New', description: 'Your personal status label — not review-verified.' },
      { name: 'notes', label: 'Notes', type: 'textarea', maxLength: 1500, wide: true }
    ]
  },
  grammar: {
    endpoint: '/api/grammar',
    idKey: 'id_grammar',
    exampleIdKey: 'id_grammar_example',
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
    renderDetail: (item) => {
      // SRS state (same shape as kanji detail, presentation only).
      const grammarReview = item.review || null;
      return element('div', { className: 'sm:col-span-2' }, [
      element('dl', { className: 'grid gap-3 text-sm sm:grid-cols-2' }, [
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Grammar point' }), element('dd', { className: 'mt-1 font-jp font-medium text-ink', text: item.grammar_point })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Meaning' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.meaning })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'JLPT tag' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.jlpt_level || 'Not set' })]),
        element('div', {}, [element('dt', { className: 'text-muted', text: 'Status (self-reported)' }), element('dd', { className: 'mt-1 font-medium text-ink', text: item.status || 'New' })])
      ]),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'aria-label': 'SRS review state' } }, [
        element('h3', { className: 'font-semibold text-ink', text: 'SRS Review' }),
        grammarReview ? element('dl', { className: 'mt-3 grid gap-3 text-sm sm:grid-cols-2' }, [
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Next Review' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatSrsDate(grammarReview.dueOn) })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Interval' }), element('dd', { className: 'mt-1 font-medium text-ink', text: `${grammarReview.intervalDays || 0} days` })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Last Reviewed' }), element('dd', { className: 'mt-1 font-medium text-ink', text: formatSrsDateTime(grammarReview.lastReviewedAt) })]),
          element('div', {}, [element('dt', { className: 'text-muted', text: 'Last Result' }), element('dd', { className: 'mt-1 font-medium text-ink', text: grammarReview.lastResult || '—' })])
        ]) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No review scheduled' })
      ]),
      ...(item.structure ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Structure' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.structure })])] : []),
      // Legacy single example: hidden once managed examples exist (the
      // migration backfills the legacy text as the first managed row, so
      // showing both would duplicate it). Kept as fallback for records
      // without managed rows.
      ...((item.example && !item.examples?.length) ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Example' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.example })])] : []),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [
        element('div', { className: 'flex items-center justify-between gap-3' }, [element('h3', { className: 'font-semibold text-ink', text: 'Examples' }), element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'Add example', attrs: { type: 'button', 'data-example-action': 'add' } })]),
        item.examples?.length ? element('div', { className: 'mt-3 grid gap-3' }, item.examples.map((example) => element('article', { className: 'rounded-md bg-paper p-3' }, [
          element('p', { className: 'whitespace-pre-wrap text-sm leading-6 text-ink', text: example.sentence }),
          ...(example.translation ? [element('p', { className: 'mt-2 text-sm text-muted', text: example.translation })] : []),
          element('button', { className: 'button-secondary mt-3 min-h-9 px-3 py-1.5', text: 'Edit example', attrs: { type: 'button', 'data-example-action': 'edit', 'data-example-id': example.id_grammar_example } })
        ]))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No examples recorded yet.' })
      ]),
      ...(item.notes ? [element('section', { className: 'mt-5 rounded-lg border border-stone p-4' }, [element('h3', { className: 'font-semibold text-ink', text: 'Notes' }), element('p', { className: 'mt-2 whitespace-pre-wrap text-sm leading-6 text-ink/80', text: item.notes })])] : []),
      element('section', { className: 'mt-5 rounded-lg border border-stone p-4', attrs: { 'data-vocabulary-example-context': 'true' } }, [
        element('h3', { className: 'font-semibold text-ink', text: 'Vocabulary in this example' }),
        element('p', { className: 'mt-2 text-sm text-muted', text: 'Loading vocabulary found in this saved example…' })
      ])
      ]);
    },
    fields: [
      { name: 'grammar_point', label: 'Grammar point', required: true, maxLength: 100 },
      { name: 'meaning', label: 'Meaning', required: true, maxLength: 255 },
      { name: 'structure', label: 'Structure', type: 'textarea', maxLength: 2000, wide: true },
      { name: 'example', label: 'Example', type: 'textarea', maxLength: 2000, wide: true },
      { name: 'jlpt_level', label: 'JLPT tag', options: JLPT_OPTIONS, description: 'Your label for filtering — not official reference data.' },
      { name: 'status', label: 'Status', options: STATUS_OPTIONS, defaultValue: 'New', description: 'Your personal status label — not review-verified.' },
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
  const payload = Object.fromEntries(config.fields.map(({ name }) => [name, formData.get(name) ?? '']));
  if (config === ENTITY_CONFIGS.grammar && formData.get('reference_id')) payload.reference_id = formData.get('reference_id');
  return payload;
}

function inputFor(content, name) {
  return content.map((item) => item.matches?.(`[name="${name}"]`) ? item : item.querySelector?.(`[name="${name}"]`)).find(Boolean);
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
    attrs: { role: 'group', 'aria-label': 'Kanji reference matches' }
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
    // Locked stays keyboard-focusable so the reference value remains
    // perceivable; editing is still blocked by the guards below.
    field.tabIndex = 0;
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
          attrs: { type: 'button', 'aria-label': `Select ${reference.character}` }
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
      // Never trap focus: Tab/Escape must keep working on the locked field.
      if (event.type === 'keydown' && (event.key === 'Tab' || event.key === 'Escape')) return;
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

function enableKanjiReferenceRestore(content, record) {
  const fields = Object.fromEntries(['character_kanji', 'meaning', 'onyomi', 'kunyomi', 'jlpt_level'].map((name) => [
    name,
    inputFor(content, name)
  ]));
  const characterField = fields.character_kanji;
  if (!characterField) return;

  const restoreButton = element('button', {
    className: 'button-secondary mt-2 min-h-9 px-3 py-1.5 sm:col-span-2',
    text: 'Restore from OpenJLPT',
    attrs: { type: 'button' }
  });
  content.unshift(restoreButton);

  restoreButton.addEventListener('click', () => {
    const character = characterField.value.trim();
    if (!character) return;

    withPendingAction(restoreButton, async () => {
      const reference = await apiRequest(`/api/kanji/lookup/${encodeURIComponent(character)}`);
      if (!reference) {
        showToast('No OpenJLPT reference found for this character.', 'error');
        return;
      }

      const referenceMeanings = reference.meanings?.join(', ') || '';
      const referenceOnyomi = reference.onyomi?.join(', ') || '';
      const referenceKunyomi = reference.kunyomi?.join(', ') || '';
      const referenceJlpt = reference.jlptLevel || '';

      const changes = [];
      if (referenceMeanings && fields.meaning?.value !== referenceMeanings) changes.push('Meaning');
      if (referenceOnyomi && fields.onyomi?.value !== referenceOnyomi) changes.push('On\'yomi');
      if (referenceKunyomi && fields.kunyomi?.value !== referenceKunyomi) changes.push('Kun\'yomi');
      if (referenceJlpt && fields.jlpt_level?.value !== referenceJlpt) changes.push('JLPT level');

      if (changes.length === 0) {
        showToast('All reference-derived fields already match OpenJLPT data.');
        return;
      }

      confirmDialog({
        title: 'Restore reference values?',
        description: `Replace the following fields with OpenJLPT reference data?\n\n` +
          changes.map(c => `• ${c}`).join('\n') +
          `\n\nYour personal notes, status, SRS/review data, encounters, and linked vocabulary will NOT be changed.`,
        confirmLabel: 'Restore',
        onConfirm: async () => {
          if (referenceMeanings) fields.meaning.value = referenceMeanings;
          if (referenceOnyomi) fields.onyomi.value = referenceOnyomi;
          if (referenceKunyomi) fields.kunyomi.value = referenceKunyomi;
          if (referenceJlpt) fields.jlpt_level.value = referenceJlpt;
          showToast('Reference values restored. Review and save to persist.');
        }
      });
    }, { pendingLabel: 'Loading…' }).catch((error) => {
      showToast(error.message || 'Failed to restore reference data.', 'error');
    });
  });
}

function recordCard(item, config, onView, onEdit, onDelete) {
  // v5.1-E collection hierarchy: PRIMARY Japanese identity, SECONDARY
  // reading/meaning, TERTIARY JLPT/status metadata. Actions are contextual:
  // View (secondary weight) opens the read-first drawer; Edit is a quiet
  // ghost; Delete is a restrained ghost-danger. Semantics unchanged.
  const viewButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5', text: 'View', attrs: { type: 'button' } });
  const editButton = element('button', { className: 'button-ghost min-h-9 px-3 py-1.5', text: 'Edit', attrs: { type: 'button' } });
  const deleteButton = element('button', { className: 'button-ghost button-ghost--danger min-h-9 px-3 py-1.5', text: 'Delete', attrs: { type: 'button' } });
  viewButton.addEventListener('click', () => onView(item));
  editButton.addEventListener('click', () => onEdit(item));
  deleteButton.addEventListener('click', () => onDelete(item));

  return element('article', { className: 'surface collection-card collection-card--interactive flex min-h-48 flex-col p-5' }, [
    element('div', { className: 'flex items-start justify-between gap-4' }, [
      element('div', { className: 'flex min-w-0 items-start gap-3' }, [
        iconTile(iconForTitle(config.title), { className: 'preview-icon shrink-0' }),
        element('div', { className: 'min-w-0' }, [
          element('h2', { className: 'entity-row-primary break-words font-jp text-lg font-semibold text-ink', text: config.primary(item), attrs: { lang: 'ja' } }),
          element('p', { className: 'entity-row-secondary mt-1 break-words text-sm text-muted', text: config.secondary(item) })
        ])
      ]),
      element('span', { className: 'status-pill shrink-0', text: item.status || 'New', attrs: { title: 'Self-reported status' } })
    ]),
    element('p', { className: 'mt-3 line-clamp-3 text-sm leading-6 text-ink/80', text: config.detail(item) }),
    element('div', { className: 'entity-row-tertiary mt-auto flex items-end justify-between gap-3 pt-5' }, [
      element('span', { className: 'text-xs font-semibold text-muted', text: item.jlpt_level || 'JLPT tag not set' }),
      element('div', { className: 'flex gap-1' }, [viewButton, editButton, deleteButton])
    ])
  ]);
}

export function renderEntityPage(container, config) {
  const pageSize = 30;
  let currentPage = 1;
  let loadSequence = 0;
  let lastItems = [];
  const addButton = element('button', { className: 'button-primary', text: `Add ${config.singular}`, attrs: { type: 'button' } });
  const search = element('input', { className: 'field-control', attrs: { type: 'search', placeholder: config.searchPlaceholder, 'aria-label': `Search ${config.title}` } });
  const jlpt = element('select', { className: 'field-control', attrs: { 'aria-label': 'Filter by JLPT tag' } }, JLPT_OPTIONS.map((option) => element('option', { text: option.label, attrs: { value: option.value } })));
  const status = element('select', { className: 'field-control', attrs: { 'aria-label': 'Filter by status' } }, [
    element('option', { text: 'Any status', attrs: { value: '' } }),
    ...STATUS_OPTIONS.map((option) => element('option', { text: option.label, attrs: { value: option.value } }))
  ]);
  const results = element('div');
  const filterBar = element('div', { className: 'surface mb-5 grid gap-3 p-4 md:grid-cols-[minmax(14rem,1fr)_10rem_11rem]' }, [search, jlpt, status]);
  const shareableType = { '/api/vocabulary': 'vocabulary', '/api/kanji': 'kanji', '/api/grammar': 'grammar' }[config.endpoint] || null;
  const deckBar = shareableType ? element('div', { className: 'mb-5 flex flex-col gap-2 sm:flex-row' }, [
    element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Share deck', attrs: { type: 'button', 'data-deck-action': 'share' } }),
    element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Import deck', attrs: { type: 'button', 'data-deck-action': 'import' } })
  ]) : null;
  const page = element('section', {}, [
    pageHeader({ eyebrow: config.eyebrow, title: config.title, description: config.description, action: addButton }),
    filterBar,
    ...(deckBar ? [deckBar] : []),
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
      lastItems = Array.isArray(items) ? items : [];
      if (!items.length && currentPage > 1 && pagination.totalPages > 0) {
        currentPage = pagination.totalPages;
        await load();
        return;
      }
      if (!items.length) {
        results.replaceChildren(emptyState({ title: `No ${config.title.toLowerCase()} found`, description: config.empty, icon: iconForTitle(config.title) }));
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

  // Shared decks (social): export the current page as a signed code, or
  // import a pasted code as new rows. Fail-open with toasts; the list
  // refreshes after an import.
  const copyDeckCode = async (text) => {
    try {
      if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the manual fallback */ }
    try {
      const area = element('textarea', { attrs: { readonly: '' } });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied === true;
    } catch {
      return false;
    }
  };
  const openShareDeck = () => {
    if (!lastItems.length) { showToast('Nothing to share on this page.', 'error'); return; }
    const boxes = lastItems.map((item) => {
      const box = element('input', { attrs: { type: 'checkbox', 'aria-label': `Include ${config.primary(item)}` } });
      box.checked = true;
      return { id: item[config.idKey], label: config.primary(item), box };
    });
    const titleInput = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'Deck title', placeholder: 'Deck title (optional)', maxLength: '120' } });
    const descriptionInput = element('textarea', { className: 'field-control', attrs: { 'aria-label': 'Deck description', placeholder: 'Description (optional)', maxLength: '500' } });
    const output = element('textarea', { className: 'field-control font-mono text-xs', attrs: { readonly: '', rows: '4', 'aria-label': 'Share code' } });
    output.hidden = true;
    const generate = element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Generate code', attrs: { type: 'button' } });
    generate.addEventListener('click', () => {
      const ids = boxes.filter(({ box }) => box.checked).map(({ id }) => id);
      if (!ids.length) { showToast('Select at least one item.', 'error'); return; }
      withPendingAction(generate, async () => {
        const deck = await apiRequest('/api/share/deck', { method: 'POST', body: { entityType: shareableType, ids, title: titleInput.value, description: descriptionInput.value } });
        output.value = deck.shareCode;
        output.hidden = false;
        showToast(`Share code ready (${deck.itemCount} items).`);
      }).catch((error) => showToast(error?.message || 'Unable to create the share deck.', 'error'));
    });
    const copy = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Copy code', attrs: { type: 'button' } });
    copy.addEventListener('click', async () => {
      if (!output.value) { showToast('Generate a code first.', 'error'); return; }
      const copied = await copyDeckCode(output.value);
      showToast(copied ? 'Share code copied.' : 'Copy failed — select the code manually.', copied ? 'success' : 'error');
    });
    openDialog({
      title: `Share ${config.title} deck`,
      description: 'Selected items become a signed code. Importing creates new rows — nothing is overwritten.',
      content: [
        element('div', { className: 'grid gap-1.5' }, boxes.map(({ label, box }) => element('label', { className: 'flex items-center gap-2 text-sm text-ink' }, [box, element('span', { text: label })]))),
        titleInput,
        descriptionInput,
        element('div', { className: 'flex flex-col gap-2 sm:flex-row' }, [generate, copy]),
        output
      ],
      submitLabel: 'Close',
      onSubmit: async (form, close) => { close(); }
    });
  };
  const openImportDeck = () => {
    const paste = element('textarea', { className: 'field-control font-mono text-xs', attrs: { rows: '4', 'aria-label': 'Paste share code', placeholder: 'Paste a share code…' } });
    const preview = element('div', { className: 'grid gap-2' });
    let pendingCode = '';
    const previewButton = element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Preview', attrs: { type: 'button' } });
    previewButton.addEventListener('click', () => {
      const code = String(paste.value || '').trim();
      if (!code) { showToast('Paste a share code first.', 'error'); return; }
      withPendingAction(previewButton, async () => {
        const deck = await apiRequest(`/api/share/deck/${encodeURIComponent(code)}`);
        pendingCode = code;
        const items = Array.isArray(deck.items) ? deck.items : [];
        const labelOf = (entry) => entry.word || entry.character_kanji || entry.grammar_point || 'item';
        preview.replaceChildren(
          element('p', { className: 'text-sm font-semibold text-ink', text: `${deck.title || 'Shared deck'} · ${deck.entityType} · ${items.length} items` }),
          ...(deck.description ? [element('p', { className: 'text-sm text-muted', text: deck.description })] : []),
          element('ul', { className: 'grid gap-1 text-sm text-ink', attrs: { role: 'list' } }, items.slice(0, 10).map((entry) => element('li', { text: labelOf(entry) }))),
          ...(items.length > 10 ? [element('p', { className: 'text-xs text-muted', text: `…and ${items.length - 10} more` })] : []),
          element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Import as new rows', attrs: { type: 'button', 'data-deck-action': 'confirm-import' } })
        );
        preview.querySelector('[data-deck-action="confirm-import"]')?.addEventListener('click', () => {
          apiRequest(`/api/share/deck/${encodeURIComponent(pendingCode)}/import`, { method: 'POST' })
            .then((result) => {
              showToast(`Imported ${result.imported}, skipped ${result.skipped}.`);
              load();
            })
            .catch((error) => showToast(error?.message || 'Unable to import the deck.', 'error'));
        });
      }).catch((error) => showToast(error?.message || 'Share code is invalid or expired.', 'error'));
    });
    openDialog({
      title: `Import ${config.title} deck`,
      description: 'Paste a share code to preview it, then import its items as new rows.',
      content: [paste, previewButton, preview],
      submitLabel: 'Close',
      onSubmit: async (form, close) => { close(); }
    });
  };
  deckBar?.querySelector('[data-deck-action="share"]')?.addEventListener('click', openShareDeck);
  deckBar?.querySelector('[data-deck-action="import"]')?.addEventListener('click', openImportDeck);

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
    enableRomajiConversion(content, config, apiRequest);
    if (config === ENTITY_CONFIGS.vocabulary && !record[config.idKey]) {
      enableVocabularyAutofill(content);
    }
    if (config === ENTITY_CONFIGS.grammar && !record[config.idKey]) {
      enableGrammarReferenceAutofill(content, apiRequest);
    }
    if (config === ENTITY_CONFIGS.kanji && !record[config.idKey]) {
      content.unshift(duplicateNotice);
      enableKanjiReferenceAutofill(content);
    } else if (config === ENTITY_CONFIGS.kanji) {
      enableKanjiReferenceEditWarning(content, record);
      enableKanjiReferenceRestore(content, record);
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
      // Edit forms wait on a fetch; the overlay covers slow loads only.
      openRecordDialog(await withGlobalLoading(
        () => apiRequest(`${config.endpoint}/${item[config.idKey]}`),
        { label: `Loading ${config.singular}…` }
      ));
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function viewRecord(item) {
    try {
      const record = await withGlobalLoading(
        () => apiRequest(`${config.endpoint}/${item[config.idKey]}`),
        { label: `Loading ${config.singular}…` }
      );
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
          const exampleId = example?.[config.exampleIdKey];
          const path = example ? `${config.endpoint}/${record[config.idKey]}/examples/${exampleId}` : `${config.endpoint}/${record[config.idKey]}/examples`;
          await apiRequest(path, { method: example ? 'PUT' : 'POST', body: { sentence: data.get('sentence'), translation: data.get('translation'), notes: data.get('notes') } });
          close();
          showToast(example ? 'Usage example updated.' : 'Usage example added.');
          await viewRecord(record);
        }
      });
      const content = config.renderDetail ? config.renderDetail(record, { openExampleForm }) : element('div', { className: 'sm:col-span-2 text-sm text-muted', text: 'A detailed preview is not available for this record yet.' });
      content.querySelector('[data-example-action="add"]')?.addEventListener('click', () => openExampleForm());
      content.querySelectorAll('[data-example-action="edit"]').forEach((button) => button.addEventListener('click', () => openExampleForm((record.examples || []).find((example) => example[config.exampleIdKey] === Number(button.dataset.exampleId)))));
      // Phase 5 enhancement (vocabulary only): explicit per-kanji import.
      // Uses the existing kanji creation endpoint (which resolves
      // reference_id, enforces ownership and duplicate rules), then
      // re-opens the detail from a fresh fetch — no full-page reload.
      if (config === ENTITY_CONFIGS.vocabulary) {
        const contextByChar = new Map((record.readingContext?.kanji || []).map((entry) => [entry.character, entry]));
        const importKanji = async (character) => {
          const payload = buildKanjiImportPayload(contextByChar.get(character));
          if (!payload) {
            showToast('Cannot import this kanji automatically. Add it from the Kanji tab.', 'error');
            return false;
          }
          try {
            await apiRequest('/api/kanji', { method: 'POST', body: payload });
            showToast(`${character} added to your Kanji collection.`);
            return true;
          } catch (error) {
            // 409 = already learning (e.g. added in another tab): refresh
            // so the card flips to "In your Kanji collection".
            if (error?.status === 409) {
              showToast(`${character} is already in your Kanji collection.`);
              return true;
            }
            showToast(error.message, 'error');
            return false;
          }
        };
        content.querySelectorAll('[data-kanji-add]').forEach((button) => button.addEventListener('click', () => {
          withPendingAction(button, async () => {
            if (await importKanji(button.dataset.kanjiAdd)) await viewRecord(record);
          }, { pendingLabel: 'Adding…' });
        }));
        content.querySelector('[data-kanji-add-all]')?.addEventListener('click', (event) => {
          const addAllButton = event.currentTarget;
          withPendingAction(addAllButton, async ({ setProgress }) => {
            const targets = [...content.querySelectorAll('[data-kanji-add]')].map((button) => button.dataset.kanjiAdd);
            let added = 0;
            let index = 0;
            for (const character of targets) {
              index += 1;
              setProgress(index, targets.length);
              if (await importKanji(character)) added += 1;
            }
            showToast(added ? `${added} kanji added to your Kanji collection.` : 'Nothing was added.');
            await viewRecord(record);
          }, { pendingLabel: 'Adding…', progressLabel: (done, total) => `Adding ${done}/${total}…` });
        });
      }
      // v5.1-E corrective spotlight: read-first centered detail modal with
      // content-appropriate width (kanji gets the wide canvas so identity,
      // readings, stroke, and SRS/encounter grids never collide). Editing
      // stays an explicit dialog action via the footer — SEEN first, edited
      // deliberately.
      const editButton = element('button', { className: 'button-secondary', text: `Edit ${config.singular}`, attrs: { type: 'button' } });
      const closeButton = element('button', { className: 'button-ghost', text: 'Close', attrs: { type: 'button' } });
      const closeDetail = openDetailModal({
        title: config.primary(record) || `${config.title} detail`,
        subtitle: config.secondary(record) || null,
        content: [content],
        actions: [closeButton, editButton],
        size: config === ENTITY_CONFIGS.kanji ? 'kanji' : 'default'
      });
      closeButton.addEventListener('click', closeDetail);
      editButton.addEventListener('click', async () => {
        closeDetail();
        await editRecord(record);
      });
      const grammarSlot = content.querySelector('[data-grammar-example-context]');
      if (grammarSlot && config === ENTITY_CONFIGS.vocabulary) {
        const openGrammarReferenceDialog = (reference) => {
          const structure = formatGrammarReferenceStructures(reference.structures);
          openDialog({
            title: `Add ${reference.grammarPoint} to Grammar`,
            content: [
              field({ name: 'grammar_point', label: 'Grammar point', required: true, maxLength: 100, value: reference.grammarPoint }),
              field({ name: 'meaning', label: 'Meaning', required: true, maxLength: 255, value: reference.meaning }),
              field({ name: 'structure', label: 'Structure', type: 'textarea', maxLength: 2000, value: structure, wide: true }),
              field({ name: 'example', label: 'Example', type: 'textarea', maxLength: 2000, value: reference.examples?.[0]?.japanese || reference.examples?.[0]?.sentence || '', wide: true }),
              field({ name: 'jlpt_level', label: 'JLPT tag', options: JLPT_OPTIONS, value: reference.jlptLevel || '' })
            ],
            submitLabel: 'Add to Grammar',
            onSubmit: async (form, close) => {
              const data = new FormData(form);
              await apiRequest('/api/grammar', {
                method: 'POST',
                body: {
                  grammar_point: data.get('grammar_point'),
                  meaning: data.get('meaning'),
                  structure: data.get('structure'),
                  example: data.get('example'),
                  jlpt_level: data.get('jlpt_level'),
                  reference_id: reference.referenceId
                }
              });
              close();
              showToast(`${reference.grammarPoint} added to your Grammar collection.`);
              await viewRecord(record);
            }
          });
        };
        apiRequest(`/api/vocabulary/${record.id_vocabulary}/grammar-context`).then((data) => {
          const examples = data.examples || [];
          grammarSlot.replaceChildren(element('h3', { className: 'font-semibold text-ink', text: 'Grammar in your examples' }));
          if (!examples.length) grammarSlot.append(element('p', { className: 'mt-2 text-sm text-muted', text: 'No saved examples to analyze.' }));
          examples.forEach((example) => {
            const matches = example.matches || [];
            if (!matches.length) return;
            grammarSlot.append(element('p', { className: 'mt-3 font-jp text-sm text-ink', text: `Seen in: ${example.sentence}`, attrs: { lang: 'ja' } }));
            matches.forEach((match) => (match.status === 'AMBIGUOUS' ? (match.references || []) : [match.reference]).filter(Boolean).forEach((reference) => {
              if (!match.collection?.inGrammar) {
                const addButton = element('button', { className: 'button-secondary mt-2 min-h-9 px-3 py-1.5', text: 'Add to Grammar', attrs: { type: 'button' } });
                addButton.addEventListener('click', () => openGrammarReferenceDialog(reference));
                grammarSlot.append(addButton);
              }
              grammarSlot.append(element('p', { className: 'mt-1 text-sm text-muted', text: `${reference.grammarPoint} · ${reference.meaning}${match.collection?.inGrammar ? ' · In your Grammar collection' : ''}` }));
            }));
          });
          if (data.truncated) grammarSlot.append(element('p', { className: 'mt-2 text-xs text-muted', text: 'Only the first bounded set of saved examples was analyzed.' }));
        }).catch(() => grammarSlot.replaceChildren(element('h3', { className: 'font-semibold text-ink', text: 'Grammar in your examples' }), element('p', { className: 'mt-2 text-sm text-muted', text: 'Grammar analysis is unavailable.' })));
      }
      const clozeSlot = content.querySelector('[data-vocab-cloze]');
      if (clozeSlot && config === ENTITY_CONFIGS.vocabulary) {
        const vocabId = record.id_vocabulary;
        const foldKana = (value) => String(value || '').replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
        const normAnswer = (value) => foldKana(String(value || '').trim().toLowerCase()).replace(/\s+/g, '');
        const playCloze = (sentence) => {
          const verdict = speakJapanese(sentence, {
            synthesis: typeof window !== 'undefined' ? window.speechSynthesis : null,
            Utterance: typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null
          });
          if (!verdict.ok) showToast(verdict.message || 'Audio playback is unavailable.', 'error');
        };
        apiRequest(`/api/vocabulary/${vocabId}/cloze`).then((data) => {
          const sentences = Array.isArray(data?.sentences) ? data.sentences : [];
          clozeSlot.replaceChildren(element('h3', { className: 'font-semibold text-ink', text: 'Cloze Practice' }));
          if (!sentences.length) {
            clozeSlot.append(element('p', { className: 'mt-2 text-sm text-muted', text: 'No cloze sentences yet — add a usage example containing this word.' }));
            return;
          }
          clozeSlot.append(element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Fill the blank from memory. Practice only — nothing is graded.' }));
          clozeSlot.append(element('div', { className: 'mt-3 grid gap-3' }, sentences.map((entry) => {
            const answer = String(data?.item?.word || '');
            const reading = String(data?.item?.reading || '');
            const input = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'Type the missing word', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' } });
            const verdict = element('p', { className: 'text-sm leading-6 text-ink', attrs: { 'aria-live': 'polite' } });
            verdict.hidden = true;
            const reveal = element('p', { className: 'break-words font-jp text-sm leading-7 text-ink', attrs: { lang: 'ja' } });
            reveal.hidden = true;
            const check = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Check', attrs: { type: 'button' } });
            const runCheck = () => {
              const typed = input.value || '';
              if (!String(typed).trim()) {
                verdict.hidden = false;
                verdict.textContent = 'Type something first.';
                return;
              }
              const want = [answer, reading].map(normAnswer).filter(Boolean);
              if (want.includes(normAnswer(typed))) {
                verdict.hidden = false;
                verdict.textContent = 'That matches! The full sentence is below.';
                reveal.hidden = false;
                reveal.textContent = entry.sentence;
              } else {
                verdict.hidden = false;
                verdict.textContent = 'Not quite — try again.';
                reveal.hidden = true;
              }
            };
            check.addEventListener('click', runCheck);
            input.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') { event.preventDefault(); check.click(); }
            });
            const play = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Play', attrs: { type: 'button', 'aria-label': `Play cloze sentence aloud` } });
            play.addEventListener('click', () => playCloze(entry.sentence));
            return element('article', { className: 'rounded-md bg-paper p-3' }, [
              element('p', { className: 'break-words font-jp text-base leading-8 text-ink', text: entry.cloze, attrs: { lang: 'ja' } }),
              ...(entry.translation ? [element('p', { className: 'mt-1 text-sm text-muted', text: entry.translation })] : []),
              element('div', { className: 'mt-2 flex flex-col gap-2 sm:flex-row' }, [input, check, play]),
              verdict,
              reveal
            ]);
          })));
        }).catch(() => clozeSlot.replaceChildren(
          element('h3', { className: 'font-semibold text-ink', text: 'Cloze Practice' }),
          element('p', { className: 'mt-2 text-sm text-muted', text: 'Cloze sentences are unavailable.' })
        ));
      }
      const tagsSlot = content.querySelector('[data-vocab-tags]');
      if (tagsSlot && config === ENTITY_CONFIGS.vocabulary) {
        const vocabId = record.id_vocabulary;
        const renderTags = (tags) => {
          const assigned = Array.isArray(tags?.assigned) ? tags.assigned : [];
          const suggested = Array.isArray(tags?.suggested) ? tags.suggested : [];
          tagsSlot.replaceChildren(
            element('h3', { className: 'font-semibold text-ink', text: 'Tags' }),
            element('div', { className: 'mt-2 flex flex-wrap gap-2' }, assigned.length
              ? assigned.map((tag) => element('span', { className: 'status-pill text-xs', text: tag.name }))
              : [element('p', { className: 'text-sm text-muted', text: 'No tags yet.' })])
          );
          if (suggested.length) {
            tagsSlot.append(element('p', { className: 'mt-3 text-xs font-semibold text-muted uppercase tracking-wide', text: 'Suggested' }));
            const row = element('div', { className: 'mt-1 flex flex-wrap gap-2' });
            for (const name of suggested) {
              const add = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: `Add ${name}`, attrs: { type: 'button' } });
              add.addEventListener('click', () => {
                const current = assigned.map((tag) => tag.name).concat([name]);
                apiRequest(`/api/vocabulary/${vocabId}/tags`, { method: 'PUT', body: { tags: current } })
                  .then((saved) => renderTags({ assigned: saved.assigned, suggested: suggested.filter((entry) => entry !== name) }))
                  .catch((error) => showToast(error?.message || 'Unable to add tag.', 'error'));
              });
              row.appendChild(add);
            }
            tagsSlot.appendChild(row);
          }
          const custom = element('input', { className: 'field-control mt-3', attrs: { type: 'text', 'aria-label': 'Add a custom tag', placeholder: 'Custom tag…', maxLength: '60' } });
          const addCustom = element('button', { className: 'button-secondary mt-2 min-h-9 px-3 py-1.5 text-sm', text: 'Add tag', attrs: { type: 'button' } });
          addCustom.addEventListener('click', () => {
            const name = String(custom.value || '').trim();
            if (!name) return;
            const current = assigned.map((tag) => tag.name).concat([name]);
            apiRequest(`/api/vocabulary/${vocabId}/tags`, { method: 'PUT', body: { tags: current } })
              .then((saved) => renderTags({ assigned: saved.assigned, suggested }))
              .catch((error) => showToast(error?.message || 'Unable to add tag.', 'error'));
          });
          tagsSlot.append(custom, addCustom);
        };
        apiRequest(`/api/vocabulary/${vocabId}/tags`)
          .then(renderTags)
          .catch(() => tagsSlot.replaceChildren(
            element('h3', { className: 'font-semibold text-ink', text: 'Tags' }),
            element('p', { className: 'mt-2 text-sm text-muted', text: 'Tags are unavailable.' })
          ));
      }
      const vocabularySlot = content.querySelector('[data-vocabulary-example-context]');
      if (vocabularySlot && config === ENTITY_CONFIGS.grammar) {
        apiRequest(`/api/grammar/${record.id_grammar}/vocabulary-context`).then((data) => {
          vocabularySlot.replaceChildren(element('h3', { className: 'font-semibold text-ink', text: 'Vocabulary in this example' }));
          const items = data.items || [];
          vocabularySlot.append(items.length ? element('div', { className: 'mt-2 grid gap-2' }, items.map((item) => element('p', { className: 'text-sm text-ink', text: `${item.canonical} · ${item.inVocabulary ? 'In Vocabulary' : 'Not in Vocabulary'}` }))) : element('p', { className: 'mt-2 text-sm text-muted', text: 'No vocabulary candidates found in this saved example.' }));
        }).catch(() => vocabularySlot.replaceChildren(element('h3', { className: 'font-semibold text-ink', text: 'Vocabulary in this example' }), element('p', { className: 'mt-2 text-sm text-muted', text: 'Vocabulary context is unavailable.' })));
      }
      if (config === ENTITY_CONFIGS.kanji) {
        // B.2 stroke-order overlay: lazy + fail-open — the owned detail
        // never depends on it. Same shared module as the reference page.
        import('../strokeOrder.js').then((module) => module.mountStrokeSlots(content)).catch(() => {});
        // Handwriting MVP: modal with the trace overlay + order check.
        content.querySelector('[data-writing-practice]')?.addEventListener('click', () => {
          const character = record.character_kanji || '';
          const holder = element('div', { className: 'grid gap-3' });
          const closeButton = element('button', { className: 'button-ghost', text: 'Close', attrs: { type: 'button' } });
          const closePractice = openDetailModal({
            title: character ? `Practice writing ${character}` : 'Practice writing',
            content: [holder],
            actions: [closeButton]
          });
          closeButton.addEventListener('click', closePractice);
          mountKanjiWriting(holder, { character, onDone: closePractice });
        });
      }
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
