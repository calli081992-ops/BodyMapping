# Supabase migration tests

Self-contained validation for `supabase/migrations/*.sql`. No external test framework
or dependencies beyond a PostgreSQL server and `psql`.

## What it checks

`run_tests.sh` spins up a throwaway database and:

1. applies a **Supabase-baseline stub** (`00_supabase_baseline_stub.sql`: the `auth`
   schema, `auth.uid()`, and the `anon`/`authenticated`/`service_role` roles that a
   real Supabase project already provides);
2. applies every migration in order with `ON_ERROR_STOP`;
3. re-applies them to prove **idempotency**;
4. seeds fixtures and runs self-verifying assertions (`10_assertions.sql`) as the
   `authenticated` role, so Row-Level Security is enforced exactly as in Supabase.

Assertions cover: no RLS recursion, cross-org tenant isolation, the `002` self-grant
loophole being closed, creator/owner grants still working, tenant-key immutability,
`003` non-admin client creation via `INSERT ... RETURNING`, the retention delete
guard, the 10-year retention default, and the generated full-text `tsvector`. Any
regression raises an exception and the runner exits non-zero.

## Running

```bash
# This repo's dev VM (peer auth as the postgres superuser):
npm run test:db            # or: sudo -u postgres bash supabase/test/run_tests.sh

# CI / custom server (role must be able to CREATE DATABASE):
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash supabase/test/run_tests.sh
```

Environment overrides: `PSQL` (custom psql command/connection), `ADMIN_DB` (database
used to create the scratch DB, default `postgres`), `TEST_DB` (scratch DB name,
default `soap_migration_test`).

## Applying migrations to the real Supabase project

The test baseline stub is **for local testing only** — never apply it to a real
Supabase database. To apply just the migrations to the actual project, use a direct
Postgres connection string (the API keys cannot run DDL):

```bash
SUPABASE_DB_URL="postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres" \
  bash supabase/apply_migrations.sh
```
