// Deck suggestions (light PRs): propose title/description edits, decided by
// the deck owner. Accept auto-applies title/description; anything else was
// rejected at creation time, so application never surprises.
const { ValidationError } = require('../errors/http');

const SUGGESTABLE_FIELDS = {
  title: { max: 120 },
  description: { max: 500 }
};
const MAX_CHANGES = 20;

function sanitizeChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) {
    throw new ValidationError(`suggestedChanges must hold 1-${MAX_CHANGES} changes`);
  }
  return changes.map((change, index) => {
    const field = change?.field;
    const rule = SUGGESTABLE_FIELDS[field];
    if (!rule) throw new ValidationError(`changes[${index}].field must be title or description`);
    const oldValue = String(change?.oldValue ?? '');
    const newValue = String(change?.newValue ?? '').trim();
    if (!newValue || newValue.length > rule.max) {
      throw new ValidationError(`changes[${index}].newValue must be 1-${rule.max} characters`);
    }
    const reason = String(change?.reason ?? '').trim();
    if (!reason || reason.length > 500) {
      throw new ValidationError(`changes[${index}].reason is required (max 500 characters)`);
    }
    return { field, oldValue, newValue, reason };
  });
}

async function deckOwnerId(executor, deckId) {
  const [rows] = await executor.execute(
    'SELECT owner_id, is_public FROM deck_publications WHERE id_deck_publication = ?',
    [deckId]
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function createSuggestion(executor, deckId, proposerId, changes) {
  const deck = await deckOwnerId(executor, deckId);
  if (!deck || (!deck.is_public && deck.is_public !== 1)) return null;
  if (String(deck.owner_id) === String(proposerId)) throw new ValidationError('authors cannot suggest edits to their own deck');
  const clean = sanitizeChanges(changes);
  const [inserted] = await executor.execute(
    `INSERT INTO deck_suggestions (id_deck_publication, proposer_id, changes_json)
     VALUES (?, ?, ?::jsonb)`,
    [deckId, proposerId, JSON.stringify(clean)]
  );
  return { id: Number(inserted?.insertId), status: 'pending' };
}

async function listSuggestions(executor, deckId, viewerId) {
  const deck = await deckOwnerId(executor, deckId);
  if (!deck) return null;
  if (String(deck.owner_id) !== String(viewerId)) return null;
  const [rows] = await executor.execute(
    `SELECT id_deck_suggestion AS id, proposer_id, changes_json, status, comment, created_at, decided_at
     FROM deck_suggestions WHERE id_deck_publication = ? ORDER BY id_deck_suggestion DESC`,
    [deckId]
  );
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: Number(row.id),
    proposerId: row.proposer_id,
    changes: row.changes_json,
    status: row.status,
    comment: row.comment || null,
    createdAt: row.created_at,
    decidedAt: row.decided_at || null
  }));
}

async function decideSuggestion(executor, suggestionId, viewerId, { decision, comment }) {
  if (!['accept', 'reject'].includes(decision)) throw new ValidationError("decision must be 'accept' or 'reject'");
  const [rows] = await executor.execute(
    `SELECT s.id_deck_suggestion AS id, s.id_deck_publication AS deck_id, s.changes_json, s.status, d.owner_id
     FROM deck_suggestions s JOIN deck_publications d ON d.id_deck_publication = s.id_deck_publication
     WHERE s.id_deck_suggestion = ?`,
    [suggestionId]
  );
  const suggestion = Array.isArray(rows) ? rows[0] : null;
  if (!suggestion || String(suggestion.owner_id) !== String(viewerId)) return null;
  if (suggestion.status !== 'pending') throw new ValidationError('suggestion was already decided');
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  if (decision === 'accept') {
    const updates = [];
    const params = [];
    for (const change of Array.isArray(suggestion.changes_json) ? suggestion.changes_json : []) {
      if (change?.field === 'title' || change?.field === 'description') {
        updates.push(`${change.field} = ?`);
        params.push(String(change.newValue ?? '').slice(0, change.field === 'title' ? 120 : 500));
      }
    }
    if (updates.length) {
      await executor.execute(
        `UPDATE deck_publications SET ${updates.join(', ')} WHERE id_deck_publication = ?`,
        [...params, suggestion.deck_id]
      );
    }
  }
  await executor.execute(
    'UPDATE deck_suggestions SET status = ?, comment = ?, decided_at = CURRENT_TIMESTAMP, decided_by = ? WHERE id_deck_suggestion = ?',
    [status, comment ? String(comment).slice(0, 500) : null, viewerId, suggestionId]
  );
  return { id: Number(suggestion.id), status };
}

module.exports = {
  createSuggestion,
  decideSuggestion,
  listSuggestions,
  sanitizeChanges
};
