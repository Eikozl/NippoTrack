import { apiRequest } from './api.js';

export function speechPieces() {
  const hasWindow = typeof window !== 'undefined';
  return {
    synthesis: hasWindow ? window.speechSynthesis : null,
    Utterance: hasWindow ? window.SpeechSynthesisUtterance : null
  };
}

export function deckItemDisplay(kind, entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (kind === 'kanji') return entry.character_kanji || entry.display || null;
  if (kind === 'grammar') return entry.grammar_point || entry.display || null;
  return entry.word || entry.display || entry.title || null;
}

export function isUsableMeaning(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/[-–—―]$/.test(text) || /^[-–—―]/.test(text)) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (/[\r\n]/.test(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return true;
}

export const SINGLE_HAN = /^\p{Script=Han}$/u;

export function deckItemSaveable(kind, entry) {
  const display = deckItemDisplay(kind, entry);
  if (!display) return false;
  if (!isUsableMeaning(entry?.meaning)) return false;
  if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return false;
  return true;
}

export function ownedIdFromSaveResponse(kind, data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = kind === 'kanji'
    ? [data.id_kanji, data.idKanji, data.id, data.insertId]
    : kind === 'grammar'
      ? [data.id_grammar, data.idGrammar, data.id, data.insertId]
      : [data.id_vocabulary, data.idVocabulary, data.id, data.insertId];
  for (const candidate of candidates) {
    const id = Number(candidate);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

export async function findOwnedEntityId(kind, display) {
  const text = String(display || '').trim();
  if (!text) return null;
  const endpoint = kind === 'kanji' ? '/api/kanji/options' : kind === 'grammar' ? '/api/grammar/options' : '/api/vocabulary/options';
  try {
    const data = await apiRequest(`${endpoint}?search=${encodeURIComponent(text)}&limit=20`);
    const rows = Array.isArray(data?.items) ? data.items : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (kind === 'kanji' && String(row.character_kanji || '') === text) {
        const id = Number(row.id_kanji);
        if (Number.isInteger(id) && id > 0) return id;
      } else if (kind === 'grammar' && String(row.grammar_point || '') === text) {
        const id = Number(row.id_grammar);
        if (Number.isInteger(id) && id > 0) return id;
      } else if (kind !== 'kanji' && kind !== 'grammar' && String(row.word || '') === text) {
        const id = Number(row.id_vocabulary);
        if (Number.isInteger(id) && id > 0) return id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function saveDeckItemReturningId(kind, entry) {
  const display = deckItemDisplay(kind, entry);
  const meaning = String(entry?.meaning || '').trim();
  if (!display || !isUsableMeaning(meaning)) return null;
  if (kind === 'kanji' && !SINGLE_HAN.test(String(display))) return null;
  try {
    let created = null;
    if (kind === 'kanji') {
      created = await apiRequest('/api/kanji', { method: 'POST', body: { character_kanji: display, meaning } });
    } else if (kind === 'grammar') {
      created = await apiRequest('/api/grammar', { method: 'POST', body: { grammar_point: display, meaning } });
    } else {
      created = await apiRequest('/api/vocabulary', { method: 'POST', body: { word: display, ...(entry.reading ? { reading: entry.reading } : {}), meaning } });
    }
    const entityId = ownedIdFromSaveResponse(kind, created);
    return entityId ? { entityId, saved: true } : null;
  } catch (error) {
    if (error?.status === 409) {
      const existing = error?.data?.existingKanji;
      const existingId = Number(existing?.idKanji ?? existing?.id_kanji ?? existing?.id);
      if (Number.isInteger(existingId) && existingId > 0) return { entityId: existingId, already: true };
    }
    return null;
  }
}

export async function ensureDeckOwnedId(kind, entry) {
  const display = deckItemDisplay(kind, entry);
  if (!display || !deckItemSaveable(kind, entry)) return null;
  const existing = await findOwnedEntityId(kind, display);
  if (existing) return { entityId: existing, already: true };
  const saved = await saveDeckItemReturningId(kind, entry);
  if (saved) return saved;
  const retry = await findOwnedEntityId(kind, display);
  if (retry) return { entityId: retry, already: true };
  return null;
}

export function todayISODate() {
  try {
    return new Date().toISOString().slice(0, 10);
  } catch {
    return '2026-01-01';
  }
}
