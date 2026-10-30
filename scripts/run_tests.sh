#!/usr/bin/env bash
# Run every SQL test in db/tests (files starting with "_" are shared helpers,
# not tests). Each test prints a PASS/FAIL table and rolls back its own data.
# Exits non-zero if any test row says FAIL or if psql hits an error.
set -uo pipefail
cd "$(dirname "$0")/.."

shopt -s nullglob
tests=(db/tests/[0-9]*.sql)
if [ ${#tests[@]} -eq 0 ]; then echo "No tests found in db/tests"; exit 1; fi

failed=0
for f in "${tests[@]}"; do
  echo
  echo "################ $f ################"
  # psql runs inside the container and cannot read files from this folder,
  # so the shared helpers and the test are piped in as one stream.
  out=$(cat db/tests/_helpers.sql "$f" | scripts/psql.sh 2>&1)
  status=$?
  echo "$out"
  if [ $status -ne 0 ] || echo "$out" | grep -qw "FAIL"; then
    echo "!!! $f FAILED"
    failed=1
  fi
done

echo
if [ $failed -eq 0 ]; then echo "ALL TESTS PASSED"; else echo "SOME TESTS FAILED"; exit 1; fi
