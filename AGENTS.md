# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single Node.js/Express app (HIPAA SOAP notes for massage therapists) backed by Supabase Postgres. Standard commands live in `README.md` and `package.json`; the notes below cover non-obvious startup/run/test caveats.

### Runtime / services
- **Node >= 22 is required** (`@supabase/supabase-js` needs `>=22`; Express 5 `>=18`, AWS SDK v3 `>=20`). The cloud VM ships Node 22.
- The update script (`.cursor/environment.json`) installs deterministically from the lockfile (`npm ci`) and auto-creates `.env` from `.env.example`, so `npm test`, `npm run test:db`, and `npm run dev` work immediately on a fresh VM.
- Dev server: `npm run dev` (`node --watch`), serves on `PORT` (default 3000): UI at `/`, health at `/health`, API under `/api`.
- `npm test` runs the Node built-in test runner over `test/*.test.js` (no external services). No lint tooling is configured.

### Key gotcha: the server boots with placeholder env
- `src/config.js` validates env vars with Zod at startup but only checks their **format**, not that credentials are real; it fails fast (listing missing vars) otherwise. The auto-created `.env` satisfies the format checks, so the server boots and serves `/health`, the static UI, and PDF generation without real credentials.
- `EMAIL_QUEUE_ENABLED` defaults to `true`, so `npm run dev` starts the background email worker (`src/services/email-queue-worker.js`). With placeholder Supabase it logs poll errors but does not crash; set `EMAIL_QUEUE_ENABLED=false` to silence it.
- Real `/api/*` end-to-end needs real credentials: Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — the worker uses the service role, which bypasses RLS; server-side only), AWS S3 (`AWS_REGION`, `AWS_S3_BUCKET`, credentials), and Paubox (`PAUBOX_*`). `.env` is gitignored; never commit real credentials.

### Database / migrations
- Migrations live in `supabase/migrations/` (`001`–`007`) and target Supabase Postgres. They assume the Supabase-managed baseline exists (`auth` schema, `auth.uid()`, and the `anon`/`authenticated`/`service_role` roles).
- `007_client_primary_creator_visibility.sql` lets a client's creator/primary therapist see it without a `client_access` row (fixes `POST /api/clients` `insert ... returning` for non-admin therapists). The `clients` SELECT policy checks the row's own `created_by`/`primary` columns directly — required for the `RETURNING` case, since a `STABLE` re-query helper uses the statement-start snapshot and can't see the row inserted by the same statement.
- **RLS helper functions must be `SECURITY DEFINER`.** `current_therapist_id`, `has_org_role`, `can_access_client`, `is_org_member`, `can_manage_client_access`, `can_edit_client`, and `can_manage_email_delivery_job` read tables whose own policies call them; as `SECURITY INVOKER` they cause `infinite recursion detected in policy ...`. `005` makes them all `SECURITY DEFINER`; keep it that way. `006` additionally rewrites the `organization_memberships` select policy to `using (is_org_member(...))` (an inline self-subquery there also recursed).
- **Automated tests:** `npm run test:db` (runner: `supabase/test/run_tests.sh`; needs a local PostgreSQL — on this dev VM: `sudo -u postgres bash supabase/test/run_tests.sh`). It spins up a throwaway DB, applies a Supabase-baseline stub + all migrations twice (idempotency), seeds fixtures, and runs self-verifying RLS assertions (no recursion, tenant isolation, access-control scoping, email-queue enqueue/update authz + immutability, retention guard, full-text search, and that all RLS helpers are `SECURITY DEFINER`). Any regression exits non-zero. Add an assertion in `supabase/test/10_assertions.sql` when you change policies. Never apply `supabase/test/00_supabase_baseline_stub.sql` to real Supabase — it only stubs objects Supabase already provides.
- **Apply to the real project:** `SUPABASE_DB_URL=... bash supabase/apply_migrations.sh` (a direct Postgres connection string — the anon/service-role API keys cannot run DDL). Apply migrations in numeric order.
