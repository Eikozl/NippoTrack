import { apiRequest } from '../api';
import { element, errorState, loadingState, pageHeader } from '../ui';

function readingCard(title, readings) {
  return element('section', { className: 'kanji-reference-reading surface p-4' }, [
    element('h2', { className: 'eyebrow', text: title }),
    element('p', { className: 'mt-2 font-jp text-lg font-semibold text-ink', text: readings.length ? readings.join(' · ') : 'Not recorded' })
  ]);
}

function referenceContent(reference) {
  const facts = element('dl', { className: 'kanji-reference-facts' }, [
    element('div', { className: 'kanji-reference-fact' }, [element('dt', { text: 'JLPT level' }), element('dd', { text: reference.jlptLevel || 'Not set' })]),
    element('div', { className: 'kanji-reference-fact' }, [element('dt', { text: 'Strokes' }), element('dd', { text: reference.strokeCount ? String(reference.strokeCount) : 'Not set' })])
  ]);
  return element('div', { className: 'grid gap-5' }, [
    element('section', { className: 'kanji-reference-overview surface p-5 sm:p-7' }, [
      element('div', { className: 'kanji-reference-copy' }, [
        element('p', { className: 'eyebrow', text: 'Meanings' }),
        element('h2', { className: 'mt-2 text-2xl font-semibold text-ink', text: reference.meanings.join(', ') || 'Not recorded' }),
        element('div', { className: 'mt-4 flex flex-wrap gap-2' }, reference.meanings.map((meaning) => element('span', { className: 'status-pill', text: meaning }))),
        facts
      ]),
      element('div', { className: 'kanji-reference-glyph', attrs: { role: 'img', 'aria-label': `Kanji ${reference.character}` } }, [element('span', { text: reference.character })])
    ]),
    element('div', { className: 'grid gap-4 sm:grid-cols-2' }, [readingCard('On’yomi', reference.onyomi), readingCard('Kun’yomi', reference.kunyomi)]),
    element('section', { className: 'kanji-reference-examples surface p-5 sm:p-7' }, [
      element('h2', { className: 'text-lg font-semibold text-ink', text: 'Examples of use' }),
      element('p', { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted', text: 'Shared reference examples are not available yet. This page currently shows the canonical JLPT reference data for this kanji.' })
    ])
  ]);
}

export async function renderKanjiReference(container, character) {
  const header = () => pageHeader({ eyebrow: 'Reference', title: 'Kanji reference', description: 'Reference details for this kanji.' });
  container.replaceChildren(header(), loadingState('Loading kanji reference…'));
  try {
    const reference = await apiRequest(`/api/kanji/lookup/${encodeURIComponent(character)}`);
    container.replaceChildren(pageHeader({ eyebrow: 'Reference', title: `Kanji ${reference.character}`, description: 'Shared JLPT reference data. Classifications are community/reference data, not an official syllabus.' }), referenceContent(reference));
  } catch (error) {
    const message = error?.status === 404 ? 'This kanji is not present in the shared JLPT reference data.' : error;
    container.replaceChildren(header(), errorState(message, () => renderKanjiReference(container, character)));
  }
}
