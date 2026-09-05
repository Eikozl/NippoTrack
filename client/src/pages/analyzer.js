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
import { element, pageHeader, setActionPending, showToast, withGlobalLoading, withPendingAction } from '../ui.js';
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

function statePill(formatted) {
  const state = getDiscoveryState(formatted);
  if (state === 'alreadyInCollection') return 'In your collection';
  if (state === 'availableToAdd') return 'Available from reference';
  return 'No reference data';
}

export async function renderAnalyzer(container) {
  container.replaceChildren();
  container.append(pageHeader({
    eyebrow: 'Study tools',
    title: 'Text Analyzer',
    description: 'Paste Japanese text to see the kanji it contains, which ones are already in your collection, and which reference-backed kanji you can add.'
  }));

  let analysis = null;
  let formatted = [];
  let rawByChar = new Map();
  const localCollection = new Map();
  let activeFilter = 'all';
  let selectedChars = new Set();

  const formCard = element('section', { className: 'surface p-5 sm:p-6' });
  const resultsSection = element('section', { className: 'mt-6 grid gap-5' });
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
      element('span', { className: 'text-xs font-normal leading-5 text-muted', text: `Analysis is read-only — nothing is saved or added unless you explicitly import. Up to ${ANALYZER_MAX_LENGTH} characters.` })
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

    const summaryTiles = [
      ['Unique kanji', String(summary.uniqueKanji)],
      ['Total occurrences', String(summary.totalOccurrences)],
      ['In collection', String(summary.inCollection)],
      ['Available to add', String(summary.availableToAdd)],
      ['No reference data', String(summary.noReferenceData)]
    ].map(([label, value]) => element('div', { className: 'surface p-4 text-center' }, [
      element('p', { className: 'text-2xl font-semibold text-ink', text: value }),
      element('p', { className: 'mt-1 text-xs text-muted', text: label })
    ]));
    const summaryGrid = element('div', { className: 'grid grid-cols-2 gap-3 sm:grid-cols-5' }, summaryTiles);

    const distributionLine = [...ANALYZER_JLPT_LEVELS, 'unclassified']
      .map((level) => `${level === 'unclassified' ? 'Unclassified' : level}: ${distribution[level] ?? 0}`)
      .join(' · ');
    const distributionCard = element('div', { className: 'surface p-4' }, [
      element('h3', { className: 'text-sm font-semibold text-ink', text: 'Kanji reference distribution' }),
      element('p', { className: 'mt-1 text-sm text-ink/80', text: distributionLine }),
      element('p', { className: 'mt-1 text-xs text-muted', text: 'Unique kanji by reference level only — not a text level, not a proficiency estimate.' })
    ]);

    const notice = element('p', { className: 'rounded-lg border border-stone bg-paper p-4 text-xs leading-5 text-muted', text: analysis.notice || '' });

    const filterBar = element('div', { className: 'flex flex-wrap gap-2', attrs: { role: 'group', 'aria-label': 'Filter analyzed kanji' } });
    const grid = element('ul', { className: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3' });
    const importBar = element('div', { className: 'surface flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });

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
          className: `rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter.value === activeFilter ? 'border-vermilion bg-vermilion text-white' : 'border-stone bg-white text-ink hover:bg-paper'}`,
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
    resultsSection.append(summaryGrid, distributionCard, notice, filterBar, grid, importBar);
  };

  const kanjiCard = (entry) => {
    const importable = getDiscoveryState(entry) === 'availableToAdd';
    const header = element('div', { className: 'flex items-start justify-between gap-3' }, [
      element('div', { className: 'flex items-baseline gap-2' }, [
        element('span', { className: 'text-3xl font-medium text-ink', text: entry.character }),
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
    if (meaning) rows.push(element('p', { className: 'mt-2 text-sm text-ink/80', text: meaning }));
    if (metaLine) rows.push(element('p', { className: 'mt-1 text-xs text-muted', text: metaLine }));
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
      const addButton = element('button', { className: 'button-secondary min-h-8 px-3 py-1 text-xs', text: 'Add to My Kanji', attrs: { type: 'button' } });
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
    return element('li', { className: 'surface p-4' }, rows);
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
    try {
      // Hybrid: local button state plus the global overlay if analysis is
      // visibly delayed. Imports keep local progress feedback only.
      const result = await withGlobalLoading(
        () => apiRequest('/api/analyze/text', { method: 'POST', body: { text } }),
        { label: 'Analyzing text…' }
      );
      analysis = result;
      rawByChar = new Map((result.kanji || []).map((entry) => [entry.character, entry]));
      localCollection.clear();
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
