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

import { apiRequest, listReadingLibrary, getReadingText, createUserReadingText, deleteReadingText, updateReadingProgress, importReadingSources, importReadingUrl, previewReadingImport, listReadingProgress } from '../api';
import { icon } from '../icons';
import { element, pageHeader, showToast, withPendingAction, paginationControls, openDetailModal, openDialog, confirmDialog, emptyState, errorState, loadingState } from '../ui';

const LIBRARY_PAGE_SIZE = 12;
const LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];
const SOURCES = [
  { value: 'aozora', label: 'Aozora Bunko' },
  { value: 'hukumusume', label: 'Hukumusume' },
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
    text: option.label,
    attrs: { value: option.value, ...(option.value === value ? { selected: '' } : {}) }
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
  const gridWrap = element('div', { className: 'mt-4' });
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
        description: 'Import from Aozora, or paste your own text to start reading.'
      }));
      return;
    }
    gridWrap.replaceChildren(element('div', { className: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' }, items.map((item) => {
      const known = Number(item.knownKanjiPct || 0);
      const isOwner = item.sourceType === 'user' && item?.id !== undefined && item?.id !== null;
      const openCard = () => {
        if (item?.id === undefined || item?.id === null) return;
        window.location.hash = `#reading?id=${encodeURIComponent(item.id)}`;
      };
      const card = element('article', {
        className: 'surface relative flex h-full cursor-pointer flex-col gap-2 p-4 pb-12 transition-colors hover:border-ink/40',
        attrs: { role: 'button', tabindex: '0', 'aria-label': `Open ${item.title}` }
      }, [
        element('div', { className: 'flex items-center justify-between gap-2' }, [
          element('span', { className: 'text-xs uppercase tracking-wide text-muted', text: item.sourceType || 'user' }),
          levelBadge(item.level) || element('span', { className: 'text-xs text-muted', text: '—' })
        ]),
        element('p', { className: 'font-semibold text-ink', text: item.title }),
        element('p', { className: 'text-xs leading-5 text-muted', text: `${Number(item.characterCount || 0).toLocaleString()} characters · you know ${known}% of its kanji` })
      ]);
      card.addEventListener('click', openCard);
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCard(); }
      });
      // Owner-only delete sits bottom-right of the card, Trash icon, with the
      // same confirm pattern as the kanji/vocabulary CRUDs. Shared (imported)
      // texts are read-only and get no button; the API 404s non-owned ids.
      if (isOwner) {
        const trashButton = element('button', {
          className: 'icon-button icon-button--danger absolute bottom-3 right-3',
          attrs: { type: 'button', title: `Delete ${item.title}`, 'aria-label': `Delete ${item.title}` }
        }, [icon('trash', { size: 18, label: `Delete ${item.title}` })]);
        trashButton.addEventListener('click', (event) => {
          event.stopPropagation();
          confirmDialog({
            title: 'Delete reading text?',
            description: `This will permanently delete “${item.title}” and its reading progress. This cannot be undone.`,
            confirmLabel: 'Delete',
            onConfirm: async () => {
              await deleteReadingText(item.id);
              showToast('Reading text deleted.');
              refresh(1);
            }
          });
        });
        card.appendChild(trashButton);
      }
      return card;
    })));
    const pagination = paginationControls({ page: currentPage, totalPages: Number(data?.totalPages || 0) }, (nextPage) => refresh(nextPage));
    if (pagination) pageWrap.replaceChildren(pagination);
  }

  const applyButton = element('button', { className: 'button-secondary w-full sm:w-auto sm:justify-self-start', text: 'Apply filters', attrs: { type: 'button' } });
  applyButton.addEventListener('click', () => refresh(1));

  // NHK Easy import was retired: NHK discontinued its public feed, so only
  // Aozora remains as an importable source (plus pasting your own text).
  // Imports run in the background (a full import classifies every text and
  // takes minutes), so this polls the library until the new rows land.
  let importPollTimer = null;
  async function pollLibraryForImports(sourceType, baseline, attempt = 0) {
    if (importPollTimer) window.clearTimeout(importPollTimer);
    importPollTimer = null;
    if (attempt >= 24) {
      showToast('Import is taking longer than expected — check back in a bit.');
      return;
    }
    try {
      const data = await listReadingLibrary({ source: sourceType, page: 1, limit: 1 });
      if (Number(data?.total || 0) > baseline) {
        refresh(1);
        showToast('Import finished — new texts are in your library.');
        return;
      }
    } catch { /* transient failures must not stop the poll */ }
    importPollTimer = window.setTimeout(() => { pollLibraryForImports(sourceType, baseline, attempt + 1); }, 15000);
  }

  const importTexts = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Import texts', attrs: { type: 'button' } });
  importTexts.addEventListener('click', () => withPendingAction(importTexts, async () => {
    let preview = null;
    try {
      preview = await previewReadingImport('aozora', 'a');
    } catch (error) {
      showToast(error?.message || 'Could not reach the sources. Check your connection.', 'error');
      return;
    }
    const works = Array.isArray(preview?.items) ? preview.items : [];
    if (preview?.status !== 'ok' || !works.length) {
      showToast('No importable texts right now. Check your connection and try again.', 'warning');
      return;
    }
    openImportPickerDialog('aozora', 'a', works);
  }, { pendingLabel: 'Loading works…' }));

  // Pasted-link import: the user brings their own work page (Aozora card or
  // Hukumusume story). The link is shape-checked here for instant feedback
  // and re-checked server-side; analysis still takes ~a minute, so this
  // enqueues like bulk import.
  const linkInput = element('input', {
    className: 'field-control',
    attrs: { type: 'url', inputmode: 'url', placeholder: 'Paste a work link…', 'aria-label': 'Work page link' }
  });
  const linkButton = element('button', { className: 'button-secondary min-h-9 shrink-0 px-3 py-1.5 text-xs', text: 'Add link', attrs: { type: 'button' } });
  linkButton.addEventListener('click', () => withPendingAction(linkButton, async () => {
    const pasted = String(linkInput.value || '').trim();
    const aozoraMatch = pasted.match(/https:\/\/www\.aozora\.gr\.jp\/cards\/\d+\/card\d+\.html/i);
    const hukuMatch = pasted.match(/https:\/\/hukumusume\.com\/douwa\/pc\/jap\/\d\d\/\d+\.htm/i);
    if (!aozoraMatch && !hukuMatch) {
      showToast('Paste an Aozora card link or a Hukumusume story link.', 'error');
      return;
    }
    const sourceType = aozoraMatch ? 'aozora' : 'hukumusume';
    try {
      const before = await listReadingLibrary({ source: sourceType, page: 1, limit: 1 }).catch(() => null);
      const result = await importReadingUrl((aozoraMatch || hukuMatch)[0]);
      if (result?.status !== 'accepted') {
        showToast('Import did not start. Please try again.', 'error');
        return;
      }
      linkInput.value = '';
      showToast('Import started — the text will appear below when ready.');
      pollLibraryForImports(sourceType, Number(before?.total || 0));
    } catch (error) {
      showToast(error?.message || 'Could not reach the API. Check your connection.', 'error');
    }
  }, { pendingLabel: 'Adding…' }));

  // Picker: choose WHAT to import, from either source. Group selects switch
  // the work index (kana groups for Aozora, months for Hukumusume) so
  // repeated imports surface different works; the search box filters titles
  // locally. Selection posts exact page URLs plus the shown index, and the
  // server imports in the background while the library poll picks up rows.
  const IMPORT_SOURCES = [
    {
      value: 'aozora', label: 'Aozora Bunko', groupLabel: 'Works starting with',
      groups: [
        { value: 'a', label: 'あ' }, { value: 'ka', label: 'か' }, { value: 'sa', label: 'さ' },
        { value: 'ta', label: 'た' }, { value: 'na', label: 'な' }, { value: 'ha', label: 'は' },
        { value: 'ma', label: 'ま' }, { value: 'ya', label: 'や' }, { value: 'ra', label: 'ら' },
        { value: 'wa', label: 'わ' }
      ]
    },
    {
      value: 'hukumusume', label: 'Hukumusume fairy tales', groupLabel: 'Tales of',
      groups: [
        { value: '01', label: 'January' }, { value: '02', label: 'February' }, { value: '03', label: 'March' },
        { value: '04', label: 'April' }, { value: '05', label: 'May' }, { value: '06', label: 'June' },
        { value: '07', label: 'July' }, { value: '08', label: 'August' }, { value: '09', label: 'September' },
        { value: '10', label: 'October' }, { value: '11', label: 'November' }, { value: '12', label: 'December' }
      ]
    }
  ];
  function openImportPickerDialog(initialSource, initialIndex, initialWorks) {
    let currentSource = initialSource;
    let currentIndex = initialIndex;
    let boxes = [];
    const sourceSelect = element('select', {
      className: 'field-control sm:col-span-2',
      attrs: { 'aria-label': 'Story source' }
    }, IMPORT_SOURCES.map((source) => element('option', {
      text: source.label,
      attrs: { value: source.value, ...(source.value === currentSource ? { selected: '' } : {}) }
    })));
    const groupSelect = element('select', {
      className: 'field-control sm:col-span-2',
      attrs: { 'aria-label': 'Work group' }
    });
    const listWrap = element('div', { className: 'grid gap-2 sm:col-span-2' });
    const countNote = element('p', { className: 'text-xs text-muted sm:col-span-2', attrs: { 'aria-live': 'polite' } });
    const searchInput = element('input', {
      className: 'field-control sm:col-span-2',
      attrs: { type: 'search', placeholder: 'Search by title…', 'aria-label': 'Search works by title' }
    });
    function sourceConfig() {
      return IMPORT_SOURCES.find((source) => source.value === currentSource) || IMPORT_SOURCES[0];
    }
    function applySearch() {
      const query = String(searchInput.value || '').trim().toLowerCase();
      boxes.forEach(({ row, title }) => { row.hidden = Boolean(query) && !title.includes(query); });
    }
    searchInput.addEventListener('input', applySearch);
    function renderGroupOptions() {
      const config = sourceConfig();
      groupSelect.replaceChildren(...config.groups.map((group) => element('option', {
        text: `${config.groupLabel} ${group.label}`,
        attrs: { value: group.value, ...(group.value === currentIndex ? { selected: '' } : {}) }
      })));
      groupSelect.setAttribute('aria-label', config.groupLabel);
    }
    async function reloadPreview() {
      groupSelect.disabled = true;
      sourceSelect.disabled = true;
      try {
        const preview = await previewReadingImport(currentSource, currentIndex);
        const works = Array.isArray(preview?.items) ? preview.items : [];
        if (preview?.status !== 'ok' || !works.length) {
          showToast('Could not load those works. Try another group.', 'warning');
          return;
        }
        searchInput.value = '';
        renderWorks(works);
      } catch (error) {
        showToast(error?.message || 'Could not load those works.', 'error');
      } finally {
        groupSelect.disabled = false;
        sourceSelect.disabled = false;
      }
    }
    sourceSelect.addEventListener('change', () => {
      currentSource = sourceSelect.value;
      currentIndex = sourceConfig().groups[0].value;
      renderGroupOptions();
      reloadPreview();
    });
    groupSelect.addEventListener('change', () => {
      currentIndex = groupSelect.value;
      reloadPreview();
    });
    function renderWorks(works) {
      boxes = works.map((work) => {
        const checkbox = element('input', {
          className: 'mt-1 size-4 shrink-0 accent-vermilion',
          attrs: { type: 'checkbox', value: work.url, 'aria-label': `Import ${work.title}` }
        });
        const row = element('label', { className: 'flex cursor-pointer items-start gap-3 rounded-xl border border-stone bg-paper px-3 py-2.5 text-sm transition hover:border-ink/40' }, [
          checkbox,
          element('span', { className: 'min-w-0' }, [
            element('span', { className: 'block break-words font-medium text-ink', text: work.title }),
            element('span', { className: 'mt-0.5 block break-words text-xs leading-5 text-muted', text: work.url })
          ])
        ]);
        return { checkbox, row, title: String(work.title || '').toLowerCase() };
      });
      listWrap.replaceChildren(...boxes.map(({ row }) => row));
      countNote.textContent = `${boxes.length} work(s) in this group. Tick what to import.`;
      applySearch();
    }
    const selectAll = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Select all', attrs: { type: 'button' } });
    const clear = element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: 'Clear', attrs: { type: 'button' } });
    selectAll.addEventListener('click', () => { boxes.forEach(({ checkbox, row }) => { if (!row.hidden) checkbox.checked = true; }); });
    clear.addEventListener('click', () => { boxes.forEach(({ checkbox }) => { checkbox.checked = false; }); });
    openDialog({
      title: 'Import texts',
      description: 'Pick a source and group, then choose the works to import. Each one is classified and added to your library in the background.',
      content: [
        sourceSelect,
        groupSelect,
        searchInput,
        element('div', { className: 'flex flex-wrap gap-2 sm:col-span-2' }, [selectAll, clear]),
        listWrap,
        countNote
      ],
      submitLabel: 'Import selected',
      pendingLabel: 'Starting…',
      onSubmit: async (form, close) => {
        const selected = [...form.querySelectorAll('input[type="checkbox"]:checked')].map((node) => node.value).filter(Boolean);
        if (!selected.length) {
          showToast('Select at least one work.', 'error');
          return;
        }
        const before = await listReadingLibrary({ source: currentSource, page: 1, limit: 1 }).catch(() => null);
        const result = await importReadingSources(currentSource, { urls: selected, index: currentIndex });
        if (result?.status !== 'accepted') {
          showToast('Import did not start. Please try again.', 'error');
          return;
        }
        close();
        showToast('Import started — new texts will appear below as they arrive.');
        pollLibraryForImports(currentSource, Number(before?.total || 0));
      }
    });
    renderGroupOptions();
    renderWorks(initialWorks);
  }

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
    if (ownSave.disabled) return;
    // Artificial progress: jumps fast at first, eases toward a variable cap
    // (~72–80%, never the same twice), then snaps to 100% when analysis
    // actually finishes. The API call starts immediately in parallel.
    ownSave.disabled = true;
    ownSave.textContent = 'Analyzing…';
    const progressLabel = element('span', { className: 'text-xs text-muted', text: '0%' });
    const progressFill = element('div', {
      className: 'h-full rounded-full bg-ink transition-all duration-300 ease-out',
      attrs: { style: 'width:0%' }
    });
    const progressContainer = element('div', { className: 'mt-2' }, [
      progressLabel,
      element('div', { className: 'h-1.5 w-48 overflow-hidden rounded-full bg-ink/10' }, [progressFill])
    ]);
    ownSave.parentNode.insertBefore(progressContainer, ownSave.nextSibling);
    const cap = 72 + Math.random() * 8;
    let shown = 0;
    const tick = () => {
      // Fast start, then ease toward the cap: big steps early, tiny near cap.
      const remaining = cap - shown;
      if (remaining <= 0.5) return;
      shown += Math.max(0.6, remaining * 0.22);
      const value = Math.min(cap, shown);
      progressFill.style.width = `${value}%`;
      progressLabel.textContent = `${Math.round(value)}%`;
      progressTimer = window.setTimeout(tick, 120);
    };
    let progressTimer = window.setTimeout(tick, 60);
    createUserReadingText({ text, title: String(ownTitle.value || '').trim() }).then((created) => {
      window.clearTimeout(progressTimer);
      progressFill.style.width = '100%';
      progressLabel.textContent = '100%';
      showToast('Text saved. Opening the reader.');
      window.location.hash = `#reading?id=${Number(created?.id)}`;
    }).catch((error) => {
      window.clearTimeout(progressTimer);
      showToast(error?.message || 'Unable to save the text.', 'error');
      ownSave.disabled = false;
      ownSave.textContent = 'Save and read';
      try { progressContainer.remove(); } catch { /* container is best-effort */ }
    });
  });

  const progressLink = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Reading progress', attrs: { type: 'button' } });
  progressLink.addEventListener('click', () => { window.location.hash = '#reading?progress=1'; });

  container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-6xl' }, [
    pageHeader({
      eyebrow: 'Library',
      title: 'Graded Reading',
      description: 'Read real Japanese matched to your level. Tap annotated words to study them.'
    }),
    element('div', { className: 'surface mt-4 grid gap-3 p-4' }, [
      element('div', { className: 'grid grid-cols-2 gap-3' }, [
        levelWrapper,
        sourceWrapper
      ]),
      applyButton,
      element('div', { className: 'grid gap-2 border-t border-stone pt-3' }, [
        element('p', { className: 'text-xs font-medium text-muted', text: 'More texts' }),
        element('div', { className: 'grid grid-cols-1 gap-2 sm:grid-cols-2' }, [importTexts, progressLink]),
        element('div', { className: 'grid gap-2' }, [
          element('p', { className: 'text-xs font-medium text-muted', text: 'Or paste a work link' }),
          element('div', { className: 'flex flex-col gap-2 sm:flex-row' }, [
            element('div', { className: 'min-w-0 flex-1' }, [linkInput]),
            linkButton
          ])
        ])
      ])
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

  const progressLabel = element('span', { className: 'text-xs font-medium tabular-nums text-muted', text: '0%' });
  const progressBar = element('div', { className: 'h-2 w-28 overflow-hidden rounded-full bg-ink/10 sm:w-36' }, [
    element('div', { className: 'h-full w-0 rounded-full bg-vermilion transition-all', attrs: { 'data-progress-fill': '' } })
  ]);
  const progressGroup = element('div', {
    className: 'ml-auto flex items-center gap-2',
    attrs: { role: 'progressbar', 'aria-label': 'Reading progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }
  }, [progressBar, progressLabel]);

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
    className: 'h-1.5 w-full cursor-pointer accent-vermilion',
    attrs: { id: 'reader-font-size', type: 'range', min: '14', max: '28', step: '1', value: '18', 'aria-label': 'Font size' }
  });
  fontSlider.addEventListener('input', () => { textBody.style.fontSize = `${fontSlider.value}px`; });

  const completeButton = element('button', {
    className: 'button-primary min-h-9 w-full px-4 py-2 text-xs sm:w-auto',
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

  // Progress = furthest-read position. Seeded from the saved value so a
  // reopened text shows its resume point instead of 0%; scrolling can only
  // advance it, never regress it, and completed texts stop autosaving.
  let highWaterPosition = total ? Math.max(0, Math.min(total, Number(data.progress?.position || 0))) : 0;

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
    const scrolled = Math.max(viewport - rect.top, 0);
    const fraction = rect.height ? scrolled / rect.height : 1;
    const position = total ? Math.max(1, Math.min(total, Math.ceil(fraction * total))) : 1;
    highWaterPosition = Math.max(highWaterPosition, position);
    updateReadingProgress(textId, { position: highWaterPosition, timeSpentSeconds: accumulatedSeconds(), completed: false }).catch(() => { /* best-effort autosave */ });
  }

  function updateProgressUi() {
    const rect = textBody.getBoundingClientRect();
    const viewport = window.innerHeight || 1;
    const scrolled = Math.max(viewport - rect.top, 0);
    const scrollFraction = rect.height ? scrolled / rect.height : 1;
    const fraction = total ? Math.max(scrollFraction, highWaterPosition / total) : scrollFraction;
    const percent = Math.min(100, Math.round(fraction * 100));
    progressLabel.textContent = `${percent}%`;
    progressGroup.setAttribute('aria-valuenow', String(percent));
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
    element('a', { className: 'text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline', text: '← Back to library', attrs: { href: '#reading' } }),
    element('header', { className: 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-2' }, [
      element('h1', { className: 'min-w-0 flex-1 break-words text-xl font-semibold text-ink', text: data.title }),
      levelBadge(data.level) || element('span', { className: 'text-xs text-muted', text: data.sourceType || 'user' })
    ]),
    element('div', { className: 'surface mt-3 flex flex-col gap-3 p-4' }, [
      element('div', { className: 'flex flex-wrap items-center gap-x-5 gap-y-3' }, [
        annotationsToggle,
        element('label', { className: 'flex min-w-44 flex-1 items-center gap-2 text-xs text-muted', attrs: { for: 'reader-font-size' } }, [
          element('span', { text: 'A', attrs: { 'aria-hidden': 'true' } }),
          fontSlider,
          element('span', { className: 'text-sm font-semibold', text: 'A', attrs: { 'aria-hidden': 'true' } })
        ]),
        progressGroup
      ]),
      element('div', { className: 'border-t border-stone pt-3' }, [completeButton])
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
