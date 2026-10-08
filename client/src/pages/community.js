// Decks hub: the single home for everything decks (feed-style). Publishing,
// sharing, importing, browsing and collections live here — entity tabs carry
// no deck actions. Public identity lives in Settings → Profile.
import { apiRequest } from '../api';
import { element, emptyState, errorState, loadingState, openDialog, confirmDialog, pageHeader, showToast, withPendingAction } from '../ui';
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
// Rapid-press cooldown: overlapping play presses still restart the queue
// (last wins); only duplicate error toasts are suppressed silently.
// Stop stays explicit via stopQueue.
// Play affordances use the speaker/bocina glyph (icons.js volume, no emoji).
const player = { stopped: true, playing: false };
let lastDecksPlayAt = 0;
const DECKS_PLAY_COOLDOWN_MS = 600;
function stopQueue() {
  player.stopped = true;
  player.playing = false;
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
  } catch { /* stop is best-effort */ }
}
function playQueue(texts, onProgress) {
  let isRapidQueue = false;
  try {
    const now = Date.now();
    isRapidQueue = Boolean(lastDecksPlayAt) && (now - lastDecksPlayAt < DECKS_PLAY_COOLDOWN_MS);
    lastDecksPlayAt = now;
  } catch { /* cooldown tracking is best-effort */ }
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
      if (isRapidQueue) return;
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

// V6.1.2: Helpers for deck review flow (save-then-queue → review session)
// Mirrored from communityFeed.js to avoid cross-module dependency.
function deckItemDisplay(kind, entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (kind === 'kanji') return entry.character_kanji || entry.display || null;
  if (kind === 'grammar') return entry.grammar_point || entry.display || null;
  return entry.word || entry.display || entry.title || null;
}

function isUsableMeaning(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/[-–—―]$/.test(text) || /^[-–—―]/.test(text)) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (/[\r\n]/.test(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return true;
}

const SINGLE_HAN = /^\p{Script=Han}$/u;

function deckItemSaveable(kind, entry) {
  const display = deckItemDisplay(kind, entry);
  if (!display) return false;
  if (!isUsableMeaning(entry?.meaning)) return false;
  if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return false;
  return true;
}

function ownedIdFromSaveResponse(kind, data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = kind === 'kanji'
    ? [data.id_kanji, data.idKanji, data.id, data.insertId]
    : kind === 'grammar'
      ? [data.id_grammar, data.idGrammar, data.id, data.insertId]
      : [data.id_vocabulary, data.idVocabulary, data.id, data.insertId];
  for (const candidate of candidates) {
    const id = Number(candidate);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

async function findOwnedEntityId(kind, display) {
  const text = String(display || '').trim();
  if (!text) return null;
  const endpoint = kind === 'kanji' ? '/api/kanji/options' : kind === 'grammar' ? '/api/grammar/options' : '/api/vocabulary/options';
  try {
    const data = await apiRequest(`${endpoint}?search=${encodeURIComponent(text)}&limit=20`);
    const rows = Array.isArray(data?.items) ? data.items : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (kind === 'kanji' && String(row.character_kanji || '') === text) {
        const id = Number(row.id_kanji);
        if (Number.isInteger(id) && id > 0) return id;
      } else if (kind === 'grammar' && String(row.grammar_point || '') === text) {
        const id = Number(row.id_grammar);
        if (Number.isInteger(id) && id > 0) return id;
      } else if (kind !== 'kanji' && kind !== 'grammar' && String(row.word || '') === text) {
        const id = Number(row.id_vocabulary);
        if (Number.isInteger(id) && id > 0) return id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function saveDeckItemReturningId(kind, entry) {
  const display = deckItemDisplay(kind, entry);
  const meaning = String(entry?.meaning || '').trim();
  if (!display || !isUsableMeaning(meaning)) return null;
  if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return null;
  try {
    let created = null;
    if (kind === 'kanji') {
      created = await apiRequest('/api/kanji', { method: 'POST', body: { character_kanji: display, meaning } });
    } else if (kind === 'grammar') {
      created = await apiRequest('/api/grammar', { method: 'POST', body: { grammar_point: display, meaning } });
    } else {
      created = await apiRequest('/api/vocabulary', { method: 'POST', body: { word: display, ...(entry.reading ? { reading: entry.reading } : {}), meaning } });
    }
    const entityId = ownedIdFromSaveResponse(kind, created);
    return entityId ? { entityId, saved: true } : null;
  } catch (error) {
    if (error?.status === 409) {
      const existing = error?.data?.existingKanji;
      const existingId = Number(existing?.idKanji ?? existing?.id_kanji ?? existing?.id);
      if (Number.isInteger(existingId) && existingId > 0) return { entityId: existingId, already: true };
    }
    return null;
  }
}

async function ensureDeckOwnedId(kind, entry) {
  const display = deckItemDisplay(kind, entry);
  if (!display || !deckItemSaveable(kind, entry)) return null;
  const existing = await findOwnedEntityId(kind, display);
  if (existing) return { entityId: existing, already: true };
  const saved = await saveDeckItemReturningId(kind, entry);
  if (saved) return saved;
  const retry = await findOwnedEntityId(kind, display);
  if (retry) return { entityId: retry, already: true };
  return null;
}

function todayISODate() {
  try {
    return new Date().toISOString().slice(0, 10);
  } catch {
    return '2026-01-01';
  }
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
// V6.1.2: Map backend lowercase to Title Case for display.
function typePill(value) {
  const raw = String(value || '').trim().toLowerCase();
  const labelMap = { vocabulary: 'Vocabulary', kanji: 'Kanji', grammar: 'Grammar', reading: 'Reading' };
  const label = labelMap[raw] || (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Deck');
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
// V6.1.2: Add "Start Review" button for decks with items (save-then-queue → review session).
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

      // V6.1.2: Start Review button — save-then-queue → POST /api/review/sessions.
      // The label travels via the `text` option: element() appends children
      // verbatim, so a raw string child here threw "Argument 1 ('node') to
      // Node.appendChild" when opening any deck with items.
      const startReview = items.length > 0 ? element('button', {
        className: 'button-primary min-h-10 px-4 py-2 text-sm font-semibold shrink-0',
        text: 'Start Review',
        attrs: { type: 'button', 'aria-label': 'Save deck items and start a review session' }
      }) : null;
      if (startReview) {
        startReview.addEventListener('click', () => withPendingAction(startReview, async () => {
          // Save-then-queue: resolve OWNED ids first (search-first reuse to avoid duplicates, then POST missing)
          let savedCount = 0;
          let alreadyCount = 0;
          let skippedCount = 0;
          const owned = [];
          const seen = new Set();
          for (const entry of items) {
            const kind = entry.entityType || effectiveType || 'vocabulary';
            const display = deckItemDisplay(kind, entry);
            if (!display || !deckItemSaveable(kind, entry)) {
              skippedCount += 1;
              continue;
            }
            // eslint-disable-next-line no-await-in-loop
            const resolved = await ensureDeckOwnedId(kind, entry);
            if (!resolved) {
              skippedCount += 1;
              continue;
            }
            if (resolved.already) alreadyCount += 1;
            else savedCount += 1;
            const key = `${kind}:${resolved.entityId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            owned.push({
              entityType: kind,
              entityId: resolved.entityId,
              display,
              ...(entry.reading ? { reading: entry.reading } : {}),
              ...(entry.meaning ? { meaning: entry.meaning } : {})
            });
          }
          if (!owned.length) {
            showToast('Nothing reviewable — items need a dictionary meaning first.', 'error');
            return;
          }
          const capped = owned.slice(0, 500);
          const cappedSkipped = owned.length - capped.length;
          if (cappedSkipped > 0) skippedCount += cappedSkipped;
          const today = todayISODate();
          let session = null;
          try {
            session = await apiRequest('/api/review/sessions', {
              method: 'POST',
              body: {
                sourceFrom: today,
                sourceTo: today,
                items: capped.map(({ entityType, entityId }) => ({ entityType, entityId }))
              }
            });
          } catch (error) {
            showToast(error?.message || 'Unable to start the review.', 'error');
            return;
          }
          const sessionId = Number(session?.id);
          if (!Number.isInteger(sessionId) || sessionId <= 0) {
            showToast('Unable to start the review.', 'error');
            return;
          }
          // Immersion hand-off pattern: stash queue for the freshly created OPEN session, then navigate
          const contextByKey = new Map((Array.isArray(session?.items) ? session.items : []).map((entry) => [`${entry.entityType}:${entry.entityId}`, entry.context]));
          const queueItems = capped.map((item) => {
            const context = contextByKey.get(`${item.entityType}:${item.entityId}`);
            return context ? { ...item, context } : item;
          });
          try {
            if (window.sessionStorage) {
              window.sessionStorage.setItem('jlt-immersion-review-queue', JSON.stringify({
                reviewSessionId: sessionId,
                items: queueItems
              }));
            }
          } catch { /* storage blocked: review falls back to its banner */ }
          const parts = [];
          if (savedCount) parts.push(`Saved ${savedCount}`);
          if (alreadyCount) parts.push(`${alreadyCount} already in library`);
          const prefix = parts.length ? `${parts.join(', ')} — ` : '';
          const skippedNote = skippedCount ? ` (${skippedCount} skipped)` : '';
          showToast(`${prefix}starting review with ${capped.length}${skippedNote}.`);
          // Close the dialog silently and navigate
          try { stopQueue(); } catch { /* ignore */ }
          window.location.hash = `#review?reviewSessionId=${sessionId}`;
        }, { pendingLabel: 'Starting…' }).catch((error) => showToast(error?.message || 'Unable to start the review.', 'error')));
      }

      const view = element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2' });
      // Deck preview items: strict chunking of max 4 per column, column-major
      // (first 4 fill column 1 top-to-bottom, next 4 column 2…). ≤4 items stay
      // a single full-width column with no dividers (unchanged look).
      // Beyond one column, fixed-width (w-36) columns wrap NATURALLY in one
      // flex-wrap row — the browser alone decides where columns wrap (a column
      // wraps IF AND ONLY IF it hit the right edge, so columns can never be
      // cut in half). Dividers come from REALITY: after layout, columns that
      // share the same top are one visual row; an <hr> (a 100%-basis flex item
      // on its own line) is inserted immediately before every column that
      // starts a new row. First row never gets an hr; a single row gets zero
      // hrs — AN <hr> EXISTS ⟺ A WRAP REALLY HAPPENED AT THE RIGHT MARGIN.
      // Single list semantics via role=list/listitem; column divs stay generic
      // so AT hears one list. ResizeObserver re-places dividers from fresh
      // measurement; signature compare-then-mutate keeps it loop-safe;
      // isConnected guard releases the observer once the dialog removes it.
      let listObserver = null;
      let lastDividerKey = null;
      const renderList = () => {
        if (listObserver) { try { listObserver.disconnect(); } catch { /* cleanup is best-effort */ } listObserver = null; }
        lastDividerKey = null;
        const makeItemNode = (entry) => {
          const open = smallButton(displayOf(entry), `Details for ${displayOf(entry)}`);
          open.classList.add('max-w-full', 'wrap-anywhere', 'break-words');
          open.addEventListener('click', () => {
            const back = smallButton('Back to items', 'Back to items');
            back.addEventListener('click', renderList);
            view.replaceChildren(back, itemDetailView(entry, effectiveType));
          });
          return element('div', { className: 'min-w-0 max-w-full', attrs: { role: 'listitem' } }, [open]);
        };
        const columnSlices = [];
        for (let index = 0; index < items.length; index += 4) {
          columnSlices.push(items.slice(index, index + 4));
        }
        if (columnSlices.length <= 1) {
          const columns = [];
          for (let index = 0; index < items.length; index += 4) {
            columns.push(element('div', { className: 'grid min-w-[9rem] max-w-full flex-1 basis-36 grid-cols-1 content-start gap-1' }, items.slice(index, index + 4).map(makeItemNode)));
          }
          view.replaceChildren(
            element('div', { className: 'flex max-h-56 w-full min-w-0 max-w-full flex-row flex-wrap items-start gap-3 overflow-x-hidden overflow-y-auto text-sm text-ink', attrs: { role: 'list' } }, columns)
          );
          return;
        }
        const listEl = element('div', { className: 'flex max-h-56 w-full min-w-0 max-w-full flex-row flex-wrap items-start gap-3 overflow-y-auto text-sm text-ink', attrs: { role: 'list' } });
        const colNodes = columnSlices.map((slice) => element('div', { className: 'grid w-36 flex-none shrink-0 grid-cols-1 content-start gap-1' }, slice.map(makeItemNode)));
        listEl.append(...colNodes);
        view.replaceChildren(listEl);
        const placeDividers = () => {
          if (!listEl.isConnected) {
            try { if (listObserver) listObserver.disconnect(); } catch { /* cleanup is best-effort */ }
            listObserver = null;
            return;
          }
          // Reveal the natural wrap: detach previous divider hrs so measurement
          // sees columns only (the browser's real wrap points, not our marks).
          const previousHrs = Array.from(listEl.querySelectorAll('hr'));
          previousHrs.forEach((hr) => hr.remove());
          const connectedCols = colNodes.filter((col) => col.isConnected);
          if (!connectedCols.length) { lastDividerKey = JSON.stringify([]); return; }
          let containerTop = 0;
          try { containerTop = listEl.getBoundingClientRect().top; } catch { /* measurement is best-effort */ }
          const tops = connectedCols.map((col) => {
            try { return col.getBoundingClientRect().top - containerTop; }
            catch { return 0; }
          });
          const breaks = [];
          let rowTop = tops[0];
          for (let colIndex = 1; colIndex < tops.length; colIndex += 1) {
            if (Math.abs(tops[colIndex] - rowTop) > 2) {
              breaks.push(colIndex);
              rowTop = tops[colIndex];
            }
          }
          const key = JSON.stringify(breaks);
          const applyDividers = () => {
            breaks.forEach((colIndex) => {
              const divider = element('hr', { className: 'my-2 w-full border-t border-white/10' });
              divider.style.cssText = 'flex:0 0 100%';
              listEl.insertBefore(divider, connectedCols[colIndex]);
            });
          };
          if (!breaks.length) {
            // Single visual row: zero hrs (already detached above). This is the
            // core guarantee — no wrap, no divider.
            lastDividerKey = key;
            return;
          }
          if (key === lastDividerKey) {
            // Same wrap as last run (e.g. a height-only callback from our own
            // insertion): restore identical dividers so the synchronous
            // remove + re-add nets to no observable change and converges.
            applyDividers();
            return;
          }
          lastDividerKey = key;
          applyDividers();
        };
        const schedulePlace = () => {
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => placeDividers());
          } else {
            placeDividers();
          }
        };
        schedulePlace();
        if (typeof ResizeObserver !== 'undefined') {
          listObserver = new ResizeObserver(() => {
            if (!listEl.isConnected) {
              try { listObserver.disconnect(); } catch { /* cleanup is best-effort */ }
              listObserver = null;
              return;
            }
            placeDividers();
          });
          try { listObserver.observe(listEl); } catch { /* observer is best-effort */ }
        }
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
          element('div', { className: 'flex min-w-0 max-w-full flex-row flex-wrap items-center gap-2' }, [playAll, stop, ...(startReview ? [startReview] : []), starEnd]),
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
// V6.1.2: Redesigned as study objects — prioritize Study action, hide analytics/suggestions.
function deckCard(deck, options = {}) {
  const { showStudyAction = false, onStudy, showOverflow = false, onOverflowActions, isImported = false } = options;
  const pill = typePill(deck.entityType);
  const creatorName = authorNameOf(deck);
  const creator = creatorName
    ? element('p', { className: 'mt-1 min-w-0 wrap-anywhere break-words text-xs text-muted', text: `by ${creatorName}` })
    : null;

  // Study signal: prefer reviews due from analytics if available, else item count
  const itemCount = deck.itemCount ?? 0;
  const reviewsDue = deck.reviewsDue ?? null;
  const studySignal = reviewsDue !== null && reviewsDue > 0
    ? `${reviewsDue} review${reviewsDue === 1 ? '' : 's'} due`
    : `${itemCount} item${itemCount === 1 ? '' : 's'}`;

  // Visibility pill (public/private)
  const visibilityPill = element('span', {
    className: `status-pill text-xs ${deck.isPublic ? 'status-pill--success' : 'status-pill--warning'}`,
    text: deck.isPublic ? 'Public' : 'Private'
  });

  const header = element('div', { className: 'flex min-w-0 max-w-full items-start justify-between gap-3' }, [
    element('div', { className: 'min-w-0 flex-1' }, [
      element('h3', { className: 'min-w-0 wrap-anywhere break-words text-lg font-semibold text-ink', text: deck.title }),
      element('div', { className: 'mt-1 flex flex-wrap items-center gap-2' }, [pill, visibilityPill])
    ]),
    ...(isImported ? [element('span', { className: 'status-pill text-xs shrink-0', text: 'Shared from Community' })] : [])
  ]);

  const description = deck.description
    ? element('p', { className: 'mt-2 min-w-0 wrap-anywhere break-words text-sm leading-6 text-muted', text: deck.description })
    : null;

  const meta = element('p', { className: 'mt-2 min-w-0 wrap-anywhere break-words text-xs font-medium text-muted', text: studySignal });

  // Primary Study action (when deck has items). The label travels via
  // the `text` option — element() appends children verbatim, so a raw
  // string child here threw "Argument 1 ('node') to Node.appendChild".
  let primaryAction = null;
  if (showStudyAction && itemCount > 0 && typeof onStudy === 'function') {
    primaryAction = element('button', {
      className: 'button-primary min-h-10 px-4 py-2 text-sm font-semibold flex-1 sm:flex-none',
      text: 'Study',
      attrs: { type: 'button', 'aria-label': `Study ${deck.title}` }
    });
    primaryAction.addEventListener('click', (event) => {
      event.stopPropagation();
      onStudy(deck);
    });
  }

  // Overflow menu for admin actions
  let overflowMenu = null;
  if (showOverflow && typeof onOverflowActions === 'function') {
    const wrap = element('div', { className: 'relative' });
    const toggle = element('button', {
      className: 'icon-button shrink-0',
      attrs: { type: 'button', 'aria-label': `Deck actions for ${deck.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }
    }, [icon('dots', { size: 18 })]);
    const menu = element('div', {
      className: 'absolute right-0 top-full z-20 hidden min-w-40 rounded-lg border border-stone bg-paper p-1 shadow-lg mt-1',
      attrs: { role: 'menu' }
    });
    const closeMenu = (refocus = false) => {
      menu.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
      if (refocus) toggle.focus();
    };
    const openMenu = () => {
      menu.classList.remove('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      menu.querySelector('button')?.focus();
    };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      menu.classList.contains('hidden') ? openMenu() : closeMenu(false);
    });
    toggle.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeMenu(true); }
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeMenu(true); }
    });
    document.addEventListener('click', (event) => {
      if (!wrap.contains(event.target)) closeMenu(false);
    });
    const addMenuItem = (label, handler, isDestructive = false) => {
      const item = element('button', {
        className: `flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium ${isDestructive ? 'text-red-700' : 'text-ink'} transition hover:bg-paper`,
        attrs: { type: 'button', role: 'menuitem' }
      }, [element('span', { text: label })]);
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenu(false);
        handler();
      });
      menu.appendChild(item);
    };
    onOverflowActions({ addMenuItem, closeMenu });
    wrap.append(toggle, menu);
    overflowMenu = wrap;
  }

  const actionsRow = element('div', { className: 'mt-3 flex min-w-0 max-w-full flex-wrap items-center gap-2' }, [
    ...(primaryAction ? [primaryAction] : []),
    ...(overflowMenu ? [overflowMenu] : [])
  ]);

  return element('article', {
    className: 'relative min-w-0 w-full max-w-full overflow-hidden wrap-anywhere rounded-xl border border-stone bg-paper p-4',
    attrs: { role: 'button', tabindex: '0', 'aria-label': `Open ${deck.title}` }
  }, [header, ...(creator ? [creator] : []), ...(description ? [description] : []), meta, actionsRow]);
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

export async function renderDecksHub(container) {
  // Decks hub home (legacy V5.x surface, preserved verbatim for V6.0):
  // publishing, sharing, importing, browsing and collections. Mounted as
  // the Decks tab of the Community shell — no header of its own. Clears
  // the shell loader first (appending under it left it spinning forever).
  container.replaceChildren();
  const feed = section('Feed', 'Public decks. Filter, listen, open details, follow.');
  const publish = section('Publish', 'Pick items from your collection and publish a deck — or pick a text tab to publish reading texts.');
  const share = section('Share & import', 'Signed codes: share your own items, import codes as new rows.');
  
  // My Decks — V6.1.2: modern header with primary Create action.
  // The label travels via the `text` option: element() appends children
  // verbatim, so a string child here threw "Argument 1 ('node') to
  // Node.appendChild" and aborted the whole hub mount.
  const mineHeader = pageHeader({
    title: 'My Decks',
    description: 'Organize your learning material into studyable decks.',
    action: element('button', {
      className: 'button-primary min-h-10 px-4 py-2 text-sm font-semibold shrink-0',
      text: '+ Create deck',
      attrs: { type: 'button', 'aria-label': 'Create a new deck' }
    })
  });
  const mineBody = element('div', { className: 'grid gap-4' });
  const mine = { wrap: element('section', { className: 'surface mt-4 p-5 sm:p-6', attrs: { 'aria-label': 'My Decks' } }, [mineHeader, mineBody]), body: mineBody };
  
  const collections = section('Collections', 'Group decks into playlists and share them as one code.');
  container.append(feed.wrap, publish.wrap, share.wrap, mine.wrap, collections.wrap);

  // Wire Create deck button to switch to Publish tab and focus title
  mineHeader.querySelector('button').addEventListener('click', () => {
    // Find and click the first picker tab (Vocabulary) to ensure we're in deck mode
    const vocabTab = publish.wrap.querySelector('[data-picker-key="vocabulary"]');
    if (vocabTab) vocabTab.click();
    // Focus the title input
    const titleInput = publish.wrap.querySelector('input[aria-label="Deck title"]');
    if (titleInput) { titleInput.focus(); titleInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });

  // ---- Feed
  // V6.1.2: YouTube-style filter selector button (reuse communityFeed.js pattern)
  const FEED_FILTERS = [
    { value: '', label: 'All types' },
    { value: 'vocabulary', label: 'Vocabulary' },
    { value: 'kanji', label: 'Kanji' },
    { value: 'grammar', label: 'Grammar' },
    { value: 'reading', label: 'Reading' }
  ];
  let feedFilterType = '';
  const filterRow = element('div', { className: 'flex flex-col gap-2 sm:flex-row sm:items-center' });
  const filterWrap = element('div', { className: 'relative inline-flex max-w-full' });
  const filterLabel = element('span', { className: 'truncate', text: `Filter: ${FEED_FILTERS.find(f => f.value === feedFilterType)?.label || 'All types'}` });
  const filterButton = element('button', {
    className: 'button-secondary inline-flex min-h-9 max-w-full items-center gap-2 px-3 py-1.5 text-xs shrink-0',
    attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Feed filter, current: ${FEED_FILTERS.find(f => f.value === feedFilterType)?.label || 'All types'}` }
  }, [icon('filter', { size: 16 }), filterLabel]);
  const filterMenu = element('div', {
    className: 'absolute left-0 top-full z-20 hidden min-w-40 max-w-[70vw] rounded-lg border border-stone bg-paper p-1 shadow-lg mt-1',
    attrs: { role: 'menu', 'aria-label': 'Feed filter by type' }
  });
  filterWrap.append(filterButton, filterMenu);
  const filterItems = new Map();
  const paintFeedFilter = () => {
    const current = FEED_FILTERS.find(f => f.value === feedFilterType)?.label || 'All types';
    filterLabel.textContent = `Filter: ${current}`;
    filterButton.setAttribute('aria-label', `Feed filter, current: ${current}`);
    for (const [value, item] of filterItems) {
      const active = value === feedFilterType;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  };
  let feedFilterOpen = false;
  const closeFeedFilter = (refocus = false) => {
    if (!feedFilterOpen) return;
    feedFilterOpen = false;
    filterMenu.classList.add('hidden');
    filterButton.setAttribute('aria-expanded', 'false');
    if (refocus) filterButton.focus();
  };
  const openFeedFilter = () => {
    feedFilterOpen = true;
    filterMenu.classList.remove('hidden');
    filterButton.setAttribute('aria-expanded', 'true');
    (filterItems.get(feedFilterType) || [...filterItems.values()][0])?.focus();
  };
  for (const entry of FEED_FILTERS) {
    const item = element('button', {
      className: 'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-ink transition hover:bg-paper',
      attrs: { type: 'button', role: 'menuitem', 'aria-label': `Filter by ${entry.label}` }
    }, [element('span', { text: entry.label })]);
    if (entry.value === feedFilterType) item.setAttribute('aria-current', 'true');
    item.addEventListener('click', () => {
      feedFilterType = entry.value;
      paintFeedFilter();
      closeFeedFilter(true);
      renderFeed();
    });
    filterItems.set(entry.value, item);
    filterMenu.appendChild(item);
  }
  paintFeedFilter();
  filterButton.addEventListener('click', (event) => {
    event.stopPropagation();
    feedFilterOpen ? closeFeedFilter(false) : openFeedFilter();
  });
  filterButton.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeFeedFilter(true); }
    if (event.key === 'ArrowDown' && !feedFilterOpen) { event.preventDefault(); openFeedFilter(); }
  });
  filterMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeFeedFilter(true); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...filterItems.values()];
    const currentIndex = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? items[(currentIndex + 1 + items.length) % items.length]
      : items[(currentIndex - 1 + items.length) % items.length];
    next?.focus();
  });
  document.addEventListener('click', (event) => {
    if (!feedFilterOpen) return;
    if (filterWrap.contains(event.target)) return;
    closeFeedFilter(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && feedFilterOpen) closeFeedFilter(true);
  });
  const textFilter = element('input', { className: 'field-control', attrs: { type: 'search', 'aria-label': 'Filter decks by text', placeholder: 'Filter by title…' } });
  filterRow.append(filterWrap, textFilter);
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
    const visible = filterFeedDecks(feedFilterType, query);
    if (!visible.length) {
      feedList.replaceChildren(element('p', { className: 'text-sm text-muted', text: 'Nothing matches. Try another filter.' }));
      return;
    }
    const shown = visible.slice(0, FEED_VISIBLE);
    feedList.replaceChildren(element('div', { className: 'grid w-full min-w-0 max-w-full grid-cols-1 gap-2 overflow-x-hidden' }, shown.map((deck) => buildFeedRow(deck))));
    if (visible.length > FEED_VISIBLE) {
      const more = smallButton(`See more (${visible.length - FEED_VISIBLE} more)`, 'View all matching decks');
      more.addEventListener('click', () => openAllDecksDialog(feedFilterType, query));
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
        : [element('p', { className: 'text-sm text-muted', text: 'Nothing matches. Try another filter.' })]));
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
  }
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
              if (result.duplicate === true) showToast('Already in your library — opened your copy.');
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
    const own = libraryTexts.filter((item) => item.mine === true || item.mine === 1);
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

  // ---- My decks: V6.1.2 — study-focused cards with Study primary action, overflow menu for admin
  const loadMine = async () => {
    mine.body.replaceChildren(loadingState('Loading your decks…'));
    try {
      const data = await apiRequest('/api/decks?mine=true&limit=50');
      const decks = Array.isArray(data?.items) ? data.items : [];
      
      if (!decks.length) {
        mine.body.replaceChildren(emptyState({
          title: 'Your study library is empty',
          description: 'Create your first deck or explore shared content from Community.',
          action: element('div', { className: 'flex flex-col gap-2 sm:flex-row' }, [
            element('button', {
              className: 'button-primary min-h-10 px-4 py-2 text-sm font-semibold',
              attrs: { type: 'button' },
              text: 'Create deck'
            }),
            element('button', {
              className: 'button-secondary min-h-10 px-4 py-2 text-sm font-semibold',
              attrs: { type: 'button' },
              text: 'Explore Community'
            })
          ])
        }));
        // Wire empty state buttons
        const createBtn = mine.body.querySelector('button:first-of-type');
        const exploreBtn = mine.body.querySelector('button:last-of-type');
        if (createBtn) createBtn.addEventListener('click', () => {
          const vocabTab = publish.wrap.querySelector('[data-picker-key="vocabulary"]');
          if (vocabTab) vocabTab.click();
          const titleInput = publish.wrap.querySelector('input[aria-label="Deck title"]');
          if (titleInput) { titleInput.focus(); titleInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        });
        if (exploreBtn) exploreBtn.addEventListener('click', () => {
          const feedTab = feed.wrap.querySelector('h2');
          if (feedTab) feedTab.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return;
      }

      // Fetch analytics for reviews due signal (parallel, best-effort)
      const analyticsMap = new Map();
      await Promise.all(decks.map(async (deck) => {
        try {
          const analytics = await apiRequest(`/api/decks/${deck.id}/analytics?period=30d`);
          analyticsMap.set(deck.id, analytics.overview);
        } catch { /* analytics optional */ }
      }));

      const cards = [];
      for (const deck of decks) {
        const overview = analyticsMap.get(deck.id) || {};
        const reviewsDue = overview.reviewsDue ?? 0;
        const isImported = deck.source === 'community' || deck.importedFromCommunity === true;

        const card = deckCard(deck, {
          showStudyAction: true,
          onStudy: (d) => openDeckViewer(d.id, d.title),
          showOverflow: true,
          onOverflowActions: ({ addMenuItem, closeMenu }) => {
            // Rename
            addMenuItem('Rename', () => {
              openDialog({
                title: 'Rename deck',
                description: 'Give this deck a new title.',
                content: [element('input', {
                  className: 'field-control',
                  attrs: { type: 'text', maxLength: '120', 'aria-label': 'New deck title', value: d.title }
                })],
                submitLabel: 'Save',
                onSubmit: async (form, close) => {
                  const newTitle = String(form.querySelector('input').value || '').trim();
                  if (!newTitle) { showToast('Title cannot be empty.', 'error'); return; }
                  try {
                    await withPendingAction(form.querySelector('button[type="submit"]'), async () => {
                      await apiRequest(`/api/decks/${d.id}`, { method: 'PUT', body: { title: newTitle } });
                    });
                    showToast('Deck renamed.');
                    close();
                    await loadMine();
                  } catch (error) {
                    showToast(error?.message || 'Unable to rename.', 'error');
                  }
                }
              });
            });
            // Duplicate
            addMenuItem('Duplicate', async () => {
              try {
                const duplicated = await apiRequest(`/api/decks/${d.id}/duplicate`, { method: 'POST' });
                showToast('Deck duplicated.');
                await loadMine();
              } catch {
                // If duplicate endpoint doesn't exist, fall back to manual recreation
                try {
                  const detail = await apiRequest(`/api/decks/${d.id}`);
                  const items = Array.isArray(detail.items) ? detail.items.map((entry) => entry.id) : [];
                  if (items.length) {
                    await apiRequest('/api/decks', { method: 'POST', body: { entityType: d.entityType, ids: items, title: `${d.title} (copy)`, description: d.description } });
                    showToast('Deck duplicated.');
                    await loadMine();
                  } else {
                    showToast('Cannot duplicate empty deck.', 'error');
                  }
                } catch (error) {
                  showToast(error?.message || 'Unable to duplicate.', 'error');
                }
              }
            });
            // Delete (destructive)
            addMenuItem('Delete', () => {
              confirmDialog({
                title: `Delete ${d.title}?`,
                description: 'This permanently deletes the deck, its items, follows and suggestions. This cannot be undone.',
                confirmLabel: 'Delete',
                onConfirm: async () => {
                  try {
                    await apiRequest(`/api/decks/${d.id}`, { method: 'DELETE' });
                    showToast('Deck deleted.');
                    await loadMine();
                  } catch (error) {
                    showToast(error?.message || 'Unable to delete.', 'error');
                  }
                }
              });
            }, true);
          },
          isImported
        });

        // Make card clickable to open detail dialog (but not when clicking actions)
        card.addEventListener('click', (event) => {
          if (event.target.closest('button, [role="menuitem"]')) return;
          itemsDialog(deck.id, deck.title, deck.entityType, deck);
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            if (event.target.closest('button, [role="menuitem"]')) return;
            event.preventDefault();
            itemsDialog(deck.id, deck.title, deck.entityType, deck);
          }
        });

        cards.push(card);
      }

      // Responsive grid: xl:3, md:2, mobile:1
      mine.body.replaceChildren(element('div', { className: 'grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' }, cards));
    } catch (error) {
      mine.body.replaceChildren(errorState(error, loadMine));
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

// V6.0 Community shell: social tabs own the page; the legacy decks hub
// mounts untouched as the Decks tab (zero regression surface).
export async function renderCommunity(container) {
  const { mountSocialFeed } = await import('./communityFeed.js');
  container.replaceChildren(element('section', {}, [
    pageHeader({
      title: 'Community',
      description: 'Learn Japanese with other learners: follow people, share what you study, save what inspires you.'
    })
  ]));
  const shell = container.firstChild;
  const tabs = element('div', { className: 'flex flex-wrap items-center gap-2', attrs: { role: 'tablist', 'aria-label': 'Community sections' } });
  const body = element('div', { className: 'mt-5' });
  shell.append(tabs, body);
  await mountSocialFeed({ tabs, body, renderDecksHub });
}
