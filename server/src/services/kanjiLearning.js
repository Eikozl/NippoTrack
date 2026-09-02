function publicUserKanji(row) {
  if (!row) return null;
  return {
    idKanji: row.id_kanji,
    character: row.character_kanji,
    meaning: row.meaning,
    jlptLevel: row.jlpt_level,
    status: row.status
  };
}

function runtimeDatabase() {
  return require('../config/db');
}

async function findUserKanjiByCharacter(userId, character, database = runtimeDatabase()) {
  const [rows] = await database.execute(
    'SELECT id_kanji, character_kanji, meaning, jlpt_level, status FROM kanji WHERE user_id = ? AND character_kanji = ?',
    [userId, character]
  );
  return publicUserKanji(rows[0]);
}

module.exports = { findUserKanjiByCharacter };
