// V5.3a — Graded Reading page: library, annotated reader, and progress stats.
//
// Three hash-routed views share one page module (the router keys pages by the
// path before '?', keeping the query in the hash for pages to read):
//   #reading            -> library (filters, own-text creation, source import)
//   #reading?id=<id>    -> reader (inline annotations, add-to-collection)
//   #reading?progress=1 -> progress stats (weekly buckets from progress rows)
//
// The backend owns classification and annotations; this page renders API
// payloads and never recomputes levels client-side. Progress saves use the
// PUT-replaces contract, so every save sends position AND accumulated time
// together (omitting timeSpentSeconds would reset it server-side).
//
// Annotation placement is greedy longest-first: broader spans (grammar,
// vocabulary) claim their range first and nested kanji inside a placed span
// are skipped — never double-underlined. Overlaps that remain are dropped,
// documented here, because the annotation payload carries start positions
// only.
//
// Kanji coverage stats ("% kanji known") intentionally live on the Statistics
// page (existing /api/level/progress data); this page links there instead of
// duplicating that computation.

import { apiRequest, listReadingLibrary, getReadingText, createUserReadingText, updateReadingProgress, importReadingSources, listReadingProgress } from '../api';
import { element, pageHeader, showToast, withPendingAction, paginationControls, openDetailModal, emptyState, errorState, loadingState } from '../ui';

const LIBRARY_PAGE_SIZE = 12;
const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const SOURCES = [
  { value: 'aozora', label: 'Aozora Bunko' },
  { value: 'nhk', label: 'NHK Easy News' },
  { value: 'user', label: 'My texts' }
];

function hashQueryParam(name) {
  const hash = typeof window !== 'undefined' && window.location ? window.location.hash || '' : '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get(name);
}

function selectControl({ name, label, value, options }) {
  const select = element('select', {
    className: 'field-control',
    attrs: { id: name, name, 'aria-label': label }
  }, options.map((option) => element('option', {
    value: option.value,
    text: option.label,
    attrs: { ...(option.value === value ? { selected: '' } : {}) }
  })));
  return element('div', { className: 'grid gap-1' }, [
    element('label', { className: 'text-xs font-medium text-ink', text: label, attrs: { for: name } }),
    select
  ]);
}

function levelBadge(level) {
  if (!level) return null;
  return element('span', { className: 'status-pill', text: level, attrs: { 'aria-label': `Estimated level ${level}` } });
}

// ---------------------------------------------------------------- library

async function renderLibraryView(container) {
  const gridWrap = element('div');
  const pageWrap = element('div');

  const levelWrapper = selectControl({
    name: 'reading-level',
    label: 'Level',
    value: '',
    options: [{ value: '', label: 'All levels' }, ...LEVELS.map((level) => ({ value: level, label: level }))]
  });
  const levelSelectNode = levelWrapper.querySelector('select');
  const sourceWrapper = selectControl({
    name: 'reading-source',
    label: 'Source',
    value: '',
    options: [{ value: '', label: 'All sources' }, ...SOURCES]
  });
  const sourceSelectNode = sourceWrapper.querySelector('select');

  async function refresh(page = 1) {
    gridWrap.replaceChildren(loadingState('Loading texts.'));
    pageWrap.replaceChildren();
    try {
      const data = await listReadingLibrary({
        level: levelSelectNode.value,
        source: sourceSelectNode.value,
        page,
        limit: LIBRARY_PAGE_SIZE
      });
      renderGrid(data, page);
    } catch (error) {
      gridWrap.replaceChildren(errorState(error, () => refresh(page)));
    }
  }

  function renderGrid(data, currentPage) {
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      gridWrap.replaceChildren(emptyState({
        title: 'No reading texts yet',
        description: 'Import from NHK Easy or Aozora, or paste your own text to start reading.'
      }));
      return;
    }
    gridWrap.replaceChildren(element('div', { className: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' }, items.map((item) => {
      const known = Number(item.knownKanjiPct || 0);
      return element('button', {
        className: 'surface flex h-full flex-col gap-2 p-4 text-left transition-colors hover:border-ink/40',
        attrs: { type: 'button', 'aria-label': `Open ${item.title}` }
      }, [
        element('div', { className: 'flex items-center justify-between gap-2' }, [
          element('span', { className: 'text-xs uppercase tracking-wide text-muted', text: item.sourceType || 'user' }),
          levelBadge(item.level) || element('span', { className: 'text-xs text-muted', text: '—' })
        ]),
        element('p', { className: 'font-semibold text-ink', text: item.title }),
        element('p', { className: 'text-xs leading-5 text-muted', text: `${Number(item.characterCount || 0).toLocaleString()} characters · you know ${known}% of its kanji` })
      ]);
    })));
    const pagination = paginationControls({ page: currentPage, totalPages: Number(data?.totalPages || 0) }, (nextPage) => refresh(nextPage));
    if (pagination) pageWrap.replaceChildren(pagination);
  }

  const applyButton = element('button', { className: 'button-secondary self-end', text: 'Apply filters', attrs: { type: 'button' } });
  applyButton.addEventListener('click', () => refresh(1));

  const importNhk = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Import NHK Easy', attrs: { type: 'button' } });
  importNhk.addEventListener('click', () => withPendingAction(importNhk, async () => {
    try {
      const result = await importReadingSources('nhk');
      if (result?.status === 'unavailable') {
        showToast(result?.reason || 'NHK Easy is unavailable right now.', 'warning');
        return;
      }
      showToast(`Imported ${Number(result?.textsImported ?? result?.imported ?? 0)} item(s) from NHK Easy.`);
      refresh(1);
    } catch (error) {
      showToast(error?.message || 'Could not reach the source. Check your connection.', 'error');
    }
  }));

  const importAozora = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Import Aozora', attrs: { type: 'button' } });
  importAozora.addEventListener('click', () => withPendingAction(importAozora, async () => {
    try {
      const result = await importReadingSources('aozora');
      if (result?.status === 'unavailable') {
        showToast(result?.reason || 'Aozora is unavailable right now.', 'warning');
        return;
      }
      showToast(`Imported ${Number(result?.textsImported ?? result?.imported ?? 0)} item(s) from Aozora.`);
      refresh(1);
    } catch (error) {
      showToast(error?.message || 'Could not reach the source. Check your connection.', 'error');
    }
  }));

  const ownTitle = element('input', {
    className: 'field-control',
    attrs: { type: 'text', maxlength: '200', placeholder: 'Title (optional)', 'aria-label': 'Text title' }
  });
  const ownText = element('textarea', {
    className: 'field-control min-h-28',
    attrs: { maxlength: '100000', placeholder: 'Paste the Japanese text you want to read…', 'aria-label': 'Reading text' }
  });
  const ownSave = element('button', { className: 'button-primary self-start', text: 'Save and read', attrs: { type: 'button' } });
  ownSave.addEventListener('click', () => {
    const text = String(ownText.value || '').trim();
    if (!text) {
      showToast('Paste some text first.', 'error');
      return;
    }
    // Show loading bar that grows fast, stops ~78% (variable), then 100% on analysis.
    ownSave.disabled = true;
    ownSave.textContent = 'Analyzing…';
    const progressContainer = element('div', { className: 'mt-2 text-right' }, [
      element('span', { className: 'text-xs text-muted', id: 'ownProgressLabel', text: '0%' }),
      element('div', { className: 'w-48 h-1.5 rounded-full bg-ink/10 mt-1' }, [
        element('div', { className: 'h-full rounded-full bg-ink transition-all duration-300 ease-out', attrs: { 'data-progress-fill': '0', style: 'width:0%' } })
      ])
    ]);
    ownSave.parentNode.insertBefore(progressContainer, ownSave.nextSibling);
    let animated = false;
    async function finish() {
      if (!animated) return;
      try {
        const created = await createUserReadingText({ text, title: String(ownTitle.value || '').trim() });
        // Jump to 100% and navigate.
        const fill = progressContainer.querySelector('[data-progress-fill]');
        if (fill) { fill.style.width = '100%'; ownProgressLabel.textContent = '100%'; }
        window.location.hash = `#reading?id=${Number(created?.id)}`;
      } catch (error) {
        showToast(error?.message || 'Unable to save the text.', 'error');
      } finally {
        ownSave.disabled = false;
        ownSave.textContent = 'Save and read';
        try { progressContainer.remove(); } catch {}
      }
    }
    // Animate progress bar: fast start, then to 78% (variable).
    animated = true;
    const vary = 70 + Math.random() * 10; // 70–80% variable
    ownProgressLabel.textContent = `${Math.round(vary)}%`;
    setTimeout(() => {
      const fill = progressContainer.querySelector('[data-progress-fill]');
      if (fill) { fill.style.width = `${vary}%`; }
    }, 350);
    finish();
  });

  const progressLink = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Reading progress', attrs: { type: 'button' } });
  progressLink.addEventListener('click', () => { window.location.hash = '#reading?progress=1'; });

  container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-6xl' }, [
    pageHeader({
      eyebrow: 'Library',
      title: 'Graded Reading',
      description: 'Read real Japanese matched to your level. Tap annotated words to study them.'
    }),
    element('div', { className: 'surface mt-4 flex flex-wrap items-end gap-3 p-4' }, [
      levelWrapper,
      sourceWrapper,
      applyButton,
      element('div', { className: 'ml-auto flex flex-wrap gap-2' }, [importNhk, importAozora, progressLink])
    ]),
    gridWrap,
    pageWrap,
    element('section', { className: 'surface mt-6 p-5', attrs: { 'aria-label': 'Add your own reading text' } }, [
      element('h2', { className: 'font-semibold text-ink', text: 'Add your own text' }),
      element('p', { className: 'mt-1 text-sm text-muted', text: 'Paste anything you want to read. It is classified and annotated automatically.' }),
      element('div', { className: 'mt-4 grid gap-3' }, [ownTitle, ownText, ownSave])
    ])
  ]));

  refresh(1);
}

// ---------------------------------------------------------------- reader

let cleanupReader = null;

async function renderReader(container, textId) {
  if (cleanupReader) { cleanupReader(); cleanupReader = null; }
  container.replaceChildren(loadingState('Loading reading text.'));
  let data;
  try {
    data = await getReadingText(textId);
  } catch (error) {
    container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-3xl' }, [
      element('a', { className: 'button-secondary inline-flex min-h-9 items-center px-3 py-1.5 text-xs', text: 'Back to library', attrs: { href: '#reading' } }),
      errorState(error, () => renderReader(container, textId))
    ]));
    return;
  }

  const codePoints = Array.from(String(data.text || ''));
  const total = codePoints.length;
  const baseTime = Number(data.progress?.timeSpentSeconds || 0);
  let completed = Boolean(data.progress?.completed);
  const sessionStart = Date.now();
  const addedKeys = new Set();
  let annotationsVisible = true;
  let lastSaveAt = 0;

  function annotationLength(annotation) {
    if (annotation.type === 'kanji') return Array.from(annotation.char || '').length;
    if (annotation.type === 'vocabulary') return Array.from(annotation.word || '').length;
    return Array.from(annotation.pattern || '').length;
  }

  function placedAnnotations() {
    const candidates = (Array.isArray(data.annotations) ? data.annotations : [])
      .filter((annotation) => Number.isInteger(annotation.position) && annotation.position >= 0 && annotation.position < total)
      .map((annotation) => ({ annotation, length: Math.max(1, annotationLength(annotation)) }))
      .sort((a, b) => a.annotation.position - b.annotation.position || b.length - a.length);
    const covered = new Set();
    const placed = [];
    for (const candidate of candidates) {
      const start = candidate.annotation.position;
      let overlaps = false;
      for (let index = start; index < start + candidate.length; index += 1) {
        if (covered.has(index)) { overlaps = true; break; }
      }
      if (overlaps) continue;
      for (let index = start; index < start + candidate.length; index += 1) covered.add(index);
      placed.push(candidate);
    }
    return placed.sort((a, b) => a.annotation.position - b.annotation.position);
  }

  function accumulatedSeconds() {
    return Math.max(1, baseTime + Math.round((Date.now() - sessionStart) / 1000));
  }

  function annotationSpan(annotation, length) {
    const surface = codePoints.slice(annotation.position, annotation.position + length).join('');
    const key = `${annotation.type}:${annotation.position}`;
    const alreadyAdded = addedKeys.has(key) || annotation.known === true;
    const decoration = !annotationsVisible
      ? ''
      : annotation.type === 'kanji'
        ? ' border-b border-dotted border-ink/60'
        : annotation.type === 'vocabulary'
          ? ' underline decoration-ink/60 underline-offset-4'
          : ' bg-ink/10';
    const span = element('span', {
      className: `cursor-pointer transition-opacity hover:opacity-80${decoration}${alreadyAdded ? ' opacity-50' : ''}`,
      text: surface,
      attrs: {
        role: 'button',
        tabindex: '0',
        'data-annotation-type': annotation.type,
        'aria-label': `${annotation.type === 'kanji' ? annotation.char : annotation.type === 'vocabulary' ? annotation.word : annotation.pattern} — open details`,
        ...(annotation.type === 'kanji' && annotation.meaning ? { title: `${annotation.char} — ${annotation.meaning}` } : {})
      }
    });
    const open = () => openAnnotationModal(annotation, key, span);
    span.addEventListener('click', open);
    span.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    return span;
  }

  function renderAnnotatedText() {
    const nodes = [];
    let cursor = 0;
    for (const { annotation, length } of placedAnnotations()) {
      if (annotation.position > cursor) nodes.push(document.createTextNode(codePoints.slice(cursor, annotation.position).join('')));
      nodes.push(annotationSpan(annotation, length));
      cursor = annotation.position + length;
    }
    if (cursor < total) nodes.push(document.createTextNode(codePoints.slice(cursor).join('')));
    textBody.replaceChildren(...nodes);
  }

  function detailRow(label, value) {
    if (value === null || value === undefined || value === '') return null;
    return element('p', { className: 'mt-2 text-sm leading-6' }, [
      element('span', { className: 'font-semibold text-ink', text: `${label}: ` }),
      element('span', { className: 'text-muted', text: String(value) })
    ]);
  }

  function openAnnotationModal(annotation, key, span) {
    const display = annotation.type === 'kanji' ? annotation.char : annotation.type === 'vocabulary' ? annotation.word : annotation.pattern;
    const alreadyAdded = addedKeys.has(key) || annotation.known === true;
    const canAdd = !alreadyAdded
      && (annotation.type === 'kanji' ? Boolean(annotation.meaning)
        : annotation.type === 'vocabulary' ? Boolean(annotation.meaning)
          : Boolean(annotation.meaning || annotation.explanation));

    const addButton = element('button', {
      className: 'button-primary min-h-9 px-4 py-2 text-xs',
      text: `Add ${annotation.type === 'kanji' ? 'kanji' : annotation.type === 'vocabulary' ? 'vocabulary' : 'grammar point'} to my collection`,
      attrs: { type: 'button', ...(canAdd ? {} : { disabled: '' }) }
    });
    const close = openDetailModal({
      title: display,
      subtitle: `${annotation.type === 'kanji' ? 'Kanji' : annotation.type === 'vocabulary' ? 'Vocabulary' : 'Grammar'} · ${annotation.level || 'level unknown'}${alreadyAdded ? ' · already in your collection' : ''}`,
      content: [
        element('div', { className: 'pb-2' }, [
          element('p', { className: 'font-jp text-3xl text-ink', text: display }),
          detailRow('Reading', annotation.reading),
          detailRow('Meaning', annotation.meaning),
          ...(annotation.type === 'grammar' ? [detailRow('Explanation', annotation.explanation)] : []),
          ...(annotation.type === 'kanji' && annotation.info ? [detailRow('On readings', (annotation.info.onyomi || []).join('、')), detailRow('Kun readings', (annotation.info.kunyomi || []).join('、'))] : []),
          ...(!canAdd && !alreadyAdded ? [element('p', { className: 'mt-2 text-xs text-muted', text: 'No reference meaning is available for this item, so it cannot be added automatically. Add it manually with your own definition.' })] : [])
        ])
      ],
      actions: [addButton]
    });
    if (!canAdd) return;
    addButton.addEventListener('click', () => withPendingAction(addButton, async () => {
      try {
        if (annotation.type === 'vocabulary') {
          await apiRequest('/api/vocabulary', { method: 'POST', body: { word: annotation.word, reading: annotation.reading || '', meaning: annotation.meaning } });
        } else if (annotation.type === 'kanji') {
          await apiRequest('/api/kanji', {
            method: 'POST',
            body: {
              character_kanji: annotation.char,
              meaning: annotation.meaning,
              ...(annotation.level ? { jlpt_level: annotation.level } : {})
            }
          });
        } else {
          await apiRequest('/api/grammar', {
            method: 'POST',
            body: { grammar_point: annotation.pattern, meaning: annotation.meaning || annotation.explanation, ...(annotation.level ? { jlpt_level: annotation.level } : {}) }
          });
        }
        addedKeys.add(key);
        showToast('Added to your collection.');
        renderAnnotatedText();
        close();
      } catch (error) {
        showToast(error?.message || 'Unable to add this item.', 'error');
      }
    }));
    void span;
  }

  const textBody = element('div', {
    className: 'surface mt-4 p-6 leading-loose',
    attrs: { 'aria-label': 'Reading text', lang: 'ja' }
  });

  const progressLabel = element('span', { className: 'text-xs text-muted', text: '0%' });
  const progressBar = element('div', { className: 'h-1.5 w-24 overflow-hidden rounded-full bg-ink/10' }, [
    element('div', { className: 'h-full w-0 rounded-full bg-ink transition-all', attrs: { 'data-progress-fill': '' } })
  ]);

  const annotationsToggle = element('button', {
    className: 'button-secondary min-h-9 px-3 py-1.5 text-xs',
    text: 'Annotations on',
    attrs: { type: 'button', 'aria-pressed': 'true' }
  });
  annotationsToggle.addEventListener('click', () => {
    annotationsVisible = !annotationsVisible;
    annotationsToggle.setAttribute('aria-pressed', String(annotationsVisible));
    annotationsToggle.textContent = annotationsVisible ? 'Annotations on' : 'Annotations off';
    renderAnnotatedText();
  });

  const fontSlider = element('input', {
    className: 'w-28',
    attrs: { type: 'range', min: '14', max: '28', step: '1', value: '18', 'aria-label': 'Font size' }
  });
  fontSlider.addEventListener('input', () => { textBody.style.fontSize = `${fontSlider.value}px`; });

  const completeButton = element('button', {
    className: 'button-primary min-h-9 px-4 py-2 text-xs',
    text: completed ? 'Completed' : 'Mark completed',
    attrs: { type: 'button', ...(completed ? { disabled: '' } : {}) }
  });
  completeButton.addEventListener('click', () => withPendingAction(completeButton, async () => {
    try {
      await updateReadingProgress(textId, { position: Math.max(1, total), completed: true, timeSpentSeconds: accumulatedSeconds() });
      completed = true;
      completeButton.textContent = 'Completed';
      completeButton.disabled = true;
      showToast('Marked as completed.');
    } catch (error) {
      showToast(error?.message || 'Unable to save progress.', 'error');
    }
  }));

  function saveProgress() {
    if (completed || !textBody.isConnected) {
      if (!textBody.isConnected && cleanupReader) {
        cleanupReader();
        cleanupReader = null;
      }
      return;
    }
    const now = Date.now();
    if (now - lastSaveAt < 30000) return;
    lastSaveAt = now;
    const rect = textBody.getBoundingClientRect();
    const viewport = window.innerHeight || 1;
    // Removed the upper-bound clamp that forced scrolled >= rect.height → 100%.
    // Now scrolled is the actual pixel distance from the viewport top to the text top.
    const scrolled = Math.max(viewport - rect.top, 0);
    const fraction = rect.height ? scrolled / rect.height : 1;
    const position = total ? Math.max(1, Math.min(total, Math.ceil(fraction * total))) : 1;
    updateReadingProgress(textId, { position, timeSpentSeconds: accumulatedSeconds(), completed: false }).catch(() => { /* best-effort autosave */ });
  }

  function updateProgressUi() {
    const rect = textBody.getBoundingClientRect();
    const viewport = window.innerHeight || 1;
    // Removed the upper-bound clamp that forced 100% when scrolling past text body.
    const scrolled = Math.max(viewport - rect.top, 0);
    const percent = rect.height ? Math.min(100, Math.round((scrolled / rect.height) * 100)) : 0;
    progressLabel.textContent = `${percent}%`;
    const fill = progressBar.querySelector('[data-progress-fill]');
    if (fill) fill.style.width = `${percent}%`;
  }

  const onScroll = () => {
    updateProgressUi();
    saveProgress();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  cleanupReader = () => window.removeEventListener('scroll', onScroll);

  container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-3xl' }, [
    element('a', { className: 'button-secondary inline-flex min-h-9 items-center px-3 py-1.5 text-xs', text: 'Back to library', attrs: { href: '#reading' } }),
    element('header', { className: 'mt-4 flex flex-wrap items-center gap-2' }, [
      element('h1', { className: 'text-xl font-semibold text-ink', text: data.title }),
      levelBadge(data.level) || element('span', { className: 'text-xs text-muted', text: data.sourceType || 'user' })
    ]),
    element('div', { className: 'mt-3 flex flex-wrap items-center gap-3' }, [
      annotationsToggle,
      element('label', { className: 'flex items-center gap-2 text-xs text-muted', attrs: { for: 'reader-font-size' } }, [element('span', { text: 'Font size' }), fontSlider]),
      progressBar,
      progressLabel,
      completeButton
    ]),
    textBody
  ]));

  textBody.style.fontSize = '18px';
  renderAnnotatedText();
  updateProgressUi();
}

// ---------------------------------------------------------------- progress

async function renderProgressView(container) {
  container.replaceChildren(loadingState('Loading your reading progress.'));
  let data;
  try {
    data = await listReadingProgress({ limit: 50 });
  } catch (error) {
    container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-3xl' }, [
      element('a', { className: 'button-secondary inline-flex min-h-9 items-center px-3 py-1.5 text-xs', text: 'Back to library', attrs: { href: '#reading' } }),
      errorState(error, () => renderProgressView(container))
    ]));
    return;
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  const completedItems = items.filter((item) => item.completedAt);
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;
  const charsAllTime = completedItems.reduce((sum, item) => sum + Number(item.characters || 0), 0);
  const chars30Days = completedItems
    .filter((item) => new Date(item.completedAt).getTime() >= thirtyDaysAgo)
    .reduce((sum, item) => sum + Number(item.characters || 0), 0);
  const minutesTotal = Math.round(items.reduce((sum, item) => sum + Number(item.timeSpentSeconds || 0), 0) / 60);

  const weekly = Array.from({ length: 8 }, (_, index) => ({ weeksAgo: index, chars: 0 }));
  for (const item of completedItems) {
    const weeksAgo = Math.floor((now - new Date(item.completedAt).getTime()) / (7 * 86400000));
    if (weeksAgo >= 0 && weeksAgo < 8) weekly[weeksAgo].chars += Number(item.characters || 0);
  }
  const maxChars = Math.max(1, ...weekly.map((week) => week.chars));

  const statCard = (label, value) => element('div', { className: 'surface p-4' }, [
    element('p', { className: 'text-xs uppercase tracking-wide text-muted', text: label }),
    element('p', { className: 'mt-1 text-2xl font-semibold text-ink', text: value })
  ]);

  container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-4xl' }, [
    element('a', { className: 'button-secondary inline-flex min-h-9 items-center px-3 py-1.5 text-xs', text: 'Back to library', attrs: { href: '#reading' } }),
    pageHeader({
      eyebrow: 'Statistics',
      title: 'Reading progress',
      description: 'Your reading activity. Kanji coverage lives on the Statistics page.'
    }),
    element('div', { className: 'mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4' }, [
      statCard('Texts completed', String(completedItems.length)),
      statCard('Characters read', charsAllTime.toLocaleString()),
      statCard('Characters · last 30 days', chars30Days.toLocaleString()),
      statCard('Time reading', `${minutesTotal} min`)
    ]),
    element('div', { className: 'surface mt-4 p-5' }, [
      element('h2', { className: 'font-semibold text-ink', text: 'Last 8 weeks' }),
      element('p', { className: 'mt-1 text-xs text-muted', text: 'Characters completed per week (newest first).' }),
      element('ul', { className: 'mt-4 grid gap-2' }, weekly.map((week) => element('li', { className: 'flex items-center gap-3 text-xs text-muted' }, [
        element('span', { className: 'w-14 shrink-0', text: week.weeksAgo === 0 ? 'This week' : `${week.weeksAgo}w ago` }),
        element('div', { className: 'h-2.5 flex-1 overflow-hidden rounded-full bg-ink/10' }, [
          element('div', { className: 'h-full rounded-full bg-ink', attrs: { style: `width:${Math.round((week.chars / maxChars) * 100)}%` } })
        ]),
        element('span', { className: 'w-16 shrink-0 text-right', text: week.chars.toLocaleString() })
      ])))
    ]),
    element('p', { className: 'mt-4 text-xs text-muted' }, [
      element('span', { text: 'Kanji coverage by JLPT level lives on ' }),
      element('a', { className: 'underline', text: 'Statistics', attrs: { href: '#statistics' } }),
      element('span', { text: '.' })
    ])
  ]));
}

export async function renderReading(container) {
  const idParam = hashQueryParam('id');
  const textId = Number(idParam);
  if (idParam && Number.isInteger(textId) && textId > 0) {
    return renderReader(container, textId);
  }
  if (hashQueryParam('progress') === '1') {
    return renderProgressView(container);
  }
  return renderLibraryView(container);
}
