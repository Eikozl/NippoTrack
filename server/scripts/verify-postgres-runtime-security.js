const pool = require('../src/config/postgres');

const applicationTables = `
  SELECT c.oid, c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
         pg_get_userbyid(c.relowner) AS owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
  ORDER BY c.relname`;

async function main() {
  try {
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
    const expectedPolicies = new Set(tables.map(({ relname }) => `${relname}:jlt_runtime_crud`));
    const actualPolicies = policiesResult.rows.filter(({ tablename }) => expectedPolicies.has(`${tablename}:jlt_runtime_crud`));
    const unexpectedPolicies = policiesResult.rows.filter(({ roles, cmd }) => roles.includes('public') || !roles.includes('jlt_runtime') || cmd !== 'ALL');
    const runtimeTableExtra = runtimeTablePrivileges.rows.filter(({ privilege_type }) => !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(privilege_type));
    const runtimeSequenceExtra = runtimeSequencePrivileges.rows.filter(({ privilege_type }) => !['USAGE', 'SELECT'].includes(privilege_type));
    const failures = [
      !role || !role.rolcanlogin || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.rolinherit ? 'jlt_runtime attributes are not least-privilege' : null,
      tables.length !== 25 ? `expected 25 application tables, found ${tables.length}` : null,
      tables.some(({ rls_enabled, rls_forced }) => !rls_enabled || !rls_forced) ? 'RLS is not enabled and forced on every application table' : null,
      actualPolicies.length !== tables.length ? 'missing explicit jlt_runtime CRUD policies' : null,
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
      runtimeTableExtra.length ? 'jlt_runtime has non-CRUD table privileges' : null,
      runtimeSequenceExtra.length ? 'jlt_runtime has non-identity sequence privileges' : null
    ].filter(Boolean);
    const report = { role, applicationTables: tables.length, policies: actualPolicies.length, triggers: triggerFunctions.rows.length, failures };
    console.log(JSON.stringify(report, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally { /* pool shutdown happens below */ }
}

main().catch((error) => { console.error('Runtime security verification failed.'); console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
