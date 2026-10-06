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
//
// Token layer (additive, feature-detected): GET /api/reading/text/:id may
// also return sentences[] and tokens[] with per-occurrence code-point
// offsets. When present, blocks come from sentences[] and words render from
// tokens[] (astral-safe slicing, whole-token ruby from surfaceReading,
// enroll via POST .../enroll with a collection-POST fallback). When absent,
// the annotation path below renders exactly as before — both orders work.

import { apiRequest, listReadingLibrary, getReadingText, createUserReadingText, deleteReadingText, updateReadingProgress, importReadingSources, importReadingUrl, previewReadingImport, listReadingProgress, publishReadingText } from '../api';
import { icon } from '../icons';
import { speakJapanese } from '../speech.js';
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

function levelPill(level) {
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
      // Filter-aware empty state: an active source/level filter that matches
      // nothing is a different situation from an empty library — say which.
      const sourceLabel = sourceSelectNode.value ? (SOURCES.find((entry) => entry.value === sourceSelectNode.value)?.label || sourceSelectNode.value) : null;
      gridWrap.replaceChildren(emptyState({
        title: sourceLabel ? `No ${sourceLabel} texts yet` : 'No reading texts yet',
        description: sourceLabel
          ? `Nothing from ${sourceLabel} in your library yet. Use Import texts or paste a link above.`
          : 'Import from Aozora, or paste your own text to start reading.',
        action: element('a', { className: 'button-primary inline-flex min-h-11 items-center justify-center px-5 py-2.5 text-sm font-semibold', text: 'Open Analyzer', attrs: { href: '#analyzer' } })
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
          levelPill(item.level) || element('span', { className: 'text-xs text-muted', text: '—' })
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
  // Imports run inside the request and answer with honest counts (the old
  // fire-and-forget background jobs silently never finished on serverless),
  // so the library refreshes straight from the response — no blind polling.
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
  // and re-checked server-side; the import completes inside the request and
  // answers with the result, so failures surface honestly instead of
  // vanishing into a background job.
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
    try {
      const result = await importReadingUrl((aozoraMatch || hukuMatch)[0]);
      if (result?.status !== 'ok' || !Number(result?.textsImported || 0)) {
        showToast('Import finished with no new text — it may already be in your library.', 'warning');
        await refresh(1);
        return;
      }
      linkInput.value = '';
      showToast('Import finished — the text is in your library.');
      await refresh(1);
    } catch (error) {
      // A function timeout can still leave a committed partial import
      // behind: refresh first so landed rows show, then explain the retry.
      await refresh(1).catch(() => {});
      showToast(error?.message || 'Import failed. Check the library — retry for anything missing.', 'error');
    }
  }, { pendingLabel: 'Importing…' }));

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
      description: 'Pick a source and group, then choose the works to import. Each one is classified and added before the request finishes.',
      content: [
        sourceSelect,
        groupSelect,
        searchInput,
        element('div', { className: 'flex flex-wrap gap-2 sm:col-span-2' }, [selectAll, clear]),
        listWrap,
        countNote
      ],
      submitLabel: 'Import selected',
      pendingLabel: 'Importing…',
      onSubmit: async (form, close) => {
        const selected = [...form.querySelectorAll('input[type="checkbox"]:checked')].map((node) => node.value).filter(Boolean);
        if (!selected.length) {
          showToast('Select at least one work.', 'error');
          return;
        }
        try {
          const result = await importReadingSources(currentSource, { urls: selected, index: currentIndex });
          close();
          const added = Number(result?.textsImported || 0);
          const checked = Number(result?.imported || selected.length);
          await refresh(1);
          showToast(added > 0 ? `Import finished — ${added} new text${added === 1 ? '' : 's'} in your library.` : `Checked ${checked} work${checked === 1 ? '' : 's'} — nothing new (already imported or unreadable).`, added > 0 ? 'success' : 'warning');
        } catch (error) {
          // Partial imports commit per item server-side: refresh so landed
          // rows show, then explain that retrying resumes the rest.
          close();
          await refresh(1).catch(() => {});
          showToast(error?.message || 'Import failed partway. Check the library — retry for anything missing.', 'error');
        }
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

function speechPieces() {
  const hasWindow = typeof window !== 'undefined';
  return {
    synthesis: hasWindow ? window.speechSynthesis : null,
    Utterance: hasWindow ? window.SpeechSynthesisUtterance : null
  };
}

// Story-view paragraph segmentation (presentation chunking only): split after
// 。！？!? or a line break and trim, mirroring the server splitter's
// boundaries. Offsets stay in Unicode code points so annotation positions
// line up with the slice each word renders.
function splitStoryParagraphs(text) {
  const points = Array.from(String(text || ''));
  const paragraphs = [];
  let start = 0;
  const push = (end) => {
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(points[from])) from += 1;
    while (to > from && /\s/u.test(points[to - 1])) to -= 1;
    if (to > from) paragraphs.push({ text: points.slice(from, to).join(''), start: from, end: to });
    start = end;
  };
  for (let index = 0; index < points.length; index += 1) {
    if (/[。！？!?\n\r]/u.test(points[index])) push(index + 1);
  }
  if (start < points.length) push(points.length);
  if (!paragraphs.length && String(text || '').trim()) {
    paragraphs.push({ text: String(text).trim(), start: 0, end: points.length });
  }
  return paragraphs;
}

const READER_FURIGANA_KEY = 'jlt-reading-furigana';
const READER_MODES = ['read', 'study', 'review'];

// Voice speed mirrors the Review page (same shared preference): discrete
// per-block selectors beside every Listen button, kept in sync, applied
// instantly and persisted in the background with revert on failure.
const SPEECH_RATES = [0.25, 0.5, 1, 1.5];
const MIN_SPEECH_RATE = 0.25;
const MAX_SPEECH_RATE = 1.5;

function sanitizeSpeechRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= MIN_SPEECH_RATE && rate <= MAX_SPEECH_RATE
    ? rate
    : 1;
}
// Han detection for token ruby: whole-token ruby only when the rendered
// surface contains at least one Han character. Kana-only surfaces render
// plain (no ruby element at all).
const HAN_RE = /\p{Script=Han}/u;

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
  const savedMetas = [];
  // Token layer, feature-detected (additive backend fields). hasTokenLayer
  // gates every token use below; without tokens[] the annotation path stays
  // exactly as before. sentences[] (when a non-empty array) becomes the
  // block list, otherwise splitStoryParagraphs remains the fallback.
  const hasTokenLayer = Array.isArray(data.tokens) && data.tokens.length > 0;
  const sentenceRows = (Array.isArray(data.sentences) ? data.sentences : []).filter((row) => row
    && typeof row.text === 'string'
    && Number.isInteger(row.start) && Number.isInteger(row.end)
    && row.start >= 0 && row.end > row.start);
  const sentenceById = new Map();
  for (const row of sentenceRows) {
    if (row.id !== undefined && row.id !== null && !sentenceById.has(row.id)) sentenceById.set(row.id, row.text);
  }
  const validTokens = hasTokenLayer ? data.tokens.filter((token) => token
    && Number.isInteger(token.start) && Number.isInteger(token.end)
    && token.start >= 0 && token.end > token.start && token.start < total)
    .sort((a, b) => a.start - b.start || b.end - a.end) : [];
  let latestReviewSession = null;
  const placed = hasTokenLayer ? [] : placedAnnotations();
  const paragraphs = sentenceRows.length > 0
    ? sentenceRows.map((row) => ({ text: row.text, start: Math.max(0, row.start), end: Math.min(total, Math.max(row.start + 1, row.end)) }))
    : splitStoryParagraphs(data.text || '');
  const paragraphCount = paragraphs.length;
  // Editorial translations (server sentence ids → English). Blocks resolve
  // through paragraphSentenceIds so reveals always match the server
  // segmentation, never the fallback split.
  const paragraphSentenceIds = sentenceRows.length > 0
    ? sentenceRows.map((row) => (Number.isInteger(row.id) ? row.id : null))
    : paragraphs.map(() => null);
  let localTranslations = data.translations && typeof data.translations === 'object' && !Array.isArray(data.translations)
    ? { ...data.translations }
    : {};
  const translationFor = (index) => {
    const sentenceId = paragraphSentenceIds[index];
    if (sentenceId === null || sentenceId === undefined) return null;
    const value = localTranslations[sentenceId];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  const revealedTranslations = new Set();
  const seen = new Set();
  let blockWrappers = [];
  let mode = 'study';
  let furiganaOn = true;
  try {
    furiganaOn = window.localStorage.getItem(READER_FURIGANA_KEY) !== 'off';
  } catch {
    furiganaOn = true;
  }
  let lastSaveAt = 0;
  // Shared voice-speed preference with the Review page: selects apply
  // instantly for the next utterance; persistence needs a server-loaded
  // snapshot (PUT requires the full preferences object), otherwise the
  // change stays local to this session instead of clobbering card types.
  let readerPreferences = { cardTypes: ['recognition'], weights: {}, engineMode: 'fixed', autoPick: true, speechRate: 1 };
  let speechPrefsLoaded = false;
  const speechRateSelects = [];
  function currentSpeechRate() {
    return sanitizeSpeechRate(readerPreferences.speechRate);
  }
  function syncSpeechRateSelects(rate) {
    for (const select of speechRateSelects) {
      try {
        if (!select || !select.isConnected) continue;
        select.value = String(rate);
      } catch { /* detached nodes are best-effort */ }
    }
  }
  async function applySpeechRate(changedSelect) {
    const previous = currentSpeechRate();
    const rate = sanitizeSpeechRate(changedSelect ? changedSelect.value : previous);
    readerPreferences = { ...readerPreferences, speechRate: rate };
    syncSpeechRateSelects(rate);
    if (!speechPrefsLoaded) return;
    try {
      const saved = await apiRequest('/api/review/preferences', {
        method: 'PUT',
        body: {
          cardTypes: Array.isArray(readerPreferences.cardTypes) ? readerPreferences.cardTypes : ['recognition'],
          weights: readerPreferences.weights && typeof readerPreferences.weights === 'object' ? readerPreferences.weights : {},
          autoPick: readerPreferences.autoPick !== false,
          speechRate: rate
        }
      });
      const preferences = saved?.userPreferences;
      readerPreferences = { ...readerPreferences, speechRate: sanitizeSpeechRate(preferences ? preferences.speechRate : rate) };
      syncSpeechRateSelects(currentSpeechRate());
    } catch (error) {
      readerPreferences = { ...readerPreferences, speechRate: previous };
      syncSpeechRateSelects(previous);
      showToast(error?.message || 'Could not save voice speed.', 'error');
    }
  }
  async function loadSpeechRate() {
    try {
      const data = await apiRequest('/api/review/types');
      const preferences = data?.userPreferences;
      if (preferences) {
        readerPreferences = {
          cardTypes: Array.isArray(preferences.cardTypes) ? preferences.cardTypes : readerPreferences.cardTypes,
          weights: preferences.weights && typeof preferences.weights === 'object' ? preferences.weights : {},
          engineMode: preferences.engineMode || 'fixed',
          autoPick: preferences.autoPick !== false,
          speechRate: sanitizeSpeechRate(preferences.speechRate)
        };
        speechPrefsLoaded = true;
        syncSpeechRateSelects(currentSpeechRate());
      }
    } catch { /* fail-open: default 1× until review preferences load */ }
  }

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

  function annotationDisplay(annotation) {
    if (annotation.type === 'kanji') return annotation.char;
    if (annotation.type === 'vocabulary') return annotation.word;
    return annotation.pattern;
  }

  function annotationTypeLabel(annotation) {
    if (annotation.type === 'kanji') return 'Kanji';
    if (annotation.type === 'vocabulary') return 'Vocabulary';
    return 'Grammar';
  }

  // Token-layer helpers (used only when tokens[] is present). entityKind
  // uses the backend vocab (maps to the vocabulary decoration/endpoint);
  // unknown kinds render with the vocabulary styling as a neutral default.
  function tokenKind(token) {
    if (token.entityKind === 'kanji') return 'kanji';
    if (token.entityKind === 'grammar') return 'grammar';
    return 'vocabulary';
  }

  function tokenKindLabel(token) {
    if (token.entityKind === 'kanji') return 'Kanji';
    if (token.entityKind === 'grammar') return 'Grammar';
    return 'Vocabulary';
  }

  function hasCandidateId(token) {
    return token.candidateId !== undefined && token.candidateId !== null && token.candidateId !== '';
  }

  // Token rendering. The surface is sliced from code-point offsets
  // (astral-safe), which keeps inflected forms aligned where a lemma-length
  // slice would drift. Ruby is whole-token from surfaceReading only: it
  // needs the toggle on, a reading, Han in the surface, and a non-kanji
  // kind (kanji readings stay sheet-only, as in the annotation path).
  // tappable === false renders a decorated but non-interactive span.
  function tokenNode(token, surface, paragraph, key) {
    const kind = tokenKind(token);
    const dimmed = addedKeys.has(key) || token.known === true;
    const decoration = kind === 'kanji'
      ? ' border-b border-dotted border-ink/60'
      : kind === 'vocabulary'
        ? ' underline decoration-ink/60 underline-offset-4'
        : ' bg-ink/10';
    let inner;
    if (furiganaOn && kind !== 'kanji' && token.surfaceReading && HAN_RE.test(surface)) {
      const ruby = element('ruby', { className: 'font-jp' });
      ruby.appendChild(document.createTextNode(surface));
      ruby.appendChild(element('rt', { className: 'text-xs text-muted', text: token.surfaceReading }));
      inner = ruby;
    } else {
      inner = document.createTextNode(surface);
    }
    if (mode !== 'study' || token.tappable === false) {
      return element('span', { className: `rounded px-0.5${decoration}${dimmed ? ' opacity-50' : ''}` }, [inner]);
    }
    const display = token.surface || surface;
    const node = element('button', {
      className: `min-w-0 rounded px-0.5 align-baseline${decoration}${dimmed ? ' opacity-50' : ''}`,
      attrs: {
        type: 'button',
        'aria-label': `${display} — open details${token.surfaceReading ? `, reading ${token.surfaceReading}` : ''}${token.gloss ? `, ${token.gloss}` : ''}`
      }
    }, [inner]);
    node.addEventListener('click', () => openTokenSheet(token, surface, paragraph, key));
    return node;
  }

  // Inline word rendering. Ruby uses server-provided readings only:
  // vocabulary/grammar readings are parser-derived for the running text,
  // while single-kanji reference readings are context-free and stay in the
  // sheet instead of risking a mismatched furigana line.
  function wordNode(annotation, length, paragraph) {
    const surface = codePoints.slice(annotation.position, annotation.position + length).join('');
    const key = `${annotation.type}:${annotation.position}`;
    const dimmed = addedKeys.has(key) || annotation.known === true;
    const decoration = annotation.type === 'kanji'
      ? ' border-b border-dotted border-ink/60'
      : annotation.type === 'vocabulary'
        ? ' underline decoration-ink/60 underline-offset-4'
        : ' bg-ink/10';
    let inner;
    if (furiganaOn && annotation.type !== 'kanji' && annotation.reading) {
      const ruby = element('ruby', { className: 'font-jp' });
      ruby.appendChild(document.createTextNode(surface));
      ruby.appendChild(element('rt', { className: 'text-xs text-muted', text: annotation.reading }));
      inner = ruby;
    } else {
      inner = document.createTextNode(surface);
    }
    if (mode !== 'study') {
      return element('span', { className: `rounded px-0.5${decoration}${dimmed ? ' opacity-50' : ''}` }, [inner]);
    }
    const node = element('button', {
      className: `min-w-0 rounded px-0.5 align-baseline${decoration}${dimmed ? ' opacity-50' : ''}`,
      attrs: {
        type: 'button',
        'aria-label': `${annotationDisplay(annotation)} — open details${annotation.reading ? `, reading ${annotation.reading}` : ''}${annotation.meaning ? `, ${annotation.meaning}` : ''}`
      }
    }, [inner]);
    node.addEventListener('click', () => openWordSheet(annotation, surface, paragraph.text, key));
    return node;
  }

  // Paragraph blocks (frames 03–04): large Japanese type inside one story
  // card, each paragraph its own block. Annotated words render inline via
  // wordNode; anything unannotated stays plain text.
  function renderParagraphs() {
    storyBlocks.replaceChildren(...paragraphs.map((paragraph, index) => {
      const nodes = [];
      const hintGlosses = [];
      const hintSeen = new Set();
      const collectHint = (gloss) => {
        if (typeof gloss !== 'string') return;
        const hint = gloss.trim();
        if (!hint || hintSeen.has(hint) || hintGlosses.length >= 8) return;
        hintSeen.add(hint);
        hintGlosses.push(hint);
      };
      let cursor = paragraph.start;
      if (hasTokenLayer) {
        for (const token of validTokens) {
          if (token.end <= paragraph.start || token.start >= paragraph.end) continue;
          const sliceStart = Math.max(token.start, cursor, paragraph.start);
          const sliceEnd = Math.min(token.end, paragraph.end);
          if (sliceEnd <= sliceStart) continue;
          if (token.start > cursor) nodes.push(document.createTextNode(codePoints.slice(cursor, Math.min(token.start, paragraph.end)).join('')));
          const surface = codePoints.slice(sliceStart, sliceEnd).join('');
          const key = hasCandidateId(token) ? `token:${token.candidateId}:${token.start}:${token.end}` : `token:${token.start}:${token.end}`;
          nodes.push(tokenNode(token, surface, paragraph, key));
          if (token.tappable === true) collectHint(token.gloss);
          cursor = Math.max(cursor, sliceEnd);
        }
      } else {
        for (const { annotation, length } of placed) {
          const spanStart = annotation.position;
          const spanEnd = spanStart + length;
          if (spanEnd <= paragraph.start || spanStart >= paragraph.end) continue;
          if (spanStart > cursor) nodes.push(document.createTextNode(codePoints.slice(cursor, spanStart).join('')));
          nodes.push(wordNode(annotation, length, paragraph));
          collectHint(annotation.meaning || annotation.explanation);
          cursor = Math.max(cursor, spanEnd);
        }
      }
      if (cursor < paragraph.end) nodes.push(document.createTextNode(codePoints.slice(cursor, paragraph.end).join('')));
      const line = element('p', {
        className: `min-w-0 break-words font-jp leading-loose text-ink${index > 0 ? ' border-t border-stone pt-5' : ''}`,
        attrs: { lang: 'ja' }
      });
      line.append(...nodes);
      const children = [line];
      const listen = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': `Listen to paragraph ${index + 1}` } }, [icon('volume', { size: 18 })]);
      listen.addEventListener('click', () => {
        const verdict = speakJapanese(paragraph.text, { rate: currentSpeechRate(), ...speechPieces() });
        if (!verdict.ok) showToast(verdict.message || 'Audio playback is unavailable.', 'error');
      });
      const speedSelect = element('select', {
        className: 'rounded-lg border border-stone bg-paper px-1.5 py-1 text-xs font-semibold text-muted',
        attrs: { 'aria-label': `Voice speed for paragraph ${index + 1}`, 'data-speech-rate': '' }
      }, SPEECH_RATES.map((rate) => element('option', {
        text: `${rate}×`,
        attrs: { value: String(rate), ...(rate === currentSpeechRate() ? { selected: '' } : {}) }
      })));
      speedSelect.addEventListener('change', () => { applySpeechRate(speedSelect); });
      speechRateSelects.push(speedSelect);
      children.push(element('div', { className: 'mt-2 flex min-w-0 items-center gap-2' }, [listen, speedSelect]));
      const translation = translationFor(index);
      if (translation !== null) {
        const english = element('p', { className: 'mt-2 min-w-0 break-words text-sm leading-6 text-muted', text: translation });
        const revealed = revealedTranslations.has(index);
        english.hidden = !revealed;
        const toggle = element('button', {
          className: 'mt-2 text-xs font-medium text-vermilion hover:underline',
          text: revealed ? 'Hide English' : 'Tap to reveal English',
          attrs: { type: 'button', 'aria-expanded': String(revealed) }
        });
        toggle.addEventListener('click', () => {
          if (revealedTranslations.has(index)) revealedTranslations.delete(index);
          else revealedTranslations.add(index);
          const nowRevealed = revealedTranslations.has(index);
          english.hidden = !nowRevealed;
          toggle.textContent = nowRevealed ? 'Hide English' : 'Tap to reveal English';
          toggle.setAttribute('aria-expanded', String(nowRevealed));
        });
        children.push(toggle, english);
      } else if (hintGlosses.length) {
        children.push(element('details', { className: 'mt-2 min-w-0' }, [
          element('summary', { className: 'cursor-pointer text-xs font-medium text-vermilion hover:underline', text: 'Word hints (not a translation)' }),
          element('p', { className: 'mt-1 min-w-0 break-words text-xs leading-5 text-muted', text: hintGlosses.join(' · '), attrs: { title: 'Hints composed from dictionary glosses — not a translation' } })
        ]));
      }
      return element('div', { className: index > 0 ? 'mt-5' : '', attrs: { 'data-paragraph-block': String(index) } }, children);
    }));
    blockWrappers = [...storyBlocks.children];
  }

  function detailRow(label, value) {
    if (value === null || value === undefined || value === '') return null;
    return element('p', { className: 'mt-2 text-sm leading-6' }, [
      element('span', { className: 'font-semibold text-ink', text: `${label}: ` }),
      element('span', { className: 'text-muted', text: String(value) })
    ]);
  }

  // Collection save shared by the word sheet: the same per-type endpoints
  // the previous annotation dialog used, with server-owned fields only.
  async function saveAnnotation(annotation, key) {
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
    savedMetas.push({
      key,
      type: annotation.type,
      display: annotationDisplay(annotation),
      reading: annotation.reading || null,
      meaning: annotation.meaning || annotation.explanation || null
    });
  }

  // Token save (token layer only). Enroll by candidateId when available;
  // any enroll problem falls back to the same per-type collection endpoints
  // the annotation path uses. Only server-owned fields are ever sent —
  // readings and meanings are never invented client-side.
  async function enrollToken(token) {
    const result = await apiRequest(`/api/reading/text/${encodeURIComponent(textId)}/enroll`, {
      method: 'POST',
      body: { selected: [token.candidateId] }
    });
    if (result && result.reviewSessionId && Array.isArray(result.queueItems)) {
      latestReviewSession = { reviewSessionId: result.reviewSessionId, queueItems: result.queueItems };
    }
    return result;
  }

  async function saveTokenToCollection(token, surface) {
    const kind = tokenKind(token);
    const word = token.lemma || token.surface || surface;
    if (kind === 'kanji') {
      await apiRequest('/api/kanji', {
        method: 'POST',
        body: {
          character_kanji: token.surface || token.lemma || surface,
          meaning: token.gloss,
          ...(token.level ? { jlpt_level: token.level } : {})
        }
      });
    } else if (kind === 'vocabulary') {
      await apiRequest('/api/vocabulary', {
        method: 'POST',
        body: { word, reading: token.lemmaReading || token.surfaceReading || '', meaning: token.gloss }
      });
    } else {
      await apiRequest('/api/grammar', {
        method: 'POST',
        body: { grammar_point: word, meaning: token.gloss, ...(token.level ? { jlpt_level: token.level } : {}) }
      });
    }
  }

  function markTokenSaved(token, surface, key) {
    addedKeys.add(key);
    savedMetas.push({
      key,
      type: tokenKind(token),
      display: token.surface || surface,
      reading: token.surfaceReading || token.lemmaReading || null,
      meaning: token.gloss || null
    });
  }

  // Token sheet (token layer only): same shape as the annotation sheet.
  // The kana line shows surfaceReading when present; the dictionary-form
  // line shows lemma + lemmaReading only when the surface differs from the
  // lemma (whole-word readings are never split across kanji). Story context
  // prefers the token's sentence text when sentences[] is present.
  function openTokenSheet(token, surface, paragraph, key) {
    const display = token.surface || surface;
    const alreadyAdded = addedKeys.has(key) || token.known === true;
    const canAdd = !alreadyAdded && (hasCandidateId(token) || Boolean(token.gloss));
    const contextText = (token.sentenceId !== undefined && token.sentenceId !== null && sentenceById.has(token.sentenceId))
      ? sentenceById.get(token.sentenceId)
      : paragraph.text;
    const liveNote = element('p', { className: 'text-xs text-muted sm:col-span-2', attrs: { 'aria-live': 'polite' } });
    const saveButton = element('button', {
      className: 'button-primary min-h-9 px-4 py-2 text-xs sm:col-span-2 sm:justify-self-start',
      text: alreadyAdded ? 'Saved to your collection' : 'Save word',
      attrs: { type: 'button', 'aria-label': `Save ${display} to your collection`, ...((alreadyAdded || !canAdd) ? { disabled: '' } : {}) }
    });
    saveButton.addEventListener('click', () => withPendingAction(saveButton, async () => {
      try {
        if (hasCandidateId(token)) {
          try {
            await enrollToken(token);
          } catch {
            await saveTokenToCollection(token, surface);
          }
        } else {
          await saveTokenToCollection(token, surface);
        }
        markTokenSaved(token, surface, key);
        saveButton.textContent = 'Saved to your collection';
        saveButton.disabled = true;
        liveNote.textContent = `${display} is now in your collection.`;
        showToast('Added to your collection.');
        renderParagraphs();
        renderSavedList();
      } catch (error) {
        showToast(error?.message || 'Unable to add this item.', 'error');
      }
    }, { pendingLabel: 'Saving…' }));
    const keepReading = element('button', { className: 'button-secondary min-h-9 px-4 py-2 text-xs sm:col-span-2 sm:justify-self-start', text: 'Keep reading', attrs: { type: 'button' } });
    const close = openDialog({
      title: display,
      description: `${tokenKindLabel(token)} · ${token.level || 'level unknown'}${alreadyAdded ? ' · already in your collection' : ''}`,
      content: [
        ...(token.surfaceReading ? [element('p', { className: 'font-jp text-sm text-muted sm:col-span-2', text: token.surfaceReading, attrs: { lang: 'ja' } })] : []),
        element('div', { className: 'rounded-xl bg-vermilion-soft p-3 sm:col-span-2', attrs: { 'aria-label': 'Meaning' } }, [
          element('p', { className: 'min-w-0 break-words text-sm leading-6 text-ink', text: token.gloss || 'No dictionary gloss is available for this item.' })
        ]),
        ...((token.lemma && surface && surface !== token.lemma)
          ? [element('p', { className: 'min-w-0 break-words text-sm text-muted sm:col-span-2', text: `Dictionary form: ${token.lemma}${token.lemmaReading ? `・${token.lemmaReading}` : ''}` })]
          : []),
        saveButton,
        liveNote,
        element('details', { className: 'surface min-w-0 p-3 sm:col-span-2' }, [
          element('summary', { className: 'cursor-pointer text-sm font-semibold text-vermilion', text: 'Examples and details' }),
          element('div', { className: 'mt-1' }, [
            detailRow('Reading', token.surfaceReading),
            detailRow('Meaning', token.gloss),
            detailRow('Level', token.level),
            element('p', { className: 'mt-2 text-xs text-muted', text: alreadyAdded ? 'Already in your collection.' : 'Not in your collection yet.' })
          ].filter(Boolean))
        ]),
        element('details', { className: 'surface min-w-0 p-3 sm:col-span-2' }, [
          element('summary', { className: 'cursor-pointer text-sm font-semibold text-vermilion', text: 'Story context' }),
          element('p', { className: 'mt-2 min-w-0 break-words font-jp text-sm leading-8 text-ink', text: contextText, attrs: { lang: 'ja' } })
        ]),
        keepReading,
        ...(!canAdd && !alreadyAdded ? [element('p', { className: 'text-xs text-muted sm:col-span-2', text: 'No reference meaning is available for this item, so it cannot be added automatically. Add it manually with your own definition.' })] : [])
      ],
      showFooter: false
    });
    keepReading.addEventListener('click', close);
  }

  // Word sheet (frames 01–02): bottom sheet on mobile and dialog on desktop
  // through openDialog's responsive panel. Large surface form, kana reading
  // below, gloss box, a dictionary-form line only when the running surface
  // differs from the base form, disclosure cards for details and story
  // context, Save word with toast feedback, Keep reading to close.
  function openWordSheet(annotation, surface, paragraphText, key) {
    const display = annotationDisplay(annotation);
    const alreadyAdded = addedKeys.has(key) || annotation.known === true;
    const canAdd = !alreadyAdded
      && (annotation.type === 'kanji' ? Boolean(annotation.meaning)
        : annotation.type === 'vocabulary' ? Boolean(annotation.meaning)
          : Boolean(annotation.meaning || annotation.explanation));
    const baseForm = annotation.type === 'kanji' ? null : display;
    const liveNote = element('p', { className: 'text-xs text-muted sm:col-span-2', attrs: { 'aria-live': 'polite' } });
    const saveButton = element('button', {
      className: 'button-primary min-h-9 px-4 py-2 text-xs sm:col-span-2 sm:justify-self-start',
      text: alreadyAdded ? 'Saved to your collection' : 'Save word',
      attrs: { type: 'button', 'aria-label': `Save ${display} to your collection`, ...((alreadyAdded || !canAdd) ? { disabled: '' } : {}) }
    });
    saveButton.addEventListener('click', () => withPendingAction(saveButton, async () => {
      try {
        await saveAnnotation(annotation, key);
        saveButton.textContent = 'Saved to your collection';
        saveButton.disabled = true;
        liveNote.textContent = `${display} is now in your collection.`;
        showToast('Added to your collection.');
        renderParagraphs();
        renderSavedList();
      } catch (error) {
        showToast(error?.message || 'Unable to add this item.', 'error');
      }
    }, { pendingLabel: 'Saving…' }));
    const keepReading = element('button', { className: 'button-secondary min-h-9 px-4 py-2 text-xs sm:col-span-2 sm:justify-self-start', text: 'Keep reading', attrs: { type: 'button' } });
    const close = openDialog({
      title: display,
      description: `${annotationTypeLabel(annotation)} · ${annotation.level || 'level unknown'}${alreadyAdded ? ' · already in your collection' : ''}`,
      content: [
        ...(annotation.reading ? [element('p', { className: 'font-jp text-sm text-muted sm:col-span-2', text: annotation.reading, attrs: { lang: 'ja' } })] : []),
        element('div', { className: 'rounded-xl bg-vermilion-soft p-3 sm:col-span-2', attrs: { 'aria-label': 'Meaning' } }, [
          element('p', { className: 'min-w-0 break-words text-sm leading-6 text-ink', text: annotation.meaning || annotation.explanation || 'No dictionary gloss is available for this item.' })
        ]),
        ...((baseForm && surface && surface !== baseForm)
          ? [element('p', { className: 'min-w-0 break-words text-sm text-muted sm:col-span-2', text: `Dictionary form: ${baseForm}${annotation.reading ? `・${annotation.reading}` : ''}` })]
          : []),
        saveButton,
        liveNote,
        element('details', { className: 'surface min-w-0 p-3 sm:col-span-2' }, [
          element('summary', { className: 'cursor-pointer text-sm font-semibold text-vermilion', text: 'Examples and details' }),
          element('div', { className: 'mt-1' }, [
            detailRow('Reading', annotation.reading),
            detailRow('Meaning', annotation.meaning),
            detailRow('Level', annotation.level),
            ...(annotation.type === 'grammar' ? [detailRow('Explanation', annotation.explanation)] : []),
            ...(annotation.type === 'kanji' && annotation.info ? [detailRow('On readings', (annotation.info.onyomi || []).join('、')), detailRow('Kun readings', (annotation.info.kunyomi || []).join('、'))] : []),
            element('p', { className: 'mt-2 text-xs text-muted', text: alreadyAdded ? 'Already in your collection.' : 'Not in your collection yet.' })
          ].filter(Boolean))
        ]),
        element('details', { className: 'surface min-w-0 p-3 sm:col-span-2' }, [
          element('summary', { className: 'cursor-pointer text-sm font-semibold text-vermilion', text: 'Story context' }),
          element('p', { className: 'mt-2 min-w-0 break-words font-jp text-sm leading-8 text-ink', text: paragraphText, attrs: { lang: 'ja' } })
        ]),
        keepReading,
        ...(!canAdd && !alreadyAdded ? [element('p', { className: 'text-xs text-muted sm:col-span-2', text: 'No reference meaning is available for this item, so it cannot be added automatically. Add it manually with your own definition.' })] : [])
      ],
      showFooter: false
    });
    keepReading.addEventListener('click', close);
  }

  // Story header card (frame 07): level + paragraph count, status line,
  // progress bar with a real progressbar role, Read/Study/Review mode pills
  // with distinct behavior, and a persisted furigana toggle.
  const statusLine = element('p', { className: 'mt-1 text-xs text-muted', attrs: { 'aria-live': 'polite' } });
  const countLine = element('span', { className: 'text-xs font-medium tabular-nums text-muted', text: '0 / 0 paragraphs' });
  const percentLine = element('span', { className: 'text-xs font-medium tabular-nums text-muted', text: '0%' });
  const progressGroup = element('div', {
    className: 'mt-1 grid gap-1.5',
    attrs: { role: 'progressbar', 'aria-label': 'Story progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }
  }, [
    element('div', { className: 'flex items-baseline justify-between gap-2' }, [countLine, percentLine]),
    element('div', { className: 'jlpt-progress-track w-full' }, [
      element('div', { className: 'jlpt-progress-fill', attrs: { 'data-progress-fill': '', style: 'width:0%' } })
    ])
  ]);

  const modeButtons = {};
  const modeGroup = element('div', { className: 'flex flex-wrap gap-2', attrs: { role: 'group', 'aria-label': 'Reading mode' } });
  for (const value of READER_MODES) {
    const label = value === 'read' ? 'Read' : value === 'study' ? 'Study' : 'Review';
    const button = element('button', { className: 'filter-pill', text: label, attrs: { type: 'button', 'aria-pressed': 'false' } });
    button.addEventListener('click', () => setMode(value));
    modeButtons[value] = button;
    modeGroup.appendChild(button);
  }

  // Modes change behavior, never just the label: Read is plain text without
  // tap targets, Study enables tap-to-lookup, Review swaps the story for
  // the words saved in this session with a path into review.
  function setMode(next) {
    mode = READER_MODES.includes(next) ? next : 'study';
    for (const [value, button] of Object.entries(modeButtons)) {
      const active = value === mode;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('filter-pill--active', active);
    }
    const reviewing = mode === 'review';
    storyCard.hidden = reviewing;
    savedCard.hidden = !reviewing;
    if (reviewing) renderSavedList();
    else renderParagraphs();
  }

  const furiganaButton = element('button', { className: 'filter-pill', attrs: { type: 'button' } });
  function paintFuriganaButton() {
    furiganaButton.textContent = furiganaOn ? 'Furigana on' : 'Furigana off';
    furiganaButton.setAttribute('aria-pressed', String(furiganaOn));
    furiganaButton.classList.toggle('filter-pill--active', furiganaOn);
  }
  furiganaButton.addEventListener('click', () => {
    furiganaOn = !furiganaOn;
    try {
      window.localStorage.setItem(READER_FURIGANA_KEY, furiganaOn ? 'on' : 'off');
    } catch { /* storage is best-effort */ }
    paintFuriganaButton();
    if (mode !== 'review') renderParagraphs();
  });

  const fontSlider = element('input', {
    className: 'h-1.5 w-full cursor-pointer accent-vermilion',
    attrs: { id: 'reader-font-size', type: 'range', min: '14', max: '28', step: '1', value: '20', 'aria-label': 'Font size' }
  });
  fontSlider.addEventListener('input', () => { storyBlocks.style.fontSize = `${fontSlider.value}px`; });

  // Community publish (owners only, own-created texts only): snapshots text
  // + translations to the Texts feed. Shared library rows hide it
  // (data.mine false, server 404s), and so do copies imported from
  // Community (server 400s): re-publishing imports would amplify one text
  // into unbounded new publications.
  const importedCopy = data?.metadata?.importedFromPublication !== undefined
    && data?.metadata?.importedFromPublication !== null;
  const publishButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Publish', attrs: { type: 'button', 'aria-label': `Publish ${data.title} to Community` } });
  publishButton.hidden = data.mine !== true || importedCopy;
  const importNote = element('p', { className: 'text-xs text-muted', text: 'Imported copies can’t be republished to Community.' });
  importNote.hidden = !importedCopy;
  publishButton.addEventListener('click', () => {
    const titleInput = element('input', { className: 'field-control', attrs: { value: data.title || '', maxlength: '200', 'aria-label': 'Publication title' } });
    const descriptionInput = element('textarea', { className: 'field-control min-h-16 w-full', attrs: { rows: '2', maxlength: '500', placeholder: 'Short description', 'aria-label': 'Publication description' } });
    openDialog({
      title: `Publish · ${data.title}`,
      description: 'Shares a snapshot (text + translations) to Community. Your library keeps the original.',
      content: [element('div', { className: 'grid gap-3' }, [titleInput, descriptionInput])],
      submitLabel: 'Publish text',
      onSubmit: async (form, close) => {
        try {
          await publishReadingText({ textId, title: titleInput.value, description: descriptionInput.value });
          showToast('Published to Community.');
          close();
        } catch (error) {
          showToast(error?.message || 'Unable to publish.', 'error');
        }
      }
    });
  });

  const translateButton = element('button', { className: 'button-secondary min-h-9 px-3 py-1.5 text-xs', text: 'Add translations', attrs: { type: 'button' } });
  const translationsNote = element('p', { className: 'mt-3 text-xs leading-5 text-muted', text: 'Paragraph translations are not provided by the reading API yet, so each block shows Japanese only.' });
  function paintTranslationChrome() {
    const translated = paragraphs.filter((_, paragraphIndex) => translationFor(paragraphIndex) !== null).length;
    translationsNote.hidden = translated > 0;
    translateButton.hidden = !(sentenceRows.length > 0 && translated < paragraphCount);
  }
  translateButton.addEventListener('click', () => {
    const fields = [];
    paragraphs.forEach((paragraph, index) => {
      const sentenceId = paragraphSentenceIds[index];
      if (sentenceId === null || sentenceId === undefined) return;
      const area = element('textarea', { className: 'field-control min-h-16 w-full', attrs: { name: `translation-${sentenceId}`, rows: '2', maxlength: '2000', placeholder: 'English translation', 'aria-label': `English translation for paragraph ${index + 1}` } });
      area.value = translationFor(index) || '';
      fields.push(element('div', { className: 'grid min-w-0 gap-1' }, [
        element('p', { className: 'min-w-0 break-words font-jp text-sm leading-7 text-ink', text: paragraph.text, attrs: { lang: 'ja' } }),
        area
      ]));
    });
    openDialog({
      title: `Translations · ${data.title}`,
      description: 'One English translation per paragraph. Empty fields stay Japanese-only.',
      content: fields.length ? [element('div', { className: 'grid gap-4' }, fields)] : [element('p', { className: 'text-sm text-muted', text: 'No paragraphs to translate.' })],
      submitLabel: 'Save translations',
      onSubmit: async (form, close) => {
        const payload = [...form.querySelectorAll('textarea[name^="translation-"]')].map((area) => ({
          sentenceId: Number(area.name.slice('translation-'.length)),
          translation: area.value
        }));
        try {
          const saved = await apiRequest(`/api/reading/text/${encodeURIComponent(textId)}/translations`, { method: 'PUT', body: { translations: payload } });
          localTranslations = saved && saved.translations && typeof saved.translations === 'object' && !Array.isArray(saved.translations)
            ? { ...saved.translations }
            : {};
          renderParagraphs();
          paintTranslationChrome();
          showToast('Translations saved.');
          close();
        } catch (error) {
          showToast(error?.message || 'Unable to save translations.', 'error');
        }
      }
    });
  });

  const headerCard = element('div', { className: 'surface mt-3 grid min-w-0 gap-3 p-4' }, [
    element('div', { className: 'flex min-w-0 flex-wrap items-start justify-between gap-3' }, [
      element('div', { className: 'min-w-0' }, [
        element('p', { className: 'break-words text-xs font-semibold uppercase tracking-[0.16em] text-vermilion', text: `${data.level || 'No level'} · ${paragraphCount} paragraph${paragraphCount === 1 ? '' : 's'}` }),
        statusLine
      ]),
      modeGroup
    ]),
    progressGroup,
    element('div', { className: 'flex min-w-0 flex-wrap items-center gap-2 border-t border-stone pt-3' }, [
      furiganaButton,
      element('label', { className: 'flex min-w-44 flex-1 items-center gap-2 text-xs text-muted', attrs: { for: 'reader-font-size' } }, [
        element('span', { text: 'A', attrs: { 'aria-hidden': 'true' } }),
        fontSlider,
        element('span', { className: 'text-sm font-semibold', text: 'A', attrs: { 'aria-hidden': 'true' } })
      ]),
      translateButton,
      publishButton,
      importNote
    ])
  ]);

  const storyBlocks = element('div', { className: 'min-w-0' });
  const storyCard = element('article', { className: 'surface mt-3 min-w-0 p-5 sm:p-6', attrs: { 'aria-label': 'Story text' } }, [storyBlocks]);

  const savedCount = element('p', { className: 'text-xs text-muted', attrs: { 'aria-live': 'polite' } });
  const savedList = element('div', { className: 'mt-3 min-w-0' });
  // Review routing: when a token enroll returned a review session, both
  // review buttons hand it off with the same sessionStorage shape the
  // immersion flow uses; otherwise they keep the plain #review target.
  function openReviewTarget() {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage && latestReviewSession
        && latestReviewSession.reviewSessionId && Array.isArray(latestReviewSession.queueItems)) {
        window.sessionStorage.setItem('jlt-immersion-review-queue', JSON.stringify({
          reviewSessionId: Number(latestReviewSession.reviewSessionId),
          items: latestReviewSession.queueItems
        }));
        window.location.hash = `#review?reviewSessionId=${Number(latestReviewSession.reviewSessionId)}`;
        return;
      }
    } catch { /* storage blocked: fall back to the review page */ }
    if (typeof window !== 'undefined') {
      window.location.hash = 'review';
    }
  }

  const openReviewButton = element('button', { className: 'button-primary min-h-9 px-4 py-2 text-xs', text: 'Open review', attrs: { type: 'button' } });
  openReviewButton.addEventListener('click', openReviewTarget);
  const savedCard = element('section', { className: 'surface mt-3 min-w-0 p-5 sm:p-6', attrs: { 'aria-label': 'Saved words' } }, [
    element('h2', { className: 'font-semibold text-ink', text: 'Saved words' }),
    element('p', { className: 'mt-1 text-sm leading-6 text-muted', text: 'Words you save while studying land in your collection and become review material.' }),
    element('div', { className: 'mt-3' }, [savedCount]),
    savedList,
    element('div', { className: 'mt-4' }, [openReviewButton])
  ]);
  savedCard.hidden = true;

  function renderSavedList() {
    if (!savedMetas.length) {
      savedCount.textContent = '0 saved this session';
      savedList.replaceChildren(element('p', { className: 'text-sm leading-6 text-muted', text: 'No saved words yet. Switch to Study and tap a word to save it.' }));
      return;
    }
    savedCount.textContent = `${savedMetas.length} saved this session`;
    savedList.replaceChildren(element('ul', { className: 'grid gap-2' }, savedMetas.map((meta) => element('li', { className: 'surface min-w-0 p-3' }, [
      element('div', { className: 'flex flex-wrap items-baseline gap-x-2 gap-y-1' }, [
        element('span', { className: 'min-w-0 break-words font-jp font-semibold text-ink', text: meta.display }),
        ...(meta.reading ? [element('span', { className: 'break-words font-jp text-xs text-muted', text: meta.reading })] : []),
        element('span', { className: 'status-pill', text: meta.type })
      ]),
      ...(meta.meaning ? [element('p', { className: 'mt-1 min-w-0 break-words text-sm text-muted', text: meta.meaning })] : [])
    ]))));
  }

  // End-of-story card (frame 05): Finish story completes through the same
  // progress endpoint the reader already used. Only destinations that
  // resolve are offered — there is no lessons target in the API.
  const finishButton = element('button', { className: 'button-primary min-h-9 px-4 py-2 text-xs', attrs: { type: 'button', ...(completed ? { disabled: '' } : {}) } }, [
    icon('check', { size: 16 }),
    element('span', { text: completed ? 'Finished' : 'Finish story' })
  ]);
  finishButton.addEventListener('click', () => withPendingAction(finishButton, async () => {
    try {
      await updateReadingProgress(textId, { position: Math.max(1, total), completed: true, timeSpentSeconds: accumulatedSeconds() });
      completed = true;
      finishButton.querySelector('span').textContent = 'Finished';
      finishButton.disabled = true;
      updateStoryProgressUI();
      showToast('Story finished. Choose your next step below.');
    } catch (error) {
      showToast(error?.message || 'Unable to save progress.', 'error');
    }
  }));
  const reviewSavedButton = element('button', { className: 'button-secondary min-h-9 px-4 py-2 text-xs', text: 'Review saved words', attrs: { type: 'button' } });
  reviewSavedButton.addEventListener('click', openReviewTarget);
  const anotherStoryButton = element('button', { className: 'button-secondary min-h-9 px-4 py-2 text-xs', text: 'Read another story', attrs: { type: 'button' } });
  anotherStoryButton.addEventListener('click', () => { window.location.hash = 'reading'; });
  const endCard = element('section', { className: 'surface mt-4 min-w-0 p-5 sm:p-6', attrs: { 'aria-label': 'End of story' } }, [
    element('p', { className: 'text-xs font-semibold uppercase tracking-[0.16em] text-vermilion', text: 'You reached the end' }),
    element('p', { className: 'mt-2 font-display text-lg font-semibold text-ink', text: 'Finish this story and choose your next step.' }),
    element('div', { className: 'mt-4 grid gap-2 sm:justify-items-start' }, [finishButton, reviewSavedButton, anotherStoryButton])
  ]);
  endCard.hidden = true;

  function updateStoryProgressUI() {
    const seenCount = seen.size;
    const percent = paragraphCount ? Math.min(100, Math.round((seenCount / paragraphCount) * 100)) : 100;
    countLine.textContent = paragraphCount ? `${seenCount} / ${paragraphCount} paragraphs` : 'No paragraphs yet';
    percentLine.textContent = `${percent}%`;
    progressGroup.setAttribute('aria-valuenow', String(percent));
    const fill = progressGroup.querySelector('[data-progress-fill]');
    if (fill) fill.style.width = `${percent}%`;
    const done = paragraphCount > 0 && seenCount >= paragraphCount;
    if (paragraphCount === 0) statusLine.textContent = 'Nothing to read yet';
    else if (done) statusLine.textContent = 'End reached · ready to finish';
    else statusLine.textContent = `${seenCount} of ${paragraphCount} paragraphs read`;
    endCard.hidden = !done;
  }

  function markSeenFromViewport() {
    const edge = (window.innerHeight || 1) * 0.85;
    for (let index = 0; index < blockWrappers.length; index += 1) {
      const rect = blockWrappers[index].getBoundingClientRect();
      if (rect.top < edge && rect.bottom > 0) seen.add(index);
    }
  }

  // Progress = furthest-read paragraph. PUT replaces the progress state, so
  // every save sends position AND accumulated time together; the stored
  // position only ever advances server-side, never regresses.
  function saveStoryProgress() {
    if (completed || !storyBlocks.isConnected) {
      if (!storyBlocks.isConnected && cleanupReader) {
        cleanupReader();
        cleanupReader = null;
      }
      return;
    }
    const now = Date.now();
    if (now - lastSaveAt < 30000) return;
    lastSaveAt = now;
    let furthest = -1;
    seen.forEach((index) => { if (index > furthest) furthest = index; });
    const position = furthest >= 0 ? Math.max(1, Math.min(total, paragraphs[furthest].end)) : 1;
    updateReadingProgress(textId, { position, timeSpentSeconds: accumulatedSeconds(), completed: false }).catch(() => { /* best-effort autosave */ });
  }

  const onScroll = () => {
    markSeenFromViewport();
    updateStoryProgressUI();
    saveStoryProgress();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  cleanupReader = () => window.removeEventListener('scroll', onScroll);

  container.replaceChildren(element('section', { className: 'mx-auto w-full max-w-3xl min-w-0' }, [
    element('a', { className: 'text-sm font-medium text-muted underline-offset-4 hover:text-ink hover:underline', text: '← Back to library', attrs: { href: '#reading' } }),
    element('header', { className: 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-2' }, [
      element('h1', { className: 'min-w-0 flex-1 break-words text-xl font-semibold text-ink', text: data.title }),
      levelPill(data.level) || element('span', { className: 'text-xs text-muted', text: data.sourceType || 'user' })
    ]),
    headerCard,
    translationsNote,
    ...(data.truncated === true ? [element('p', { className: 'mt-2 text-xs leading-5 text-muted', text: 'This long text carries tap-lookup for its first part only; later blocks show plain text.' })] : []),
    storyCard,
    savedCard,
    endCard
  ]));

  storyBlocks.style.fontSize = `${fontSlider.value}px`;
  paintFuriganaButton();
  paintTranslationChrome();
  loadSpeechRate();
  setMode('study');
  if (completed) {
    for (let index = 0; index < paragraphCount; index += 1) seen.add(index);
  }
  renderSavedList();
  updateStoryProgressUI();
  window.requestAnimationFrame(() => {
    markSeenFromViewport();
    updateStoryProgressUI();
  });
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
