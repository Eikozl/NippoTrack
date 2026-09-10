import { apiRequest, queryString } from '../api';
import { element, emptyState, errorState, loadingState, pageHeader, showToast, withPendingAction } from '../ui';

const TYPE_ORDER = ['kanji', 'vocabulary', 'grammar'];
const TYPE_LABEL = { kanji: 'Kanji', vocabulary: 'Vocabulary', grammar: 'Grammar' };
const TYPE_HEADING = { kanji: 'KANJI', vocabulary: 'VOCABULARY', grammar: 'GRAMMAR' };
const JLPT_OPTIONS = ['all', 'N5', 'N4', 'N3', 'N2', 'N1'];
const GRADES = [
  { result: 'Again', hint: "I couldn't recall it" },
  { result: 'Hard', hint: 'I recalled it with difficulty' },
  { result: 'Good', hint: 'I recalled it comfortably' }
];

let activeReview = { sessionId: null, selected: [] };
let detachReviewKeys = null;

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayISO() {
  return toISODate(new Date());
}

function daysAgoISO(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toISODate(date);
}

function provenanceLine(item) {
  const first = Array.isArray(item.sources) && item.sources.length ? item.sources[0] : null;
  if (!first) return '';
  const label = first.label || '';
  const context = first.context || '';
  if (label && context) return `${label} — ${context}`;
  return label || context || '';
}

function isWeak(item) {
  return item.evidenceStrength === 'weak';
}

function itemKey(item) {
  return `${item.entityType}:${item.entityId}`;
}

export async function renderReview(container) {
  if (typeof detachReviewKeys === 'function') {
    try { detachReviewKeys(); } catch { /* noop */ }
    detachReviewKeys = null;
  }
  activeReview = { sessionId: null, selected: [] };

  const today = todayISO();
  const defaultFrom = daysAgoISO(3);

  let stage = 'INTRO';
  let lastSearch = null;
  let candidatesByKey = new Map();
  let selectedKeys = new Set();
  let queue = [];
  let currentIndex = 0;
  let revealed = false;
  let sessionId = null;
  let gradeButtons = [];
  let localDetach = null;

  function detachKeys() {
    if (typeof localDetach === 'function') {
      try { localDetach(); } catch { /* noop */ }
    }
    localDetach = null;
    if (detachReviewKeys) detachReviewKeys = null;
  }

  const content = element('div');

  // Hero surface: INTRO copy on top, SETUP form expands below it.
  const heroSurface = element('div', { className: 'surface p-5 sm:p-8' });

  const introBlock = element('div', {}, [
    element('p', { className: 'eyebrow', text: 'Review' }),
    element('h1', { className: 'mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: 'Want to review your JLPT study?', attrs: { tabindex: '-1' } }),
    element('p', { className: 'mt-3 max-w-2xl text-sm leading-6 text-muted', text: 'Revisit recent study activity with focused recall, one item at a time. Use self-assessment to note how each item felt and decide what to look at again.' })
  ]);
  const startWrap = element('div', { className: 'mt-5' });
  const startButton = element('button', { className: 'button-primary', text: 'Start review', attrs: { type: 'button' } });
  startWrap.appendChild(startButton);

  // Setup form (hidden until SETUP).
  const setupWrap = element('div', { className: 'mt-6 overflow-hidden border-t border-stone pt-6 transition-all duration-200' });
  const backButton = element('button', { className: 'text-sm font-semibold text-vermilion hover:underline', text: 'Back', attrs: { type: 'button' } });
  const setupTitle = element('h2', { className: 'mt-2 text-lg font-semibold text-ink', text: 'Find material' });
  const setupForm = element('form', { className: 'mt-4 grid gap-5', attrs: { novalidate: '' } });

  // Date preset radio group.
  const presetFieldset = element('fieldset', { className: 'grid gap-2' });
  presetFieldset.appendChild(element('legend', { className: 'text-sm font-semibold text-ink', text: 'Date range' }));
  const presetOptions = element('div', { className: 'flex flex-wrap gap-2' });
  const presetRadios = [];
  [
    { value: 'today', label: 'Today' },
    { value: 'last3', label: 'Last 3 days' },
    { value: 'custom', label: 'Custom range' }
  ].forEach(({ value, label }) => {
    const radio = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'radio', name: 'review-preset', value, ...(value === 'last3' ? { checked: '' } : {}) }
    });
    presetRadios.push(radio);
    const pill = element('label', { className: 'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone bg-paper px-3 py-2 text-sm font-medium text-ink' }, [
      radio,
      element('span', { text: label })
    ]);
    presetOptions.appendChild(pill);
  });
  presetFieldset.appendChild(presetOptions);

  // Custom From/To inputs.
  const fromInput = element('input', {
    className: 'field-control',
    attrs: { type: 'date', name: 'review-from', value: defaultFrom, max: today, 'aria-label': 'From date' }
  });
  const toInput = element('input', {
    className: 'field-control',
    attrs: { type: 'date', name: 'review-to', value: today, max: today, 'aria-label': 'To date' }
  });
  const customWrap = element('div', { className: 'hidden grid gap-3 sm:grid-cols-2', attrs: { 'aria-hidden': 'true' } }, [
    element('label', { className: 'field' }, [element('span', { text: 'From' }), fromInput]),
    element('label', { className: 'field' }, [element('span', { text: 'To' }), toInput])
  ]);

  // JLPT radio group.
  const jlptFieldset = element('fieldset', { className: 'grid gap-2' });
  jlptFieldset.appendChild(element('legend', { className: 'text-sm font-semibold text-ink', text: 'JLPT level' }));
  const jlptOptions = element('div', { className: 'flex flex-wrap gap-2' });
  JLPT_OPTIONS.forEach((value) => {
    const radio = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'radio', name: 'review-jlpt', value, ...(value === 'all' ? { checked: '' } : {}) }
    });
    const label = value === 'all' ? 'All' : value;
    jlptOptions.appendChild(element('label', { className: 'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone bg-paper px-3 py-2 text-sm font-medium text-ink' }, [
      radio,
      element('span', { text: label })
    ]));
  });
  jlptFieldset.appendChild(jlptOptions);

  // Type checkboxes.
  const typesFieldset = element('fieldset', { className: 'grid gap-2' });
  typesFieldset.appendChild(element('legend', { className: 'text-sm font-semibold text-ink', text: 'Material types' }));
  const typesOptions = element('div', { className: 'flex flex-wrap gap-2' });
  TYPE_ORDER.forEach((value) => {
    const checkbox = element('input', {
      className: 'size-4 accent-vermilion',
      attrs: { type: 'checkbox', name: 'review-types', value, checked: '' }
    });
    typesOptions.appendChild(element('label', { className: 'inline-flex cursor-pointer items-center gap-2 rounded-xl border border-stone bg-paper px-3 py-2 text-sm font-medium text-ink' }, [
      checkbox,
      element('span', { text: TYPE_LABEL[value] })
    ]));
  });
  typesFieldset.appendChild(typesOptions);

  const formError = element('p', { className: 'hidden text-sm leading-6 text-red-700', attrs: { role: 'alert' } });
  const findButton = element('button', { className: 'button-primary w-full sm:w-auto', text: 'Find material', attrs: { type: 'submit' } });

  setupForm.append(presetFieldset, customWrap, jlptFieldset, typesFieldset, formError, element('div', {}, [findButton]));
  setupWrap.append(backButton, setupTitle, setupForm);
  setupWrap.hidden = true;

  heroSurface.append(introBlock, startWrap, setupWrap);

  // Summary bar shown during CANDIDATES.
  const summaryBar = element('div', { className: 'surface mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });
  const summaryText = element('p', { className: 'text-sm font-medium text-ink' });
  const editButton = element('button', { className: 'button-secondary shrink-0', text: 'Edit search', attrs: { type: 'button' } });
  summaryBar.append(summaryText, editButton);
  summaryBar.hidden = true;

  const candidatesBlock = element('div', { className: 'grid gap-4' });
  candidatesBlock.hidden = true;

  const reviewingBlock = element('div', { className: 'grid gap-4' });
  reviewingBlock.hidden = true;

  const completeBlock = element('div');
  completeBlock.hidden = true;

  container.replaceChildren(element('section', {}, [
    pageHeader({ eyebrow: 'Recall', title: 'Review', description: 'Choose recent activity and review it at a steady pace.' }),
    heroSurface,
    summaryBar,
    candidatesBlock,
    reviewingBlock,
    completeBlock
  ]));

  function currentPreset() {
    const checked = setupForm.querySelector('input[name="review-preset"]:checked');
    return checked ? checked.value : 'last3';
  }

  function currentJlpt() {
    const checked = setupForm.querySelector('input[name="review-jlpt"]:checked');
    return checked ? checked.value : 'all';
  }

  function currentTypes() {
    return Array.from(setupForm.querySelectorAll('input[name="review-types"]:checked')).map((node) => node.value);
  }

  function syncCustomVisibility() {
    const isCustom = currentPreset() === 'custom';
    customWrap.classList.toggle('hidden', !isCustom);
    customWrap.setAttribute('aria-hidden', String(!isCustom));
  }

  function showFormError(message) {
    if (!message) {
      formError.textContent = '';
      formError.classList.add('hidden');
      return;
    }
    formError.textContent = message;
    formError.classList.remove('hidden');
  }

  function presetLabel(preset, from, to) {
    if (preset === 'today') return 'Today';
    if (preset === 'last3') return 'Last 3 days';
    return `${from} to ${to}`;
  }

  function summaryLabel(search) {
    const jlptLabel = search.jlpt === 'all' ? 'All levels' : search.jlpt;
    let typesLabel;
    if (search.types.length === 3) typesLabel = '3 types';
    else if (search.types.length === 1) typesLabel = TYPE_LABEL[search.types[0]] || search.types[0];
    else typesLabel = search.types.map((type) => TYPE_LABEL[type] || type).join(' + ');
    return `${search.presetLabel} · ${jlptLabel} · ${typesLabel}`;
  }

  function setStage(next) {
    stage = next;
    heroSurface.hidden = !(next === 'INTRO' || next === 'SETUP');
    startWrap.hidden = next !== 'INTRO';
    setupWrap.hidden = next !== 'SETUP';
    summaryBar.hidden = next !== 'CANDIDATES';
    candidatesBlock.hidden = next !== 'CANDIDATES';
    reviewingBlock.hidden = next !== 'REVIEWING';
    completeBlock.hidden = next !== 'COMPLETE';
    if (next !== 'REVIEWING') detachKeys();
  }

  startButton.addEventListener('click', () => {
    showFormError('');
    setStage('SETUP');
    syncCustomVisibility();
  });

  backButton.addEventListener('click', () => {
    showFormError('');
    setStage('INTRO');
  });

  editButton.addEventListener('click', () => {
    // Keep every control value so the search can be refined.
    showFormError('');
    setStage('SETUP');
    syncCustomVisibility();
  });

  presetRadios.forEach((radio) => radio.addEventListener('change', syncCustomVisibility));
  syncCustomVisibility();

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    showFormError('');
    const preset = currentPreset();
    const jlpt = currentJlpt();
    const types = currentTypes();
    if (!types.length) {
      showFormError('Choose at least one material type.');
      return;
    }
    let from;
    let to;
    if (preset === 'today') {
      from = todayISO();
      to = todayISO();
    } else if (preset === 'last3') {
      from = daysAgoISO(3);
      to = todayISO();
    } else {
      from = (fromInput.value || '').slice(0, 10);
      to = (toInput.value || '').slice(0, 10);
      if (!from || !to) {
        showFormError('Choose From and To dates.');
        return;
      }
      if (from > to) {
        showFormError('Choose a From date on or before the To date.');
        return;
      }
      if (to > todayISO()) {
        showFormError('Choose a To date on or before today.');
        return;
      }
    }
    const search = { preset, presetLabel: presetLabel(preset, from, to), from, to, jlpt, types: [...types] };
    lastSearch = search;
    summaryText.textContent = summaryLabel(search);
    setStage('CANDIDATES');
    loadCandidates();
  });

  async function loadCandidates() {
    if (!lastSearch) return;
    selectedKeys = new Set();
    candidatesByKey = new Map();
    candidatesBlock.replaceChildren(loadingState('Finding material…'));
    try {
      const data = await apiRequest(`/api/review/candidates${queryString({
        from: lastSearch.from,
        to: lastSearch.to,
        jlpt: lastSearch.jlpt,
        types: lastSearch.types.join(',')
      })}`);
      renderCandidates(data);
    } catch (error) {
      candidatesBlock.replaceChildren(errorState(error, loadCandidates));
    }
  }

  function renderCandidates(data) {
    const groups = data?.groups || {};
    const orderedTypes = TYPE_ORDER.filter((type) => lastSearch.types.includes(type));
    let grandTotal = 0;
    orderedTypes.forEach((type) => {
      const group = groups[type] || {};
      const items = Array.isArray(group.items) ? group.items : [];
      grandTotal += items.length;
    });
    if (!grandTotal) {
      candidatesBlock.replaceChildren(emptyState({
        title: 'No material found',
        description: 'Try widening the date range or including more types.'
      }));
      return;
    }

    candidatesBlock.replaceChildren();
    const footer = element('div', { className: 'surface review-sticky-footer flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between' });
    const countNote = element('p', { className: 'text-sm text-muted', text: '0 selected', attrs: { 'aria-live': 'polite' } });
    const beginButton = element('button', { className: 'button-primary', text: 'Start review', attrs: { type: 'button', disabled: '' } });
    footer.append(countNote, beginButton);

    function refreshFooter() {
      countNote.textContent = `${selectedKeys.size} selected`;
      if (selectedKeys.size > 0) beginButton.removeAttribute('disabled');
      else beginButton.setAttribute('disabled', '');
    }

    function registerCheckbox(checkbox, item) {
      checkbox.addEventListener('change', () => {
        const key = itemKey(item);
        if (checkbox.checked) selectedKeys.add(key);
        else selectedKeys.delete(key);
        refreshFooter();
      });
    }

    orderedTypes.forEach((type) => {
      const group = groups[type] || {};
      const items = Array.isArray(group.items) ? group.items : [];
      if (!items.length) return;
      items.forEach((item) => candidatesByKey.set(itemKey(item), item));
      const studied = items.filter((item) => !isWeak(item));
      const weak = items.filter((item) => isWeak(item));
      const total = typeof group.total === 'number' ? group.total : items.length;

      const section = element('section', { className: 'surface p-5 sm:p-6', attrs: { 'aria-label': TYPE_LABEL[type] } });
      const headingRow = element('div', { className: 'flex flex-wrap items-center justify-between gap-3' }, [
        element('h2', { className: 'text-sm font-bold uppercase tracking-[0.12em] text-ink', text: `${TYPE_HEADING[type]} · ${total}` })
      ]);
      const listActions = element('div', { className: 'flex flex-wrap gap-2' });
      const selectAllButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Select all', attrs: { type: 'button' } });
      const clearButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-sm', text: 'Clear', attrs: { type: 'button' } });
      listActions.append(selectAllButton, clearButton);

      const list = element('ul', { className: 'mt-4 grid gap-2' });
      const studiedBoxes = [];
      studied.forEach((item) => {
        const checkbox = element('input', { className: 'mt-1 size-4 shrink-0 accent-vermilion', attrs: { type: 'checkbox' } });
        checkbox.dataset.key = itemKey(item);
        studiedBoxes.push(checkbox);
        registerCheckbox(checkbox, item);
        const line = provenanceLine(item);
        const meta = [item.reading, item.meaning].filter(Boolean).join(' — ');
        list.appendChild(element('li', {}, [
          element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:bg-paper' }, [
            checkbox,
            element('span', { className: 'min-w-0' }, [
              element('span', { className: 'block break-words font-jp font-semibold text-ink', text: item.display }),
              ...(line ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: line })] : []),
              ...(meta ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: meta })] : []),
              ...(item.jlpt ? [element('span', { className: 'status-pill mt-1.5', text: item.jlpt })] : [])
            ])
          ])
        ]));
      });

      selectAllButton.addEventListener('click', () => {
        studiedBoxes.forEach((checkbox) => {
          if (!checkbox.checked) {
            checkbox.checked = true;
            selectedKeys.add(checkbox.dataset.key);
          }
        });
        refreshFooter();
      });
      clearButton.addEventListener('click', () => {
        section.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
          checkbox.checked = false;
          selectedKeys.delete(checkbox.dataset.key);
        });
        refreshFooter();
      });

      section.append(headingRow, listActions);
      section.appendChild(list);
      if (group.truncated) {
        section.appendChild(element('p', { className: 'mt-3 text-xs leading-5 text-muted', text: 'Showing the first results — narrow the date range for a smaller set.' }));
      }

      if (weak.length) {
        const weakBoxes = [];
        const weakList = element('ul', { className: 'mt-2 grid gap-2' });
        weak.forEach((item) => {
          const checkbox = element('input', { className: 'mt-1 size-4 shrink-0 accent-vermilion', attrs: { type: 'checkbox' } });
          checkbox.dataset.key = itemKey(item);
          weakBoxes.push(checkbox);
          registerCheckbox(checkbox, item);
          const line = provenanceLine(item);
          weakList.appendChild(element('li', {}, [
            element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:bg-paper' }, [
              checkbox,
              element('span', { className: 'min-w-0' }, [
                element('span', { className: 'block break-words font-jp font-semibold text-ink', text: item.display }),
                ...(line ? [element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: line })] : [])
              ])
            ])
          ]));
        });
        const weakSelectAll = element('button', { className: 'button-secondary mt-2 min-h-9 px-3 py-1.5 text-sm', text: 'Select all recent additions', attrs: { type: 'button' } });
        weakSelectAll.addEventListener('click', () => {
          weakBoxes.forEach((checkbox) => {
            if (!checkbox.checked) {
              checkbox.checked = true;
              selectedKeys.add(checkbox.dataset.key);
            }
          });
          refreshFooter();
        });
        const details = element('details', { className: 'mt-4 rounded-xl border border-stone bg-paper/40 p-3' }, [
          element('summary', { className: 'cursor-pointer text-sm font-semibold text-muted', text: `Recent additions (${weak.length}) — added, not proven study` }),
          element('p', { className: 'mt-2 text-xs leading-5 text-muted', text: 'These were added in this period. Include them only if you want to look at them now.' }),
          weakSelectAll,
          weakList
        ]);
        section.appendChild(details);
      }

      candidatesBlock.appendChild(section);
    });

    candidatesBlock.appendChild(footer);
    refreshFooter();

    beginButton.addEventListener('click', () => {
      if (!selectedKeys.size) return;
      const picked = [];
      TYPE_ORDER.forEach((type) => {
        const group = (data.groups || {})[type] || {};
        (Array.isArray(group.items) ? group.items : []).forEach((item) => {
          if (selectedKeys.has(itemKey(item))) {
            picked.push({
              entityType: item.entityType,
              entityId: item.entityId,
              display: item.display,
              reading: item.reading,
              meaning: item.meaning
            });
          }
        });
      });
      if (!picked.length) return;
      withPendingAction(beginButton, async () => {
        const session = await apiRequest('/api/review/sessions', {
          method: 'POST',
          body: { sourceFrom: lastSearch.from, sourceTo: lastSearch.to }
        });
        sessionId = session.id;
        queue = picked;
        currentIndex = 0;
        revealed = false;
        activeReview = { sessionId, selected: picked };
        setStage('REVIEWING');
        renderCard();
      }, { pendingLabel: 'Starting…' }).catch((error) => {
        showToast(error?.message || 'Unable to start the review.', 'error');
      });
    });
  }

  function attachGradeKeys() {
    const handler = (event) => {
      if (!['1', '2', '3'].includes(event.key)) return;
      const tag = document.activeElement?.tagName;
      if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (stage !== 'REVIEWING' || !revealed) return;
      const target = gradeButtons[Number(event.key) - 1];
      if (target && !target.disabled) {
        event.preventDefault();
        target.click();
      }
    };
    document.addEventListener('keydown', handler);
    localDetach = () => document.removeEventListener('keydown', handler);
    detachReviewKeys = localDetach;
  }

  function renderCard() {
    detachKeys();
    attachGradeKeys();
    revealed = false;
    gradeButtons = [];
    const total = queue.length;
    const item = queue[currentIndex];
    reviewingBlock.replaceChildren();

    const progress = element('p', {
      className: 'text-sm font-semibold text-muted',
      text: `${currentIndex + 1} of ${total}`,
      attrs: { 'aria-live': 'polite' }
    });
    const counter = element('span', { className: 'text-xs font-semibold text-muted', text: `${currentIndex + 1} / ${total}` });
    // Thin determinate track mirrors the announced progress visually only
    // (text labels carry meaning; color never acts alone).
    const track = element('div', { className: 'review-progress-track mt-3', attrs: { 'aria-hidden': 'true' } }, [
      element('div', { className: 'review-progress-fill', attrs: { style: `width: ${total ? Math.round(((currentIndex + 1) / total) * 100) : 0}%` } })
    ]);
    const title = element('h2', { className: 'mt-2 break-words text-3xl font-semibold tracking-tight text-ink', text: item.display, attrs: { tabindex: '-1' } });
    const card = element('article', { className: 'surface review-card p-5 sm:p-8' }, [
      element('div', { className: 'flex items-start justify-between gap-3' }, [progress, counter]),
      track,
      title
    ]);

    const body = element('div', { className: 'mt-5 border-t border-stone pt-5' });
    card.appendChild(body);

    function renderFront() {
      body.replaceChildren();
      const revealButton = element('button', { className: 'button-primary', text: 'Reveal answer', attrs: { type: 'button' } });
      revealButton.addEventListener('click', () => {
        revealed = true;
        renderAnswer();
      });
      body.appendChild(revealButton);
    }

    function renderAnswer() {
      body.replaceChildren();
      if (item.reading) body.appendChild(element('p', { className: 'text-sm text-muted', text: item.reading }));
      if (item.meaning) body.appendChild(element('p', { className: 'mt-2 text-base leading-7 text-ink', text: item.meaning }));
      body.appendChild(element('p', { className: 'mt-5 text-sm font-semibold text-ink', text: 'How did recall feel?' }));
      const grades = element('div', { className: 'mt-3 grid gap-2 sm:grid-cols-3' });
      GRADES.forEach(({ result, hint }, gradeIndex) => {
        const button = element('button', { className: 'button-secondary flex-col gap-1 px-4 py-3 text-center', attrs: { type: 'button', 'aria-keyshortcuts': String(gradeIndex + 1) } }, [
          element('span', { className: 'block text-sm font-semibold', text: result }),
          element('span', { className: 'block text-xs font-normal leading-5 text-muted', text: hint })
        ]);
        button.addEventListener('click', () => {
          withPendingAction(button, async () => {
            await apiRequest('/api/review/grade', {
              method: 'POST',
              body: { entityType: item.entityType, entityId: item.entityId, result, reviewSessionId: sessionId }
            });
            if (currentIndex + 1 < total) {
              currentIndex += 1;
              renderCard();
            } else {
              await finishReview();
            }
          }, { pendingLabel: 'Saving…' }).catch((error) => {
            showToast(error?.message || 'Unable to save this response.', 'error');
          });
        });
        gradeButtons.push(button);
        grades.appendChild(button);
      });
      body.appendChild(grades);
      body.appendChild(element('p', { className: 'mt-3 text-xs text-muted', text: 'Shortcuts: 1 Again · 2 Hard · 3 Good' }));
    }

    reviewingBlock.appendChild(card);
    renderFront();
    title.focus({ preventScroll: true });
  }

  async function finishReview() {
    reviewingBlock.replaceChildren(loadingState('Wrapping up…'));
    try {
      const summary = await apiRequest(`/api/review/sessions/${sessionId}/complete`, { method: 'POST' });
      renderComplete(summary);
    } catch (error) {
      reviewingBlock.replaceChildren(errorState(error, finishReview));
    }
  }

  function renderComplete(summary) {
    detachKeys();
    setStage('COMPLETE');
    completeBlock.replaceChildren();
    const total = Number(summary?.total || 0);
    const byType = summary?.byType || {};
    const byResult = summary?.byResult || {};
    const kanjiCount = Number(byType.kanji || 0);
    const vocabCount = Number(byType.vocabulary || 0);
    const grammarCount = Number(byType.grammar || 0);
    const goodCount = Number(byResult.Good || 0);
    const hardCount = Number(byResult.Hard || 0);
    const againCount = Number(byResult.Again || 0);

    const heading = element('h1', { className: 'text-2xl font-semibold tracking-tight text-ink sm:text-3xl', text: 'Review complete', attrs: { tabindex: '-1' } });
    const card = element('div', { className: 'surface p-5 sm:p-8' }, [
      heading,
      element('p', { className: 'mt-3 text-sm leading-6 text-muted', text: `${total} items reviewed` }),
      element('ul', { className: 'mt-4 grid gap-1.5 text-sm font-medium text-ink' }, [
        element('li', { text: `${kanjiCount} Kanji` }),
        element('li', { text: `${vocabCount} Vocabulary` }),
        element('li', { text: `${grammarCount} Grammar` })
      ]),
      element('ul', { className: 'mt-4 grid gap-1.5 border-t border-stone pt-4 text-sm leading-6 text-muted' }, [
        element('li', { text: `${goodCount} felt comfortable` }),
        element('li', { text: `${hardCount} felt difficult` }),
        element('li', { text: `${againCount} should be revisited` })
      ]),
      element('div', { className: 'mt-6 flex flex-col gap-2 sm:flex-row' }, [
        element('button', { className: 'button-primary', text: 'Back to Review', attrs: { type: 'button' } }),
        element('a', { className: 'button-secondary', text: 'Go to Dashboard', attrs: { href: '#dashboard' } })
      ])
    ]);
    const resetButton = card.querySelector('button');
    resetButton.addEventListener('click', () => {
      // Reset to a fresh INTRO so a new round starts from defaults.
      setupForm.querySelector('input[name="review-preset"][value="last3"]').checked = true;
      setupForm.querySelector('input[name="review-jlpt"][value="all"]').checked = true;
      setupForm.querySelectorAll('input[name="review-types"]').forEach((node) => { node.checked = true; });
      fromInput.value = daysAgoISO(3);
      toInput.value = todayISO();
      showFormError('');
      syncCustomVisibility();
      lastSearch = null;
      queue = [];
      currentIndex = 0;
      revealed = false;
      sessionId = null;
      selectedKeys = new Set();
      candidatesByKey = new Map();
      activeReview = { sessionId: null, selected: [] };
      candidatesBlock.replaceChildren();
      reviewingBlock.replaceChildren();
      setStage('INTRO');
    });
    completeBlock.appendChild(card);
    heading.focus({ preventScroll: true });
  }

  setStage('INTRO');
}
