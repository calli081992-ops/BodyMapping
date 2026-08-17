# Supabase migration tests

Self-contained validation for `supabase/migrations/*.sql`. No external test framework
or dependencies beyond a PostgreSQL server and `psql`.

## What it checks

`run_tests.sh` (via `npm run test:db`) spins up a throwaway database and:

1. applies a **Supabase-baseline stub** (`00_supabase_baseline_stub.sql`: the `auth`
   schema, `auth.uid()`, and the `anon`/`authenticated`/`service_role` roles a real
   Supabase project already provides);
2. applies every migration in order with `ON_ERROR_STOP`;
3. re-applies them to prove **idempotency**;
4. seeds fixtures and runs self-verifying assertions (`10_assertions.sql`) as the
   `authenticated`/`service_role` roles, so Row-Level Security is enforced as in Supabase.

Assertions cover: no RLS recursion + members reading their org/memberships (`005`/`006`),
tenant + cross-org isolation, `can_edit_client` / `can_manage_client_access` scoping
(`002`), email-queue enqueue authorization (`003`), job update authorization +
immutability (`004`), the retention delete guard, the generated full-text `tsvector`,
that every RLS helper is `SECURITY DEFINER`, and that a therapist can create + see
their own client via `insert ... returning` (`007`). Any regression raises and the
runner exits non-zero.

## Running

```bash
# This repo's dev VM (peer auth as the postgres superuser):
npm run test:db            # or: sudo -u postgres bash supabase/test/run_tests.sh

# CI / custom server (role must be able to CREATE DATABASE):
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bash supabase/test/run_tests.sh
```

Env overrides: `PSQL` (custom psql command/connection), `ADMIN_DB` (database used to
create the scratch DB, default `postgres`), `TEST_DB` (scratch DB name, default
`soap_migration_test`).

## Applying migrations to the real Supabase project

The baseline stub is **for local testing only** — never apply it to real Supabase. To
apply just the migrations to the actual project, use a direct Postgres connection
string (the API keys cannot run DDL):

```bash
SUPABASE_DB_URL="postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres" \
  bash supabase/apply_migrations.sh
```
