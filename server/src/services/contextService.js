// CA-B2 — Context-Aware Vocabulary Intelligence orchestration.
//
// resolveContext({ pool, candidates, tokens, options }) → context block.
// Reusable by the Analyzer and future Vocabulary Auto-Fill: input is
// candidate-shaped data (Phase 12 aggregates), never raw sentence text.
// Tokens are optional and used ONLY to recover head-token inflection
// evidence (inflectionType); candidate aggregates are never mutated.
//
// One call = at most 3 batched DB queries (Q1 pin+lookup, Q2 senses, Q2
// forms), never N+1, always under the pinned snapshot id. This function
// never throws: any internal failure degrades to an explicit unavailable
// block (HTTP stays 200 at the controller). No user text is logged.

const {
  CONTEXT_MAX_CANDIDATES,
  eligibleCandidate,
  identityKeysFor,
  headTokenFor
} = require('./contextIdentity');
const { runQ1, runQ2, CONTEXT_MAX_ENTRIES_Q2 } = require('./contextReference');
const { MATCH, INTERP, finalizeCandidate } = require('./contextFilters');
const { buildItem, buildBlock } = require('./contextResponse');

function unsupportedItem(candidate, reason) {
  return {
    key: candidate.key,
    canonical: candidate.canonical,
    dictionaryMatch: {
      status: MATCH.UNSUPPORTED,
      identityStrategy: null,
      lookupTruncated: false,
      entries: [],
      entryCount: 0,
      selectedEntryId: null,
      readings: { suggested: null, alternatives: [], provenance: null },
      reason
    },
    interpretation: {
      status: INTERP.NOT_APPLICABLE,
      evaluationTruncated: false,
      selectedSense: null,
      compatibleSenses: [],
      remainingCount: 0,
      evidenceSummary: { codes: [], excludedBy: {} },
      reason: 'unsupported-candidate'
    }
  };
}

function unavailableItem(candidate, identity, reason) {
  return {
    key: candidate.key,
    canonical: candidate.canonical,
    dictionaryMatch: {
      status: MATCH.UNAVAILABLE,
      identityStrategy: identity ? identity.strategy : null,
      lookupTruncated: false,
      entries: [],
      entryCount: 0,
      selectedEntryId: null,
      readings: { suggested: null, alternatives: [], provenance: null },
      reason
    },
    interpretation: {
      status: INTERP.NOT_APPLICABLE,
      evaluationTruncated: false,
      selectedSense: null,
      compatibleSenses: [],
      remainingCount: 0,
      evidenceSummary: { codes: [], excludedBy: {} },
      reason: 'reference-unavailable'
    }
  };
}

// Degenerate-but-eligible candidate with no safe identity string at all
// (empty lemma + canonical): no lookup is possible, and nothing compatible
// can remain. NOT_APPLICABLE downstream — no dictionary assertion is made.
function noIdentityItem(candidate) {
  const item = unavailableItem(candidate, null, 'no-safe-identity');
  item.dictionaryMatch.status = MATCH.NO_MATCH;
  item.interpretation.reason = 'nothing-to-interpret';
  return item;
}

function noMatchItem(candidate, identity) {
  const item = unavailableItem(candidate, identity, 'no-compatible-entry');
  item.dictionaryMatch.status = MATCH.NO_MATCH;
  item.interpretation.reason = 'nothing-to-interpret';
  return item;
}

function pinDictionary(pin) {
  // Provenance comes ONLY from the pinned snapshot row Q1 actually read —
  // never from importer constants. The zero-match path pins the same row
  // (same single query), so provenance is identical with matches or not.
  return {
    source: pin.sourceName,
    version: pin.converterVersion,
    fileDate: pin.fileDate,
    converter: pin.converter,
    sourceId: pin.sourceId
  };
}

async function resolveContext({ pool, candidates, tokens, options } = {}) {
  const started = Date.now();
  try {
    return await resolveInner({ pool, candidates, tokens, options, started });
  } catch (_) {
    // Belt and braces: pure-code bugs degrade, never 500 the Analyzer.
    return buildBlock({
      status: 'unavailable',
      reason: 'context-failed',
      dictionary: null,
      items: [],
      warnings: ['context-failed'],
      retryable: true,
      durationMs: Date.now() - started
    });
  }
}

async function resolveInner({ pool, candidates, tokens, options, started }) {
  void options;
  const finish = (partial) => ({ ...partial, durationMs: Date.now() - started });
  const list = Array.isArray(candidates) ? candidates : [];
  const analyzed = list.slice(0, CONTEXT_MAX_CANDIDATES);
  const warnings = [];
  if (list.length > analyzed.length) warnings.push('candidate-cap-reached');

  // Pass 1 (pure): one slot per analyzed candidate, original order kept.
  // Slots are either prebuilt items or prepared lookups — never reordered.
  const slots = analyzed.map((candidate) => {
    const eligibility = eligibleCandidate(candidate);
    if (!eligibility.eligible) return { item: unsupportedItem(candidate, eligibility.reason) };
    const identity = identityKeysFor(candidate);
    if (!identity) return { item: noIdentityItem(candidate) };
    return { candidate, identity, head: headTokenFor(candidate, tokens) };
  });
  const lookupSlots = slots.filter((slot) => !slot.item);

  const finishBlock = ({ status, reason, dictionary, retryable }) =>
    finish(buildBlock({
      status,
      reason,
      dictionary,
      items: slots.map((slot) => slot.item),
      warnings,
      retryable
    }));

  if (!lookupSlots.length) {
    // No dictionary assertion is made: no query, dictionary stays null.
    return finishBlock({ status: 'ok', reason: null, dictionary: null, retryable: false });
  }
  if (!pool || typeof pool.execute !== 'function') {
    throw new Error('resolveContext requires a pool with execute().');
  }

  // Pass 2: Q1 — pin + bounded lookup in ONE round trip.
  const sqlKeys = [];
  lookupSlots.forEach((slot) => {
    slot.firstKeyIdx = sqlKeys.length;
    for (const key of slot.identity.keys) {
      sqlKeys.push({ candidateIdx: sqlKeys.length, normalized: key.normalized, kind: slot.identity.kind });
    }
  });
  let pin;
  let cohorts;
  try {
    ({ pin, cohorts } = await runQ1(pool, sqlKeys));
  } catch (_) {
    for (const slot of lookupSlots) slot.item = unavailableItem(slot.candidate, slot.identity, 'reference-query-failed');
    warnings.push('reference-query-failed');
    return finishBlock({ status: 'unavailable', reason: 'reference-query-failed', dictionary: null, retryable: true });
  }
  if (!pin) {
    for (const slot of lookupSlots) slot.item = unavailableItem(slot.candidate, slot.identity, 'version-absent');
    warnings.push('version-absent');
    return finishBlock({ status: 'unavailable', reason: 'version-absent', dictionary: null, retryable: false });
  }
  const dictionary = pinDictionary(pin);

  // Pass 3: per-slot cohorts (dedup by entry, Q1 sentinel preserved), then
  // the global ≤150 distinct-entry budget for Q2. Overflow marks the
  // affected slot lookupTruncated (UNIQUE forbidden); slots left with a
  // cohort but zero budget evaluate nothing (MULTIPLE + truncated).
  const budgeted = new Set();
  for (const slot of lookupSlots) {
    slot.cohortRows = [];
    slot.entryIds = [];
    const seen = new Set();
    slot.lookupTruncated = false;
    for (let idx = slot.firstKeyIdx; idx < slot.firstKeyIdx + slot.identity.keys.length; idx += 1) {
      const cohort = cohorts.get(idx);
      if (!cohort) continue;
      if (cohort.truncated) slot.lookupTruncated = true;
      for (const row of cohort.rows) {
        slot.cohortRows.push(row);
        if (!seen.has(row.entryId)) {
          seen.add(row.entryId);
          slot.entryIds.push(row.entryId);
        }
      }
    }
    const kept = [];
    for (const id of slot.entryIds) {
      if (budgeted.has(id)) {
        kept.push(id);
        continue;
      }
      if (budgeted.size >= CONTEXT_MAX_ENTRIES_Q2) {
        slot.lookupTruncated = true;
        continue;
      }
      budgeted.add(id);
      kept.push(id);
    }
    slot.entryIds = kept;
    slot.unevaluated = slot.cohortRows.length > 0 && kept.length === 0;
    if (slot.unevaluated) slot.lookupTruncated = true;
  }

  // Pass 4: Q2 senses + forms under the pin (skipped when nothing to fetch).
  // budgeted already holds exactly the distinct kept ids: reuse it directly
  // so shared entries never inflate the VALUES list with duplicates.
  const fetchIds = [...budgeted];
  let sensesByEntry = new Map();
  let formsByEntry = new Map();
  if (fetchIds.length) {
    try {
      ({ sensesByEntry, formsByEntry } = await runQ2(pool, pin.sourceId, fetchIds));
    } catch (_) {
      for (const slot of lookupSlots) {
        if (!slot.cohortRows.length) {
          slot.item = noMatchItem(slot.candidate, slot.identity);
          continue;
        }
        const failed = unavailableItem(slot.candidate, slot.identity, 'sense-evaluation-failed');
        failed.interpretation = {
          status: INTERP.UNAVAILABLE,
          evaluationTruncated: false,
          selectedSense: null,
          compatibleSenses: [],
          remainingCount: 0,
          evidenceSummary: { codes: [], excludedBy: {} },
          reason: 'sense-evaluation-failed'
        };
        slot.item = failed;
      }
      warnings.push('sense-evaluation-failed');
      return finishBlock({ status: 'partial', reason: 'sense-evaluation-failed', dictionary, retryable: true });
    }
  }

  // Pass 5: pure evaluation + diet assembly, request order preserved.
  for (const slot of lookupSlots) {
    if (slot.unevaluated) {
      slot.item = buildItem(finalizeCandidate({
        candidate: slot.candidate,
        identity: slot.identity,
        cohortRows: slot.cohortRows,
        lookupTruncated: true,
        entries: new Map(),
        unevaluated: true,
        inflectionType: slot.head && slot.head.inflectionType
      }));
      continue;
    }
    if (!slot.cohortRows.length) {
      slot.item = noMatchItem(slot.candidate, slot.identity);
      continue;
    }
    const data = new Map();
    for (const id of slot.entryIds) {
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
    slot.item = buildItem(finalizeCandidate({
      candidate: slot.candidate,
      identity: slot.identity,
      cohortRows: slot.cohortRows,
      lookupTruncated: slot.lookupTruncated,
      entries: data,
      inflectionType: slot.head && slot.head.inflectionType
    }));
  }

  let status = 'ok';
  let reason = null;
  // retryable is true ONLY when a transient/infrastructure failure
  // contributed: deterministic structural limits (candidate cap, lookup or
  // evaluation truncation) repeat identically on retry, so they stay false.
  let transientFailure = false;
  for (const slot of slots) {
    if (slot.item.dictionaryMatch.status === MATCH.UNAVAILABLE) {
      status = 'partial';
      reason = reason || 'sense-evaluation-failed';
      transientFailure = true;
    }
    if (slot.item.dictionaryMatch.lookupTruncated && status === 'ok') {
      status = 'partial';
      reason = reason || 'lookup-truncated';
    }
    if (slot.item.interpretation.evaluationTruncated && status === 'ok') {
      status = 'partial';
      reason = reason || 'evaluation-truncated';
    }
  }
  if (warnings.includes('candidate-cap-reached') && status === 'ok') {
    status = 'partial';
    reason = reason || 'candidate-cap-reached';
  }
  if (status === 'partial') {
    if (reason === 'lookup-truncated' && !warnings.includes('lookup-truncated')) warnings.push('lookup-truncated');
    if (reason === 'evaluation-truncated' && !warnings.includes('evaluation-truncated')) warnings.push('evaluation-truncated');
  }
  return finishBlock({ status, reason, dictionary, retryable: transientFailure });
}

module.exports = {
  resolveContext,
  unsupportedItem,
  unavailableItem,
  noMatchItem
};
