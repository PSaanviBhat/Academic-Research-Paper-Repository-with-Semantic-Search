#!/usr/bin/env bash
# Rebuild the database from scratch in one command:
#   1. make sure the Postgres container is up and healthy
#   2. drop the whole "public" schema (every table, view, function, trigger and row)
#   3. apply every numbered migration in db/ in order (001_, 002_, ...)
# psql stops at the first error (ON_ERROR_STOP), so a broken migration fails loudly.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait db

echo "==> Dropping and recreating schema 'public'"
scripts/psql.sh -q -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

for f in db/[0-9][0-9][0-9]_*.sql; do
  echo "==> Applying $f"
  scripts/psql.sh -q < "$f"
done

echo "==> Done. Tables now in the database:"
scripts/psql.sh -c "\dt"
