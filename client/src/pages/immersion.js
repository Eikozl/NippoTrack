// V5.3a — Immersion reading page.
//
// Paste Japanese text, review the pipeline's candidates (vocabulary, kanji,
// grammar), pick what to study, and create a study session. The backend is
// authoritative: candidate ids, level estimates, and the review session URL
// all come from API responses — this page renders and forwards them, never
// recomputing them client-side.
//
// History rows are deliberately read-only: the history payload carries no
// reviewSessionId, so a "repeat" action would have to silently create a
// duplicate session instead of resuming the original one. Source-text
// previews are likewise absent from the API and are never fabricated here.
//
// Keep imports to exactly one statement per module ('../api' and '../ui')
// and mirror review.js's export shape — client/tests/immersion.test.mjs
// drives this source through a source-transform loader that strips them.

import { analyzeImmersionText, createImmersionSession, listImmersionHistory } from '../api';
import { element, pageHeader, showToast, withPendingAction } from '../ui';

const TEXT_MAX_LENGTH = 5000;
const GROUPS = [
  { key: 'vocabulary', label: 'Vocabulary', idsKey: 'vocabularyIds' },
  { key: 'kanji', label: 'Kanji', idsKey: 'kanjiIds' },
  { key: 'grammar', label: 'Grammar', idsKey: 'grammarIds' }
];

// Hash-routed app: query parameters live after the page name in the hash
// (e.g. `#immersion?returnUrl=/review`).
function hashQueryParam(name) {
  try {
    const hash = typeof window !== 'undefined' && window.location ? window.location.hash || '' : '';
    const queryIndex = hash.indexOf('?');
    if (queryIndex === -1) return null;
    return new URLSearchParams(hash.slice(queryIndex + 1)).get(name);
  } catch {
    return null;
  }
}

// Only internal page routes are honored; anything else drops the back link.
function normalizeReturnTarget(value) {
  const target = String(value || '').trim().replace(/^\/+/, '');
  return /^[a-z][a-z0-9-]*(\?[a-z0-9=&%_.\-/]*)?$/i.test(target) ? target : null;
}

// Navigate to the backend-provided URL through the app's hash routing — the
// URL itself is returned by create-session and never rebuilt client-side.
function followReviewSessionUrl(url) {
  const value = String(url || '');
  if (!value.startsWith('/')) return;
  if (typeof window !== 'undefined' && window.location) {
    // Hash routes carry no leading slash (`#review?…` resolves to `/review?…`).
    window.location.hash = `#${value.replace(/^\/+/, '')}`;
  }
}

export async function renderImmersion(container) {
  const returnTarget = normalizeReturnTarget(hashQueryParam('returnUrl'));

  // Snapshot of the text that produced the current results: create-session
  // re-analyzes server-side, so the sent text must be the analyzed text.
  let analyzedText = '';
  const selections = { vocabularyIds: new Set(), kanjiIds: new Set(), grammarIds: new Set() };

  // ---- Input surface -------------------------------------------------------
  const textarea = element('textarea', {
    className: 'field-control min-h-40 resize-y font-jp',
    attrs: { id: 'immersion-text', name: 'immersion-text', rows: '8', maxlength: String(TEXT_MAX_LENGTH), placeholder: 'Paste or write Japanese text here…' }
  });
  const analyzeButton = element('button', { className: 'button-primary', text: 'Analyze', attrs: { type: 'button' } });
  const inputSurface = element('section', { className: 'surface p-5 sm:p-6' }, [
    element('label', { className: 'field', attrs: { for: 'immersion-text' } }, [
      element('span', { text: 'Japanese text' }),
      element('span', { className: 'text-xs font-normal leading-5 text-muted', text: `Up to ${TEXT_MAX_LENGTH} characters. The level estimate is based on the kanji your text contains.` }),
      textarea
    ]),
    element('div', { className: 'mt-4' }, [analyzeButton])
  ]);

  const resultsSection = element('div', { className: 'mt-6 grid gap-4' });
  resultsSection.hidden = true;

  // Fail-open like review history: hidden when empty or unavailable.
  const historyBlock = element('section', { className: 'surface mt-6 p-5 sm:p-6', attrs: { 'aria-label': 'Immersion history' } });
  historyBlock.hidden = true;

  container.replaceChildren(element('section', {}, [
    pageHeader({
      eyebrow: 'Study tools',
      title: 'Immersion',
      description: 'Paste a text you are reading, pick the words, kanji, and grammar you want to study, and turn them into a review session.'
    }),
    ...(returnTarget
      ? [element('p', { className: 'mb-4' }, [element('a', { className: 'text-sm font-semibold text-vermilion hover:underline', text: 'Back to Review', attrs: { href: `#${returnTarget}` } })])]
      : []),
    inputSurface,
    resultsSection,
    historyBlock
  ]));

  function renderResults(data) {
    const candidates = data?.candidates || {};
    GROUPS.forEach(({ idsKey }) => selections[idsKey].clear());
    resultsSection.replaceChildren();

    // Level estimate badge: a backend decision, rendered as given.
    const estimate = data?.estimatedLevel || null;
    const level = estimate && estimate.level ? String(estimate.level) : null;
    if (level) {
      const percent = Math.max(0, Math.min(100, Math.round(Number(estimate.confidence || 0) * 100)));
      resultsSection.appendChild(element('p', { className: 'status-pill', text: `Estimated level: ${level} · ${percent}%` }));
    } else {
      resultsSection.appendChild(element('p', { className: 'text-sm text-muted', text: 'Could not estimate a level.' }));
    }

    const footer = element('div', { className: 'surface review-sticky-footer flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });
    const countNote = element('p', { className: 'text-sm text-muted', text: '0 selected', attrs: { 'aria-live': 'polite' } });
    const createButton = element('button', { className: 'button-primary', text: 'Create study session', attrs: { type: 'button', disabled: '' } });
    footer.append(countNote, createButton);

    function selectedTotal() {
      return GROUPS.reduce((sum, { idsKey }) => sum + selections[idsKey].size, 0);
    }
    function refreshFooter() {
      const total = selectedTotal();
      countNote.textContent = `${total} selected`;
      if (total > 0) createButton.removeAttribute('disabled');
      else createButton.setAttribute('disabled', '');
    }

    GROUPS.forEach(({ key, label, idsKey }) => {
      const items = Array.isArray(candidates[key]) ? candidates[key] : [];
      const section = element('section', { className: 'surface p-5 sm:p-6', attrs: { 'aria-label': label } });
      section.appendChild(element('div', { className: 'flex flex-wrap items-center justify-between gap-3' }, [
        element('h2', { className: 'text-sm font-bold uppercase tracking-[0.12em] text-ink', text: `${label.toUpperCase()} · ${items.length}` })
      ]));

      if (!items.length) {
        section.appendChild(element('p', { className: 'mt-3 text-xs leading-5 text-muted', text: `No ${label.toLowerCase()} found in this text.` }));
        resultsSection.appendChild(section);
        return;
      }

      const listActions = element('div', { className: 'mt-3 flex flex-wrap gap-2' });
      const selectAllButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Select all', attrs: { type: 'button' } });
      const clearButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Clear', attrs: { type: 'button' } });
      listActions.append(selectAllButton, clearButton);
      section.appendChild(listActions);

      const list = element('ul', { className: 'mt-4 grid gap-2' });
      const boxes = [];
      items.forEach((item) => {
        const checkbox = element('input', { className: 'mt-1 size-4 shrink-0 accent-vermilion', attrs: { type: 'checkbox', 'aria-label': `Select ${item.display}` } });
        checkbox.dataset.id = String(item.id);
        boxes.push(checkbox);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selections[idsKey].add(checkbox.dataset.id);
          else selections[idsKey].delete(checkbox.dataset.id);
          refreshFooter();
        });
        list.appendChild(element('li', {}, [
          element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:bg-paper' }, [
            checkbox,
            element('span', { className: 'min-w-0' }, [
              element('span', { className: 'block break-words font-jp font-semibold text-ink', text: item.display }),
              ...(item.reading ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: item.reading })] : []),
              ...(item.meaning ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: item.meaning })] : []),
              ...(item.jlpt ? [element('span', { className: 'status-pill mt-1.5', text: item.jlpt })] : []),
              ...(item.known ? [element('span', { className: 'status-pill mt-1.5', text: 'In your collection' })] : [])
            ])
          ])
        ]));
      });
      section.appendChild(list);

      selectAllButton.addEventListener('click', () => {
        boxes.forEach((checkbox) => {
          if (!checkbox.checked) {
            checkbox.checked = true;
            selections[idsKey].add(checkbox.dataset.id);
          }
        });
        refreshFooter();
      });
      clearButton.addEventListener('click', () => {
        boxes.forEach((checkbox) => {
          checkbox.checked = false;
          selections[idsKey].delete(checkbox.dataset.id);
        });
        refreshFooter();
      });

      resultsSection.appendChild(section);
    });

    resultsSection.appendChild(footer);
    refreshFooter();
    resultsSection.hidden = false;

    createButton.addEventListener('click', () => {
      if (!selectedTotal()) return;
      const selectedItems = {
        vocabularyIds: [...selections.vocabularyIds],
        kanjiIds: [...selections.kanjiIds],
        grammarIds: [...selections.grammarIds]
      };
      withPendingAction(createButton, async () => {
        const result = await createImmersionSession({ text: analyzedText, selectedItems });
        // Hand-off queue for the Review page: freshly enrolled items have no
        // review_events yet, so date-range discovery cannot surface them.
        // The server returns the resolved items; Review consumes them against
        // the freshly created OPEN review session (grading still validates
        // ownership server-side). sessionStorage is per-tab and consumed once.
        const queueItems = Array.isArray(result?.items) ? result.items : [];
        try {
          if (typeof window !== 'undefined' && window.sessionStorage && queueItems.length) {
            window.sessionStorage.setItem('jlt-immersion-review-queue', JSON.stringify({
              reviewSessionId: Number(result?.reviewSessionId),
              items: queueItems
            }));
          }
        } catch { /* storage full/blocked: Review falls back to its banner */ }
        followReviewSessionUrl(result?.reviewSessionUrl);
      }, { pendingLabel: 'Creating…' }).catch((error) => {
        showToast(error?.message || 'Unable to create the study session.', 'error');
      });
    });
  }

  analyzeButton.addEventListener('click', () => {
    const text = String(textarea.value || '').trim();
    if (!text) {
      showToast('Paste some Japanese text first.', 'error');
      return;
    }
    withPendingAction(analyzeButton, async () => {
      const data = await analyzeImmersionText(text);
      analyzedText = text;
      renderResults(data);
    }, { pendingLabel: 'Analyzing…' }).catch((error) => {
      showToast(error?.message || 'Unable to analyze this text.', 'error');
    });
  });

  async function loadHistory() {
    try {
      const data = await listImmersionHistory({ limit: 10 });
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        historyBlock.hidden = true;
        historyBlock.replaceChildren();
        return;
      }
      historyBlock.replaceChildren(
        element('h2', { className: 'font-semibold text-ink', text: 'Immersion history' }),
        element('p', { className: 'mt-1 text-sm text-muted', text: 'Texts you turned into study sessions, newest first.' }),
        element('ul', { className: 'mt-4 grid gap-2' }, items.map((item) => {
          const date = String(item.createdAt || '').slice(0, 10);
          const counts = item.items || {};
          const levelText = item.estimatedLevel
            ? `Estimated level: ${item.estimatedLevel}${item.confidence != null ? ` · ${Math.round(Number(item.confidence) * 100)}%` : ''}`
            : 'No level estimate';
          return element('li', { className: 'rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm' }, [
            element('p', { className: 'font-semibold text-ink', text: date || 'Session' }),
            element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: levelText }),
            element('p', { className: 'mt-0.5 break-words text-xs leading-5 text-muted', text: `${Number(counts.total || 0)} items · ${Number(counts.vocabulary || 0)} vocabulary · ${Number(counts.kanji || 0)} kanji · ${Number(counts.grammar || 0)} grammar` })
          ]);
        }))
      );
      historyBlock.hidden = false;
    } catch {
      historyBlock.hidden = true;
    }
  }

  loadHistory();
}
