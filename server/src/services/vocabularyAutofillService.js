// VAF-B — Vocabulary Auto-Fill orchestration, hint mapping, composer,
// ownership, and entry drill-down.
//
// Frozen Context internals are imported, never reimplemented:
// - identity: safeIdentityStrings / identityKeysFor / strategyFor
// - reference: buildQ1 / runQ1 / buildQ2Senses / buildQ2Forms / runQ2
// - filters: evaluateSenses / finalizeCandidate (H1-H6 untouched; pos null is
//   UNKNOWN which never excludes — conservative retention)
// - response: buildItem / dietEntry
// - ownership: matchOwnedVocabulary semantics (exact word -> existing,
//   reading-correlated -> possible-match, bounded, never "duplicate
//   confirmed"; throw -> unavailable, never "new")
// No Kuromoji, no deinflection, no name analysis, no JMnedict, no lexical
// budget, no rate-limit changes. Runtime pool only (pool.execute,
// SELECT-only). Never logs the typed word (sizes only).

const {
  safeIdentityStrings,
  identityKeysFor,
  strategyFor
} = require('./contextIdentity');
const {
  buildQ1,
  runQ1,
  buildQ2Senses,
  buildQ2Forms,
  runQ2
} = require('./contextReference');
const {
  MATCH,
  INTERP,
  evaluateSenses,
  finalizeCandidate,
  resolveReadings
} = require('./contextFilters');
const {
  buildItem,
  dietEntry
} = require('./contextResponse');
const {
  matchOwnedVocabulary
} = require('./lexicalCandidates');
const {
  katakanaToHiragana,
  hiraganaToKatakana
} = require('../search/japaneseSearch');
const { buildStandaloneCandidate } = require('./vocabularyAutofillCandidate');

const NO_MATCH_HINT = 'No JMdict entry matches this exact text. You can still add it manually. Tip: type the dictionary form (e.g. 行く instead of 行った).';
const MEANING_MAX_LENGTH = 255;
const SENSE_CHOICE_CAP = 10;
const ENTRY_CHOICE_CAP = 5;
const ENTRY_SENSE_PAGE_SIZE = 20;
const ENTRY_SENSE_CURSOR_MAX = 64;

// Pure composer: same-sense glosses only, joined with " · ", greedy
// whole-gloss while total <= max. Never char-cuts. No preference semantics:
// gating (UNIQUE+COMPATIBLE or explicit user pick) selects, the composer only
// renders. Zero-fitting (including empty) yields blank with fits:false.
function composeSenseMeaning(glosses, maxLength = 255) {
  const max = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : 255;
  const list = Array.isArray(glosses) ? glosses.filter((g) => typeof g === 'string' && g !== '') : [];
  if (!list.length) {
    return {
      value: '',
      glossesUsed: [],
      glossCount: 0,
      remainingCount: Array.isArray(glosses) ? glosses.length : 0,
      fits: false
    };
  }
  const used = [];
  let value = '';
  for (const gloss of list) {
    const next = used.length === 0 ? gloss : `${value} · ${gloss}`;
    if (next.length > max) break;
    value = next;
    used.push(gloss);
  }
  if (!used.length) {
    return { value: '', glossesUsed: [], glossCount: 0, remainingCount: list.length, fits: false };
  }
  return {
    value,
    glossesUsed: used,
    glossCount: used.length,
    remainingCount: list.length - used.length,
    fits: true
  };
}

function blankReading() {
  return { action: 'blank', value: null, choices: [], provenance: null };
}

function blankMeaning() {
  return {
    action: 'blank',
    value: '',
    glossesUsed: [],
    glossCount: 0,
    remainingCount: 0,
    entryId: null,
    senseId: null,
    provenance: null,
    senseChoices: null,
    entryChoices: null
  };
}

// Hint mapping (pure, no I/O). Covers all 5 dictionary statuses:
// UNIQUE+COMPATIBLE -> reading prefill/choose/blank + meaning prefill (blank
//   on zero-fitting, remainingCount noted)
// UNIQUE+AMBIGUOUS -> reading as above + meaning choose + bounded
//   senseChoices (each {entryId,senseId,glosses FULL ordered,pos})
// MULTIPLE -> reading blank (never fill, never alternatives[0]) + meaning
//   choose-entry-then-sense + bounded entryChoices (written/kana/gloss
//   preview/POS, stable display order only, never ranked-best)
// NO_MATCH -> blanks + neutral hint
// UNAVAILABLE -> blanks, retryable decided by caller (true only transient)
// UNSUPPORTED (practically unreachable standalone) -> blanks, retryable false
function buildFieldHints(finalized) {
  const matchStatus = finalized && finalized.matchStatus;
  const interpStatus = finalized && finalized.interpretationStatus;

  if (matchStatus === MATCH.UNIQUE) {
    const readings = finalized.itemReadings || { suggested: null, alternatives: [], provenance: null };
    let reading;
    if (readings.suggested) {
      reading = {
        action: 'prefill',
        value: readings.suggested,
        choices: Array.isArray(readings.alternatives) ? readings.alternatives.slice(0, 5) : [],
        provenance: 'dictionary'
      };
    } else if (Array.isArray(readings.alternatives) && readings.alternatives.length) {
      reading = {
        action: 'choose',
        value: null,
        choices: readings.alternatives.slice(0, 5),
        provenance: 'dictionary'
      };
    } else {
      reading = blankReading();
    }

    if (interpStatus === INTERP.COMPATIBLE && finalized.selectedSense) {
      const sense = finalized.selectedSense;
      const composed = composeSenseMeaning(sense.glossEn, MEANING_MAX_LENGTH);
      if (!composed.fits) {
        return {
          reading,
          meaning: {
            action: 'blank',
            value: '',
            glossesUsed: [],
            glossCount: Array.isArray(sense.glossEn) ? sense.glossEn.length : 0,
            remainingCount: Array.isArray(sense.glossEn) ? sense.glossEn.length : 0,
            entryId: sense.entryId || null,
            senseId: typeof sense.senseNo === 'number' ? sense.senseNo : null,
            provenance: null,
            senseChoices: null,
            entryChoices: null
          }
        };
      }
      return {
        reading,
        meaning: {
          action: 'prefill',
          value: composed.value,
          glossesUsed: composed.glossesUsed,
          glossCount: composed.glossCount,
          remainingCount: composed.remainingCount,
          entryId: sense.entryId || null,
          senseId: typeof sense.senseNo === 'number' ? sense.senseNo : null,
          provenance: 'dictionary',
          senseChoices: null,
          entryChoices: null
        }
      };
    }

    if (interpStatus === INTERP.AMBIGUOUS) {
      const all = Array.isArray(finalized.compatibleSenses) ? finalized.compatibleSenses : [];
      const choices = all.slice(0, SENSE_CHOICE_CAP).map((sense) => ({
        entryId: sense.entryId,
        senseId: sense.senseNo,
        glosses: Array.isArray(sense.glossEn) ? [...sense.glossEn] : [],
        pos: Array.isArray(sense.pos) ? [...sense.pos] : []
      }));
      return {
        reading,
        meaning: {
          action: 'choose',
          value: '',
          glossesUsed: [],
          glossCount: 0,
          remainingCount: Math.max(0, all.length - choices.length),
          entryId: finalized.selectedEntryId || null,
          senseId: null,
          provenance: null,
          senseChoices: choices,
          entryChoices: null
        }
      };
    }

    // UNIQUE + UNAVAILABLE (glossless) or any other: reading stands, meaning blank.
    return { reading, meaning: blankMeaning() };
  }

  if (matchStatus === MATCH.MULTIPLE) {
    const entries = Array.isArray(finalized.survivingEntries) ? finalized.survivingEntries : [];
    // Stable display order only (finalizeCandidate order: common first, then
    // entry id) — never ranked-best, never alternatives[0] as reading.
    const entryChoices = entries.slice(0, ENTRY_CHOICE_CAP).map((entry) => {
      const diet = dietEntry(entry);
      const firstSense = (entry.senses || []).find((s) => Array.isArray(s.glossEn) && s.glossEn.length);
      return {
        entryId: entry.entryId,
        kanji: diet.kanji,
        kana: diet.kana,
        glossPreview: firstSense ? String(firstSense.glossEn[0]) : '',
        pos: Array.isArray(entry.posSummary) ? [...entry.posSummary] : []
      };
    });
    const totalCompatible = Array.isArray(finalized.compatibleSenses) ? finalized.compatibleSenses.length : 0;
    return {
      reading: blankReading(),
      meaning: {
        action: 'choose-entry-then-sense',
        value: '',
        glossesUsed: [],
        glossCount: 0,
        remainingCount: Math.max(0, entries.length - entryChoices.length),
        entryId: null,
        senseId: null,
        provenance: null,
        senseChoices: null,
        entryChoices,
        _compatibleTotal: totalCompatible
      }
    };
  }

  // NO_MATCH, UNAVAILABLE, UNSUPPORTED -> blanks.
  return { reading: blankReading(), meaning: blankMeaning() };
}

function buildHint(finalized) {
  if (finalized && finalized.matchStatus === MATCH.NO_MATCH) return NO_MATCH_HINT;
  return null;
}

function pinFromQ1(pin, sha256Verified) {
  if (!pin) return null;
  return {
    sourceId: String(pin.sourceId),
    sourceName: String(pin.sourceName),
    converter: String(pin.converter),
    converterVersion: String(pin.converterVersion),
    fileDate: String(pin.fileDate),
    sha256Verified: sha256Verified === true || sha256Verified === 1 ? true
      : sha256Verified === false || sha256Verified === 0 ? false
      : null
  };
}

async function fetchSha256Verified(pool, sourceId) {
  try {
    const [rows] = await pool.execute(
      'SELECT sha256_verified FROM jmdict_sources WHERE source_id = ?',
      [sourceId]
    );
    const row = rows && rows[0];
    if (!row) return null;
    const value = row.sha256_verified !== undefined ? row.sha256_verified : row.sha256Verified;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    return null;
  } catch (_) {
    return null;
  }
}

// Ownership via matchOwnedVocabulary semantics: exact word -> existing
// ("Existing in Vocabulary"); reading-correlated -> possible-match
// ("Possible existing match"), bounded to 3; never "duplicate confirmed";
// throw -> unavailable, never "new". user_id is always the first bind via
// matchOwnedVocabulary (placeholders only, never interpolated, never JOIN
// vocabulary<->jmdict). includeOwnership=false skips vocabulary queries
// entirely (caller guarantees).
async function resolveOwnership(pool, userId, word, dictReadings) {
  const readings = [...new Set((Array.isArray(dictReadings) ? dictReadings : []).filter((r) => typeof r === 'string' && r !== ''))].slice(0, 5);
  const candidate = {
    key: `standalone::${word}`,
    canonical: word,
    lemma: word,
    pos: null,
    lemmaReading: readings[0] || null,
    surfaceReading: null,
    observed: [],
    match: { state: 'new', ownedCount: 0, possibleMatches: [] }
  };
  try {
    await matchOwnedVocabulary(pool, userId, [candidate]);
  } catch (_) {
    return { state: 'unavailable', matches: [] };
  }
  const state = candidate.match && candidate.match.state;
  if (state === 'existing') {
    return {
      state: 'existing',
      matches: [{ word, reading: readings[0] || null }]
    };
  }
  if (state === 'ambiguous') {
    const matches = (candidate.match.possibleMatches || []).slice(0, 3).map((m) => ({
      word: m.word,
      reading: null
    }));
    return { state: 'possible-match', matches };
  }
  return { state: 'new', matches: [] };
}

function unavailableAutofill({ word, reason, retryable, pin, ownership, item }) {
  const reading = blankReading();
  const meaning = blankMeaning();
  return {
    word,
    dictionaryMatch: item ? item.dictionaryMatch : { status: MATCH.UNAVAILABLE, reason, identityStrategy: null, lookupTruncated: false, entries: [], entryCount: 0, selectedEntryId: null, readings: { suggested: null, alternatives: [], provenance: null } },
    interpretation: item ? item.interpretation : { status: INTERP.NOT_APPLICABLE, evaluationTruncated: false, selectedSense: null, compatibleSenses: [], remainingCount: 0, evidenceSummary: { codes: [], excludedBy: {} }, reason: 'reference-unavailable' },
    reason,
    retryable,
    pin: pin || null,
    item: item || null,
    fieldHints: { reading, meaning },
    ownership: ownership || null,
    hint: null
  };
}

// POST /api/vocabulary/autofill orchestration. Never throws for dictionary
// failures (degrades to UNAVAILABLE blanks in-payload, HTTP 200 at the
// controller). Only validation/auth errors are real HTTP errors (thrown by
// the controller before calling here).
async function resolveAutofill({ pool, word, userId, includeOwnership = true } = {}) {
  const candidate = buildStandaloneCandidate(word);

  // Pos-less bypass: eligibleCandidate is intentionally NOT consulted
  // (proper nouns get an ordinary exact lookup). Everything else reuses the
  // frozen pipeline identically.
  void safeIdentityStrings;
  void strategyFor;
  void evaluateSenses;
  const identity = identityKeysFor(candidate);
  if (!identity) {
    const ownership = includeOwnership
      ? await resolveOwnership(pool, userId, word, [])
      : null;
    const noId = {
      candidateKey: candidate.key,
      canonical: candidate.canonical,
      matchStatus: MATCH.NO_MATCH,
      matchReason: 'no-safe-identity',
      identityStrategy: null,
      lookupTruncated: false,
      evaluationTruncated: false,
      selectedEntryId: null,
      survivingEntries: [],
      itemReadings: { suggested: null, alternatives: [], provenance: null },
      interpretationStatus: INTERP.NOT_APPLICABLE,
      interpretationReason: 'nothing-to-interpret',
      selectedSense: null,
      compatibleSenses: [],
      evidenceSummary: { codes: [], excludedBy: {} }
    };
    const item = buildItem(noId);
    const { reading, meaning } = buildFieldHints(noId);
    return {
      word,
      dictionaryMatch: item.dictionaryMatch,
      interpretation: item.interpretation,
      reason: noId.matchReason,
      retryable: false,
      pin: null,
      item,
      fieldHints: { reading, meaning },
      ownership,
      hint: NO_MATCH_HINT
    };
  }

  const sqlKeys = identity.keys.map((key, index) => ({
    candidateIdx: index,
    normalized: key.normalized,
    kind: identity.kind
  }));

  let pin;
  let cohorts;
  try {
    void buildQ1;
    ({ pin, cohorts } = await runQ1(pool, sqlKeys));
  } catch (_) {
    const ownership = includeOwnership
      ? await resolveOwnership(pool, userId, word, [])
      : null;
    return unavailableAutofill({
      word,
      reason: 'reference-query-failed',
      retryable: true,
      pin: null,
      ownership,
      item: {
        key: candidate.key,
        canonical: candidate.canonical,
        dictionaryMatch: { status: MATCH.UNAVAILABLE, identityStrategy: identity.strategy, lookupTruncated: false, entries: [], entryCount: 0, selectedEntryId: null, readings: { suggested: null, alternatives: [], provenance: null }, reason: 'reference-query-failed' },
        interpretation: { status: INTERP.NOT_APPLICABLE, evaluationTruncated: false, selectedSense: null, compatibleSenses: [], remainingCount: 0, evidenceSummary: { codes: [], excludedBy: {} }, reason: 'reference-unavailable' }
      }
    });
  }

  if (!pin) {
    const ownership = includeOwnership
      ? await resolveOwnership(pool, userId, word, [])
      : null;
    return unavailableAutofill({
      word,
      reason: 'version-absent',
      retryable: false,
      pin: null,
      ownership,
      item: {
        key: candidate.key,
        canonical: candidate.canonical,
        dictionaryMatch: { status: MATCH.UNAVAILABLE, identityStrategy: identity.strategy, lookupTruncated: false, entries: [], entryCount: 0, selectedEntryId: null, readings: { suggested: null, alternatives: [], provenance: null }, reason: 'version-absent' },
        interpretation: { status: INTERP.NOT_APPLICABLE, evaluationTruncated: false, selectedSense: null, compatibleSenses: [], remainingCount: 0, evidenceSummary: { codes: [], excludedBy: {} }, reason: 'reference-unavailable' }
      }
    });
  }

  // Per-slot cohorts (single candidate): dedup by entry, Q1 sentinel
  // preserved. Lookup truncation forbids UNIQUE exactly like Context.
  const cohortRows = [];
  const entryIds = [];
  const seen = new Set();
  let lookupTruncated = false;
  for (let idx = 0; idx < identity.keys.length; idx += 1) {
    const cohort = cohorts.get(idx);
    if (!cohort) continue;
    if (cohort.truncated) lookupTruncated = true;
    for (const row of cohort.rows) {
      cohortRows.push(row);
      if (!seen.has(row.entryId)) {
        seen.add(row.entryId);
        entryIds.push(row.entryId);
      }
    }
  }

  const sha256Verified = await fetchSha256Verified(pool, pin.sourceId);
  const fullPin = pinFromQ1(pin, sha256Verified);

  if (!cohortRows.length) {
    const noMatch = finalizeCandidate({
      candidate,
      identity,
      cohortRows: [],
      lookupTruncated: false,
      entries: new Map(),
      inflectionType: null
    });
    const item = buildItem(noMatch);
    const { reading, meaning } = buildFieldHints(noMatch);
    const ownership = includeOwnership
      ? await resolveOwnership(pool, userId, word, [])
      : null;
    return {
      word,
      dictionaryMatch: item.dictionaryMatch,
      interpretation: item.interpretation,
      reason: noMatch.matchReason,
      retryable: false,
      pin: fullPin,
      item,
      fieldHints: { reading, meaning },
      ownership,
      hint: NO_MATCH_HINT
    };
  }

  let sensesByEntry = new Map();
  let formsByEntry = new Map();
  try {
    void buildQ2Senses;
    void buildQ2Forms;
    ({ sensesByEntry, formsByEntry } = await runQ2(pool, pin.sourceId, entryIds));
  } catch (_) {
    const ownership = includeOwnership
      ? await resolveOwnership(pool, userId, word, [])
      : null;
    return unavailableAutofill({
      word,
      reason: 'sense-evaluation-failed',
      retryable: true,
      pin: fullPin,
      ownership,
      item: {
        key: candidate.key,
        canonical: candidate.canonical,
        dictionaryMatch: { status: MATCH.UNAVAILABLE, identityStrategy: identity.strategy, lookupTruncated: false, entries: [], entryCount: 0, selectedEntryId: null, readings: { suggested: null, alternatives: [], provenance: null }, reason: 'sense-evaluation-failed' },
        interpretation: { status: INTERP.UNAVAILABLE, evaluationTruncated: false, selectedSense: null, compatibleSenses: [], remainingCount: 0, evidenceSummary: { codes: [], excludedBy: {} }, reason: 'sense-evaluation-failed' }
      }
    });
  }

  const data = new Map();
  for (const id of entryIds) {
    const senses = sensesByEntry.get(id);
    const forms = formsByEntry.get(id);
    data.set(id, {
      senses: senses ? senses.senses : [],
      evaluationTruncated: senses ? senses.truncated : false,
      forms: forms ? forms.forms : [],
      formsTruncated: forms ? forms.truncated : false,
      posSummary: senses ? senses.posSummary : [],
      isCommon: senses ? senses.isCommon : false
    });
  }

  const finalized = finalizeCandidate({
    candidate,
    identity,
    cohortRows,
    lookupTruncated,
    entries: data,
    inflectionType: null
  });
  const item = buildItem(finalized);
  const { reading, meaning } = buildFieldHints(finalized);
  const hint = buildHint(finalized);

  const dictReadings = [];
  if (item.dictionaryMatch.readings) {
    if (item.dictionaryMatch.readings.suggested) dictReadings.push(item.dictionaryMatch.readings.suggested);
    for (const alt of item.dictionaryMatch.readings.alternatives || []) dictReadings.push(alt);
  }
  // UNIQUE readings come from the selected entry; MULTIPLE has none by
  // design (never alternatives[0]). Ownership reading correlation therefore
  // only applies to UNIQUE results — MULTIPLE stays word-exact or new.
  const ownership = includeOwnership
    ? await resolveOwnership(pool, userId, word, finalized.matchStatus === MATCH.UNIQUE ? dictReadings : [])
    : null;

  const topReason = finalized.matchStatus === MATCH.UNIQUE && finalized.interpretationStatus === INTERP.COMPATIBLE
    ? null
    : finalized.matchReason;
  const retryable = false;

  return {
    word,
    dictionaryMatch: item.dictionaryMatch,
    interpretation: item.interpretation,
    reason: topReason,
    retryable,
    pin: fullPin,
    item,
    fieldHints: { reading, meaning },
    ownership,
    hint
  };
}

// Entry-drill reading hint: backend is the semantic authority over
// whole-word readings for the pinned entry, derived via the frozen
// resolveReadings over the already-fetched Q2 form inventory. Synthetic
// identity is built from the entry's own keb inventory (ORTHOGRAPHIC); for
// kana-only entries (no keb) a READING_FALLBACK identity over the entry's
// reb inventory is used. Exactly-one applicable whole-word reading ->
// prefill; multiple -> choose with explicit choices; none -> blank. Same
// shape as fieldHints.reading. Never alternatives[0] as value, never
// per-kanji inference.
function buildEntryReading(allForms) {
  try {
    const forms = Array.isArray(allForms) ? allForms : [];
    const kebSurfaces = [...new Set(
      forms
        .filter((f) => f && f.kind === 'keb' && typeof f.surface === 'string' && f.surface !== '')
        .map((f) => f.surface)
    )];
    let resolved = null;
    if (kebSurfaces.length) {
      const identity = {
        strategy: 'ORTHOGRAPHIC',
        kind: 'keb',
        keys: kebSurfaces.map((value) => ({ value })),
        lemmaReading: null
      };
      resolved = resolveReadings(identity, forms, []);
    } else {
      const rebSurfaces = [...new Set(
        forms
          .filter((f) => f && f.kind === 'reb' && typeof f.surface === 'string' && f.surface !== '')
          .map((f) => f.surface)
      )];
      if (!rebSurfaces.length) return blankReading();
      const identity = {
        strategy: 'READING_FALLBACK',
        kind: 'reb',
        keys: rebSurfaces.map((value) => ({ value })),
        lemmaReading: null
      };
      const matchedRows = forms
        .filter((f) => f && f.kind === 'reb' && typeof f.surface === 'string' && f.surface !== '')
        .map((f) => ({ kind: 'reb', surface: f.surface }));
      resolved = resolveReadings(identity, forms, matchedRows);
    }
    const alternatives = resolved && Array.isArray(resolved.alternatives)
      ? resolved.alternatives.slice(0, 5)
      : [];
    if (resolved && typeof resolved.suggested === 'string' && resolved.suggested !== '') {
      return { action: 'prefill', value: resolved.suggested, choices: alternatives, provenance: 'dictionary' };
    }
    if (alternatives.length) {
      return { action: 'choose', value: null, choices: alternatives, provenance: 'dictionary' };
    }
  } catch (_) {
    // fall through to blank
  }
  return blankReading();
}

// POST /api/vocabulary/autofill/entry: drill into one pinned entry.
// Pinned equality: the supplied sourceId IS the pin (explicit sourceId to
// Q2, never re-reads the active pointer, never allocate/activate/prune).
// Returns {status:'ok',...} | {status:'unavailable',...} | {status:'not-found'}.
async function resolveAutofillEntry({ pool, sourceId, entryId, senseCursor = 0 } = {}) {
  const sid = String(sourceId);
  const eid = String(entryId);
  const cursor = Number(senseCursor);

  let sourceRow = null;
  try {
    const [rows] = await pool.execute(
      'SELECT source_id, source_name, converter, converter_version, file_date, sha256_verified, status FROM jmdict_sources WHERE source_id = ?',
      [sid]
    );
    sourceRow = rows && rows[0] ? rows[0] : null;
  } catch (_) {
    // Transient source-verification failure: reference query failed,
    // retryable. Deterministic stale (absent / not-ready) is handled below
    // and stays snapshot-unavailable.
    return { status: 'unavailable', reason: 'reference-query-failed', retryable: true, pin: null };
  }

  const status = sourceRow ? sourceRow.status : null;
  if (!sourceRow || status !== 'ready') {
    return { status: 'unavailable', reason: 'snapshot-unavailable', retryable: false, pin: null };
  }

  const pin = {
    sourceId: String(sourceRow.source_id !== undefined ? sourceRow.source_id : sid),
    sourceName: String(sourceRow.source_name),
    converter: String(sourceRow.converter),
    converterVersion: String(sourceRow.converter_version),
    fileDate: sourceRow.file_date instanceof Date
      ? sourceRow.file_date.toISOString().slice(0, 10)
      : String(sourceRow.file_date),
    sha256Verified: sourceRow.sha256_verified === true || sourceRow.sha256_verified === 1 ? true
      : sourceRow.sha256_verified === false || sourceRow.sha256_verified === 0 ? false
      : null
  };

  let sensesByEntry;
  let formsByEntry;
  try {
    ({ sensesByEntry, formsByEntry } = await runQ2(pool, sid, [eid]));
  } catch (_) {
    return { status: 'unavailable', reason: 'reference-query-failed', retryable: true, pin: null };
  }

  const sensesBucket = sensesByEntry.get(eid);
  const formsBucket = formsByEntry.get(eid);
  if (!sensesBucket && !formsBucket) {
    return { status: 'not-found', pin };
  }

  const allSenses = sensesBucket ? sensesBucket.senses : [];
  const sensesTruncated = sensesBucket ? sensesBucket.truncated === true : false;
  const formsTruncated = formsBucket ? formsBucket.truncated === true : false;
  const posSummary = sensesBucket ? sensesBucket.posSummary : [];
  const isCommon = sensesBucket ? sensesBucket.isCommon : false;
  const allForms = formsBucket ? formsBucket.forms : [];

  const entry = dietEntry({
    entryId: eid,
    posSummary,
    isCommon,
    matchedForms: [],
    allForms
  });

  // FULL gloss arrays (no DISPLAY_MAX_GLOSSES slice): explicit user pick
  // needs complete sense text. Cursor paginates fixed pages over the
  // 64-usable (+1 sentinel) valve.
  const full = allSenses.map((sense) => ({
    senseId: sense.senseNo,
    glosses: Array.isArray(sense.glossEn) ? [...sense.glossEn] : [],
    glossCount: Array.isArray(sense.glossEn) ? sense.glossEn.length : 0,
    pos: Array.isArray(sense.pos) ? [...sense.pos] : [],
    stagk: Array.isArray(sense.stagk) ? [...sense.stagk] : [],
    stagr: Array.isArray(sense.stagr) ? [...sense.stagr] : []
  }));
  const start = Math.min(Math.max(cursor, 0), Math.max(full.length, 0));
  const page = full.slice(start, start + ENTRY_SENSE_PAGE_SIZE);
  const nextCursor = start + ENTRY_SENSE_PAGE_SIZE < full.length ? start + ENTRY_SENSE_PAGE_SIZE : null;
  const reading = buildEntryReading(allForms);

  return {
    status: 'ok',
    pin,
    entry,
    reading,
    senses: page,
    senseCursor: start,
    nextCursor,
    truncated: sensesTruncated || formsTruncated,
    totalSenses: full.length
  };
}

module.exports = {
  NO_MATCH_HINT,
  MEANING_MAX_LENGTH,
  SENSE_CHOICE_CAP,
  ENTRY_CHOICE_CAP,
  ENTRY_SENSE_PAGE_SIZE,
  ENTRY_SENSE_CURSOR_MAX,
  composeSenseMeaning,
  buildFieldHints,
  buildHint,
  resolveOwnership,
  resolveAutofill,
  resolveAutofillEntry
};
