#!/usr/bin/env bash
# Run psql inside the Postgres container, using the user and database that
# docker-compose configured. Any arguments are passed straight to psql.
#   scripts/psql.sh -c "select count(*) from papers"
#   scripts/psql.sh < db/tests/001_schema_test.sql
set -euo pipefail
cd "$(dirname "$0")/.."
# -T: no TTY, so SQL can be piped in through stdin.
# Single quotes: $POSTGRES_USER / $POSTGRES_DB are expanded inside the container.
exec docker compose exec -T db sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
