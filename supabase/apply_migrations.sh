#!/usr/bin/env bash
#
# Applies supabase/migrations/*.sql (in order) to a real database over a direct
# PostgreSQL connection. Intended for the actual Supabase project.
#
# The anon/service-role API keys CANNOT run DDL, so a direct Postgres connection
# string is required. In the Supabase dashboard: Project Settings -> Database ->
# Connection string (URI). Provide it as SUPABASE_DB_URL (or DATABASE_URL):
#
#   SUPABASE_DB_URL="postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres" \
#     bash supabase/apply_migrations.sh
#
# Do NOT apply supabase/test/00_supabase_baseline_stub.sql to a real Supabase
# database — Supabase already provides the auth schema, auth.uid(), and roles.
set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "ERROR: set SUPABASE_DB_URL (or DATABASE_URL) to the Supabase Postgres connection string." >&2
  echo "       Dashboard -> Project Settings -> Database -> Connection string (URI)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/migrations"

for f in "$MIGRATIONS"/*.sql; do
  echo "==> Applying $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -X -q "$DB_URL" -f "$f"
done

echo "All migrations applied."
