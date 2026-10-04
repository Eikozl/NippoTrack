const postgresPool = require('./postgresRuntime');

const ID_COLUMNS = {
  vocabulary: 'id_vocabulary', kanji: 'id_kanji', grammar_points: 'id_grammar', study_sessions: 'id_session',
  session_writings: 'id_session_writing', usage_examples: 'id_usage_example', grammar_examples: 'id_grammar_example', goals: 'id_goal',
  content_entries: 'id_content_entry', notes: 'id_note', tags: 'id_tag', review_items: 'id_review_item', review_events: 'id_review_event',
  deck_publications: 'id_deck_publication', deck_publication_items: 'id_deck_publication_item', deck_suggestions: 'id_deck_suggestion', deck_collections: 'id_deck_collection'
};

function placeholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function convertSql(source) {
  let sql = source
    .replace(/\bCONCAT\(' ',\s*COALESCE\(meaning, ''\)\)/gi, "(' ' || COALESCE(meaning, ''))")
    .replace(/\bDATE\(created_at\)/gi, 'created_at::date')
    .replace(/\sLIKE\s/gi, ' ILIKE ');
  return placeholders(sql);
}

function mysqlLikeResult(result, sql) {
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) return [result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value])))];
  const inserted = result.rows[0];
  return [{ affectedRows: result.rowCount || 0, insertId: inserted ? Number(Object.values(inserted)[0]) : undefined }];
}

function prepare(sql) {
  const match = sql.match(/^\s*INSERT\s+INTO\s+([a-z_]+)/i);
  if (!match || /\bRETURNING\b/i.test(sql)) return sql;
  const id = ID_COLUMNS[match[1].toLowerCase()];
  return id ? `${sql} RETURNING ${id}` : sql;
}

function wrap(client, { release = false } = {}) {
  return {
    async execute(sql, params = []) { const result = await client.query(convertSql(prepare(sql)), params); return mysqlLikeResult(result, sql); },
    async query(sql, params = []) { const result = await client.query(convertSql(prepare(sql)), params); return mysqlLikeResult(result, sql); },
    beginTransaction() { return client.query('BEGIN'); },
    commit() { return client.query('COMMIT'); },
    rollback() { return client.query('ROLLBACK'); },
    release() { if (release) client.release(); }
  };
}

module.exports = {
  async execute(sql, params = []) { const client = await postgresPool.connect(); try { return await wrap(client).execute(sql, params); } finally { client.release(); } },
  async query(sql, params = []) { const client = await postgresPool.connect(); try { return await wrap(client).query(sql, params); } finally { client.release(); } },
  async getConnection() { return wrap(await postgresPool.connect(), { release: true }); },
  end() { return postgresPool.end(); },
  // Exposed for regression tests: every user-insertable table with an
  // identity PK must map here or bare INSERTs lose their insertId on
  // Postgres (see reviewController's RETURNING note for the exception).
  ID_COLUMNS
};
