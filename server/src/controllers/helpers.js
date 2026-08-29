const pool = require('../config/db');

const ENTITY_QUERIES = {
  sessions: 'SELECT id_session, session_date, duration_minutes, category, resource, notes FROM study_sessions WHERE id_session = ?',
  vocabulary: 'SELECT id_vocabulary, word, reading, meaning, jlpt_level, status, notes FROM vocabulary WHERE id_vocabulary = ?',
  kanji: 'SELECT id_kanji, character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes FROM kanji WHERE id_kanji = ?',
  grammar: 'SELECT id_grammar, grammar_point, meaning, structure, example, jlpt_level, status, notes FROM grammar_points WHERE id_grammar = ?'
};

async function fetchEntityById(entityName, id) {
  const [rows] = await pool.execute(ENTITY_QUERIES[entityName], [id]);
  return rows[0] || null;
}

async function rollbackAndRelease(connection) {
  try {
    await connection.rollback();
  } catch (rollbackError) {
    console.error('Transaction rollback failed:', rollbackError);
  } finally {
    connection.release();
  }
}

module.exports = {
  fetchEntityById,
  rollbackAndRelease
};
