const pool = require('../src/config/postgres');

const roots = ['vocabulary', 'kanji', 'grammar_points', 'study_sessions', 'goals', 'content_entries', 'notes', 'tags'];
const ownerId = process.env.JLT_OWNER_AUTH_USER_ID;

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function requireOwnerId(value) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('JLT_OWNER_AUTH_USER_ID must be a valid Supabase Auth UUID.');
  }
  return value;
}

async function main() {
  const verifiedOwnerId = requireOwnerId(ownerId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4100, 2)');
    const stage = await client.query("SELECT 1 FROM public.schema_migrations WHERE filename = '004_multi_user_ownership_stage_1.sql'");
    if (!stage.rowCount) throw new Error('Apply 004_multi_user_ownership_stage_1.sql before the ownership backfill.');
    const owner = await client.query('SELECT id FROM auth.users WHERE id = $1 AND email_confirmed_at IS NOT NULL', [verifiedOwnerId]);
    if (!owner.rowCount) throw new Error('The configured owner is not a confirmed Supabase Auth user.');

    const result = {};
    for (const table of roots) {
      const foreignOwners = await client.query(`SELECT count(*)::integer AS count FROM public.${quoteIdentifier(table)} WHERE user_id IS NOT NULL AND user_id <> $1`, [verifiedOwnerId]);
      if (foreignOwners.rows[0].count) throw new Error(`${table} already contains rows owned by another user; refusing single-owner backfill.`);
      const updated = await client.query(`UPDATE public.${quoteIdentifier(table)} SET user_id = $1 WHERE user_id IS NULL`, [verifiedOwnerId]);
      const validation = await client.query(`SELECT count(*) FILTER (WHERE user_id IS NULL)::integer AS null_count, count(DISTINCT user_id)::integer AS owner_count FROM public.${quoteIdentifier(table)}`);
      if (validation.rows[0].null_count !== 0 || validation.rows[0].owner_count > 1) throw new Error(`${table} ownership validation failed.`);
      result[table] = { assigned: updated.rowCount, nullRows: validation.rows[0].null_count, distinctOwners: validation.rows[0].owner_count };
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ backfill: 'complete', roots: result, owner: 'verified-and-redacted' }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => { console.error('Multi-user ownership backfill failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
