#!/usr/bin/env bash
# Authentication walkthrough with curl: register, login, logout, sessions,
# and the role guard (researcher vs admin).
# Needs: database + app running (npm --prefix web run dev) and the admin
# account created (npm --prefix web run seed:admin).
#   bash web/tests/auth_curl.sh            (BASE_URL defaults to http://localhost:3000)
set -uo pipefail
cd "$(dirname "$0")/../.."
BASE="${BASE_URL:-http://localhost:3000}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Admin credentials come from .env (never hard-coded here).
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }
ADMIN_EMAIL=$(env_get ADMIN_EMAIL); ADMIN_PASSWORD=$(env_get ADMIN_PASSWORD)
TEST_EMAIL="authtest@example.com"; TEST_PASSWORD="researcher-pass-123"

# Start clean: remove the test accounts left by an earlier run.
bash scripts/psql.sh -q -c "DELETE FROM users WHERE email IN ('authtest@example.com', 'authtest2@example.com')" >/dev/null

pass=0; fail=0
# check <label> <expected HTTP code> <cookie jar> <method> <path> [json body] [text that must appear in the response]
check() {
  local label=$1 want=$2 jar=$3 method=$4 path=$5 body=${6:-} must=${7:-}
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X "$method" -b "$jar" -c "$jar")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" --data "$body")
  local got; got=$(curl "${args[@]}" "$BASE$path")
  local ok=1
  [ "$got" = "$want" ] || ok=0
  if [ -n "$must" ] && ! grep -q -- "$must" "$TMP/body" "$TMP/headers"; then ok=0; fi
  if [ $ok = 1 ]; then pass=$((pass+1)); r="PASS"; else fail=$((fail+1)); r="FAIL"; fi
  printf "%-4s  %-58s expected %s, got %s\n" "$r" "$label" "$want" "$got"
  [ $ok = 1 ] || echo "      response: $(head -c 200 "$TMP/body")"
}

# Cookie jars: R = researcher, A = admin, N = never logged in, J = throwaway for extra sign-ups.
R="$TMP/researcher.jar"; A="$TMP/admin.jar"; N="$TMP/none.jar"; J="$TMP/junk.jar"; : > "$R"; : > "$A"; : > "$N"; : > "$J"
echo "=== AUTH API TESTS against $BASE ==="
check "me without a session"                       401 "$N" GET  /api/auth/me
check "register researcher"                        201 "$R" POST /api/auth/register "{\"name\":\"Auth Test\",\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" '"role":"researcher"'
check "the cookie from register logs you in"       200 "$R" GET  /api/auth/me "" '"email":"authtest@example.com"'
check "register same email again"                  409 "$J" POST /api/auth/register "{\"name\":\"X\",\"email\":\"AuthTest@Example.com\",\"password\":\"whatever-123\"}" '"CONFLICT"'
check "register cannot choose role=admin"          201 "$J" POST /api/auth/register "{\"name\":\"Sneaky\",\"email\":\"authtest2@example.com\",\"password\":\"whatever-123\",\"role\":\"admin\"}" '"role":"researcher"'
check "register with short password"               400 "$J" POST /api/auth/register "{\"name\":\"X\",\"email\":\"short@example.com\",\"password\":\"123\"}" '"VALIDATION_ERROR"'
check "register with bad email"                    400 "$J" POST /api/auth/register "{\"name\":\"X\",\"email\":\"not-an-email\",\"password\":\"whatever-123\"}"
check "researcher: me"                             200 "$R" GET  /api/auth/me "" '"role":"researcher"'
check "researcher: admin-only route is forbidden"  403 "$R" GET  /api/admin/audit-log "" '"FORBIDDEN"'
check "logout"                                     200 "$R" POST /api/auth/logout "" '"ok":true'
check "me after logout"                            401 "$R" GET  /api/auth/me
check "login with wrong password"                  401 "$R" POST /api/auth/login "{\"email\":\"$TEST_EMAIL\",\"password\":\"wrong-password\"}" 'wrong email or password'
check "login with unknown email (same message)"    401 "$R" POST /api/auth/login "{\"email\":\"nobody@example.com\",\"password\":\"wrong-password\"}" 'wrong email or password'
check "login researcher again"                     200 "$R" POST /api/auth/login "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" '"role":"researcher"'
check "no session: admin-only route"               401 "$N" GET  /api/admin/audit-log "" '"UNAUTHENTICATED"'
check "login admin"                                200 "$A" POST /api/auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" '"role":"admin"'
check "admin: admin-only route allowed"            200 "$A" GET  /api/admin/audit-log "" '"results"'

# A forged cookie: valid-looking payload claiming to be the admin, wrong signature.
forged=$(printf '{"uid":1,"exp":9999999999}' | base64 | tr '+/' '-_' | tr -d '=\n')
printf 'localhost\tFALSE\t/\tFALSE\t0\tsession\t%s.forgedsignature\n' "$forged" > "$TMP/forged.jar"
check "forged session cookie is rejected"          401 "$TMP/forged.jar" GET /api/auth/me

# The cookie flags, and what is stored in the database.
curl -s -o /dev/null -D "$TMP/h" -H "Content-Type: application/json" \
  --data "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" "$BASE/api/auth/login"
if grep -qi "^set-cookie: session=.*httponly" "$TMP/h" && grep -qi "samesite=lax" "$TMP/h"; then
  pass=$((pass+1)); echo "PASS  session cookie is HttpOnly and SameSite=Lax"
else fail=$((fail+1)); echo "FAIL  session cookie flags: $(grep -i set-cookie "$TMP/h")"; fi
stored=$(bash scripts/psql.sh -At -c "SELECT left(password_hash, 7) FROM users WHERE email = '$TEST_EMAIL'")
if [ "$stored" = '$2b$10$' ]; then pass=$((pass+1)); echo "PASS  password stored as a bcrypt hash (starts with \$2b\$10\$), not plain text"
else fail=$((fail+1)); echo "FAIL  stored password_hash starts with '$stored'"; fi

echo; echo "$pass passed, $fail failed"
[ $fail -eq 0 ]
