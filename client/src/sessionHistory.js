// Study Sessions history UX — pure, testable helpers (no DOM, no imports).
//
// sessionCardModel drives the session-history card: compact badge +
// duration + date on top, writing title (or a fallback derived from existing
// info) as the primary line, a short writing/notes preview, and metadata
// rows ONLY for fields with real information. Absent fields are omitted
// entirely — never rendered as "No X recorded" placeholders.
//
// SESSION_FORM_FIELD_ORDER + buildSessionSubmitPayload drive the Add/Edit
// form (Basic → Linked material → Writing → Notes). Manual linking is a
// compact optional section: vocabulary_ids / kanji_ids / grammar_ids travel
// only when the form supplies them. The backend treats omitted relationship
// arrays as "leave untouched" (no DELETE) and supplied arrays (even empty)
// as "replace", so Add sends the pickers' values and Edit round-trips the
// record's current links — nothing is ever silently cleared. Writing notes
// stay hidden from the form and are never submitted, so the backend keeps
// existing writing notes on edit. No automatic/magical linking is attempted:
// the form only records what the learner explicitly links.

export const SESSION_FORM_FIELD_ORDER = [
  'category',
  'session_date',
  'duration_minutes',
  'resource',
  'vocabulary_ids',
  'kanji_ids',
  'grammar_ids',
  'writing_title',
  'writing_content',
  'notes'
];

const LINKING_FIELD_NAMES = ['vocabulary_ids', 'kanji_ids', 'grammar_ids'];

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function positiveCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Single canonical study-duration formatter (presentation only): minutes
// below 60 stay compact (`45m`), 60+ collapse to hours (`1hr`, `1hr30m`,
// `2hr`). Pure and DOM-free so sessionCardModel and every UI caller share
// one implementation; ui.js re-exports it next to formatDate for callers
// that already import from there. No backend logic is duplicated here.
export function formatDuration(minutes) {
  const total = Math.round(Number(minutes));
  if (!Number.isFinite(total) || total <= 0) return '0m';
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}hr` : `${hours}hr${rest}m`;
}

export function sessionCardModel(session) {
  const record = session && typeof session === 'object' ? session : {};
  const resource = cleanText(record.resource);
  const category = cleanText(record.category);
  const meta = [];
  if (resource) meta.push({ key: 'resource', label: 'Resource', text: resource });
  const counts = [
    ['vocabulary_count', 'Vocabulary'],
    ['kanji_count', 'Kanji'],
    ['grammar_count', 'Grammar']
  ];
  for (const [key, label] of counts) {
    const number = positiveCount(record[key]);
    if (number) meta.push({ key, label, text: `${number} item${number === 1 ? '' : 's'}` });
  }
  const minutes = Number(record.duration_minutes);
  return {
    badge: category || 'Session',
    durationLabel: Number.isFinite(minutes) && minutes > 0 ? formatDuration(minutes) : null,
    // Raw YYYY-MM-DD; the card formats it for display.
    dateValue: cleanText(record.session_date) || '',
    title: cleanText(record.writing_title) || resource || `${category || 'Study'} session`,
    preview: cleanText(record.writing_excerpt) || cleanText(record.writing_content) || cleanText(record.notes),
    meta
  };
}

// Builds the create/update payload from form values. Linking ID arrays pass
// through only when the form supplies them (the compact "Linked material"
// pickers); when absent they are omitted so an edit preserves existing links.
// Writing title/content travel only when the user actually wrote something.
// writing_notes is NEVER included (hidden from the form, backend keeps it).
export function buildSessionSubmitPayload(values) {
  const source = values && typeof values === 'object' ? values : {};
  const text = (value) => {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    return String(value);
  };
  const payload = {
    session_date: text(source.session_date),
    duration_minutes: Number(source.duration_minutes),
    category: text(source.category),
    resource: text(source.resource),
    notes: text(source.notes)
  };
  for (const field of LINKING_FIELD_NAMES) {
    if (source[field] === undefined) continue;
    const ids = Array.isArray(source[field]) ? source[field] : [];
    payload[field] = [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  }
  const writingTitle = text(source.writing_title);
  const writingContent = text(source.writing_content);
  if (writingTitle.trim() || writingContent.trim()) {
    payload.writing_title = writingTitle;
    payload.writing_content = writingContent;
  }
  return payload;
}

// True when the payload names no linking arrays and no writing_notes — the
// edit-safe omit path where the backend preserves existing relationships and
// writing notes. Payloads built from the "Linked material" pickers name the
// linking arrays explicitly (replace semantics) and correctly return false.
export function submitPayloadOmitsHiddenFields(payload) {
  const present = payload && typeof payload === 'object' ? Object.keys(payload) : [];
  return [...LINKING_FIELD_NAMES, 'writing_notes'].every((field) => !present.includes(field));
}
