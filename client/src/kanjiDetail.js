// B.1 — one shared kanji identity builder for the two detail surfaces:
//   - Reference page (`pages/kanjiReference.js`, `#kanji-reference/<char>`)
//   - Owned View (`ENTITY_CONFIGS.kanji.renderDetail` in `pages/entityPage.js`)
// Both keep their endpoints; this module only presents already-fetched data.
// No auth, no derivation, no intelligence heuristics.
//
// Dependency-free on purpose (no `ui.js` import): callers pass their `element`
// factory in, so this module stays unit-testable under plain node while the
// app keeps one DOM helper. `h` has the `ui.element` signature
// `h(tagName, { className, text, attrs } = {}, children = [])`.

const KANJI_STATUS_STYLES = {
  New: 'bg-sky text-sky-foreground',
  Learning: 'bg-amber text-amber-foreground',
  Familiar: 'bg-emerald text-emerald-foreground',
  Mastered: 'bg-violet text-violet-foreground'
};

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function sameMeaningText(a, b) {
  const normalize = (value) => String(value || '')
    .replace(/[·]/g, ',')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalize(a) === normalize(b);
}

export function normalizeKanjiReferenceIdentity(reference = {}) {
  const meanings = asArray(reference.meanings);
  const onyomi = asArray(reference.onyomi);
  const kunyomi = asArray(reference.kunyomi);
  return {
    character: reference.character || '',
    headline: meanings.join(', ') || 'Not recorded',
    meanings,
    userMeaning: null,
    onyomiRef: onyomi,
    kunyomiRef: kunyomi,
    onyomiUser: null,
    kunyomiUser: null,
    jlptLevel: reference.jlptLevel || null,
    strokeCount: reference.strokeCount || null,
    status: null,
    variant: 'reference'
  };
}

export function normalizeKanjiOwnedIdentity(item = {}) {
  const ref = item.reference || null;
  const refMeanings = asArray(ref?.meanings);
  const refOnyomi = asArray(ref?.onyomi);
  const refKunyomi = asArray(ref?.kunyomi);
  const userMeaning = typeof item.meaning === 'string' && item.meaning.trim() ? item.meaning : null;
  return {
    character: item.character_kanji || '',
    headline: refMeanings.length ? refMeanings.join(' · ') : (userMeaning || 'Meaning not recorded'),
    meanings: refMeanings.length ? refMeanings : (userMeaning ? [userMeaning] : []),
    userMeaning,
    onyomiRef: refOnyomi,
    kunyomiRef: refKunyomi,
    onyomiUser: item.onyomi || null,
    kunyomiUser: item.kunyomi || null,
    jlptLevel: ref?.jlptLevel || null,
    strokeCount: ref?.strokeCount || null,
    status: item.status || 'New',
    variant: 'owned'
  };
}

function readingFact(h, term, value) {
  return h('div', { className: 'kanji-fact' }, [
    h('dt', { className: 'text-xs font-semibold text-muted uppercase tracking-wide', text: term }),
    h('dd', { className: 'mt-1 font-jp text-sm text-ink/80', text: value, attrs: { lang: 'ja' } })
  ]);
}

export function buildKanjiIdentity(identity, h) {
  const element = h;
  if (typeof element !== 'function') throw new Error('buildKanjiIdentity requires an element factory');
  const data = identity || {};
  const character = data.character || '';
  const isOwned = data.variant === 'owned';
  const refOnyomi = asArray(data.onyomiRef);
  const refKunyomi = asArray(data.kunyomiRef);

  const copyChildren = [
    element('p', { className: 'eyebrow', text: isOwned ? 'Your kanji' : 'Meanings' }),
    element('h2', { className: 'kanji-identity-headline mt-2 text-2xl font-semibold text-ink sm:text-3xl', text: data.headline || 'Not recorded' })
  ];

  if (isOwned && data.userMeaning && asArray(data.meanings).length > 0 && !sameMeaningText(data.userMeaning, data.headline)) {
    copyChildren.push(
      element('p', { className: 'mt-2 text-sm leading-6 text-muted', text: `Your record: ${data.userMeaning}` })
    );
  }

  if (!isOwned && asArray(data.meanings).length > 0) {
    copyChildren.push(
      element('div', { className: 'mt-4 flex flex-wrap gap-2' }, asArray(data.meanings).map((meaning) => element('span', { className: 'status-pill', text: meaning })))
    );
  }

  const readings = isOwned
    ? element('dl', { className: 'kanji-identity-readings mt-4 grid gap-4 sm:grid-cols-2' }, [
      readingFact(element, "On'yomi (Reference)", refOnyomi.length ? refOnyomi.join(' · ') : '—'),
      readingFact(element, "On'yomi (Your record)", data.onyomiUser || 'Not recorded'),
      readingFact(element, "Kun'yomi (Reference)", refKunyomi.length ? refKunyomi.join(' · ') : '—'),
      readingFact(element, "Kun'yomi (Your record)", data.kunyomiUser || 'Not recorded')
    ])
    : element('dl', { className: 'kanji-identity-readings mt-4 grid gap-4 sm:grid-cols-2' }, [
      readingFact(element, 'On’yomi', refOnyomi.length ? refOnyomi.join(' · ') : 'Not recorded'),
      readingFact(element, 'Kun’yomi', refKunyomi.length ? refKunyomi.join(' · ') : 'Not recorded')
    ]);
  copyChildren.push(readings);

  if (isOwned) {
    const pills = element('div', { className: 'mt-4 flex flex-wrap items-center gap-2' }, [
      data.jlptLevel && element('span', { className: 'status-pill status-jlpt', text: `JLPT ${data.jlptLevel} (Reference)` }),
      element('span', { className: `status-pill ${KANJI_STATUS_STYLES[data.status] || 'bg-stone text-stone-foreground'}`, text: data.status || 'New', attrs: { title: 'Self-reported status' } }),
      data.strokeCount && element('span', { className: 'status-pill bg-stone text-stone-foreground', text: `${data.strokeCount} strokes (Ref)` })
    ]);
    copyChildren.push(pills);
    copyChildren.push(element('p', { className: 'mt-2 text-sm text-muted', text: `Character: ${character}` }));
  } else {
    const facts = element('dl', { className: 'kanji-reference-facts mt-4' }, [
      element('div', { className: 'kanji-reference-fact' }, [element('dt', { text: 'JLPT level' }), element('dd', { text: data.jlptLevel || 'Not set' })]),
      element('div', { className: 'kanji-reference-fact' }, [element('dt', { text: 'Strokes' }), element('dd', { text: data.strokeCount ? String(data.strokeCount) : 'Not set' })])
    ]);
    copyChildren.push(facts);
  }

  const copy = element('div', { className: 'kanji-identity-copy' }, copyChildren);

  // B.2 mount point: `.kanji-stroke-slot` stays empty in B.1 (no animation,
  // no interaction). The stroke-order affordance will render into it.
  const glyphPanel = element('div', {
    className: 'kanji-identity-glyph kanji-glyph-panel-large kanji-identity-glyph--square',
    attrs: { role: 'img', 'aria-label': isOwned ? `Selected kanji: ${character}` : `Kanji ${character}` }
  }, [
    element('span', { className: 'kanji-glyph-large', text: character, attrs: { lang: 'ja' } }),
    element('div', { className: 'kanji-stroke-slot', attrs: { 'data-kanji-stroke-slot': character, 'aria-hidden': 'true' } })
  ]);

  return element('section', {
    className: 'kanji-identity',
    attrs: { 'aria-label': `Kanji identity: ${character}` }
  }, [copy, glyphPanel]);
}
