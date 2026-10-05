// Reading publications (Reading <-> Community): snapshot-based sharing of
// reading texts, modelled on deckPublications. A publication freezes the
// text (+ editorial translations) so it survives author edits; import copies
// the snapshot into the importer's own library. Only owners can publish
// their own texts; anyone can read public publications and import them.
const { ValidationError } = require('../errors/http');
const { createUserReadingText, parseTranslations } = require('./gradedReader');

const MAX_PUBLICATION_TITLE = 200;
const MAX_PUBLICATION_DESCRIPTION = 500;
const MAX_LIST_LIMIT = 50;

async function publishReading(executor, ownerId, { textId, title, description, isPublic = true }) {
  const id = Number(textId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('textId must be a positive integer.');
  const [rows] = await executor.execute(
    'SELECT id_reading_text, title, level, text, sentence_translations_json FROM reading_texts WHERE id_reading_text = ? AND user_id = ?',
    [id, ownerId]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const cleanTitle = String(title ?? row.title ?? '').trim().slice(0, MAX_PUBLICATION_TITLE);
  if (!cleanTitle) throw new ValidationError('title must be a non-empty string.');
  const cleanDescription = String(description ?? '').trim().slice(0, MAX_PUBLICATION_DESCRIPTION);
  const [inserted] = await executor.execute(
    'INSERT INTO reading_publications (owner_id, title, description, level, text, translations_json, is_public) VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)',
    [ownerId, cleanTitle, cleanDescription, row.level || null, row.text, JSON.stringify(parseTranslations(row.sentence_translations_json)), isPublic !== false]
  );
  const publicationId = Number(inserted?.insertId);
  if (!Number.isSafeInteger(publicationId) || publicationId <= 0) throw new Error('Unable to publish the text.');
  return { id: publicationId };
}

function mapFeedRow(row, viewerId) {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    level: row.level || null,
    isPublic: row.is_public === true || row.is_public === 1,
    mine: String(row.owner_id) === String(viewerId),
    ownerUsername: row.owner_username || null,
    ownerDisplay: row.owner_display || null,
    createdAt: row.created_at,
    chars: Number(row.chars || 0),
    hasTranslations: row.has_translations === true || row.has_translations === 1
  };
}

async function listReadingPublications(executor, { limit = 20, offset = 0, ownerId = null, viewerId = null } = {}) {
  const safeLimit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || 20));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const where = [];
  const params = [];
  if (ownerId) {
    where.push('r.owner_id = ?');
    params.push(ownerId);
  } else {
    where.push('r.is_public = TRUE');
  }
  const [rows] = await executor.execute(
    `SELECT r.id_reading_publication AS id, r.owner_id, r.title, r.description, r.level, r.is_public, r.created_at,
       p.username AS owner_username, p.display_name AS owner_display,
       char_length(r.text) AS chars,
       CASE WHEN r.translations_json IS NOT NULL AND r.translations_json <> '{}'::jsonb THEN true ELSE false END AS has_translations
      FROM reading_publications r
      LEFT JOIN user_profile p ON p.user_id = r.owner_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.id_reading_publication DESC LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );
  return { items: (Array.isArray(rows) ? rows : []).map((row) => mapFeedRow(row, viewerId)) };
}

async function getReadingPublication(executor, publicationId, viewerId) {
  const id = Number(publicationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('publication id must be a positive integer.');
  const [rows] = await executor.execute(
    `SELECT r.id_reading_publication AS id, r.owner_id, r.title, r.description, r.level, r.text,
       r.translations_json, r.is_public, r.created_at,
       p.username AS owner_username, p.display_name AS owner_display
      FROM reading_publications r
      LEFT JOIN user_profile p ON p.user_id = r.owner_id
      WHERE r.id_reading_publication = ?`,
    [id]
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  if (row.is_public !== true && row.is_public !== 1 && String(row.owner_id) !== String(viewerId)) return null;
  return {
    id: Number(row.id),
    ownerId: row.owner_id,
    mine: String(row.owner_id) === String(viewerId),
    title: row.title,
    description: row.description,
    level: row.level || null,
    text: row.text,
    translations: parseTranslations(row.translations_json),
    isPublic: row.is_public === true || row.is_public === 1,
    ownerUsername: row.owner_username || null,
    ownerDisplay: row.owner_display || null,
    createdAt: row.created_at
  };
}

async function deleteReadingPublication(executor, publicationId, viewerId) {
  const id = Number(publicationId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('publication id must be a positive integer.');
  const [rows] = await executor.execute(
    'SELECT owner_id FROM reading_publications WHERE id_reading_publication = ?',
    [id]
  );
  const publication = Array.isArray(rows) ? rows[0] : null;
  if (!publication || String(publication.owner_id) !== String(viewerId)) return null;
  await executor.execute('DELETE FROM reading_publications WHERE id_reading_publication = ?', [id]);
  return { deletedId: Number(publicationId) };
}

async function importReadingPublication(executor, userId, publicationId) {
  const publication = await getReadingPublication(executor, publicationId, userId);
  if (!publication) return null;
  const created = await createUserReadingText(executor, userId, { text: publication.text, title: publication.title });
  const translations = publication.translations && Object.keys(publication.translations).length
    ? publication.translations
    : null;
  if (translations) {
    await executor.execute(
      'UPDATE reading_texts SET sentence_translations_json = ?::jsonb WHERE id_reading_text = ? AND user_id = ?',
      [JSON.stringify(translations), created.id, userId]
    );
  }
  return { id: created.id, title: created.title };
}

module.exports = {
  deleteReadingPublication,
  getReadingPublication,
  importReadingPublication,
  listReadingPublications,
  publishReading
};
