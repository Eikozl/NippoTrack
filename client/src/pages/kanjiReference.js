import { apiRequest } from '../api';
import { element, errorState, loadingState, pageHeader } from '../ui';
import { buildKanjiIdentity, normalizeKanjiReferenceIdentity } from '../kanjiDetail.js';

function referenceContent(reference) {
  return element('div', { className: 'grid gap-5' }, [
    buildKanjiIdentity(normalizeKanjiReferenceIdentity(reference), element),
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
