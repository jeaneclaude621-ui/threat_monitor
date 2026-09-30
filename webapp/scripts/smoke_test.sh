#!/bin/bash
# Smoke test of the API against a running local `wrangler dev` with a seeded
# local D1 and this .dev.vars:
#   DEV_AUTH_EMAIL=the.owner@example.org
#   DEV_AUTH_MACHINE=1
#   READERS=reader@example.com
# and OWNER=the.owner@example.org from wrangler.jsonc. The users table
# is seeded by the Worker on first use from OWNER, ADMINS and READERS.
#
#   scripts/smoke_test.sh [base_url]     (default http://127.0.0.1:8787)
#
# Also runs scripts/auth_test.mjs (JWT verification, no server needed) and
# checks the append-only triggers directly in the local D1.
set -u
cd "$(dirname "$0")/.."
BASE="${1:-http://127.0.0.1:8787}"
PASS=0; FAIL=0

check() {  # name expected_status actual_status [body]
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok    $1 ($3)"
  else FAIL=$((FAIL+1)); echo "  FAIL  $1: expected $2, got $3 ${4:-}"; fi
}
contains() {  # name haystack needle
  if printf '%s' "$2" | grep -q -- "$3"; then PASS=$((PASS+1)); echo "  ok    $1"
  else FAIL=$((FAIL+1)); echo "  FAIL  $1: '$3' not in: ${2:0:200}"; fi
}
req() {  # method path [extra curl args...] -> sets STATUS and BODY
  local method=$1 path=$2; shift 2
  local out; out=$(curl -s -w $'\n%{http_code}' -X "$method" "$BASE$path" "$@")
  STATUS="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
uuid() { node -e 'console.log(crypto.randomUUID())'; }
# wrangler d1 execute against the local DB now and then returns nothing
# while wrangler dev holds it; one retry settles it.
d1() {
  local out; out=$(npx wrangler d1 execute hotmonitor --local --command "$1" 2>&1)
  [ -z "$out" ] && { sleep 1; out=$(npx wrangler d1 execute hotmonitor --local --command "$1" 2>&1); }
  printf '%s' "$out"
}
# Mutating requests from people must carry the app's own Origin.
JSONH=(-H 'Content-Type: application/json' -H "Origin: $BASE")
READER=(-H 'X-Dev-Email: reader@example.com')
MACHINE=(-H 'X-Dev-Machine: 1')

echo "Identity"
req GET /api/me;                          check "admin /api/me" 200 "$STATUS" "$BODY"; contains "role admin" "$BODY" '"role":"admin"'
req GET /api/me "${READER[@]}";           check "reader /api/me" 200 "$STATUS"; contains "role reader" "$BODY" '"role":"reader"'
req GET /api/me -H 'X-Dev-Email: stranger@example.com'; check "unknown email refused" 403 "$STATUS"
req POST /api/me -H "Origin: $BASE";    check "wrong method" 405 "$STATUS"
req GET /api/nothing;                     check "unknown route" 404 "$STATUS"

echo "Reports"
req GET /api/reports;                     check "list reports" 200 "$STATUS"; contains "list has 2026-09-30" "$BODY" '"date":"2026-09-30"'
req GET /api/reports/2026-09-30;          check "one report" 200 "$STATUS"; contains "report body" "$BODY" '"events"'
req GET /api/reports/2099-01-01;          check "missing report" 404 "$STATUS"
req GET /api/reports/not-a-date;          check "bad date" 400 "$STATUS"
req GET /api/reports "${MACHINE[@]}";     check "machine cannot read user routes" 403 "$STATUS"

echo "Assessments"
CID=$(uuid)
POST_OK="{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"event_id\":\"2026-09-30-e1\",\"outlet\":\"Reuters\",\"value\":1,\"supersedes\":null,\"client_id\":\"$CID\"}"
req POST /api/assessments "${JSONH[@]}" -d "$POST_OK"; check "admin records assessment" 201 "$STATUS" "$BODY"
FIRST_ID=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id||""))')
contains "operator from identity" "$BODY" '"operator":"the.owner@example.org"'
req POST /api/assessments "${JSONH[@]}" -d "$POST_OK"; check "repeat client_id is idempotent" 200 "$STATUS"; contains "same row returned" "$BODY" "\"id\":\"$FIRST_ID\""
req POST /api/assessments "${JSONH[@]}" -d "{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"value\":1,\"operator\":\"forged@example.com\",\"client_id\":\"$(uuid)\"}"
check "client cannot set operator" 201 "$STATUS"; contains "operator not forged" "$BODY" '"operator":"the.owner@example.org"'
req POST /api/assessments "${JSONH[@]}" -d '{"article_id":"0123456789abcdef","report_date":"2026-09-30","value":5}';        check "value out of range" 400 "$STATUS"
req POST /api/assessments "${JSONH[@]}" -d '{"article_id":"0123456789abcdef","report_date":"2026-09-30","value":1.5}';      check "non-integer value" 400 "$STATUS"
req POST /api/assessments "${JSONH[@]}" -d '{"article_id":"XYZ","report_date":"2026-09-30","value":1}';                     check "bad article_id" 400 "$STATUS"
req POST /api/assessments "${JSONH[@]}" -d '{"article_id":"0123456789abcdef","report_date":"2099-01-01","value":1}';        check "report_date without report" 400 "$STATUS"
req POST /api/assessments "${JSONH[@]}" -d 'not json';                                                                      check "invalid JSON" 400 "$STATUS"
req POST /api/assessments "${JSONH[@]}" "${READER[@]}" -d "{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"value\":1,\"client_id\":\"$(uuid)\"}"
check "reader cannot record" 403 "$STATUS"
req POST /api/assessments "${JSONH[@]}" "${MACHINE[@]}" -d "{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"value\":1}"
check "machine cannot record" 403 "$STATUS"
req POST /api/assessments "${JSONH[@]}" -d "{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"value\":-2,\"supersedes\":\"$FIRST_ID\",\"client_id\":\"$(uuid)\"}"
check "supersede own article" 201 "$STATUS" "$BODY"; contains "supersedes stored" "$BODY" "\"supersedes\":\"$FIRST_ID\""
req POST /api/assessments "${JSONH[@]}" -d "{\"article_id\":\"fedcba9876543210\",\"report_date\":\"2026-09-30\",\"value\":1,\"supersedes\":\"$FIRST_ID\",\"client_id\":\"$(uuid)\"}"
check "supersede other article refused" 400 "$STATUS"
req POST /api/assessments "${JSONH[@]}" -d "{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"value\":0,\"supersedes\":\"no-such-id\",\"client_id\":\"$(uuid)\"}"
check "supersede unknown id refused" 400 "$STATUS"
req GET /api/assessments;                 check "list assessments" 200 "$STATUS"; contains "list has first row" "$BODY" "$FIRST_ID"
req GET /api/assessments "${READER[@]}";  check "reader can list" 200 "$STATUS"

echo "Machine"
req GET "/api/export/assessments?since=" "${MACHINE[@]}";   check "export all" 200 "$STATUS"; contains "export has first row" "$BODY" "$FIRST_ID"
req GET "/api/export/assessments?since=2999-01-01T00:00:00Z" "${MACHINE[@]}"; check "export since future" 200 "$STATUS"; contains "export empty" "$BODY" '^\[\]$'
req GET "/api/export/assessments";        check "user cannot export" 403 "$STATUS"
req PUT /api/ingest/reports/2026-09-30 "${JSONH[@]}" -d '{"date":"2026-09-30"}'; check "user cannot ingest" 403 "$STATUS"
req PUT /api/ingest/reports/2026-09-30 "${JSONH[@]}" "${MACHINE[@]}" -d '{"date":"2026-09-29"}'; check "ingest date mismatch" 400 "$STATUS"
req PUT /api/ingest/reports/bad "${JSONH[@]}" "${MACHINE[@]}" -d '{"date":"bad"}'; check "ingest bad date" 400 "$STATUS"
BIG=$(mktemp)
node -e 'process.stdout.write(JSON.stringify({date:"2026-09-30",pad:"x".repeat(2200000)}))' > "$BIG"
req PUT /api/ingest/reports/2026-09-30 "${JSONH[@]}" "${MACHINE[@]}" --data-binary "@$BIG"; check "oversized body refused" 413 "$STATUS"
rm -f "$BIG"

echo "Users and roles (v2)"
req GET /api/me;                           contains "owner flagged" "$BODY" '"is_owner":true'
req GET /api/me -H 'X-Dev-Email: admin.one@example.org'; check "seeded admin" 200 "$STATUS"; contains "johan admin" "$BODY" '"role":"admin"'
req GET /api/admin/users "${READER[@]}";   check "reader denied admin routes" 403 "$STATUS"
req GET /api/admin/status "${READER[@]}";  check "reader denied status" 403 "$STATUS"
req GET /api/admin/users;                  check "admin lists users" 200 "$STATUS"; contains "list has reader" "$BODY" 'reader@example.com'
NEW="newbie-$RANDOM$RANDOM@example.com"
AS_NEW=(-H "X-Dev-Email: $NEW")
req GET /api/me "${AS_NEW[@]}";            check "not yet a user" 403 "$STATUS"
req POST /api/admin/users "${JSONH[@]}" -d "{\"email\":\"$NEW\",\"role\":\"reader\"}"; check "add reader" 201 "$STATUS" "$BODY"
req GET /api/me "${AS_NEW[@]}";            check "new reader gets in" 200 "$STATUS"; contains "as reader" "$BODY" '"role":"reader"'
req POST /api/assessments "${JSONH[@]}" "${AS_NEW[@]}" -d "{\"article_id\":\"0123456789abcdef\",\"report_date\":\"2026-09-30\",\"value\":1,\"client_id\":\"$(uuid)\"}"
check "new reader cannot record" 403 "$STATUS"
req PATCH "/api/admin/users/$NEW" "${JSONH[@]}" -d '{"role":"admin"}'; check "promote to admin" 200 "$STATUS"
req GET /api/me "${AS_NEW[@]}";            contains "now admin" "$BODY" '"role":"admin"'
req DELETE "/api/admin/users/$NEW" -H "Origin: $BASE"; check "remove user" 200 "$STATUS"; contains "inactive" "$BODY" '"active":false'
req GET /api/me "${AS_NEW[@]}";            check "removed user refused" 403 "$STATUS"
req POST /api/admin/users "${JSONH[@]}" -d "{\"email\":\"$NEW\",\"role\":\"reader\"}"; check "re-add reactivates" 200 "$STATUS"; contains "active again" "$BODY" '"active":true'
req POST /api/admin/users "${JSONH[@]}" -d '{"email":"not-an-email","role":"reader"}'; check "bad email refused" 400 "$STATUS"
req POST /api/admin/users "${JSONH[@]}" -d '{"email":"x@example.com","role":"god"}';   check "bad role refused" 400 "$STATUS"
req PATCH /api/admin/users/the.owner@example.org "${JSONH[@]}" -d '{"role":"reader"}'; check "owner cannot be demoted" 409 "$STATUS"
req DELETE /api/admin/users/the.owner@example.org -H "Origin: $BASE"; check "owner cannot be removed" 409 "$STATUS"
req PATCH "/api/admin/users/nobody@example.com" "${JSONH[@]}" -d '{"role":"reader"}'; check "unknown user" 404 "$STATUS"
# Last-admin rule: take the owner's row out of the table (the owner stays
# admin by OWNER), leave johan as the only active admin row, then restore.
req DELETE /api/admin/users/admin.two@example.org -H "Origin: $BASE"; check "remove greger" 200 "$STATUS"
req DELETE "/api/admin/users/$NEW" -H "Origin: $BASE"
npx wrangler d1 execute hotmonitor --local --command "DELETE FROM users WHERE email = 'the.owner@example.org'" >/dev/null 2>&1
req DELETE /api/admin/users/admin.one@example.org -H "Origin: $BASE"; check "last admin cannot be removed" 409 "$STATUS"
req PATCH /api/admin/users/admin.one@example.org "${JSONH[@]}" -d '{"role":"reader"}'; check "last admin cannot be demoted" 409 "$STATUS"
req GET /api/me;                           contains "owner still admin without a row" "$BODY" '"role":"admin"'
npx wrangler d1 execute hotmonitor --local --command "INSERT INTO users (email, role, active, created_at, created_by) VALUES ('the.owner@example.org', 'admin', 1, datetime('now'), 'seed')" >/dev/null 2>&1
req POST /api/admin/users "${JSONH[@]}" -d '{"email":"admin.two@example.org","role":"admin"}'; check "restore greger" 200 "$STATUS"
req GET /api/admin/audit;                  check "audit log" 200 "$STATUS"; contains "audit has deactivate" "$BODY" '"action":"deactivate"'; contains "audit has seed" "$BODY" '"action":"seed"'

echo "Origin check"
req POST /api/reads -H 'Content-Type: application/json' -d '{"item_ids":["2026-09-30-e1"]}'; check "no Origin refused" 403 "$STATUS"
req POST /api/reads -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{"item_ids":["2026-09-30-e1"]}'; check "foreign Origin refused" 403 "$STATUS"

echo "Reads"
req GET /api/reads;                        check "get reads" 200 "$STATUS"; contains "reads shape" "$BODY" '"item_ids"'
req POST /api/reads "${JSONH[@]}" -d '{"item_ids":["2026-09-30-e1","u-smoke-1"]}'; check "mark read" 200 "$STATUS"
req GET /api/reads;                        contains "read id stored" "$BODY" '2026-09-30-e1'
req GET /api/reads "${READER[@]}";         check "reader reads" 200 "$STATUS"
if printf '%s' "$BODY" | grep -q 'u-smoke-1'; then FAIL=$((FAIL+1)); echo "  FAIL  reads leak between users"; else PASS=$((PASS+1)); echo "  ok    reads are per user"; fi
req POST /api/reads "${JSONH[@]}" -d '{"item_ids":["bad id with spaces"]}'; check "bad item id" 400 "$STATUS"
req POST /api/reads "${JSONH[@]}" -d '{"all_before":"2026-09-30T23:59:59Z"}'; check "mark all before" 200 "$STATUS"
req GET /api/reads;                        contains "all_before marked old events" "$BODY" '2026-09-19-e1'

echo "Updates feed"
UPD='[{"id":"u-smoke-1","ts":"2026-10-01T08:00:00Z","thread_id":"t1","thread_label":"Tråd","classification":"NEW_DEVELOPMENT","title_sv":"Rubrik","summary_sv":"Sammanfattning","outlets":["Reuters"],"report_date":"2026-09-30"}]'
req PUT /api/ingest/updates "${JSONH[@]}" "${MACHINE[@]}" -d "$UPD"; check "ingest updates" 200 "$STATUS" "$BODY"
req PUT /api/ingest/updates "${JSONH[@]}" -d "$UPD";                check "user cannot ingest updates" 403 "$STATUS"
req PUT /api/ingest/updates "${JSONH[@]}" "${MACHINE[@]}" -d '[{"id":"u2","ts":"yesterday"}]'; check "bad update ts" 400 "$STATUS"
req PUT /api/ingest/updates "${JSONH[@]}" "${MACHINE[@]}" -d "${UPD/Rubrik/Ny rubrik}"; check "upsert update" 200 "$STATUS"
req GET "/api/updates?since=2026-09-01T00:00:00Z"; check "get updates" 200 "$STATUS"; contains "update listed" "$BODY" 'u-smoke-1'
contains "upsert applied" "$BODY" 'Ny rubrik'; contains "outlets as array" "$BODY" '"outlets":\["Reuters"\]'
req GET "/api/updates?since=bad";          check "bad since" 400 "$STATUS"

echo "Status and security"
req GET /api/admin/status;                 check "status" 200 "$STATUS"; contains "machine pull recorded" "$BODY" '"last_machine_pull_at":"20'
contains "token expiry" "$BODY" '"service_token_expires":"2027-09-30"'; contains "event count" "$BODY" '"events":'
req GET "/api/admin/security?days=7";      check "security report" 200 "$STATUS"
contains "logged not_allowed" "$BODY" '"reason":"not_allowed"'; contains "logged bad_origin" "$BODY" '"reason":"bad_origin"'
contains "logged forbidden" "$BODY" '"reason":"forbidden"'; contains "logged bad_request" "$BODY" '"reason":"bad_request"'
contains "counts 24h" "$BODY" '"24h":{'

echo "Headers"
HDRS=$(curl -s -D - -o /dev/null "$BASE/api/me")
contains "no-store" "$HDRS" 'no-store'
contains "nosniff" "$HDRS" 'nosniff'

echo "Append-only (local D1)"
OUT=$(d1 "UPDATE assessments SET value = 2")
contains "UPDATE blocked" "$OUT" 'append-only'
OUT=$(d1 "DELETE FROM assessments")
contains "DELETE blocked" "$OUT" 'append-only'

OUT=$(d1 "UPDATE audit_log SET actor = 'x'")
contains "audit UPDATE blocked" "$OUT" 'append-only'
OUT=$(d1 "DELETE FROM audit_log")
contains "audit DELETE blocked" "$OUT" 'append-only'

echo "Rate limit"
FLOOD=(-H "X-Dev-Email: flood-$RANDOM@example.com")
LAST=""
for i in $(seq 1 125); do LAST=$(curl -s -o /dev/null -w '%{http_code}' "${FLOOD[@]}" "$BASE/api/me"); done
check "request 125 in a minute is limited" 429 "$LAST"
req GET "/api/admin/security?days=1";      contains "logged rate_limited" "$BODY" '"reason":"rate_limited"'

echo "JWT verification (unit)"
if node scripts/auth_test.mjs; then PASS=$((PASS+1)); echo "  ok    auth_test.mjs"; else FAIL=$((FAIL+1)); echo "  FAIL  auth_test.mjs"; fi

echo
echo "Smoke test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
