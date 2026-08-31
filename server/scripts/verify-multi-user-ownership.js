const pool = require('../src/config/postgres');

const roots = ['vocabulary', 'kanji', 'grammar_points', 'study_sessions', 'goals', 'content_entries', 'notes', 'tags'];
const expectedConstraints = new Set(['kanji_user_character_kanji_key', 'grammar_points_user_grammar_point_key', 'tags_user_normalized_name_key']);
const crossUserRelations = {
  kanji_vocabulary: 'SELECT count(*)::integer AS count FROM kanji_vocabulary l JOIN kanji k ON k.id_kanji = l.id_kanji JOIN vocabulary v ON v.id_vocabulary = l.id_vocabulary WHERE k.user_id <> v.user_id',
  session_grammar: 'SELECT count(*)::integer AS count FROM session_grammar l JOIN study_sessions s ON s.id_session = l.id_session JOIN grammar_points g ON g.id_grammar = l.id_grammar WHERE s.user_id <> g.user_id',
  session_kanji: 'SELECT count(*)::integer AS count FROM session_kanji l JOIN study_sessions s ON s.id_session = l.id_session JOIN kanji k ON k.id_kanji = l.id_kanji WHERE s.user_id <> k.user_id',
  session_vocabulary: 'SELECT count(*)::integer AS count FROM session_vocabulary l JOIN study_sessions s ON s.id_session = l.id_session JOIN vocabulary v ON v.id_vocabulary = l.id_vocabulary WHERE s.user_id <> v.user_id',
  content_entry_sessions: 'SELECT count(*)::integer AS count FROM content_entry_sessions l JOIN content_entries c ON c.id_content_entry = l.id_content_entry JOIN study_sessions s ON s.id_session = l.id_session WHERE c.user_id <> s.user_id',
  note_study_sessions: 'SELECT count(*)::integer AS count FROM note_study_sessions l JOIN notes n ON n.id_note = l.id_note JOIN study_sessions s ON s.id_session = l.id_session WHERE n.user_id <> s.user_id',
  note_vocabulary: 'SELECT count(*)::integer AS count FROM note_vocabulary l JOIN notes n ON n.id_note = l.id_note JOIN vocabulary v ON v.id_vocabulary = l.id_vocabulary WHERE n.user_id <> v.user_id',
  note_kanji: 'SELECT count(*)::integer AS count FROM note_kanji l JOIN notes n ON n.id_note = l.id_note JOIN kanji k ON k.id_kanji = l.id_kanji WHERE n.user_id <> k.user_id',
  note_grammar: 'SELECT count(*)::integer AS count FROM note_grammar l JOIN notes n ON n.id_note = l.id_note JOIN grammar_points g ON g.id_grammar = l.id_grammar WHERE n.user_id <> g.user_id',
  tag_study_sessions: 'SELECT count(*)::integer AS count FROM tag_study_sessions l JOIN tags t ON t.id_tag = l.id_tag JOIN study_sessions s ON s.id_session = l.id_session WHERE t.user_id <> s.user_id',
  tag_vocabulary: 'SELECT count(*)::integer AS count FROM tag_vocabulary l JOIN tags t ON t.id_tag = l.id_tag JOIN vocabulary v ON v.id_vocabulary = l.id_vocabulary WHERE t.user_id <> v.user_id',
  tag_kanji: 'SELECT count(*)::integer AS count FROM tag_kanji l JOIN tags t ON t.id_tag = l.id_tag JOIN kanji k ON k.id_kanji = l.id_kanji WHERE t.user_id <> k.user_id',
  tag_grammar: 'SELECT count(*)::integer AS count FROM tag_grammar l JOIN tags t ON t.id_tag = l.id_tag JOIN grammar_points g ON g.id_grammar = l.id_grammar WHERE t.user_id <> g.user_id'
};

async function main() {
  const client = await pool.connect();
  try {
    const columns = await client.query("SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY table_name");
    const constraints = await client.query("SELECT conname FROM pg_constraint WHERE conrelid IN ('kanji'::regclass, 'grammar_points'::regclass, 'tags'::regclass) AND conname = ANY($1::text[]) ORDER BY conname", [[...expectedConstraints]]);
    const ownerForeignKeys = await client.query("SELECT c.conrelid::regclass::text AS table_name FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = ANY($1::regclass[]) AND c.confrelid = 'auth.users'::regclass ORDER BY table_name", [roots]);
    const migrations = await client.query("SELECT filename FROM public.schema_migrations WHERE filename IN ('004_multi_user_ownership_stage_1.sql', '005_multi_user_ownership_stage_2.sql') ORDER BY filename");
    const perRoot = {};
    for (const table of roots) {
      const row = (await client.query(`SELECT count(*)::integer AS total, count(*) FILTER (WHERE user_id IS NULL)::integer AS null_users FROM public.${table}`)).rows[0];
      perRoot[table] = { total: Number(row.total), nullUsers: Number(row.null_users) };
    }
    const crossUser = {};
    for (const [table, sql] of Object.entries(crossUserRelations)) crossUser[table] = Number((await client.query(sql)).rows[0].count);
    const failures = [
      columns.rows.length !== roots.length ? 'not every root table has user_id' : null,
      columns.rows.some((row) => row.is_nullable !== 'NO') ? 'a root user_id remains nullable' : null,
      ownerForeignKeys.rows.length !== roots.length ? 'one or more roots do not reference auth.users(id)' : null,
      constraints.rows.length !== expectedConstraints.size ? 'per-user uniqueness constraints are incomplete' : null,
      migrations.rows.length !== 2 ? 'ownership migrations are missing from schema_migrations' : null,
      Object.values(perRoot).some(({ nullUsers }) => nullUsers !== 0) ? 'one or more roots contain null user_id values' : null,
      Object.values(crossUser).some((count) => count !== 0) ? 'a cross-user junction row exists' : null
    ].filter(Boolean);
    console.log(JSON.stringify({ roots: perRoot, crossUserRelations: crossUser, migrations: migrations.rows.map((row) => row.filename), failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().catch((error) => { console.error('Multi-user ownership verification failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
