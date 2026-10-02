const pool = require('../src/config/postgres');
const { assertExpectedDbTarget } = require('../../scripts/production-guard');

const applicationTables = `
  SELECT c.oid, c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
         pg_get_userbyid(c.relowner) AS owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
  ORDER BY c.relname`;

// Tables where jlt_runtime has only SELECT (no writes permitted at runtime).
const readOnlyRuntimeTables = new Set([
  'grammar_reference',
  'kanji_reference',
  'jmdict_sources',
  'jmdict_active_snapshot',
  'jmdict_entries',
  'jmdict_forms',
  'jmdict_senses'
]);

// Tables where jlt_runtime has only SELECT + INSERT (append-only; no UPDATE/DELETE).
// These use per-command policies instead of a single jlt_runtime_crud/ALL policy.
const appendOnlyRuntimeTables = new Set(['kanji_encounters']);

// Tables with bespoke per-command policies instead of a single
// jlt_runtime_crud/ALL policy (permission intent lives in the owning migration).
const splitPolicyTables = {
  user_jlpt_target: [
    { name: 'user_jlpt_target_runtime_select', command: 'SELECT' },
    { name: 'user_jlpt_target_runtime_write', command: 'ALL' },
  ],
  user_first_experience: [
    { name: 'user_first_experience_runtime_select', command: 'SELECT' },
    { name: 'user_first_experience_runtime_write', command: 'ALL' },
  ],
  user_profile: [
    { name: 'user_profile_runtime_select', command: 'SELECT' },
    { name: 'user_profile_runtime_write', command: 'ALL' },
  ],
};

// Returns the list of { name, command } policy descriptors expected for a table.
function expectedPolicies(tableName) {
  if (readOnlyRuntimeTables.has(tableName)) {
    return [{ name: `${tableName}_runtime_select`, command: 'SELECT' }];
  }
  if (splitPolicyTables[tableName]) return splitPolicyTables[tableName];
  if (appendOnlyRuntimeTables.has(tableName)) {
    return [
      { name: 'kanji_encounters_runtime_select', command: 'SELECT' },
      { name: 'kanji_encounters_runtime_insert', command: 'INSERT' },
    ];
  }
  return [{ name: 'jlt_runtime_crud', command: 'ALL' }];
}

function expectedRuntimePrivileges(tableName) {
  if (readOnlyRuntimeTables.has(tableName)) return ['SELECT'];
  if (appendOnlyRuntimeTables.has(tableName)) return ['SELECT', 'INSERT'];
  return ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
}

async function main() {
  try {
    assertExpectedDbTarget({ host: process.env.POSTGRES_HOST, user: process.env.POSTGRES_USER, source: process.env.POSTGRES_ENV_FILE || '.env.postgres' });
    const [roleResult, tablesResult, ownershipResult, policiesResult, apiTablePrivileges, apiSequencePrivileges, publicPrivileges, functionsResult, triggerFunctions, defaultPrivileges, schemaPrivileges, migrationPrivileges, runtimeTablePrivileges, runtimeSequencePrivileges] = await Promise.all([
      pool.query(`SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = 'jlt_runtime'`),
      pool.query(applicationTables),
      pool.query(`SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r', 'S') AND pg_get_userbyid(c.relowner) = 'jlt_runtime' ORDER BY c.relname`),
      pool.query(`SELECT tablename, policyname, roles, cmd FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname`),
      pool.query(`SELECT c.relname, r.rolname, privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r CROSS JOIN LATERAL unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS privilege_type WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'schema_migrations' AND r.rolname IN ('anon','authenticated') AND has_table_privilege(r.oid, c.oid, privilege_type) ORDER BY c.relname, r.rolname, privilege_type`),
      pool.query(`SELECT c.relname, r.rolname, privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r CROSS JOIN LATERAL unnest(ARRAY['USAGE','SELECT','UPDATE']) AS privilege_type WHERE n.nspname='public' AND c.relkind='S' AND r.rolname IN ('anon','authenticated') AND has_sequence_privilege(r.oid, c.oid, privilege_type) ORDER BY c.relname, r.rolname, privilege_type`),
      pool.query(`SELECT c.relname, c.relkind, e.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) e WHERE n.nspname='public' AND c.relkind IN ('r','S') AND e.grantee=0 ORDER BY c.relkind, c.relname, e.privilege_type`),
      pool.query(`SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, coalesce(r.rolname, 'PUBLIC') AS grantee, e.privilege_type FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) e ON true LEFT JOIN pg_roles r ON r.oid=e.grantee WHERE n.nspname='public' ORDER BY p.proname, grantee, e.privilege_type`),
      pool.query(`SELECT t.tgname, c.relname AS table_name, p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`),
      pool.query(`SELECT pg_get_userbyid(d.defaclrole) AS owner, d.defaclobjtype, coalesce(r.rolname, 'PUBLIC') AS grantee, e.privilege_type FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) e LEFT JOIN pg_roles r ON r.oid=e.grantee WHERE d.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public') AND pg_get_userbyid(d.defaclrole)='postgres' AND (r.rolname IN ('anon','authenticated') OR e.grantee=0) ORDER BY owner, d.defaclobjtype, grantee, e.privilege_type`),
      pool.query(`SELECT r.rolname, privilege_type FROM pg_roles r CROSS JOIN LATERAL unnest(ARRAY['USAGE','CREATE']) privilege_type WHERE r.rolname IN ('anon','authenticated','jlt_runtime') AND has_schema_privilege(r.oid, 'public', privilege_type) ORDER BY r.rolname, privilege_type`),
      pool.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='schema_migrations' AND grantee='jlt_runtime' ORDER BY privilege_type`),
      pool.query(`SELECT c.relname, privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege_type WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'schema_migrations' AND has_table_privilege('jlt_runtime', c.oid, privilege_type) ORDER BY c.relname, privilege_type`),
      pool.query(`SELECT c.relname, privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL unnest(ARRAY['USAGE','SELECT','UPDATE']) privilege_type WHERE n.nspname='public' AND c.relkind='S' AND has_sequence_privilege('jlt_runtime', c.oid, privilege_type) ORDER BY c.relname, privilege_type`)
    ]);

    const role = roleResult.rows[0];
    const tables = tablesResult.rows;

    // Build a flat list of all expected { tablename, name, command } policy descriptors.
    const expectedPolicySet = tables.flatMap(({ relname }) =>
      expectedPolicies(relname).map((p) => ({ tablename: relname, ...p }))
    );
    // Count how many actual policies exactly satisfy an expected descriptor.
    const actualMatchCount = policiesResult.rows.filter(({ tablename, policyname, cmd }) =>
      expectedPolicySet.some((e) => e.tablename === tablename && e.name === policyname && e.command === cmd)
    ).length;
    const unexpectedPolicies = policiesResult.rows.filter(({ tablename, policyname, roles, cmd }) => {
      if (roles.includes('public') || !roles.includes('jlt_runtime')) return true;
      return !expectedPolicySet.some((e) => e.tablename === tablename && e.name === policyname && e.command === cmd);
    });

    const runtimeTableExtra = runtimeTablePrivileges.rows.filter(({ relname, privilege_type }) => !expectedRuntimePrivileges(relname).includes(privilege_type));
    const runtimeTableMissing = tables.flatMap(({ relname }) => expectedRuntimePrivileges(relname)
      .filter((privilege) => !runtimeTablePrivileges.rows.some((row) => row.relname === relname && row.privilege_type === privilege))
      .map((privilege) => `${relname}:${privilege}`));
    const runtimeSequenceExtra = runtimeSequencePrivileges.rows.filter(({ privilege_type }) => !['USAGE', 'SELECT'].includes(privilege_type));
    const failures = [
      !role || !role.rolcanlogin || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.rolinherit ? 'jlt_runtime attributes are not least-privilege' : null,
      tables.length !== 40 ? `expected 40 application tables, found ${tables.length}` : null,
      tables.some(({ rls_enabled, rls_forced }) => !rls_enabled || !rls_forced) ? 'RLS is not enabled and forced on every application table' : null,
      actualMatchCount !== expectedPolicySet.length ? 'missing explicit least-privilege jlt_runtime policies' : null,
      unexpectedPolicies.length ? 'unexpected or broad RLS policies exist' : null,
      ownershipResult.rowCount ? 'jlt_runtime owns one or more application relations' : null,
      apiTablePrivileges.rowCount ? 'anon or authenticated retains an application-table privilege' : null,
      apiSequencePrivileges.rowCount ? 'anon or authenticated retains a sequence privilege' : null,
      publicPrivileges.rowCount ? 'PUBLIC retains a table or sequence privilege' : null,
      functionsResult.rows.some(({ prosecdef }) => prosecdef) ? 'a public-schema function uses SECURITY DEFINER' : null,
      functionsResult.rows.some(({ grantee, privilege_type }) => grantee === 'PUBLIC' && privilege_type === 'EXECUTE') ? 'a public-schema function remains executable by PUBLIC' : null,
      triggerFunctions.rows.some(({ prosecdef }) => prosecdef) ? 'a trigger calls a SECURITY DEFINER function' : null,
      defaultPrivileges.rowCount ? 'a default privilege can grant anon, authenticated, or PUBLIC future access' : null,
      schemaPrivileges.rows.some(({ rolname, privilege_type }) => ['anon','authenticated'].includes(rolname) || (rolname === 'jlt_runtime' && privilege_type !== 'USAGE')) ? 'schema privileges are broader than intended' : null,
      migrationPrivileges.rowCount ? 'jlt_runtime can access schema_migrations' : null,
      runtimeTableExtra.length || runtimeTableMissing.length ? 'jlt_runtime table privileges are broader or narrower than intended' : null,
      runtimeSequenceExtra.length ? 'jlt_runtime has non-identity sequence privileges' : null
    ].filter(Boolean);
    const report = { role, applicationTables: tables.length, policies: actualMatchCount, triggers: triggerFunctions.rows.length, failures };
    console.log(JSON.stringify(report, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally { /* pool shutdown happens below */ }
}

main().catch((error) => { console.error('Runtime security verification failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
