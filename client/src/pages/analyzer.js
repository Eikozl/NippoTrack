// Phase 8 — Smart Text Analyzer page.
//
// Paste arbitrary Japanese text; the server returns deterministic Han
// character analysis (occurrences + collection/reference states). Analysis
// is read-only — only explicit Add actions write, reusing the Phase 7
// sequential POST /api/kanji import flow. Analyzer text is preserved across
// imports; results update locally without re-analysis or page reload.
//
// All pasted text renders via textContent (ui element helper), so markup in
// the input can never become HTML. Reference readings are labeled context
// only — never the reading used in the pasted text.

import { apiRequest } from '../api.js';
import { element, field, openDialog, pageHeader, setActionPending, showToast, withGlobalLoading, withPendingAction } from '../ui.js';
import { enableRomajiConversion } from '../kanjiReference.js';
import {
  buildKanjiImportPayload,
  getDiscoveryState,
  getImportableKanji,
  summarizeImportResults
} from '../vocabularyReading.js';
import {
  ANALYZER_FILTERS,
  ANALYZER_JLPT_LEVELS,
  ANALYZER_MAX_LENGTH,
  filterAnalyzerEntries,
  formatAnalyzerEntries,
  summarizeAnalyzerEntries
} from '../textAnalyzer.js';
import {
  LEXICAL_ANALYSIS_MAX_LENGTH,
  buildVocabularyImportPayload,
  groupLexicalCandidates
} from '../lexicalAnalyzer.js';
import {
  addSuggestion,
  attributionModel,
  contextBlockModel,
  contextItemModel,
  payloadTruncationNotice
} from '../contextAnalyzer.js';
import {
  analyzerPrefillFromContext,
  composeSenseMeaningMirror,
  evaluateExampleOffer,
  fetchAutofillEntry,
  glossCountNote,
  normalizeReadingHint
} from '../vocabularyAutofill.js';

function statePill(formatted) {
  const state = getDiscoveryState(formatted);
  if (state === 'alreadyInCollection') return 'In your collection';
  if (state === 'availableToAdd') return 'Available from reference';
  return 'No reference data';
}

export async function renderAnalyzer(container) {
  container.replaceChildren();
  container.append(pageHeader({
    title: 'Text Analyzer',
    description: 'Paste Japanese text to see the kanji it contains, which ones are already in your collection, and which reference-backed kanji you can add. Does not estimate your level or prove knowledge.'
  }));

  let analysis = null;
  let formatted = [];
  let rawByChar = new Map();
  const localCollection = new Map();
  let activeFilter = 'all';
  let selectedChars = new Set();
  // Phase 12-B lexical state: canonical forms added this session (flips cards
  // to "Already in Vocabulary" without re-analysis) + analyzed length for the
  // >2000-char vocabulary notice.
  const localVocabAdded = new Set();
  let analyzedTextLength = 0;

  const formCard = element('section', { className: 'surface min-w-0 p-5 sm:p-6' });
  const resultsSection = element('section', { className: 'mt-6 grid min-w-0 gap-5' });
  container.append(formCard, resultsSection);

  const input = element('textarea', {
    className: 'field-control min-h-40 w-full resize-y leading-7',
    attrs: {
      id: 'analyzer-text',
      rows: '7',
      maxlength: String(ANALYZER_MAX_LENGTH),
      placeholder: '例：今日は学校に行く。'
    }
  });
  const counter = element('p', { className: 'mt-2 text-right text-xs text-muted', text: `0 / ${ANALYZER_MAX_LENGTH}` });
  const formError = element('p', { className: 'mt-2 hidden text-sm text-red-700', attrs: { role: 'alert' } });
  const analyzeButton = element('button', { className: 'button-primary mt-4 min-h-10 px-5', text: 'Analyze text', attrs: { type: 'button' } });

  const showFormError = (message) => {
    formError.textContent = message || '';
    formError.classList.toggle('hidden', !message);
  };

  input.addEventListener('input', () => {
    counter.textContent = `${input.value.length} / ${ANALYZER_MAX_LENGTH}`;
    if (input.value.length) showFormError(null);
  });

  formCard.append(
    element('label', { className: 'field', attrs: { for: 'analyzer-text' } }, [
      element('span', { text: 'Japanese text' }),
      element('span', { className: 'text-xs font-normal leading-5 text-muted', text: `Analysis is read-only — nothing is saved or added unless you explicitly import. Up to ${ANALYZER_MAX_LENGTH} characters; vocabulary analysis runs automatically for texts up to ${LEXICAL_ANALYSIS_MAX_LENGTH} characters.` })
    ]),
    input,
    counter,
    formError,
    analyzeButton
  );

  const applyLocalCollection = () => {
    formatted = formatAnalyzerEntries([...rawByChar.values()].map((raw) => (
      localCollection.has(raw.character)
        ? { ...raw, inUserCollection: true, userKanji: localCollection.get(raw.character), meaning: raw.meaning ?? localCollection.get(raw.character)?.meaning ?? null }
        : raw
    )));
    selectedChars = new Set(getImportableKanji(formatted).map((entry) => entry.character));
  };

  const renderResults = () => {
    resultsSection.replaceChildren();
    if (!analysis) return;

    const summary = summarizeAnalyzerEntries(formatted);
    const distribution = analysis.jlptDistribution || {};
    // Strip counts mirror the rendered cards: the presentation-layer noise
    // filter (whitespace/punctuation-only) applies to grouping, so the
    // visible grouped total is the truthful count — never the raw payload.
    const groupedForCount = groupLexicalCandidates(analysis.lexical, localVocabAdded);
    const lexicalCount = groupedForCount.existing.length + groupedForCount.fresh.length + groupedForCount.verify.length;
    const grammarCount = analysis.lexical?.grammar?.status === 'ok' ? (analysis.lexical.grammar.matches?.length || 0) : 0;

    // v5.1-E summary strip: one calm grouped line instead of five equal
    // tiles. Tabular numerals; hierarchy via a single strip.
    const summaryStrip = element('div', { className: 'summary-strip', attrs: { role: 'status' } }, [
      element('span', {}, [
        element('strong', { text: String(lexicalCount) }),
        element('span', { text: ' vocabulary' })
      ]),
      element('span', { text: '·', attrs: { 'aria-hidden': 'true' } }),
      element('span', {}, [
        element('strong', { text: String(grammarCount) }),
        element('span', { text: ' grammar' })
      ]),
      element('span', { text: '·', attrs: { 'aria-hidden': 'true' } }),
      element('span', {}, [
        element('strong', { text: String(summary.uniqueKanji) }),
        element('span', { text: ' kanji' })
      ])
    ]);

    const distributionLine = [...ANALYZER_JLPT_LEVELS, 'unclassified']
      .map((level) => `${level === 'unclassified' ? 'Unclassified' : level}: ${distribution[level] ?? 0}`)
      .join(' · ');
    // Quiet caption line (not a competing card): reference distribution is
    // unique-kanji only — never a text level, never proficiency.
    const distributionCaption = element('div', { className: 'mt-1 px-1' }, [
      element('p', { className: 'break-words text-xs leading-5 text-muted', text: `Kanji reference: ${distributionLine}` }),
      element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: 'Unique kanji by reference level only — not a text level, not a proficiency estimate.' })
    ]);

    const notice = element('p', { className: 'rounded-lg border border-stone bg-paper p-4 text-xs leading-5 text-muted', text: analysis.notice || '' });

    const filterBar = element('div', { className: 'flex min-w-0 flex-wrap gap-2', attrs: { role: 'group', 'aria-label': 'Filter analyzed kanji' } });
    const grid = element('ul', { className: 'grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3' });
    const importBar = element('div', { className: 'surface flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });
    const lexicalSection = element('section', { className: 'surface analyzer-chapter min-w-0 p-4 sm:p-5', attrs: { 'aria-label': 'Vocabulary analysis' } });
    const grammarSection = element('section', { className: 'surface analyzer-chapter min-w-0 p-4 sm:p-5', attrs: { 'aria-label': 'Grammar analysis' } });

    const renderGrammar = () => {
      grammarSection.replaceChildren(element('h2', { className: 'font-semibold text-ink', text: 'Grammar' }));
      const grammar = analysis.lexical?.grammar;
      if (!grammar || grammar.status !== 'ok') {
        grammarSection.append(element('p', { className: 'mt-2 text-sm text-muted', text: 'Grammar analysis is unavailable.' }));
        return;
      }
      const matches = Array.isArray(grammar.matches) ? grammar.matches : [];
      if (!matches.length) {
        grammarSection.append(element('p', { className: 'mt-2 text-sm text-muted', text: 'No supported grammar patterns detected.' }));
        return;
      }
      const addReference = (reference) => {
        const example = reference.examples?.find((item) => item?.ja)?.ja || '';
        const content = [
          field({ name: 'grammar_point', label: 'Grammar point', required: true, maxLength: 100, value: reference.grammarPoint }),
          field({ name: 'meaning', label: 'Meaning', required: true, maxLength: 255, value: reference.meaning }),
          field({ name: 'structure', label: 'Structure', type: 'textarea', maxLength: 2000, value: (reference.structures || []).join('\n') }),
          field({ name: 'example', label: 'Example', type: 'textarea', maxLength: 2000, value: example }),
          field({ name: 'jlpt_level', label: 'JLPT reference', type: 'select', value: reference.jlptLevel || '', options: [{ value: '', label: 'Not set' }, ...['N5','N4','N3','N2','N1'].map((value) => ({ value, label: `${value} reference` }))] })
        ];
        openDialog({ title: 'Add Grammar', content, submitLabel: 'Save Grammar', onSubmit: async (form, close) => {
          const data = new FormData(form);
          await apiRequest('/api/grammar', { method: 'POST', body: { grammar_point: data.get('grammar_point'), meaning: data.get('meaning'), structure: data.get('structure'), example: data.get('example'), jlpt_level: data.get('jlpt_level'), reference_id: reference.referenceId } });
          close(); showToast('Grammar point added as New.');
        } });
      };
      for (const match of matches) {
        const references = match.status === 'AMBIGUOUS' ? match.references : [match.reference];
        const card = element('article', { className: 'mt-3 rounded-lg border border-stone bg-paper p-3' }, [
          element('p', { className: 'font-jp font-semibold text-ink', text: match.detected?.text || '', attrs: { lang: 'ja' } }),
          element('p', { className: 'mt-1 text-xs text-muted', text: match.status === 'AMBIGUOUS' ? 'Grammar pattern detected. Possible uses:' : 'Seen here' })
        ]);
        for (const reference of references.filter(Boolean)) {
          const row = element('div', { className: 'mt-2 flex flex-wrap items-center justify-between gap-2' }, [
            element('p', { className: 'text-sm text-ink', text: `${reference.grammarPoint} · ${reference.meaning} · ${reference.jlptLevel} reference` }),
            element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: match.collection?.inGrammar ? 'In your Grammar collection' : 'Add to Grammar', attrs: { type: 'button', disabled: match.collection?.inGrammar ? 'true' : null } })
          ]);
          const button = row.querySelector('button'); if (!match.collection?.inGrammar) button.addEventListener('click', () => addReference(reference));
          card.append(row);
        }
        grammarSection.append(card);
      }
      grammarSection.append(element('p', { className: 'mt-3 text-xs text-muted', text: 'Grammar reference data: Nihongo Mono · MIT' }));
    };

    const renderLexical = () => {
      lexicalSection.replaceChildren();
      lexicalSection.append(element('h2', { className: 'font-semibold text-ink', text: 'Vocabulary' }));
      const lexical = analysis.lexical || null;
      if (!lexical && analyzedTextLength > LEXICAL_ANALYSIS_MAX_LENGTH) {
        lexicalSection.append(element('p', {
          className: 'mt-2 break-words text-sm text-muted',
          text: `Vocabulary analysis is available for texts up to ${LEXICAL_ANALYSIS_MAX_LENGTH} characters. Kanji analysis was still completed.`
        }));
        return;
      }
      if (!lexical || lexical.status !== 'ok') {
        lexicalSection.append(element('p', {
          className: 'mt-2 break-words text-sm text-muted',
          text: (lexical && lexical.warnings && lexical.warnings[0]) || 'Word-level analysis is unavailable. Kanji results below are complete.'
        }));
        return;
      }
      const groups = groupLexicalCandidates(lexical, localVocabAdded);
      const summary = { candidates: lexical.candidates?.length || 0, existing: groups.existing.length, new: groups.fresh.length };
      const tiles = [
        ['Vocabulary candidates', String(summary.candidates ?? 0)],
        ['Already in Vocabulary', String(summary.existing ?? 0)],
        ['New candidates', String(summary.new ?? 0)]
      ].map(([label, value]) => element('div', { className: 'rounded-lg border border-stone bg-paper p-3 text-center' }, [
        element('p', { className: 'text-xl font-semibold text-ink', text: value }),
        element('p', { className: 'mt-1 text-xs text-muted', text: label })
      ]));
      lexicalSection.append(element('div', { className: 'mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3' }, tiles));
      if (lexical.matching && lexical.matching.available === false) {
        lexicalSection.append(element('p', {
          className: 'mt-3 rounded-lg border border-stone bg-paper p-3 text-xs leading-5 text-muted',
          text: 'Vocabulary collection matching is unavailable. Candidates are shown without ownership state.'
        }));
      }
      // Context block state never hides Phase 12 candidates: structural
      // partials get a neutral informational notice (no Retry — retrying
      // repeats the same bounded result); transient failures get Retry only
      // when the backend marks them retryable. A payload-budget trim adds
      // one compact disclosure line in the same box. Retry reuses the normal
      // Analyze action — same request, same budget.
      const contextState = contextBlockModel(lexical.context);
      const truncationNotice = payloadTruncationNotice(lexical.context);
      if (contextState.state === 'unavailable' || contextState.state === 'partial' || truncationNotice) {
        const notice = element('div', { className: 'mt-3 rounded-lg border border-stone bg-paper p-3', attrs: { role: 'status' } });
        if (contextState.notice) {
          notice.append(element('p', { className: 'break-words text-sm text-ink/80', text: contextState.notice }));
        }
        if (truncationNotice) {
          notice.append(element('p', { className: 'mt-1 break-words text-xs leading-5 text-muted', text: truncationNotice }));
        }
        if (contextState.retryable) {
          const retryButton = element('button', { className: 'button-secondary mt-2 min-h-9 px-3 py-1.5 text-xs', text: 'Retry analysis', attrs: { type: 'button' } });
          retryButton.addEventListener('click', () => analyzeButton.click());
          notice.append(retryButton);
        }
        lexicalSection.append(notice);
      }
      const groupSections = [
        ['Already in Vocabulary', groups.existing],
        ['New Vocabulary', groups.fresh],
        ['Needs verification', groups.verify]
      ];
      for (const [title, items] of groupSections) {
        if (!items.length) continue;
        lexicalSection.append(element('h3', { className: 'mt-4 text-sm font-semibold text-ink', text: `${title} (${items.length})` }));
        const list = element('ul', { className: 'mt-2 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3' });
        for (const view of items) {
          list.append(lexicalCard(view));
        }
        lexicalSection.append(list);
      }
      if (!groups.existing.length && !groups.fresh.length && !groups.verify.length) {
        lexicalSection.append(element('p', { className: 'mt-2 text-sm text-muted', text: 'No vocabulary candidates found in this text.' }));
      } else {
        lexicalSection.append(element('p', {
          className: 'mt-3 text-xs leading-5 text-muted',
          text: 'Detected words are not knowledge: adding stores them as New vocabulary without scheduling reviews.'
        }));
      }
      // One visible source line for the whole vocabulary section (never per
      // card). Rendered only when the response carries dictionary provenance.
      const attribution = attributionModel(lexical.context && lexical.context.dictionary);
      if (attribution) {
        const footer = element('p', { className: 'mt-3 break-words text-xs leading-5 text-muted' }, [
          element('span', { text: 'Dictionary data: ' }),
          element('a', {
            className: 'font-semibold text-vermilion transition hover:text-vermilion-dark',
            text: 'JMdict',
            attrs: { href: 'https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project', target: '_blank', rel: 'noreferrer noopener' }
          }),
          element('span', { text: ' © EDRDG (' }),
          element('a', {
            className: 'font-semibold text-vermilion transition hover:text-vermilion-dark',
            text: 'CC BY-SA 4.0',
            attrs: { href: 'https://creativecommons.org/licenses/by-sa/4.0/', target: '_blank', rel: 'noreferrer noopener' }
          }),
          element('span', { text: ').' })
        ]);
        lexicalSection.append(footer);
        if (attribution.detail) {
          const versionDetails = element('details', { className: 'mt-1 text-xs' });
          versionDetails.append(
            element('summary', { className: 'cursor-pointer font-semibold text-vermilion', text: 'Reference version' }),
            element('p', { className: 'mt-1 break-words leading-5 text-muted', text: attribution.detail })
          );
          lexicalSection.append(versionDetails);
        }
      }
    };

    const findLexicalCandidate = (key) => (
      ((analysis.lexical && analysis.lexical.candidates) || []).find((entry) => entry.key === key) || null
    );

    const findContextItem = (key) => (
      ((analysis.lexical && analysis.lexical.context && analysis.lexical.context.items) || []).find((entry) => entry.key === key) || null
    );

    // Compact Context-Aware block inside a vocabulary card. Augments the
    // Phase 12 card; every branch renders through textContent (no raw HTML).
    const contextSection = (rawItem) => {
      const model = contextItemModel(rawItem);
      if (model.kind === 'pending' || model.kind === 'unsupported') return null;
      const block = element('div', {
        className: 'mt-3 rounded-lg border border-stone bg-paper p-3',
        dataset: { contextKind: model.kind },
        attrs: { role: 'group', 'aria-label': 'Dictionary context' }
      });
      const noteLine = (text) => element('p', { className: 'mt-1 break-words text-xs leading-5 text-muted', text });
      if (model.kind === 'no-match') {
        block.append(element('p', { className: 'break-words text-xs text-muted', text: model.notice }));
        return block;
      }
      if (model.kind === 'unavailable') {
        block.append(element('p', { className: 'break-words text-xs text-muted', text: model.notice }));
        return block;
      }
      const readingLine = () => {
        if (model.readings.suggested) {
          return element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: `Dictionary reading: ${model.readings.suggested} (JMdict)` });
        }
        if (model.readings.alternatives.length) {
          return element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: `Dictionary readings: ${model.readings.alternatives.join(' · ')} (JMdict)` });
        }
        return null;
      };
      const whyDetails = () => {
        if (!model.evidence?.length && !model.excluded) return null;
        const details = element('details', { className: 'mt-2 text-xs' });
        const rows = [];
        if (model.evidence?.length) {
          rows.push(element('ul', { className: 'mt-1 grid gap-1' }, model.evidence.map((line) => (
            element('li', { className: 'break-words leading-5 text-muted', text: `· ${line}` })
          ))));
        }
        if (model.excluded) rows.push(element('p', { className: 'mt-1 break-words leading-5 text-muted', text: model.excluded }));
        details.append(element('summary', { className: 'cursor-pointer font-semibold text-vermilion', text: 'Why this matches' }), ...rows);
        return details;
      };
      if (model.kind === 'compatible') {
        block.append(element('p', { className: 'text-sm font-semibold text-ink', text: model.heading }));
        block.append(element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: model.meaning }));
        const reading = readingLine();
        if (reading) block.append(reading);
      } else if (model.kind === 'ambiguous-unique') {
        const reading = readingLine();
        if (reading) block.append(reading);
        block.append(element('p', { className: 'mt-1 text-sm font-semibold text-ink', text: model.heading }));
        block.append(element('p', { className: 'mt-1 break-words text-xs leading-5 text-muted', text: model.subheading }));
        block.append(element('ul', { className: 'mt-1 grid gap-1' }, model.choices.map((choice) => (
          element('li', { className: 'break-words text-sm text-ink/80', text: `· ${choice.label}` })
        ))));
        if (model.moreMeanings) block.append(noteLine('More meanings exist.'));
      } else if (model.kind === 'multiple') {
        block.append(element('p', { className: 'text-sm font-semibold text-ink', text: model.heading }));
        block.append(element('p', { className: 'mt-1 break-words text-xs leading-5 text-muted', text: model.subheading }));
        block.append(element('ul', { className: 'mt-1 grid gap-1' }, model.rows.map((row) => (
          element('li', { className: 'break-words text-sm text-ink/80', text: row.gloss ? `${row.headword} — ${row.gloss}` : row.headword })
        ))));
      }
      for (const note of model.notes || []) block.append(noteLine(note));
      const why = whyDetails();
      if (why) block.append(why);
      return block;
    };

    const lexicalCard = (view) => {
      const header = element('div', { className: 'flex items-start justify-between gap-3' }, [
        element('div', { className: 'flex min-w-0 items-baseline gap-2' }, [
          element('span', { className: 'break-words text-lg font-semibold text-ink', text: view.canonical }),
          ...(view.occurrences > 1 ? [element('span', { className: 'shrink-0 text-xs font-semibold text-muted', text: `×${view.occurrences}` })] : [])
        ]),
        element('span', { className: 'status-pill shrink-0 text-xs', text: view.pill })
      ]);
      const rows = [header];
      rows.push(element('p', { className: 'mt-1 break-words text-xs text-muted', text: view.posLabel }));
      if (view.observedLine) rows.push(element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: view.observedLine }));
      if (view.readingLine) rows.push(element('p', { className: 'mt-1 break-words text-sm text-ink/80', text: view.readingLine }));
      if (view.possibleMatches.length) {
        rows.push(element('p', {
          className: 'mt-1 break-words text-xs text-muted',
          text: `Possible match: ${view.possibleMatches.map((entry) => entry.word).join('、')} — verify the meaning before adding.`
        }));
      }
      const contextItem = findContextItem(view.key);
      if (contextItem) {
        const section = contextSection(contextItem);
        if (section) rows.push(section);
      }
      if (view.showAdd) {
        const addButton = element('button', { className: 'button-secondary min-h-10 px-4 py-2 text-xs', text: view.addLabel, attrs: { type: 'button' } });
        addButton.addEventListener('click', () => {
          const candidate = findLexicalCandidate(view.key);
          if (candidate) openVocabularyAddDialog(candidate, view);
        });
        rows.push(element('div', { className: 'mt-3 flex items-center justify-end gap-3 border-t border-stone pt-3' }, [addButton]));
      }
      return element('li', { className: 'rounded-lg border border-stone bg-paper p-4' }, rows);
    };

    const openVocabularyAddDialog = (candidate, view) => {
      // VAF-B Analyzer path: ZERO autofill endpoint calls on the normal path.
      // Seed reading/meaning from the cached context item only (fetchEnabled
      // = false). Meaning is the bounded same-sense composition — never
      // primaryGloss-only. The ONLY network call allowed here is an explicit
      // entry expansion via fetchAutofillEntry under the cached item pin.
      const rawContextItem = findContextItem(view.key);
      // Per-item pins are never emitted by the server diet; the context
      // block-level dictionary IS the same pinned snapshot the analysis ran
      // under, so it is a valid expansion anchor for entry drilling.
      const contextDictionaryPin = (() => {
        const dictionary = analysis?.lexical?.context?.dictionary;
        if (!dictionary || dictionary.sourceId == null) return null;
        return {
          sourceId: String(dictionary.sourceId),
          sourceName: dictionary.source ?? null,
          converter: dictionary.converter ?? null,
          converterVersion: dictionary.version ?? null,
          fileDate: dictionary.fileDate ?? null
        };
      })();
      // addSuggestion-compatible identity check (kept for stale semantics).
      const suggestion = rawContextItem ? addSuggestion(rawContextItem) : null;
      const hasContextSuggestion = !!(suggestion && suggestion.sourceKey === view.key);
      const prefill = analyzerPrefillFromContext(candidate, hasContextSuggestion ? rawContextItem : null, contextDictionaryPin)
        || { word: candidate.lemma || candidate.canonical, reading: candidate.lemmaReading || '', readingProvenance: null, meaning: '', meaningChoices: [], moreMeanings: false, requiresChoice: false, entryRows: [], pin: null, glossMeta: null };
      const identityWord = prefill.word;
      // Analyzer reading fallback preserves the pre-VAF behavior: cached
      // UNIQUE suggestion first, then the parser lemma reading. The VAF
      // prefill already encodes this; the fallback below only covers a null
      // prefill (no candidate/context) and never touches the network.
      const suggestedReading = prefill.reading || '';
      const suggestedMeaning = prefill.meaning || '';
      const wordField = field({ name: 'word', label: 'Word (dictionary form)', value: identityWord, required: true, maxLength: 100 });
      const readingField = field({
        name: 'reading',
        label: 'Reading',
        value: suggestedReading,
        maxLength: 150,
        placeholder: 'ひらがな',
        description: 'Dictionary-form reading only. Leave blank if unsure — never copy the “as read here” form.'
      });
      const meaningField = field({ name: 'meaning', label: 'Meaning', value: suggestedMeaning, required: true, maxLength: 255, placeholder: 'Your definition' });
      // Example-sentence gate (Analyzer only): prefill ONLY when the trimmed
      // source is short, single-statement, and contains the observed surface.
      const observedSurface = (Array.isArray(candidate.observed) && candidate.observed[0]?.surface)
        || identityWord;
      const exampleOffer = evaluateExampleOffer({ sourceText: input.value, observedSurface });
      const examplePrefilled = exampleOffer.action === 'prefill';
      const exampleField = field({
        name: 'example_sentence',
        label: 'Example sentence (optional)',
        type: 'textarea',
        value: examplePrefilled ? exampleOffer.value : '',
        maxLength: 2000,
        placeholder: 'A natural sentence using this word'
      });
      const dialogContent = [
        element('p', { className: 'text-xs leading-5 text-muted sm:col-span-2', text: 'Confirm this word before saving. Adding stores it as New vocabulary — it does not schedule reviews or claim knowledge.' }),
        wordField,
        readingField,
        meaningField,
        exampleField
      ];
      // Stale-suggestion identity tracking (declared before the example offer
      // row so every control participates; semantics extend the pre-VAF
      // behavior without weakening it).
      const dirtyFields = new Set();
      const inputFor = (content, name) => content
        .map((item) => (item.matches?.(`[name="${name}"]`) ? item : item.querySelector?.(`[name="${name}"]`)))
        .find(Boolean) || null;
      let senseChoiceButtons = [];
      let entryChoiceButtons = [];
      let exampleOfferButton = null;
      // Reading/meaning provenance note (verbatim labels, compact, inline).
      if (prefill.readingProvenance || suggestedMeaning) {
        const bits = [];
        if (prefill.readingProvenance) bits.push(`Reading: ${prefill.readingProvenance}`);
        if (suggestedMeaning) {
          const note = glossCountNote(prefill.glossMeta || {});
          bits.push(note ? `Meaning: JMdict · ${note}` : 'Meaning: JMdict');
          if (prefill.moreMeanings && !(prefill.glossMeta && (prefill.glossMeta.remainingCount || 0) > 0)) bits.push('More meanings exist.');
        }
        if (bits.length) {
          dialogContent.push(element('p', {
            className: 'break-words text-xs leading-5 text-muted sm:col-span-2',
            text: `${bits.join(' · ')} — editable.`
          }));
        }
      }
      if (prefill.moreMeanings && suggestedMeaning && prefill.glossMeta && (prefill.glossMeta.remainingCount || 0) > 0) {
        dialogContent.push(element('p', {
          className: 'break-words text-xs leading-5 text-muted sm:col-span-2',
          text: `+${prefill.glossMeta.remainingCount} more dictionary meanings. Additional dictionary glosses exist. Dictionary meaning — editable.`
        }));
      }
      // Example offer row: explicit "Use analyzed text" action unless the
      // gate prefilled; disabled with an explanation past the server max.
      if (!examplePrefilled) {
        if (exampleOffer.action === 'offer') {
          const useButton = element('button', {
            className: 'button-secondary min-h-9 justify-self-start px-3 py-1.5 text-xs sm:col-span-2',
            text: 'Use analyzed text',
            attrs: { type: 'button', 'aria-label': 'Use the analyzed text as the example sentence' }
          });
          useButton.addEventListener('click', () => {
            const exampleInput = inputFor(dialogContent, 'example_sentence');
            if (exampleInput) {
              exampleInput.value = exampleOffer.value;
              dirtyFields.add('example_sentence');
              exampleInput.focus();
            }
          });
          dialogContent.push(useButton);
          exampleOfferButton = useButton;
        } else if (exampleOffer.action === 'disabled') {
          const note = element('p', {
            className: 'break-words text-xs leading-5 text-muted sm:col-span-2',
            text: exampleOffer.reason || 'The analyzed text is too long to save as an example.',
            attrs: { role: 'status' }
          });
          dialogContent.push(note);
          const disabledButton = element('button', {
            className: 'button-secondary min-h-9 justify-self-start px-3 py-1.5 text-xs sm:col-span-2',
            text: 'Use analyzed text',
            attrs: { type: 'button', disabled: '', 'aria-disabled': 'true', title: exampleOffer.reason || 'Too long' }
          });
          dialogContent.push(disabledButton);
          exampleOfferButton = disabledButton;
        }
      } else {
        dialogContent.push(element('p', {
          className: 'break-words text-xs leading-5 text-muted sm:col-span-2',
          text: 'Example: Context — editable.'
        }));
      }
      // Stale-suggestion safety: context suggestions belong to the original
      // candidate identity (declared above). Sense/entry picks below are
      // explicit USER actions; untouched context-derived values clear (never
      // reapplied) when the word leaves the identity.
      // UNIQUE + AMBIGUOUS: explicit sense picks with FULL composed previews
      // (same-sense " · " join, ≤255). Each choice is a USER action that
      // fills the meaning field — never an automatic selection.
      if (prefill.requiresChoice && prefill.meaningChoices.length) {
        const choicesBox = element('div', { className: 'grid gap-2 sm:col-span-2', attrs: { role: 'group', 'aria-label': 'Possible meanings from the dictionary' } }, [
          element('p', { className: 'text-xs font-semibold text-ink', text: 'Possible meanings — choose one:' })
        ]);
        let manualNote = null;
        senseChoiceButtons = prefill.meaningChoices.map((choice) => {
          const posSuffix = choice.pos?.length ? ` (${choice.pos.join(', ')})` : '';
          const useButton = element('button', {
            className: 'button-secondary min-h-9 justify-start px-3 py-1.5 text-left text-xs',
            text: `Use “${choice.label}”${posSuffix}`,
            attrs: { type: 'button', 'aria-label': `Use meaning "${choice.label}" for ${view.canonical}` }
          });
          useButton.addEventListener('click', () => {
            const meaningInput = inputFor(dialogContent, 'meaning');
            if (meaningInput) {
              // Explicit user pick from the backend-supplied full gloss array.
              // Zero-fit: leave blank + manual note (never the over-long label).
              const composed = composeSenseMeaningMirror(choice.glosses);
              meaningInput.value = composed.value || '';
              if (!composed.value && !manualNote) {
                manualNote = element('p', { className: 'text-xs leading-5 text-muted', text: 'This dictionary meaning is too long to fill in — please enter it manually.' });
                choicesBox.append(manualNote);
              }
              dirtyFields.add('meaning');
              meaningInput.focus();
            }
          });
          choicesBox.append(useButton);
          return useButton;
        });
        if (prefill.moreMeanings) {
          choicesBox.append(element('p', { className: 'text-xs leading-5 text-muted', text: 'More meanings exist.' }));
        }
        dialogContent.push(choicesBox);
      }
      // MULTIPLE: entry picker. Overflow fetch ONLY on explicit expansion,
      // reusing the cached item pin. No identity is ever selected here.
      if (prefill.entryRows.length) {
        const entriesBox = element('div', { className: 'grid gap-2 sm:col-span-2', attrs: { role: 'group', 'aria-label': 'Dictionary entries — choose one to expand' } }, [
          element('p', { className: 'text-xs font-semibold text-ink', text: 'Multiple dictionary entries — choose one to see meanings:' })
        ]);
        entryChoiceButtons = prefill.entryRows.map((row) => {
          const kanaSuffix = row.kanaLine ? ` (${row.kanaLine})` : '';
          const preview = row.glossPreview ? ` — ${row.glossPreview}` : '';
          const posSuffix = row.pos?.length ? ` · ${row.pos.join(', ')}` : '';
          const expandButton = element('button', {
            className: 'button-secondary min-h-9 justify-start px-3 py-1.5 text-left text-xs',
            text: `${row.headword}${kanaSuffix}${preview}${posSuffix}`,
            attrs: { type: 'button', 'aria-label': `Show meanings for dictionary entry ${row.headword}` }
          });
          expandButton.addEventListener('click', async () => {
            if (!prefill.pin?.sourceId || row.entryId == null) {
              showToast('This entry cannot be expanded. Enter the meaning manually.', 'error');
              return;
            }
            expandButton.disabled = true;
            try {
              const data = await fetchAutofillEntry({ sourceId: prefill.pin.sourceId, entryId: row.entryId }, {});
              if (!data || data.status !== 'ok') {
                // Branch on the backend reason (same contract as standalone):
                // stale snapshots need a fresh analysis, transient failures
                // can retry this expansion (the button re-enables below).
                // Manual fields stay usable either way.
                const reason = data && typeof data === 'object' ? data.reason : null;
                const retryable = data && typeof data === 'object' && data.retryable === true;
                if (reason === 'snapshot-unavailable') {
                  showToast('Dictionary data changed since this lookup. Re-run the analysis to refresh the dictionary data.', 'error');
                } else if (retryable) {
                  showToast('Could not load dictionary entry. Try expanding the entry again.', 'error');
                } else {
                  showToast('Entry meanings are unavailable. Enter the meaning manually.', 'error');
                }
                return;
              }
              const senses = Array.isArray(data.senses) ? data.senses : [];
              const wordInput = inputFor(dialogContent, 'word');
              const intact = wordInput && wordInput.value.trim() === identityWord;
              if (!intact) return;
              // Overflow reading: backend-authoritative only — never the first
              // alternative, never per-kanji inference. A user-edited
              // reading (dirtyFields) is never overwritten.
              const readingInput = inputFor(dialogContent, 'reading');
              const overflowReading = normalizeReadingHint(data.reading);
              if (readingInput && !dirtyFields.has('reading')) {
                if (overflowReading.action === 'prefill' && overflowReading.value) {
                  readingInput.value = overflowReading.value;
                  entriesBox.append(element('p', {
                    className: 'text-xs leading-5 text-muted',
                    text: `Dictionary reading: ${overflowReading.value} (JMdict) — editable.`
                  }));
                } else if (overflowReading.action === 'choose' && overflowReading.choices.length) {
                  const readingGroup = element('div', {
                    className: 'grid gap-2',
                    attrs: { role: 'group', 'aria-label': 'Dictionary readings — choose one' }
                  }, [
                    element('p', { className: 'text-xs font-semibold text-ink', text: 'Dictionary readings — choose one:' })
                  ]);
                  for (const choice of overflowReading.choices.slice(0, 6)) {
                    const useReading = element('button', {
                      className: 'button-secondary min-h-9 justify-start px-3 py-1.5 text-left text-xs',
                      text: choice,
                      attrs: { type: 'button', 'aria-label': `Use reading ${choice}` }
                    });
                    useReading.addEventListener('click', () => {
                      const target = inputFor(dialogContent, 'reading');
                      if (target) {
                        target.value = choice;
                        dirtyFields.add('reading');
                        target.focus();
                      }
                    });
                    readingGroup.append(useReading);
                  }
                  entriesBox.append(readingGroup);
                }
                // blank → leave the reading field unchanged.
              }
              let overflowManualNote = null;
              for (const sense of senses.slice(0, 8)) {
                const glosses = Array.isArray(sense?.glosses) ? sense.glosses : [];
                const composed = composeSenseMeaningMirror(glosses);
                const label = composed.value || glosses[0] || 'Untranslated sense';
                const pick = element('button', {
                  className: 'button-secondary min-h-9 justify-start px-3 py-1.5 text-left text-xs',
                  text: `Use “${label}”`,
                  attrs: { type: 'button', 'aria-label': `Use meaning "${label}" for ${view.canonical}` }
                });
                pick.addEventListener('click', () => {
                  const meaningInput = inputFor(dialogContent, 'meaning');
                  if (meaningInput) {
                    // Zero-fit: leave blank + manual note (never the long label).
                    meaningInput.value = composed.value || '';
                    if (!composed.value && !overflowManualNote) {
                      overflowManualNote = element('p', { className: 'text-xs leading-5 text-muted', text: 'This dictionary meaning is too long to fill in — please enter it manually.' });
                      entriesBox.append(overflowManualNote);
                    }
                    dirtyFields.add('meaning');
                    meaningInput.focus();
                  }
                });
                entriesBox.append(pick);
                senseChoiceButtons.push(pick);
              }
              if (data.truncated || data.nextCursor != null) {
                entriesBox.append(element('p', { className: 'text-xs leading-5 text-muted', text: 'More meanings exist.' }));
              }
            } catch {
              showToast('Entry meanings are unavailable. Enter the meaning manually.', 'error');
            } finally {
              expandButton.disabled = false;
            }
          });
          entriesBox.append(expandButton);
          return expandButton;
        });
        if (prefill.moreMeanings) {
          entriesBox.append(element('p', { className: 'text-xs leading-5 text-muted', text: 'More dictionary matches exist.' }));
        }
        dialogContent.push(entriesBox);
      }
      // Untouched context-derived values clear (never reapplied) when the
      // word leaves the suggested identity; user-edited fields always win.
      // Extended to the example prefill without weakening reading/meaning.
      const syncStaleSuggestions = () => {
        const wordInput = inputFor(dialogContent, 'word');
        const readingInput = inputFor(dialogContent, 'reading');
        const meaningInput = inputFor(dialogContent, 'meaning');
        const exampleInput = inputFor(dialogContent, 'example_sentence');
        const intact = wordInput && wordInput.value.trim() === identityWord;
        for (const button of [...senseChoiceButtons, ...entryChoiceButtons]) button.disabled = !intact;
        if (exampleOfferButton && exampleOffer.action === 'offer') exampleOfferButton.disabled = !intact;
        if (intact || !hasContextSuggestion) return;
        if (readingInput && !dirtyFields.has('reading') && suggestedReading && readingInput.value === suggestedReading) {
          readingInput.value = '';
        }
        if (meaningInput && !dirtyFields.has('meaning') && suggestedMeaning && meaningInput.value === suggestedMeaning) {
          meaningInput.value = '';
        }
        if (exampleInput && !dirtyFields.has('example_sentence') && examplePrefilled && exampleInput.value === exampleOffer.value) {
          exampleInput.value = '';
        }
      };
      openDialog({
        title: `Add ${view.canonical} to Vocabulary`,
        content: dialogContent,
        submitLabel: 'Add to Vocabulary',
        onSubmit: async (form, close) => {
          const data = new FormData(form);
          const meaning = String(data.get('meaning') || '');
          if (!meaning.trim()) throw new Error('Meaning is required.');
          const payload = buildVocabularyImportPayload(candidate, {
            meaning,
            word: String(data.get('word') || ''),
            reading: String(data.get('reading') || '')
          });
          if (!payload) throw new Error('Meaning is required.');
          // Optional example sentence (Analyzer gate only — never required).
          // Submit path otherwise unchanged: same POST + 409 behavior.
          const exampleSentence = String(data.get('example_sentence') || '').trim();
          if (exampleSentence) payload.example_sentence = exampleSentence.slice(0, 2000);
          const created = await apiRequest('/api/vocabulary', { method: 'POST', body: payload });
          localVocabAdded.add(created?.word || payload.word);
          close();
          renderResults();
          showToast(`Added ${created && created.word ? created.word : candidate.canonical} to Vocabulary.`);
        }
      });
      for (const name of ['word', 'reading', 'meaning', 'example_sentence']) {
        const input = inputFor(dialogContent, name);
        if (input) input.addEventListener('input', () => {
          dirtyFields.add(name);
          if (name === 'word') syncStaleSuggestions();
        });
      }
      // Enable romaji → hiragana conversion for the reading field (matches Vocabulary form behavior)
      enableRomajiConversion(dialogContent, { japaneseTextFields: { reading: 'hiragana' } }, apiRequest);
    };

    const renderGrid = () => {
      const visible = filterAnalyzerEntries(formatted, activeFilter);
      grid.replaceChildren();
      if (!visible.length) {
        grid.append(element('li', { className: 'surface p-6 text-center text-sm text-muted sm:col-span-2 lg:col-span-3', text: formatted.length ? 'No kanji match this filter.' : 'No kanji characters found in this text.' }));
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const entry of visible) {
        fragment.appendChild(kanjiCard(entry));
      }
      grid.append(fragment);
    };

    const renderImportBar = () => {
      const importableCount = getImportableKanji(formatted).length;
      importBar.replaceChildren();
      if (!importableCount) {
        importBar.append(element('p', { className: 'text-sm text-muted', text: 'Nothing available to import — every analyzed kanji is already collected or has no reference data.' }));
        return;
      }
      const addSelectedButton = element('button', {
        className: 'button-secondary min-h-9 px-3 py-1.5',
        text: `Add selected Kanji (${selectedChars.size})`,
        attrs: { type: 'button' }
      });
      addSelectedButton.disabled = selectedChars.size === 0;
      addSelectedButton.addEventListener('click', () => {
        const targets = [...selectedChars];
        if (!targets.length) return;
        withPendingAction(addSelectedButton, async ({ setProgress }) => {
          await importKanji(targets, setProgress);
        }, { pendingLabel: 'Adding…', progressLabel: (done, total) => `Adding ${done}/${total}…` });
      });
      importBar.append(
        element('p', { className: 'text-sm text-muted', text: 'Select reference-backed kanji to import explicitly. Already-collected kanji and kanji without reference data cannot be added.' }),
        addSelectedButton
      );
    };

    const renderFilters = () => {
      filterBar.replaceChildren();
      for (const filter of ANALYZER_FILTERS) {
        const button = element('button', {
          className: `filter-pill ${filter.value === activeFilter ? 'filter-pill--active' : ''}`,
          text: filter.label,
          attrs: { type: 'button', 'aria-pressed': String(filter.value === activeFilter) }
        });
        button.addEventListener('click', () => {
          activeFilter = filter.value;
          renderFilters();
          renderGrid();
        });
        filterBar.append(button);
      }
    };

    renderFilters();
    renderGrid();
    renderImportBar();
    renderLexical();
    renderGrammar();
    // v5.1-E information architecture: Summary → Vocabulary → Grammar →
    // Kanji → quiet reference caption → notice. Usefulness order; the
    // kanji filter/grid/import stay grouped as one Kanji chapter.
    const kanjiChapter = element('section', { className: 'surface analyzer-chapter min-w-0 p-4 sm:p-5', attrs: { 'aria-label': 'Kanji analysis' } }, [
      element('h2', { className: 'font-semibold text-ink', text: 'Kanji' }),
      element('p', { className: 'mt-1 text-xs leading-5 text-muted', text: `${summary.uniqueKanji} unique · ${summary.totalOccurrences} occurrences · ${summary.inCollection} in collection · ${summary.availableToAdd} available · ${summary.noReferenceData} no reference` }),
      element('div', { className: 'mt-3' }, [filterBar]),
      element('div', { className: 'mt-3' }, [grid]),
      element('div', { className: 'mt-3' }, [importBar])
    ]);
    resultsSection.append(summaryStrip, lexicalSection, grammarSection, kanjiChapter, distributionCaption, notice);
  };

  const kanjiCard = (entry) => {
    const importable = getDiscoveryState(entry) === 'availableToAdd';
    const header = element('div', { className: 'flex items-start justify-between gap-3' }, [
      element('div', { className: 'flex items-baseline gap-2' }, [
        element('span', { className: 'font-jp text-3xl font-medium text-ink', text: entry.character }),
        ...(entry.occurrences > 1 ? [element('span', { className: 'text-xs font-semibold text-muted', text: `×${entry.occurrences}` })] : [])
      ]),
      element('span', { className: 'status-pill shrink-0 text-xs', text: statePill(entry) })
    ]);
    const meaning = entry.inUserCollection ? entry.meaning : entry.referenceMeanings;
    const jlptLevel = entry.inUserCollection ? entry.jlptLevel : entry.referenceJlptLevel;
    const metaLine = [
      ...(jlptLevel ? [`JLPT ${jlptLevel}`] : []),
      ...(entry.occurrences === 1 ? ['1 occurrence'] : [`${entry.occurrences} occurrences`])
    ].join(' · ');
    const readings = [entry.referenceOnyomi, entry.referenceKunyomi].filter(Boolean).join(' · ');
    const rows = [header];
    if (meaning) rows.push(element('p', { className: 'mt-2 break-words text-sm text-ink/80', text: meaning }));
    if (metaLine) rows.push(element('p', { className: 'mt-1 break-words text-xs text-muted', text: metaLine }));
    if (readings) {
      const details = element('details', { className: 'mt-2 text-xs' });
      details.append(
        element('summary', { className: 'cursor-pointer font-semibold text-vermilion', text: 'Reference readings (context only)' }),
        element('p', { className: 'mt-1 leading-5 text-muted', text: readings }),
        element('p', { className: 'mt-1 leading-5 text-muted', text: 'General inventory for this character — not the reading used in the pasted text.' })
      );
      rows.push(details);
    }
    if (importable) {
      const checkbox = element('input', { className: 'mt-0.5 size-4 accent-vermilion', attrs: { type: 'checkbox', value: entry.character, 'aria-label': `Select ${entry.character} for import` } });
      checkbox.checked = selectedChars.has(entry.character);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedChars.add(entry.character);
        else selectedChars.delete(entry.character);
        renderResults();
      });
      const addButton = element('button', { className: 'button-secondary min-h-10 px-4 py-2 text-xs', text: 'Add to My Kanji', attrs: { type: 'button' } });
      addButton.addEventListener('click', () => {
        withPendingAction(addButton, async () => {
          await importKanji([entry.character]);
        }, { pendingLabel: 'Adding…' });
      });
      rows.push(element('div', { className: 'mt-3 flex items-center justify-between gap-3 border-t border-stone pt-3' }, [
        element('label', { className: 'flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink' }, [checkbox, element('span', { text: 'Select' })]),
        addButton
      ]));
    }
    return element('li', { className: 'surface min-w-0 p-4' }, rows);
  };

  // Phase 7 import semantics: sequential POST /api/kanji (per-item
  // 201/409/422), server resolves reference authoritatively. After success
  // the affected cards flip locally — analyzer text preserved, no
  // re-analysis, no reload.
  const importKanji = async (characters, setProgress = null) => {
    if (!characters.length) return;
    try {
      const outcomes = [];
      let index = 0;
      for (const character of characters) {
        index += 1;
        if (typeof setProgress === 'function') setProgress(index, characters.length);
        const payload = buildKanjiImportPayload(rawByChar.get(character));
        if (!payload) continue;
        try {
          const created = await apiRequest('/api/kanji', { method: 'POST', body: payload });
          localCollection.set(character, created && typeof created === 'object'
            ? { meaning: created.meaning ?? null, jlptLevel: created.jlpt_level ?? null, status: created.status ?? null, onyomi: created.onyomi ?? null, kunyomi: created.kunyomi ?? null }
            : { meaning: null, jlptLevel: null, status: null, onyomi: null, kunyomi: null });
          outcomes.push({ character, ok: true, status: 'added' });
        } catch (error) {
          if (error?.status === 409) {
            localCollection.set(character, localCollection.get(character) || { meaning: null, jlptLevel: null, status: null, onyomi: null, kunyomi: null });
            outcomes.push({ character, ok: true, status: 'already' });
          } else {
            outcomes.push({ character, ok: false, status: 'failed' });
          }
        }
      }
      const summary = summarizeImportResults(outcomes);
      const parts = [];
      if (summary.added) parts.push(`${summary.added} added`);
      if (summary.already) parts.push(`${summary.already} already in collection`);
      showToast(parts.length ? `${parts.join(' · ')}.` : 'Nothing was added.');
      if (summary.failed.length) showToast(`Could not add: ${summary.failed.join(', ')}.`, 'error');
      // Local state flip only: imported kanji show "In your collection";
      // the pasted text and remaining analysis are untouched.
      applyLocalCollection();
      renderResults();
    } catch (error) {
      showToast(error.message || 'Unable to import kanji.', 'error');
    }
  };

  analyzeButton.addEventListener('click', async () => {
    const text = input.value;
    if (!text.trim()) {
      showFormError('Paste some Japanese text first.');
      return;
    }
    if (text.length > ANALYZER_MAX_LENGTH) {
      showFormError(`Text exceeds the maximum length of ${ANALYZER_MAX_LENGTH} characters.`);
      return;
    }
    showFormError(null);
    if (!setActionPending(analyzeButton, true, { pendingLabel: 'Analyzing…' })) return;
    // v5.1-E deliberate analyzing transition: truthful skeleton chapters
    // replace prior results the moment analysis starts (no decorative wait).
    resultsSection.replaceChildren(
      element('div', { className: 'surface grid gap-3 p-4 sm:p-5', attrs: { role: 'status', 'aria-label': 'Analyzing text' } }, [
        element('div', { className: 'skeleton-block h-5 w-2/3' }),
        element('div', { className: 'skeleton-block h-4 w-full' }),
        element('div', { className: 'skeleton-block h-4 w-5/6' })
      ])
    );
    try {
      // Hybrid: local button state plus the global overlay if analysis is
      // visibly delayed. Imports keep local progress feedback only.
      const result = await withGlobalLoading(
        () => apiRequest('/api/analyze/text', {
          method: 'POST',
          // Vocabulary analysis is automatic for eligible lengths; longer
          // texts stay Kanji-only without touching the lexical parser.
          // Context-Aware rides the same request (no duplicate Analyze call).
          body: text.length <= LEXICAL_ANALYSIS_MAX_LENGTH ? { text, lexical: { enabled: true }, context: { enabled: true } } : { text }
        }),
        { label: 'Analyzing text…' }
      );
      analysis = result;
      analyzedTextLength = text.length;
      rawByChar = new Map((result.kanji || []).map((entry) => [entry.character, entry]));
      localCollection.clear();
      localVocabAdded.clear();
      activeFilter = 'all';
      applyLocalCollection();
      renderResults();
    } catch (error) {
      showToast(error.message || 'Unable to analyze text.', 'error');
    } finally {
      setActionPending(analyzeButton, false);
    }
  });
}
