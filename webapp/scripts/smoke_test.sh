#!/bin/bash
# Smoke test of the API against a running local `wrangler dev` with a seeded
# local D1 and this .dev.vars:
#   DEV_AUTH_EMAIL=the.owner@example.org
#   DEV_AUTH_MACHINE=1
#   READERS=reader@example.com
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
JSONH=(-H 'Content-Type: application/json')
READER=(-H 'X-Dev-Email: reader@example.com')
MACHINE=(-H 'X-Dev-Machine: 1')

echo "Identity"
req GET /api/me;                          check "admin /api/me" 200 "$STATUS" "$BODY"; contains "role admin" "$BODY" '"role":"admin"'
req GET /api/me "${READER[@]}";           check "reader /api/me" 200 "$STATUS"; contains "role reader" "$BODY" '"role":"reader"'
req GET /api/me -H 'X-Dev-Email: stranger@example.com'; check "unknown email refused" 403 "$STATUS"
req POST /api/me;                         check "wrong method" 405 "$STATUS"
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

echo "Headers"
HDRS=$(curl -s -D - -o /dev/null "$BASE/api/me")
contains "no-store" "$HDRS" 'no-store'
contains "nosniff" "$HDRS" 'nosniff'

echo "Append-only (local D1)"
OUT=$(npx wrangler d1 execute hotmonitor --local --command "UPDATE assessments SET value = 2" 2>&1)
contains "UPDATE blocked" "$OUT" 'append-only'
OUT=$(npx wrangler d1 execute hotmonitor --local --command "DELETE FROM assessments" 2>&1)
contains "DELETE blocked" "$OUT" 'append-only'

echo "JWT verification (unit)"
if node scripts/auth_test.mjs; then PASS=$((PASS+1)); echo "  ok    auth_test.mjs"; else FAIL=$((FAIL+1)); echo "  FAIL  auth_test.mjs"; fi

echo
echo "Smoke test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
