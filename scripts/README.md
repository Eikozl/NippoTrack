# Scripts

Root launchers live in `scripts/`; database and import tooling lives in `server/scripts/`
(invoked via root or `server/package.json` scripts). This file documents targets only —
behavior is unchanged.

| Script | Target DB | One-shot? | Guard? |
| --- | --- | --- | --- |
| `scripts/development-environment.js` | Selects the server env file (`server/.env.development` vs `server/.env.integration`) | No (launcher helper for `dev.js`) | Pairs with `production-guard.js` |
| `scripts/production-guard.js` | None (guard library: dev/client/DB-target identity checks) | No | THE fail-closed guard (enforced in `dev.js`, `server/index.js`, `client/vite.config.js`) |
| `scripts/dev-integration-proxy.js` | None (TCP `3000`→`3101` proxy, integration mode only) | Per run (spawned by `dev.js`) | None needed (loopback proxy) |
| `server/scripts/check-db.js` (`db:check`) | Legacy MariaDB `jlt` (`mariadbSource`) — FROZEN | No (read-only probe) | Direct-DB script: confirm target before running; do not point at Postgres |
| `server/scripts/check-postgres-db.js` (`postgres:check`) | Postgres admin pool (`postgres.js`, `POSTGRES_*`) | No (read-only probe) | Direct-DB script: confirm target before running |
| `server/scripts/backup-db.js` | Legacy MariaDB `jlt` — FROZEN | Yes (writes backup file passed as arg) | Do not use for Postgres (use `postgres:backup`) |
| `server/scripts/run-migration.js` | Legacy MariaDB V2 `db/migrations` — FROZEN | Yes (one migration file per run) | Do not use for Postgres (use `postgres:migrate`) |
| `server/scripts/audit-mariadb-source.js` | Legacy MariaDB (read-only source audit) — FROZEN | Yes (writes report JSON passed as arg) | Read-only; do not extend |
| Other `server/scripts/*` (`postgres:migrate`, `postgres:backup`, `postgres:import`, ownership/backfill/verify, kanji/jmdict/grammar imports) | Per file header and `server/package.json` script name — not audited in this pass | Per file | Direct-DB scripts: confirm the resolved target (host/user/project ref) before running anything write-capable |

## Naming note (not a rename)

`db:check` is the **legacy MariaDB** probe (`server/scripts/check-db.js` → `mariadbSource`);
`postgres:check` is the **Postgres** probe (`server/scripts/check-postgres-db.js` →
`postgres.js`). The names are confusingly close but scripts are NOT renamed in this pass —
read the Target DB column above before running either.
