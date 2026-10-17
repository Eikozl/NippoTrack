// Story Registry enroll dialog (shared with the Content Log): candidate
// checkboxes with TTS preview, server-id enrollment. No fetching here.
import { apiRequest } from '../api';
import { element, openDialog, showToast, withPendingAction } from '../ui';
import { icon } from '../icons';
import { speakJapanese } from '../speech.js';

function smallButton(label, ariaLabel) {
  return element('button', { className: 'button-secondary min-h-8 px-2.5 py-1 text-xs', text: label, attrs: { type: 'button', 'aria-label': ariaLabel || label } });
}

function speechPieces() {
  const hasWindow = typeof window !== 'undefined';
  return {
    synthesis: hasWindow ? window.speechSynthesis : null,
    Utterance: hasWindow ? window.SpeechSynthesisUtterance : null
  };
}

function candidateLabel(kind, entry) {
  if (kind === 'kanji') return `${entry.char} (${entry.reading || '?'} · ${entry.meaning || '?'}) ×${entry.frequency}`;
  if (kind === 'vocab') return `${entry.word} (${entry.reading || '?'} · ${entry.meaning || '?'})`;
  return `${entry.pattern} · ${entry.meaning || '?'}`;
}

export function openEnrollDialog(storyId, storyTitle, preview, meta = {}) {
  const groups = [
    { kind: 'kanji', label: 'Kanji', entries: Array.isArray(preview?.kanji) ? preview.kanji : [] },
    { kind: 'vocab', label: 'Vocabulary', entries: Array.isArray(preview?.vocab) ? preview.vocab : [] },
    { kind: 'grammar', label: 'Grammar', entries: Array.isArray(preview?.grammar) ? preview.grammar : [] }
  ];
  const picks = [];
  const sections = groups.map(({ kind, label, entries }) => {
    if (!entries.length) return null;
    const boxes = entries.map((entry) => {
      const box = element('input', { attrs: { type: 'checkbox', 'aria-label': `Enroll ${candidateLabel(kind, entry)}` } });
      box.checked = false;
      return { id: entry.id, box };
    });
    picks.push(boxes);
    return element('div', { className: 'grid gap-1.5' }, [
      element('p', { className: 'text-xs font-semibold text-muted uppercase tracking-[0.08em]', text: `${label} (${entries.length})` }),
      element('div', { className: 'grid max-h-44 gap-1 overflow-y-auto' }, entries.map((entry, index) => {
        const play = element('button', { className: 'icon-button shrink-0', attrs: { type: 'button', 'aria-label': `Play ${candidateLabel(kind, entry)} aloud` } }, [icon('volume', { size: 18 })]);
        play.addEventListener('click', () => {
          const word = kind === 'kanji' ? entry.char : kind === 'vocab' ? entry.word : entry.pattern;
          const verdict = speakJapanese(word, { ...speechPieces() });
          if (!verdict.ok) showToast(verdict.message || 'Audio playback is unavailable.', 'error');
        });
        return element('label', { className: 'flex min-w-0 items-center gap-2 text-sm text-ink' }, [
          boxes[index].box,
          element('span', { className: 'flex-1 min-w-0 wrap-anywhere', text: candidateLabel(kind, entry) }),
          play
        ]);
      }))
    ]);
  }).filter(Boolean);
  if (!sections.length) {
    showToast('Nothing detected to enroll.', 'error');
    return;
  }
  const resultBox = element('div', { className: 'grid gap-2', attrs: { 'aria-live': 'polite' } });
  const enroll = element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Enroll selected', attrs: { type: 'button' } });
  function dialogStackLike() {
    return element('div', { className: 'grid min-w-0 gap-3 sm:col-span-2' }, [
      ...sourceBlock(meta),
      ...sections,
      enroll,
      resultBox
    ]);
  }
  let closeEnroll = null;
  enroll.addEventListener('click', () => {
    const selected = picks.flat().filter(({ box }) => box.checked).map(({ id }) => id).filter(Boolean);
    if (!selected.length) { showToast('Select at least one candidate.', 'error'); return; }
    withPendingAction(enroll, async () => {
      const result = await apiRequest(`/api/stories/${storyId}/enroll-srs`, { method: 'POST', body: { selected } });
      const items = Array.isArray(result.items) ? result.items : [];
      const reviewNow = element('button', { className: 'button-primary min-h-9 px-3 py-1.5 text-sm', text: 'Review these now', attrs: { type: 'button' } });
      reviewNow.addEventListener('click', () => {
        try {
          if (typeof window !== 'undefined' && window.sessionStorage && result.reviewSessionId && Array.isArray(result.queueItems)) {
            window.sessionStorage.setItem('jlt-immersion-review-queue', JSON.stringify({
              reviewSessionId: Number(result.reviewSessionId),
              items: result.queueItems
            }));
            closeEnroll?.();
            window.location.hash = `#review?reviewSessionId=${Number(result.reviewSessionId)}`;
            return;
          }
        } catch { /* storage blocked: fall back to the review page */ }
        if (typeof window !== 'undefined') {
          closeEnroll?.();
          window.location.hash = 'review';
        }
      });
      resultBox.replaceChildren(
        element('p', { className: 'text-sm font-semibold text-ink', text: `Enrolled ${result.created} review item${result.created === 1 ? '' : 's'}:` }),
        ...(items.length ? [element('ul', { className: 'grid gap-1 text-sm text-ink', attrs: { role: 'list' } }, items.map((item) => element('li', { text: `${item.entityType}: ${item.display}` })))] : []),
        reviewNow
      );
    }).catch((error) => showToast(error?.message || 'Unable to enroll.', 'error'));
  });
  closeEnroll = openDialog({
    title: `Enroll from ${storyTitle}`,
    description: 'Checked rows become SRS review items. Practice only until graded.',
    content: [dialogStackLike()],
    // Enroll + result actions live in-body; the header X is the sole
    // dismiss, so no footer is rendered.
    showFooter: false
  });
}

// Source context: the text being mined, its URL, and a YouTube player when
// the URL points at a video. Sandbox stays tight (scripts + same-origin for
// playback, presentation for fullscreen).
export function youtubeVideoId(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return parsed.pathname.slice(1).split(/[?#]/)[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube.com')) {
      if (parsed.pathname === '/watch') return parsed.searchParams.get('v');
      const match = parsed.pathname.match(/^\/(shorts|embed|live)\/([^/?#]+)/);
      if (match) return match[2];
    }
  } catch { /* invalid URL means no embed */ }
  return null;
}

function sourceBlock(meta = {}) {
  const nodes = [];
  const videoId = youtubeVideoId(meta.sourceUrl);
  if (videoId) {
    const frame = element('iframe', {
      className: 'aspect-video w-full rounded-md bg-ink/10',
      attrs: {
        src: `https://www.youtube-nocookie.com/embed/${videoId}`,
        title: 'Story video preview',
        sandbox: 'allow-scripts allow-same-origin allow-presentation',
        allow: 'accelerometer; encrypted-media; picture-in-picture',
        allowfullscreen: '',
        loading: 'lazy'
      }
    });
    nodes.push(frame);
  } else if (meta.sourceUrl) {
    nodes.push(element('a', {
      className: 'min-w-0 break-all text-sm font-medium text-vermilion underline underline-offset-4 hover:no-underline',
      text: meta.sourceUrl, attrs: { href: meta.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }
    }));
  }
  if (meta.sourceText) {
    nodes.push(element('details', { className: 'min-w-0 rounded-md bg-paper p-3' }, [
      element('summary', { className: 'cursor-pointer text-sm font-semibold text-ink', text: 'Source text' }),
      element('p', { className: 'mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-ink/80', text: meta.sourceText })
    ]));
  }
  return nodes;
}

