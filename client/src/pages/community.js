// Decks hub: the single home for everything decks (feed-style). Publishing,
// sharing, importing, browsing and collections live here — entity tabs carry
// no deck actions. Public identity lives in Settings → Profile.
import { apiRequest } from '../api';
import { element, emptyState, openDialog, confirmDialog, pageHeader, showToast, withPendingAction } from '../ui';
import { icon } from '../icons';
import { speakJapanese } from '../speech.js';
import { loadStrokePaths, STROKE_SVG_NS, STROKE_SVG_VIEWBOX } from '../strokeOrder.js';
import { mountKanjiWriting } from '../kanjiWriting.js';

function smallButton(label, ariaLabel) {
  return element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: label, attrs: { type: 'button', 'aria-label': ariaLabel || label } });
}

// openDialog lays content in a 2-column grid on sm+: custom bodies must
// arrive as ONE full-width node or the grid tears them apart. grid-cols-1
// pins the inner track to minmax(0,1fr) so wide rows can never push the
// panel past the viewport.
function dialogStack(nodes) {
  return element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-3 sm:col-span-2' }, nodes);
}

function speechPieces() {
  const hasWindow = typeof window !== 'undefined';
  return {
    synthesis: hasWindow ? window.speechSynthesis : null,
    Utterance: hasWindow ? window.SpeechSynthesisUtterance : null
  };
}

// Sequential TTS queue with a stop flag: each utterance ends into the next.
// A fresh play flushes the previous queue first (no overlaps).
const player = { stopped: true, playing: false };
function stopQueue() {
  player.stopped = true;
  player.playing = false;
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
  } catch { /* stop is best-effort */ }
}
function playQueue(texts, onProgress) {
  stopQueue();
  const queue = (Array.isArray(texts) ? texts : []).map((text) => String(text || '').trim()).filter(Boolean);
  if (!queue.length) { showToast('Nothing to play.', 'error'); return; }
  player.stopped = false;
  player.playing = true;
  const next = (index) => {
    if (player.stopped || index >= queue.length) {
      player.playing = false;
      if (typeof onProgress === 'function') onProgress(-1);
      return;
    }
    if (typeof onProgress === 'function') onProgress(index, queue.length, queue[index]);
    const verdict = speakJapanese(queue[index], {
      ...speechPieces(),
      onEnd: () => next(index + 1)
    });
    if (!verdict.ok) {
      player.playing = false;
      if (typeof onProgress === 'function') onProgress(-1);
      showToast(verdict.message || 'Audio playback is unavailable.', 'error');
    }
  };
  next(0);
}

function displayOf(entry) {
  return entry.word || entry.character_kanji || entry.grammar_point || 'item';
}
function readingOf(entry) {
  return entry.reading || entry.onyomi || entry.kunyomi || null;
}

// Rich item detail as an inline view (never a nested dialog: openDialog is
// single-instance and a second dialog would destroy the list beneath).
function itemDetailView(entry, entityType) {
  const display = displayOf(entry);
  const reading = readingOf(entry);
  const body = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-3' });
  const play = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': `Play ${display} aloud` } }, [icon('volume', { size: 20 })]);
  play.addEventListener('click', () => playQueue([display], () => {}));
  body.append(
    element('p', { className: 'min-w-0 wrap-anywhere break-words font-jp text-2xl font-semibold text-ink', text: display, attrs: { lang: 'ja' } }),
    ...(reading ? [element('p', { className: 'min-w-0 wrap-anywhere break-words text-sm text-muted', text: reading })] : []),
    ...(entry.meaning ? [element('p', { className: 'min-w-0 wrap-anywhere break-words text-base leading-7 text-ink', text: entry.meaning })] : []),
    play
  );
  const extras = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-3' });
  body.appendChild(extras);
  const itemId = Number(entry.id);
  if (entityType === 'kanji' && /^\p{Script=Han}$/u.test(display)) {
    loadStrokePaths(display).then((paths) => {
      const svg = document.createElementNS(STROKE_SVG_NS, 'svg');
      svg.setAttribute('viewBox', STROKE_SVG_VIEWBOX);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `Stroke order for ${display}: ${paths.length} strokes`);
      svg.style.cssText = 'width:120px;height:120px;opacity:0.8;';
      for (const d of paths) {
        const path = document.createElementNS(STROKE_SVG_NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '4.5');
        path.setAttribute('stroke-linecap', 'round');
        extras.appendChild(svg);
        svg.appendChild(path);
      }
      const practice = smallButton('Practice strokes', `Practice strokes of ${display}`);
      practice.addEventListener('click', () => {
        const holder = element('div', { className: 'grid gap-3' });
        const closePractice = openDialog({
          title: `Practice strokes: ${display}`,
          description: 'Trace in stroke order. Practice only — nothing is graded.',
          content: [holder],
          submitLabel: 'Done',
          onSubmit: async (form, closeDialog) => { closeDialog(); }
        });
        mountKanjiWriting(holder, { character: display, onDone: closePractice });
      });
      extras.append(practice);
    }).catch(() => {});
  } else if (Number.isInteger(itemId) && itemId > 0 && (entityType === 'vocabulary' || entityType === 'grammar')) {
    const endpoint = entityType === 'vocabulary' ? `/api/vocabulary/${itemId}` : `/api/grammar/${itemId}`;
    apiRequest(endpoint).then((detail) => {
      const examples = Array.isArray(detail?.examples) ? detail.examples : [];
      if (!examples.length) return;
      extras.append(element('p', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: 'Usage examples' }));
      extras.append(element('ul', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2', attrs: { role: 'list' } }, examples.slice(0, 3).map((example) => element('li', { className: 'min-w-0 max-w-full wrap-anywhere break-words rounded-md bg-paper p-2 text-sm' }, [
        element('p', { className: 'font-jp text-ink', text: example.sentence, attrs: { lang: 'ja' } }),
        ...(example.translation ? [element('p', { className: 'mt-1 text-xs text-muted', text: example.translation })] : [])
      ]))));
    }).catch(() => {});
  }
  return body;
}

// Type pill renders FROM DATA: whatever entityType the backend sent
// (vocabulary, kanji or grammar today; unknown values such as 'reading'
// render as-is). No list of known types lives here.
function typePill(value) {
  const label = String(value || '').trim() || 'deck';
  return element('span', { className: 'status-pill max-w-full shrink-0 wrap-anywhere break-words text-xs', text: label });
}

function authorNameOf(deck) {
  if (!deck) return null;
  if (deck.ownerDisplay) return String(deck.ownerDisplay);
  if (deck.ownerUsername) return `@${deck.ownerUsername}`;
  return null;
}

// Compact list row for the feed and the "Ver más" dialog: title plus
// "by {author}" only. The whole row is one real <button> (keyboard
// focusable, visible focus from the global button ring). Pills,
// descriptions, counts and stars live in the detail dialog only, so rows
// can never push the list track wider than the dialog.
function deckRowButton(deck, onOpen) {
  const titleText = String(deck?.title || 'Deck');
  const author = authorNameOf(deck);
  const label = author ? `Open ${titleText} by ${author}` : `Open ${titleText}`;
  const row = element('button', {
    className: 'flex min-w-0 w-full max-w-full items-center gap-3 overflow-hidden rounded-xl border border-stone bg-paper p-3 text-left wrap-anywhere',
    attrs: { type: 'button', 'aria-label': label }
  }, [
    element('span', { className: 'flex min-w-0 flex-1 flex-col gap-0.5' }, [
      element('span', { className: 'min-w-0 wrap-anywhere break-words text-sm font-semibold text-ink', text: titleText }),
      ...(author ? [element('span', { className: 'min-w-0 wrap-anywhere break-words text-xs text-muted', text: `by ${author}` })] : [])
    ])
  ]);
  row.addEventListener('click', onOpen);
  return row;
}

// Single deck detail dialog: header metadata (author, description, type
// pill from data, inline likes) plus the collected items with play-all,
// drill-down, examples and strokes. Unknown entity types render the pill
// as-is and the items section stays fail-open through the existing
// toast-on-error path (no per-type detail backend is built here).
function itemsDialog(deckId, title, entityType, deckRef = null) {
  apiRequest(`/api/decks/${deckId}`)
    .then((detail) => {
      const items = Array.isArray(detail.items) ? detail.items : [];
      const effectiveType = detail.entityType || entityType || deckRef?.entityType || 'deck';
      const author = authorNameOf(detail) || authorNameOf(deckRef);
      const description = detail.description || deckRef?.description || null;
      const progress = element('p', { className: 'min-w-0 wrap-anywhere break-words text-xs text-muted', attrs: { 'aria-live': 'polite' } });
      const playAll = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': 'Play every item aloud in order' } }, [icon('volume', { size: 20 })]);
      playAll.addEventListener('click', () => {
        playQueue(items.map((entry) => displayOf(entry)), (index, total, text) => {
          progress.textContent = index < 0 ? '' : `Playing ${index + 1} of ${total}: ${text}`;
        });
      });
      const stop = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': 'Stop playback' } }, [icon('stop', { size: 20 })]);
      stop.addEventListener('click', () => {
        stopQueue();
        progress.textContent = '';
      });
      const starEnd = element('div', { className: 'ml-auto shrink-0' }, [starWidget({
        id: Number(deckId),
        title: detail.title || title || 'Deck',
        followers: detail.followers ?? deckRef?.followers ?? 0,
        viewerFollowing: detail.viewerFollowing ?? deckRef?.viewerFollowing ?? false
      })]);
      const view = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2' });
      const renderList = () => {
        view.replaceChildren(
          element('ul', { className: 'grid max-h-56 w-full min-w-0 max-w-full grid-cols-1 gap-1 overflow-x-hidden overflow-y-auto text-sm text-ink', attrs: { role: 'list' } }, items.map((entry) => {
            const open = smallButton(displayOf(entry), `Details for ${displayOf(entry)}`);
            open.classList.add('max-w-full', 'wrap-anywhere', 'break-words');
            open.addEventListener('click', () => {
              const back = smallButton('Back to items', 'Back to items');
              back.addEventListener('click', renderList);
              view.replaceChildren(back, itemDetailView(entry, effectiveType));
            });
            return element('li', { className: 'min-w-0 max-w-full' }, [open]);
          }))
        );
      };
      renderList();
      const header = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2' }, [
        element('div', { className: 'flex min-w-0 max-w-full flex-wrap items-center gap-2' }, [
          typePill(effectiveType),
          element('span', { className: 'min-w-0 wrap-anywhere break-words text-xs text-muted', text: `${items.length} items` })
        ]),
        ...(author ? [element('p', { className: 'min-w-0 wrap-anywhere break-words text-sm text-muted', text: `by ${author}` })] : []),
        ...(description ? [element('p', { className: 'min-w-0 wrap-anywhere break-words text-sm leading-6 text-ink', text: description })] : [])
      ]);
      openDialog({
        title: detail.title || title || 'Deck',
        description: `${items.length} items. Select one for details, examples and strokes.`,
        content: [dialogStack([
          header,
          element('div', { className: 'flex min-w-0 max-w-full flex-row flex-nowrap items-center gap-2' }, [playAll, stop, starEnd]),
          progress,
          view
        ])],
        submitLabel: 'Close',
        onSubmit: async (form, close) => { stopQueue(); close(); }
      });
    })
    .catch((error) => showToast(error?.message || 'Unable to load the deck.', 'error'));
}

function section(title, description) {
  const body = element('div', { className: 'grid gap-3' });
  const wrap = element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': title } }, [
    element('h2', { className: 'font-semibold text-ink', text: title }),
    element('p', { className: 'mt-1 text-sm text-muted', text: description }),
    body
  ]);
  return { wrap, body };
}

// Full card stays for owner-managed contexts (My decks, Collections) where
// selection, analytics, suggestions and member controls need the room.
// Feed and Ver-más lists use deckRowButton instead.
function deckCard(deck, actions = []) {
  const pill = typePill(deck.entityType);
  const creatorName = authorNameOf(deck);
  const creator = creatorName
    ? element('p', { className: 'mt-1 min-w-0 wrap-anywhere break-words text-xs text-muted', text: `by ${creatorName}` })
    : null;
  return element('article', { className: 'relative min-w-0 w-full max-w-full overflow-hidden wrap-anywhere rounded-xl border border-stone bg-paper p-4' }, [
    element('div', { className: 'flex min-w-0 max-w-full items-start justify-between gap-3' }, [
      element('h3', { className: 'min-w-0 flex-1 wrap-anywhere break-words text-lg font-semibold text-ink', text: deck.title }),
      pill
    ]),
    ...(creator ? [creator] : []),
    ...(deck.description ? [element('p', { className: 'mt-1 min-w-0 wrap-anywhere break-words text-sm leading-6 text-muted', text: deck.description })] : []),
    element('p', { className: 'mt-2 min-w-0 wrap-anywhere break-words text-xs font-medium text-muted', text: `${deck.itemCount ?? '?'} items` }),
    ...(actions.length ? [element('div', { className: 'mt-3 flex min-w-0 max-w-full flex-row flex-wrap items-center gap-2' }, actions)] : [])
  ]);
}

// Inline like control. It renders only inside the deck detail dialog, so it
// stays in normal flow (no absolute positioning, no card padding hack).
function starWidget(deck) {
  let liked = Boolean(deck.viewerFollowing);
  let count = Number(deck.followers || 0);
  const countNode = element('p', { className: 'text-xs font-semibold text-muted', text: String(count), attrs: { 'aria-label': `${count} likes` } });
  const star = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': `Like ${deck.title}`, 'aria-pressed': String(liked) } }, [icon('star', { size: 20 })]);
  const paint = () => {
    star.setAttribute('aria-pressed', String(liked));
    star.classList.toggle('text-amber-500', liked);
    const svg = star.querySelector('svg');
    if (svg) {
      if (liked) svg.setAttribute('fill', 'currentColor');
      else svg.removeAttribute('fill');
    }
    countNode.textContent = String(count);
    countNode.setAttribute('aria-label', `${count} likes`);
  };
  paint();
  star.addEventListener('click', () => {
    withPendingAction(star, async () => {
      if (liked) {
        const result = await apiRequest(`/api/decks/${deck.id}/follow`, { method: 'DELETE' });
        liked = false;
        count = Number(result.followers || 0);
      } else {
        const result = await apiRequest(`/api/decks/${deck.id}/follow`, { method: 'POST' });
        liked = true;
        count = Number(result.followers || 0);
      }
      paint();
    }).catch((error) => showToast(error?.message || 'Unable to like the deck.', 'error'));
  });
  const wrap = element('div', { className: 'flex min-w-0 shrink-0 flex-row items-center gap-1.5' }, [star, countNode]);
  return wrap;
}

const PICKER_TYPES = [
  { key: 'vocabulary', label: 'Vocabulary', endpoint: '/api/vocabulary/options', idKey: 'id_vocabulary', titleOf: (row) => row.word, subOf: (row) => [row.reading, row.meaning].filter(Boolean).join(' · ') },
  { key: 'kanji', label: 'Kanji', endpoint: '/api/kanji/options', idKey: 'id_kanji', titleOf: (row) => row.character_kanji, subOf: (row) => [row.meaning].filter(Boolean).join(' · ') },
  { key: 'grammar', label: 'Grammar', endpoint: '/api/grammar/options', idKey: 'id_grammar', titleOf: (row) => row.grammar_point, subOf: (row) => [row.meaning].filter(Boolean).join(' · ') }
];

export async function renderCommunity(container) {
  container.replaceChildren(pageHeader({
    eyebrow: 'Social',
    title: 'Decks',
    description: 'Discover, publish, share and collect decks and reading texts. Everything social lives here.'
  }));
  const feed = section('Feed', 'Public decks. Filter, listen, open details, follow.');
  const publish = section('Publish', 'Pick items from your collection and publish a deck — or pick a text tab to publish reading texts.');
  const share = section('Share & import', 'Signed codes: share your own items, import codes as new rows.');
  const mine = section('My decks', 'Your publications with suggestions and analytics.');
  const collections = section('Collections', 'Group decks into playlists and share them as one code.');
  container.append(feed.wrap, publish.wrap, share.wrap, mine.wrap, collections.wrap);

  // ---- Feed
  const filterRow = element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' });
  const typeFilter = element('select', { className: 'field-control sm:max-w-44', attrs: { 'aria-label': 'Filter by type' } }, [
    element('option', { text: 'All types', attrs: { value: '' } }),
    ...PICKER_TYPES.map((type) => element('option', { text: type.label, attrs: { value: type.key } }))
  ]);
  const textFilter = element('input', { className: 'field-control', attrs: { type: 'search', 'aria-label': 'Filter decks by text', placeholder: 'Filter by title…' } });
  filterRow.append(typeFilter, textFilter);
  const feedList = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-4' });
  feed.body.append(filterRow, feedList);
  let feedDecks = [];
  const FEED_VISIBLE = 3;
  const filterFeedDecks = (type, query) => feedDecks.filter((deck) =>
    (!type || deck.entityType === type) &&
    (!query || `${deck.title} ${deck.description || ''}`.toLowerCase().includes(query)));
  const buildFeedRow = (deck) => deckRowButton(deck, () => itemsDialog(deck.id, deck.title, deck.entityType, deck));
  const renderFeed = () => {
    const query = String(textFilter.value || '').trim().toLowerCase();
    const visible = filterFeedDecks(typeFilter.value, query);
    if (!visible.length) {
      feedList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No decks match. Publish the first one below.' }));
      return;
    }
    const shown = visible.slice(0, FEED_VISIBLE);
    feedList.replaceChildren(element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2 overflow-x-hidden' }, shown.map((deck) => buildFeedRow(deck))));
    if (visible.length > FEED_VISIBLE) {
      const more = smallButton(`Ver más (${visible.length - FEED_VISIBLE} more)`, 'View all matching decks');
      more.addEventListener('click', () => openAllDecksDialog(typeFilter.value, query));
      feedList.append(element('div', { className: 'mt-1 flex justify-center' }, [more]));
    }
  };
  const openAllDecksDialog = (initialType, initialQuery) => {
    const dialogType = element('select', { className: 'field-control sm:max-w-44', attrs: { 'aria-label': 'Filter by type' } }, [
      element('option', { text: 'All types', attrs: { value: '' } }),
      ...PICKER_TYPES.map((type) => element('option', { text: type.label, attrs: { value: type.key } }))
    ]);
    dialogType.value = initialType || '';
    const dialogSearch = element('input', { className: 'field-control', attrs: { type: 'search', 'aria-label': 'Filter decks by text', placeholder: 'Filter by title…', value: initialQuery || '' } });
    const dialogList = element('div', { className: 'grid max-h-[50vh] w-full min-w-0 max-w-full grid-cols-1 gap-2 overflow-x-hidden overflow-y-auto' });
    const renderDialogList = () => {
      const query = String(dialogSearch.value || '').trim().toLowerCase();
      const visible = filterFeedDecks(dialogType.value, query);
      dialogList.replaceChildren(...(visible.length
        ? visible.map((deck) => deckRowButton(deck, () => itemsDialog(deck.id, deck.title, deck.entityType, deck)))
        : [element('p', { className: 'text-sm text-muted', text: 'No decks match.' })]));
    };
    dialogType.addEventListener('change', renderDialogList);
    dialogSearch.addEventListener('input', renderDialogList);
    renderDialogList();
    openDialog({
      title: 'All public decks',
      description: 'Filter by title and type, same as the feed.',
      content: [dialogStack([
        element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' }, [dialogType, dialogSearch]),
        dialogList
      ])],
      submitLabel: 'Close',
      onSubmit: async (form, close) => { close(); }
    });
  };
  typeFilter.addEventListener('change', renderFeed);
  textFilter.addEventListener('input', renderFeed);
  feedList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading public decks…' }));
  try {
    const data = await apiRequest('/api/decks?limit=30');
    feedDecks = Array.isArray(data?.items) ? data.items : [];
    renderFeed();
  } catch {
    feedList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Public decks are unavailable.' }));
  }

  // ---- Community reading texts (Reading <-> Community)
  const texts = section('Texts', 'Community reading texts. Open a preview, import copies into your reader library.');
  container.insertBefore(texts.wrap, publish.wrap);
  const textsSearch = element('input', { className: 'field-control', attrs: { type: 'search', 'aria-label': 'Filter texts by title', placeholder: 'Filter by title…' } });
  const textsList = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2 overflow-x-hidden' });
  texts.body.append(textsSearch, textsList);
  let feedTexts = [];
  const renderTexts = () => {
    const query = String(textsSearch.value || '').trim().toLowerCase();
    const visible = feedTexts.filter((pub) =>
      !query || `${pub.title} ${pub.description || ''}`.toLowerCase().includes(query));
    if (!visible.length) {
      textsList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'No community texts yet. Publish one from the reader.' }));
      return;
    }
    textsList.replaceChildren(...visible.slice(0, 30).map((pub) => deckRowButton(pub, () => textDetailDialog(pub))));
  };
  textsSearch.addEventListener('input', renderTexts);
  const textDetailDialog = (pub) => {
    apiRequest(`/api/reading/publications/${pub.id}`)
      .then((detail) => {
        const points = Array.from(String(detail.text || ''));
        const preview = points.length > 1500 ? `${points.slice(0, 1500).join('')}…` : points.join('');
        const meta = [
          detail.level || null,
          `${points.length} chars`,
          detail.translations && Object.keys(detail.translations).length ? 'with translations' : null
        ].filter(Boolean).join(' · ');
        const importButton = smallButton('Import text', `Import ${detail.title} into your library`);
        importButton.addEventListener('click', () => {
          withPendingAction(importButton, async () => {
            const result = await apiRequest(`/api/reading/publications/${detail.id}/import`, { method: 'POST' });
            return result;
          }).then((result) => {
            if (result && result.id) {
              closeDetail();
              window.location.hash = `#reading?id=${result.id}`;
            }
          }).catch((error) => showToast(error?.message || 'Unable to import.', 'error'));
        });
        const actions = [importButton];
        if (detail.mine) {
          const deleteButton = smallButton('Delete', `Delete ${detail.title} from Community`);
          deleteButton.addEventListener('click', () => {
            confirmDialog({
              title: `Delete ${detail.title}?`,
              description: 'Removes it from Community. Imported copies stay in their libraries.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                try {
                  await apiRequest(`/api/reading/publications/${detail.id}`, { method: 'DELETE' });
                  closeDetail();
                  showToast('Publication deleted.');
                  loadTexts();
                } catch (error) {
                  showToast(error?.message || 'Unable to delete.', 'error');
                }
              }
            });
          });
          actions.push(deleteButton);
        }
        const closeDetail = openDialog({
          title: detail.title,
          description: `${detail.ownerDisplay || (detail.ownerUsername ? `@${detail.ownerUsername}` : 'Community')} · ${meta}`,
          content: [dialogStack([
            ...(detail.description ? [element('p', { className: 'min-w-0 break-words text-sm leading-6 text-ink', text: detail.description })] : []),
            element('p', { className: 'max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-jp text-sm leading-7 text-ink', text: preview, attrs: { lang: 'ja' } }),
            element('div', { className: 'flex flex-wrap gap-2' }, actions)
          ])],
          submitLabel: 'Close',
          onSubmit: async (form, close) => { close(); }
        });
      })
      .catch((error) => showToast(error?.message || 'Unable to load the text.', 'error'));
  };
  const loadTexts = async () => {
    textsList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading community texts…' }));
    try {
      const data = await apiRequest('/api/reading/publications?limit=30');
      feedTexts = Array.isArray(data?.items) ? data.items : [];
      renderTexts();
    } catch {
      textsList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Community texts are unavailable.' }));
    }
  };
  loadTexts();

  // ---- Publish composer
  const tabs = element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center', attrs: { role: 'group', 'aria-label': 'Pick item type' } });
  let pickerType = PICKER_TYPES[0];
  const search = element('input', { className: 'field-control', attrs: { type: 'search', 'aria-label': 'Search your collection', placeholder: 'Search your collection…' } });
  const jlptFilter = element('select', { className: 'field-control sm:max-w-36', attrs: { 'aria-label': 'Filter picker by JLPT level' } }, [
    element('option', { text: 'Any level', attrs: { value: '' } }),
    ...['N5', 'N4', 'N3', 'N2', 'N1'].map((level) => element('option', { text: level, attrs: { value: level } }))
  ]);
  const results = element('div', { className: 'grid gap-1.5' });
  const tray = element('div', { className: 'flex flex-wrap gap-1.5', attrs: { 'aria-live': 'polite' } });
  const titleInput = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'Deck title', placeholder: 'Deck title', maxLength: '120' } });
  const descriptionInput = element('textarea', { className: 'field-control', attrs: { 'aria-label': 'Deck description', placeholder: 'Description (optional)', maxLength: '500' } });
  const selected = new Map();
  const syncTray = () => {
    tray.replaceChildren(...[...selected.values()].map(({ label, remove }) => element('span', { className: 'status-pill text-xs' }, [
      element('span', { text: label }),
      (() => {
        const clear = element('button', { className: 'ml-1 font-bold', text: '×', attrs: { type: 'button', 'aria-label': `Remove ${label}` } });
        clear.addEventListener('click', remove);
        return clear;
      })()
    ])));
  };
  const runSearch = async () => {
    if (textsMode) { renderTextsPicker(); return; }
    const query = String(search.value || '').trim();
    results.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Searching…' }));
    try {
      const jlpt = jlptFilter.value ? `&jlpt=${encodeURIComponent(jlptFilter.value)}` : '';
      const data = await apiRequest(`${pickerType.endpoint}?search=${encodeURIComponent(query)}&limit=30${jlpt}`);
      const rows = Array.isArray(data?.items) ? data.items : [];
      if (!rows.length) {
        results.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Nothing found.' }));
        return;
      }
      results.replaceChildren(element('div', { className: 'grid max-h-56 gap-1.5 overflow-y-auto' }, rows.map((row) => {
        const id = row[pickerType.idKey];
        const label = pickerType.titleOf(row);
        const box = element('input', { attrs: { type: 'checkbox', 'aria-label': `Include ${label}` } });
        box.checked = selected.has(`${pickerType.key}:${id}`);
        box.addEventListener('change', () => {
          if (box.checked) selected.set(`${pickerType.key}:${id}`, { id, label, remove: () => { selected.delete(`${pickerType.key}:${id}`); syncTray(); } });
          else { selected.delete(`${pickerType.key}:${id}`); syncTray(); }
        });
        return element('label', { className: 'flex items-center gap-2 text-sm text-ink' }, [
          box,
          element('span', {}, [
            element('span', { className: 'font-medium', text: label }),
            element('span', { className: 'text-muted', text: ` — ${pickerType.subOf(row)}` })
          ])
        ]);
      })));
    } catch {
      results.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Search is unavailable.' }));
    }
  };
  let searchTimer = null;
  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  jlptFilter.addEventListener('change', runSearch);
  for (const type of PICKER_TYPES) {
    const tab = element('button', {
      className: `button-secondary min-h-9 px-3 py-1.5 text-sm${type.key === pickerType.key ? ' font-bold' : ''}`,
      text: type.label,
      attrs: { type: 'button', 'aria-pressed': String(type.key === pickerType.key) },
      dataset: { pickerKey: type.key }
    });
    tab.addEventListener('click', () => {
      pickerType = type;
      textsMode = false;
      jlptFilter.hidden = false;
      publishButton.textContent = 'Publish deck';
      publishButton.setAttribute('aria-label', 'Publish deck');
      selected.clear();
      syncTray();
      paintPickerTabs();
      runSearch();
    });
    tabs.appendChild(tab);
  }
  const paintPickerTabs = () => {
    [...tabs.children].forEach((node) => {
      const key = node.dataset ? node.dataset.pickerKey : null;
      const active = textsMode ? key === 'texts' : key === pickerType.key;
      node.setAttribute('aria-pressed', String(active));
      node.classList.toggle('font-bold', active);
    });
  };
  // Texts tab (Reading <-> Community): single-select one OWNED library text
  // (shared rows carry mine false and the server 404s them) and publish it
  // as a snapshot. Reuses search/title/description inputs; deck state stays
  // untouched while this mode is active.
  let textsMode = false;
  let libraryTexts = [];
  let libraryLoaded = false;
  let selectedTextId = null;
  const renderTextsPicker = () => {
    const query = String(search.value || '').trim().toLowerCase();
    const own = libraryTexts.filter((item) => item.mine === true);
    const visible = own.filter((item) => !query || String(item.title || '').toLowerCase().includes(query));
    if (!visible.length) {
      results.replaceChildren(element('p', { className: 'text-sm text-muted', text: libraryLoaded ? 'No own texts match. Create one from the reader.' : 'Loading your texts…' }));
      return;
    }
    results.replaceChildren(element('div', { className: 'grid max-h-56 gap-1.5 overflow-y-auto' }, visible.map((item) => {
      const radio = element('input', { attrs: { type: 'radio', name: 'publish-text-choice', value: String(item.id), 'aria-label': `Publish ${item.title}` } });
      radio.checked = selectedTextId === Number(item.id);
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        selectedTextId = Number(item.id);
        if (!String(titleInput.value || '').trim()) titleInput.value = item.title || '';
      });
      return element('label', { className: 'flex items-center gap-2 text-sm text-ink' }, [
        radio,
        element('span', {}, [
          element('span', { className: 'font-medium', text: item.title }),
          element('span', { className: 'text-muted', text: ` — ${Number(item.characterCount || 0)} chars${item.level ? ` · ${item.level}` : ''}` })
        ])
      ]);
    })));
  };
  const loadLibraryTexts = async () => {
    results.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading your texts…' }));
    try {
      const data = await apiRequest('/api/reading/library?limit=50');
      libraryTexts = Array.isArray(data?.items) ? data.items : [];
      libraryLoaded = true;
      renderTextsPicker();
    } catch {
      results.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Library is unavailable.' }));
    }
  };
  const textsTab = element('button', {
    className: 'button-secondary min-h-9 px-3 py-1.5 text-sm',
    text: 'Texts',
    attrs: { type: 'button', 'aria-pressed': 'false' },
    dataset: { pickerKey: 'texts' }
  });
  textsTab.addEventListener('click', () => {
    textsMode = true;
    selected.clear();
    syncTray();
    jlptFilter.hidden = true;
    publishButton.textContent = 'Publish text';
    publishButton.setAttribute('aria-label', 'Publish text');
    paintPickerTabs();
    if (!libraryLoaded) loadLibraryTexts();
    else renderTextsPicker();
  });
  tabs.appendChild(textsTab);
  const publishButton = smallButton('Publish deck', 'Publish deck');
  const publishSelectedText = () => {
    const title = String(titleInput.value || '').trim();
    const description = String(descriptionInput.value || '').trim();
    if (!selectedTextId) { showToast('Select a text first.', 'error'); return; }
    withPendingAction(publishButton, async () => {
      await apiRequest('/api/reading/publications', {
        method: 'POST',
        body: { textId: selectedTextId, ...(title ? { title } : {}), ...(description ? { description } : {}) }
      });
      showToast('Text published to Community.');
      selectedTextId = null;
      titleInput.value = '';
      descriptionInput.value = '';
      renderTextsPicker();
      loadTexts();
    }).catch((error) => showToast(error?.message || 'Unable to publish the text.', 'error'));
  };
  publishButton.addEventListener('click', () => {
    if (textsMode) { publishSelectedText(); return; }
    const ids = [...selected.values()].map(({ id }) => id);
    const title = String(titleInput.value || '').trim();
    if (!ids.length) { showToast('Select at least one item.', 'error'); return; }
    if (!title) { showToast('Give the deck a title.', 'error'); return; }
    withPendingAction(publishButton, async () => {
      const deck = await apiRequest('/api/decks', { method: 'POST', body: { entityType: pickerType.key, ids, title, description: descriptionInput.value } });
      showToast(`Deck published (${deck.itemCount} items).`);
      selected.clear();
      syncTray();
      titleInput.value = '';
      descriptionInput.value = '';
    }).catch((error) => showToast(error?.message || 'Unable to publish the deck.', 'error'));
  });
  publish.body.append(tabs, element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' }, [search, jlptFilter]), results, tray, titleInput, descriptionInput, publishButton);
  syncTray();
  runSearch();

  // ---- Share & import (moved here from entity tabs)
  const codeInput = element('textarea', { className: 'field-control font-mono text-xs', attrs: { rows: '3', 'aria-label': 'Paste share code', placeholder: 'Paste a share code to preview it…' } });
  const importPreview = element('div', { className: 'grid gap-2' });
  let pendingCode = '';
  const previewImport = smallButton('Preview', 'Preview share code');
  previewImport.addEventListener('click', () => {
    const code = String(codeInput.value || '').trim();
    if (!code) { showToast('Paste a share code first.', 'error'); return; }
    withPendingAction(previewImport, async () => {
      const deck = await apiRequest('/api/share/deck/preview', { method: 'POST', body: { shareCode: code } });
      pendingCode = code;
      const items = Array.isArray(deck.items) ? deck.items : [];
      const boxes = items.map((entry, index) => {
        const box = element('input', { attrs: { type: 'checkbox', 'aria-label': `Import ${entry.display || 'item'}` } });
        box.checked = true;
        return { index, box };
      });
      const count = element('p', { className: 'text-sm font-semibold text-ink', attrs: { 'aria-live': 'polite' } });
      const syncImportCount = () => {
        count.textContent = `${boxes.filter(({ box }) => box.checked).length} of ${items.length} items selected`;
      };
      const selectAll = smallButton('Select all', 'Select all items');
      const clearSelection = smallButton('Clear selection', 'Clear selection');
      selectAll.addEventListener('click', () => { boxes.forEach(({ box }) => { box.checked = true; }); syncImportCount(); });
      clearSelection.addEventListener('click', () => { boxes.forEach(({ box }) => { box.checked = false; }); syncImportCount(); });
      const confirmImport = smallButton('Import selected', 'Import selected items');
      confirmImport.addEventListener('click', () => {
        const selectedItems = boxes.filter(({ box }) => box.checked).map(({ index }) => index);
        if (!selectedItems.length) { showToast('Select at least one item.', 'error'); return; }
        withPendingAction(confirmImport, async () => {
          const result = await apiRequest('/api/share/deck/import', { method: 'POST', body: { shareCode: pendingCode, selectedItems } });
          const imported = typeof result.imported === 'object'
            ? Object.values(result.imported).reduce((sum, n) => sum + Number(n || 0), 0)
            : Number(result.imported || 0);
          showToast(`Imported ${imported}, skipped ${Number(result.skipped || 0)}.`);
        }).catch((error) => showToast(error?.message || 'Unable to import the deck.', 'error'));
      });
      importPreview.replaceChildren(
        element('p', { className: 'text-sm font-semibold text-ink', text: `${deck.title || 'Shared deck'} · ${items.length} items` }),
        ...(deck.description ? [element('p', { className: 'text-sm text-muted', text: deck.description })] : []),
        element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' }, [selectAll, clearSelection]),
        count,
        element('div', { className: 'grid max-h-56 gap-1.5 overflow-y-auto' }, boxes.map(({ box }, position) => {
          const entry = items[position];
          box.addEventListener('change', syncImportCount);
          return element('label', { className: 'flex items-center gap-2 text-sm text-ink' }, [
            box,
            element('span', { text: `${entry.display || 'item'} — ${[entry.entityType, entry.reading, entry.meaning].filter(Boolean).join(' · ')}` })
          ]);
        })),
        confirmImport
      );
      syncImportCount();
    }).catch((error) => showToast(error?.message || 'Share code is invalid or expired.', 'error'));
  });
  share.body.append(
    element('p', { className: 'text-sm text-muted', text: 'Publish above for public decks, or paste a signed code to import items as new rows.' }),
    codeInput, previewImport, importPreview
  );

  // ---- My decks: click a card to open it; trash deletes. When two or more
  // cards are checked, any single trash deletes the whole selection.
  const selectedDecks = new Set();
  const loadMine = async () => {
    selectedDecks.clear();
    mine.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading your decks…' }));
    try {
      const data = await apiRequest('/api/decks?mine=true&limit=50');
      const decks = Array.isArray(data?.items) ? data.items : [];
      if (!decks.length) {
        mine.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Nothing published yet — use the composer above.' }));
        return;
      }
      const cards = [];
      for (const deck of decks) {
        const suggestionsBox = element('div', { className: 'grid gap-2' });
        const analyticsLine = element('p', { className: 'mt-1 text-xs text-muted', text: 'Loading analytics…' });
        const selectBox = element('input', { attrs: { type: 'checkbox', 'aria-label': `Select ${deck.title} for deletion` } });
        selectBox.addEventListener('click', (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        });
        selectBox.addEventListener('change', () => {
          if (selectBox.checked) selectedDecks.add(deck.id);
          else selectedDecks.delete(deck.id);
        });
        const remove = element('button', { className: 'icon-button icon-button--danger shrink-0', attrs: { type: 'button', 'aria-label': `Delete ${deck.title}` } }, [icon('trash', { size: 18 })]);
        remove.addEventListener('click', (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          const ids = selectedDecks.size > 0 ? [...selectedDecks] : [deck.id];
          confirmDialog({
            title: ids.length > 1 ? `Delete ${ids.length} decks?` : `Delete ${deck.title}?`,
            description: 'This permanently deletes the deck(s), their items, follows and suggestions. This cannot be undone.',
            onConfirm: async () => {
              for (const id of ids) {
                await apiRequest(`/api/decks/${id}`, { method: 'DELETE' });
              }
              showToast(ids.length > 1 ? 'Selected decks deleted.' : 'Deck deleted.');
              await loadMine();
            }
          });
        });
        const card = deckCard(deck, []);
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Open ${deck.title}`);
        card.classList.add('cursor-pointer');
        card.addEventListener('click', () => itemsDialog(deck.id, deck.title, deck.entityType, deck));
        card.addEventListener('keydown', (event) => {
          try {
            if (event.target && event.target !== card && typeof event.target.closest === 'function' && event.target.closest('button,input')) return;
          } catch { /* target guard is best-effort */ }
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); itemsDialog(deck.id, deck.title, deck.entityType, deck); }
        });
        card.append(
          element('div', { className: 'mt-2 flex items-center gap-2' }, [selectBox, remove]),
          analyticsLine,
          suggestionsBox
        );
        cards.push(card);
        apiRequest(`/api/decks/${deck.id}/analytics?period=30d`)
          .then((analytics) => {
            analyticsLine.textContent = `${analytics.overview.followers} followers · ${analytics.overview.items} items · suggestions ${analytics.overview.suggestions.pending} pending`;
          })
          .catch(() => { analyticsLine.textContent = 'Analytics unavailable.'; });
        apiRequest(`/api/decks/${deck.id}/suggestions`)
          .then((incoming) => {
            const items = Array.isArray(incoming?.items) ? incoming.items.filter((entry) => entry.status === 'pending') : [];
            if (!items.length) return;
            suggestionsBox.append(element('p', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: `Suggestions (${items.length})` }));
            for (const suggestion of items) {
              const changes = (Array.isArray(suggestion.changes) ? suggestion.changes : [])
                .map((change) => `${change.field}: ${change.oldValue} → ${change.newValue} (${change.reason})`).join(' · ');
              const accept = smallButton('Accept', `Accept suggestion ${suggestion.id}`);
              const reject = smallButton('Reject', `Reject suggestion ${suggestion.id}`);
              const decide = (decision) => {
                withPendingAction(accept, async () => {
                  await apiRequest(`/api/decks/suggestions/${suggestion.id}/decision`, { method: 'POST', body: { decision } });
                  showToast(`Suggestion ${decision}ed.`);
                  suggestionsBox.replaceChildren();
                }).catch((error) => showToast(error?.message || 'Unable to decide.', 'error'));
              };
              accept.addEventListener('click', (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                decide('accept');
              });
              reject.addEventListener('click', (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                decide('reject');
              });
              suggestionsBox.append(element('div', { className: 'rounded-md border border-stone p-2' }, [
                element('p', { className: 'text-sm text-ink', text: changes || 'No changes listed.' }),
                element('div', { className: 'mt-2 flex gap-2' }, [accept, reject])
              ]));
            }
          })
          .catch(() => {});
      }
      mine.body.replaceChildren(element('div', { className: 'grid gap-4 md:grid-cols-2' }, cards));
    } catch {
      mine.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Your decks are unavailable.' }));
    }
  };
  await loadMine();

  // ---- Collections
  collections.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Loading collections…' }));
  const refreshCollections = async () => {
    try {
      const data = await apiRequest('/api/collections?scope=mine&limit=20');
      const items = Array.isArray(data?.items) ? data.items : [];
      let ownDecks = [];
      try {
        const mineData = await apiRequest('/api/decks?mine=true&limit=50');
        ownDecks = Array.isArray(mineData?.items) ? mineData.items : [];
      } catch { /* member picker degrades to id input */ }
      const createTitle = element('input', { className: 'field-control', attrs: { type: 'text', 'aria-label': 'New collection title', placeholder: 'New collection title', maxLength: '120' } });
      const create = smallButton('Create collection', 'Create collection');
      create.addEventListener('click', () => {
        const title = String(createTitle.value || '').trim();
        if (!title) { showToast('Give the collection a title.', 'error'); return; }
        withPendingAction(create, async () => {
          await apiRequest('/api/collections', { method: 'POST', body: { title } });
          showToast('Collection created.');
          await refreshCollections();
        }).catch((error) => showToast(error?.message || 'Unable to create the collection.', 'error'));
      });
      const list = element('div', { className: 'grid gap-3' }, items.map((collection) => {
        const removeCollection = element('button', { className: 'icon-button icon-button--danger shrink-0', attrs: { type: 'button', 'aria-label': `Delete collection ${collection.title}` } }, [icon('trash', { size: 18 })]);
        removeCollection.addEventListener('click', () => {
          confirmDialog({
            title: `Delete collection ${collection.title}?`,
            description: 'This permanently deletes the collection (member decks stay untouched). This cannot be undone.',
            onConfirm: async () => {
              await apiRequest(`/api/collections/${collection.id}`, { method: 'DELETE' });
              showToast('Collection deleted.');
              await refreshCollections();
            }
          });
        });
        const membersBox = element('div', { className: 'grid gap-1.5' });
        const memberSelect = element('select', { className: 'field-control', attrs: { 'aria-label': `Add deck to ${collection.title}` } }, [
          element('option', { text: 'Pick one of your decks…', attrs: { value: '' } }),
          ...ownDecks.map((deck) => element('option', { text: `${deck.title} · ${deck.entityType}`, attrs: { value: String(deck.id) } }))
        ]);
        const addMember = smallButton('Add deck', `Add deck to ${collection.title}`);
        addMember.addEventListener('click', () => {
          const deckId = Number(memberSelect.value);
          if (!Number.isInteger(deckId) || deckId <= 0) { showToast('Pick one of your decks first.', 'error'); return; }
          withPendingAction(addMember, async () => {
            await apiRequest(`/api/collections/${collection.id}/decks`, { method: 'POST', body: { deckId } });
            showToast('Deck added.');
            await refreshCollectionMembers();
          }).catch((error) => showToast(error?.message || 'Unable to add the deck.', 'error'));
        });
        const refreshCollectionMembers = async () => {
          try {
            const detail = await apiRequest(`/api/collections/${collection.id}`);
            const members = Array.isArray(detail?.decks) ? detail.decks : [];
            if (!members.length) {
              membersBox.replaceChildren(element('p', { className: 'text-xs text-muted', text: 'No decks yet — add yours above.' }));
              return;
            }
            membersBox.replaceChildren(element('ul', { className: 'grid gap-1', attrs: { role: 'list' } }, members.map((member) => {
              const remove = smallButton('Remove', `Remove ${member.title} from ${collection.title}`);
              remove.addEventListener('click', () => {
                withPendingAction(remove, async () => {
                  await apiRequest(`/api/collections/${collection.id}/decks/${member.id}`, { method: 'DELETE' });
                  showToast('Deck removed.');
                  await refreshCollectionMembers();
                }).catch((error) => showToast(error?.message || 'Unable to remove the deck.', 'error'));
              });
              return element('li', { className: 'flex items-center justify-between gap-2 text-sm text-ink' }, [
                element('span', { text: `${member.title} · ${member.entityType}` }),
                remove
              ]);
            })));
          } catch {
            membersBox.replaceChildren(element('p', { className: 'text-xs text-muted', text: 'Members unavailable.' }));
          }
        };
        refreshCollectionMembers();
        const shareCollection = smallButton('Share', `Share collection ${collection.title}`);
        shareCollection.addEventListener('click', () => {
          apiRequest(`/api/collections/${collection.id}/share`, { method: 'POST' })
            .then((result) => {
              const output = element('textarea', { className: 'field-control font-mono text-xs', attrs: { readonly: '', rows: '3', 'aria-label': 'Collection share code' } });
              output.value = result.shareCode;
              openDialog({
                title: `Share ${collection.title}`,
                description: `Covers ${result.deckCount} decks. Importing copies every item.`,
                content: [output],
                submitLabel: 'Close',
                onSubmit: async (form, close) => { close(); }
              });
            })
            .catch((error) => showToast(error?.message || 'Unable to share the collection.', 'error'));
        });
        const card = deckCard({ title: collection.title, description: collection.description, entityType: 'collection', itemCount: `${collection.deckCount} decks`, followers: '' }, [shareCollection]);
        memberSelect.classList.add('min-w-0', 'flex-1');
        addMember.classList.add('shrink-0');
        card.append(
          membersBox,
          element('div', { className: 'mt-2 flex items-center gap-2' }, [memberSelect, addMember, removeCollection])
        );
        return card;
      }));
      collections.body.replaceChildren(
        element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' }, [createTitle, create]),
        list
      );
    } catch {
      collections.body.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Collections are unavailable.' }));
    }
  };
  await refreshCollections();
}
