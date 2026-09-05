// Phase 8 — Smart Text Analyzer, client-side pure helpers (no DOM).
//
// Analyzer entries share the Phase 6 discovery contract, so formatting,
// state mapping, and import-payload conventions reuse vocabularyReading.js
// (formatKanjiContextEntry, getDiscoveryState, getImportableKanji,
// buildKanjiImportPayload). This module only adds analyzer-specific shape:
// occurrence counts, filter matching, and result summaries.

import {
  formatKanjiContextEntry,
  getDiscoveryState
} from './vocabularyReading.js';

// Mirrors server MAX_ANALYZER_TEXT_LENGTH (textKanjiAnalysis.js), which
// follows the writing_content convention. Client-side check is UX only;
// the server re-validates authoritatively.
export const ANALYZER_MAX_LENGTH = 10000;

export const ANALYZER_JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'];

// Filters: collection state first, then reference JLPT level. Unclassified
// means no recognized N5..N1 reference level — kept separate, never merged
// into a level and never presented as a "text level".
export const ANALYZER_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'in_collection', label: 'In collection' },
  { value: 'available', label: 'Available to add' },
  { value: 'no_reference', label: 'No reference data' },
  ...ANALYZER_JLPT_LEVELS.map((level) => ({ value: level, label: level })),
  { value: 'unclassified', label: 'Unclassified' }
];

export function normalizeAnalyzerJlptLevel(value) {
  if (typeof value !== 'string') return 'unclassified';
  const level = value.trim().toUpperCase();
  return ANALYZER_JLPT_LEVELS.includes(level) ? level : 'unclassified';
}

// Formats a raw analyzer entry (discovery-shaped + occurrences) for
// rendering. Occurrences ride along untouched — formatting never claims
// readings (readingSegment stays null via formatKanjiContextEntry).
export function formatAnalyzerEntry(entry) {
  const formatted = formatKanjiContextEntry(entry);
  if (!formatted) return null;
  const occurrences = Number(entry && entry.occurrences);
  return { ...formatted, occurrences: Number.isInteger(occurrences) && occurrences > 0 ? occurrences : 0 };
}

export function formatAnalyzerEntries(kanji) {
  if (!Array.isArray(kanji)) return [];
  return kanji.map(formatAnalyzerEntry).filter(Boolean);
}

export function matchesAnalyzerFilter(formattedEntry, filter) {
  if (!formattedEntry) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'in_collection':
      return getDiscoveryState(formattedEntry) === 'alreadyInCollection';
    case 'available':
      return getDiscoveryState(formattedEntry) === 'availableToAdd';
    case 'no_reference':
      return getDiscoveryState(formattedEntry) === 'noReferenceData';
    case 'unclassified':
      return normalizeAnalyzerJlptLevel(formattedEntry.referenceJlptLevel) === 'unclassified';
    default:
      return normalizeAnalyzerJlptLevel(formattedEntry.referenceJlptLevel) === filter;
  }
}

export function filterAnalyzerEntries(formattedEntries, filter) {
  if (!Array.isArray(formattedEntries)) return [];
  if (!filter || filter === 'all') return [...formattedEntries];
  return formattedEntries.filter((entry) => matchesAnalyzerFilter(entry, filter));
}

// Recomputes state counts locally (e.g. after imports) without re-running
// analysis. Reference distribution is reference-based and unaffected by
// imports, so it is not recomputed here.
export function summarizeAnalyzerEntries(formattedEntries) {
  const list = Array.isArray(formattedEntries) ? formattedEntries : [];
  const summary = {
    uniqueKanji: list.length,
    totalOccurrences: 0,
    inCollection: 0,
    availableToAdd: 0,
    noReferenceData: 0
  };
  for (const entry of list) {
    summary.totalOccurrences += entry.occurrences || 0;
    const state = getDiscoveryState(entry);
    if (state === 'alreadyInCollection') summary.inCollection += 1;
    else if (state === 'availableToAdd') summary.availableToAdd += 1;
    else summary.noReferenceData += 1;
  }
  return summary;
}
