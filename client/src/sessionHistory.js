// Study Sessions history UX — pure, testable helpers (no DOM, no imports).
//
// sessionCardModel drives the session-history card: compact badge +
// duration + date on top, writing title (or a fallback derived from existing
// info) as the primary line, a short writing/notes preview, and metadata
// rows ONLY for fields with real information. Absent fields are omitted
// entirely — never rendered as "No X recorded" placeholders.
//
// SESSION_FORM_FIELD_ORDER + buildSessionSubmitPayload drive the simplified
// Add/Edit form (Basic → Resource → Writing → Notes). Manual linking
// controls and Writing notes are hidden from the form and never submitted:
// the backend treats omitted relationship arrays as "leave untouched" (no
// DELETE) and omitted writing_notes as "keep current notes", so hidden
// existing data survives edit/save.

export const SESSION_FORM_FIELD_ORDER = [
  'category',
  'session_date',
  'duration_minutes',
  'resource',
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
    durationLabel: Number.isFinite(minutes) && minutes > 0 ? `${minutes} min` : null,
    // Raw YYYY-MM-DD; the card formats it for display.
    dateValue: cleanText(record.session_date) || '',
    title: cleanText(record.writing_title) || resource || `${category || 'Study'} session`,
    preview: cleanText(record.writing_excerpt) || cleanText(record.writing_content) || cleanText(record.notes),
    meta
  };
}

// Builds the create/update payload from visible form values only.
// Linking IDs and writing_notes are NEVER included. Writing title/content
// travel only when the user actually wrote something.
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
  const writingTitle = text(source.writing_title);
  const writingContent = text(source.writing_content);
  if (writingTitle.trim() || writingContent.trim()) {
    payload.writing_title = writingTitle;
    payload.writing_content = writingContent;
  }
  return payload;
}

export function submitPayloadOmitsHiddenFields(payload) {
  const present = payload && typeof payload === 'object' ? Object.keys(payload) : [];
  return [...LINKING_FIELD_NAMES, 'writing_notes'].every((field) => !present.includes(field));
}
