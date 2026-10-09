// Community profile interests: canonical multi-select values. Stored on
// the profile as a comma-joined string (same `interests` column, no
// migration); the discover matcher normalizes server-side, so legacy free
// text keeps working and simply matches less often.
export const PROFILE_INTEREST_OPTIONS = [
  'anime',
  'manga',
  'gaming',
  'travel',
  'conversation',
  'reading',
  'grammar',
  'kanji',
  'jlpt prep',
  'business',
  'music',
  'cooking'
];

export function parseProfileInterests(value) {
  const found = new Set();
  for (const token of String(value || '').split(/[,;]/)) {
    const cleaned = token.trim().toLowerCase();
    if (PROFILE_INTEREST_OPTIONS.includes(cleaned)) found.add(cleaned);
  }
  return [...found];
}

export function formatProfileInterests(values) {
  const unique = [];
  for (const value of Array.isArray(values) ? values : []) {
    const cleaned = String(value || '').trim().toLowerCase();
    if (PROFILE_INTEREST_OPTIONS.includes(cleaned) && !unique.includes(cleaned)) unique.push(cleaned);
  }
  return unique.join(', ');
}
