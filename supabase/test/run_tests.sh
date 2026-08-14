#!/usr/bin/env bash
#
# Validates supabase/migrations/*.sql against a throwaway PostgreSQL database:
#   1. applies a Supabase-baseline stub (auth schema, auth.uid(), roles)
#   2. applies every migration in order (ON_ERROR_STOP)
#   3. re-applies them to prove idempotency
#   4. runs self-verifying RLS/behavior assertions
#
# Connection: uses standard libpq env vars (PGHOST/PGPORT/PGUSER/PGPASSWORD) or a
# custom psql command via $PSQL. The connecting role must be able to CREATE DATABASE.
#
#   Local (this repo's dev VM):  sudo -u postgres bash supabase/test/run_tests.sh
#   CI / custom:                 PSQL="psql 'postgresql://user:pass@host:5432/postgres'" bash supabase/test/run_tests.sh
#
# Override the scratch DB name with TEST_DB (default: soap_migration_test).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$(cd "$HERE/../migrations" && pwd)"
PSQL="${PSQL:-psql}"
ADMIN_DB="${ADMIN_DB:-postgres}"
TEST_DB="${TEST_DB:-soap_migration_test}"

admin() { $PSQL -v ON_ERROR_STOP=1 -X -q -d "$ADMIN_DB" "$@"; }
test_db() { $PSQL -v ON_ERROR_STOP=1 -X -q -d "$TEST_DB" "$@"; }

echo "==> Recreating scratch database: $TEST_DB"
admin -c "drop database if exists $TEST_DB;"
admin -c "create database $TEST_DB;"

cleanup() { admin -c "drop database if exists $TEST_DB;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Applying Supabase baseline stub"
test_db -f "$HERE/00_supabase_baseline_stub.sql"

echo "==> Applying migrations"
for f in "$MIGRATIONS"/*.sql; do
  echo "    - $(basename "$f")"
  test_db -f "$f"
done

echo "==> Granting authenticated privileges (Supabase does this automatically)"
test_db -f "$HERE/01_grants.sql"

echo "==> Re-applying migrations (idempotency check)"
for f in "$MIGRATIONS"/*.sql; do test_db -f "$f"; done

echo "==> Seeding test fixtures"
test_db -f "$HERE/05_seed.sql"

echo "==> Running assertions"
test_db -f "$HERE/10_assertions.sql" 2>&1 | sed 's/^psql.*NOTICE:  /  /; s/^NOTICE:  /  /'

echo "ALL DB TESTS PASSED"
