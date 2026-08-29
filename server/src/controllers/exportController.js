const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');

const EXPORT_QUERIES = {
  studySessions: 'SELECT id_session, session_date, duration_minutes, category, resource, notes, created_at, updated_at FROM study_sessions ORDER BY id_session',
  vocabulary: 'SELECT id_vocabulary, word, reading, meaning, jlpt_level, status, notes, created_at, updated_at FROM vocabulary ORDER BY id_vocabulary',
  kanji: 'SELECT id_kanji, character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes, created_at, updated_at FROM kanji ORDER BY id_kanji',
  grammarPoints: 'SELECT id_grammar, grammar_point, meaning, structure, example, jlpt_level, status, notes, created_at, updated_at FROM grammar_points ORDER BY id_grammar',
  kanjiVocabulary: 'SELECT id_kanji, id_vocabulary FROM kanji_vocabulary ORDER BY id_kanji, id_vocabulary',
  sessionVocabulary: 'SELECT id_session, id_vocabulary FROM session_vocabulary ORDER BY id_session, id_vocabulary',
  sessionKanji: 'SELECT id_session, id_kanji FROM session_kanji ORDER BY id_session, id_kanji',
  sessionGrammar: 'SELECT id_session, id_grammar FROM session_grammar ORDER BY id_session, id_grammar'
};

async function exportBackup(req, res) {
  try {
    const entries = await Promise.all(Object.entries(EXPORT_QUERIES).map(async ([name, query]) => {
      const [rows] = await pool.query(query);
      return [name, rows];
    }));
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="jlt-backup-${date}.json"`);
    return res.json({
      version: 1,
      database: 'jlt',
      exportedAt: new Date().toISOString(),
      data: Object.fromEntries(entries)
    });
  } catch (error) {
    return sendRouteError(res, error, {
      defaultStatus: 503,
      defaultMessage: 'Unable to export backup.'
    });
  }
}

module.exports = { exportBackup };
