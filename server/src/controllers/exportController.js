const pool = require('../config/db');
const { sendRouteError } = require('../errors/http');

function exportQueries(userId) {
  return {
    studySessions: ['SELECT id_session, session_date, duration_minutes, category, resource, notes, created_at, updated_at FROM study_sessions WHERE user_id = ? ORDER BY id_session', [userId]],
    vocabulary: ['SELECT id_vocabulary, word, reading, meaning, jlpt_level, status, notes, created_at, updated_at FROM vocabulary WHERE user_id = ? ORDER BY id_vocabulary', [userId]],
    kanji: ['SELECT id_kanji, character_kanji, meaning, onyomi, kunyomi, jlpt_level, status, notes, created_at, updated_at FROM kanji WHERE user_id = ? ORDER BY id_kanji', [userId]],
    grammarPoints: ['SELECT id_grammar, grammar_point, meaning, structure, example, jlpt_level, status, notes, created_at, updated_at FROM grammar_points WHERE user_id = ? ORDER BY id_grammar', [userId]],
    kanjiVocabulary: ['SELECT kv.id_kanji, kv.id_vocabulary FROM kanji_vocabulary kv JOIN kanji k ON k.id_kanji = kv.id_kanji JOIN vocabulary v ON v.id_vocabulary = kv.id_vocabulary WHERE k.user_id = ? AND v.user_id = ? ORDER BY kv.id_kanji, kv.id_vocabulary', [userId, userId]],
    sessionVocabulary: ['SELECT sv.id_session, sv.id_vocabulary FROM session_vocabulary sv JOIN study_sessions s ON s.id_session = sv.id_session JOIN vocabulary v ON v.id_vocabulary = sv.id_vocabulary WHERE s.user_id = ? AND v.user_id = ? ORDER BY sv.id_session, sv.id_vocabulary', [userId, userId]],
    sessionKanji: ['SELECT sk.id_session, sk.id_kanji FROM session_kanji sk JOIN study_sessions s ON s.id_session = sk.id_session JOIN kanji k ON k.id_kanji = sk.id_kanji WHERE s.user_id = ? AND k.user_id = ? ORDER BY sk.id_session, sk.id_kanji', [userId, userId]],
    sessionGrammar: ['SELECT sg.id_session, sg.id_grammar FROM session_grammar sg JOIN study_sessions s ON s.id_session = sg.id_session JOIN grammar_points g ON g.id_grammar = sg.id_grammar WHERE s.user_id = ? AND g.user_id = ? ORDER BY sg.id_session, sg.id_grammar', [userId, userId]]
  };
}

async function exportBackup(req, res) {
  try {
    const entries = await Promise.all(Object.entries(exportQueries(req.user.id)).map(async ([name, [query, params]]) => {
      const [rows] = await pool.query(query, params);
      return [name, rows];
    }));
    const date = new Date().toISOString().slice(0, 10);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="nippotrack-backup-${date}.json"`);
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
