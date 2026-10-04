#!/bin/bash
# Smoke test of the API against a running local `wrangler dev` with a seeded
# local D1 and this .dev.vars:
#   DEV_AUTH_EMAIL=the.owner@example.org
#   DEV_AUTH_MACHINE=1
#   READERS=reader@example.com
#   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   a local key pair
#   DEV_PUSH_ALLOW=http://127.0.0.1:8799  the fake push server
# run under `wrangler dev --test-scheduled` (for the cron tests),
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

echo "Version 3: home screen"
req POST /api/me/device "${JSONH[@]}" -d '{"standalone":true,"platform":"ios"}'; check "record standalone device" 200 "$STATUS" "$BODY"; contains "installed_at set" "$BODY" '"installed_at":"20'
req POST /api/me/device "${JSONH[@]}" "${READER[@]}" -d '{"standalone":false,"platform":"android"}'; check "reader records browser" 200 "$STATUS"; contains "not installed" "$BODY" '"installed_at":null'
req POST /api/me/device "${JSONH[@]}" -d '{"standalone":true,"platform":"tv"}'; check "bad platform" 400 "$STATUS"
req POST /api/me/device "${JSONH[@]}" -d '{"standalone":"yes","platform":"ios"}'; check "bad standalone" 400 "$STATUS"
req POST /api/me/device -H 'Content-Type: application/json' -d '{"standalone":true,"platform":"ios"}'; check "device needs Origin" 403 "$STATUS"
req GET /api/admin/users; contains "admin list has installed flag" "$BODY" '"installed":true'; contains "admin list has platform" "$BODY" '"platform":"ios"'
contains "admin list has push device count" "$BODY" '"push_devices":'

echo "Version 3: push subscriptions"
# Start from a clean push/alarm state so the suite can run again on the same DB.
d1 "DELETE FROM push_subscriptions; DELETE FROM reports WHERE date = '2026-10-05'; DELETE FROM meta WHERE key = 'alarm_missing_report' OR key LIKE 'push_sent:%'" >/dev/null
PUSH_LOG=$(mktemp); PUSH_PORT=8799; PB="http://127.0.0.1:$PUSH_PORT"
node scripts/fake_push_server.mjs $PUSH_PORT "$PUSH_LOG" & PUSH_PID=$!
trap 'kill $PUSH_PID 2>/dev/null' EXIT
sleep 1
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((x,k)=>x==null?x:x[k],o);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
VPUB=$(grep '^VAPID_PUBLIC_KEY=' .dev.vars | cut -d= -f2-)
KA=$(node scripts/push_helper.mjs keys); KR=$(node scripts/push_helper.mjs keys); KN=$(node scripts/push_helper.mjs keys)
A_P=$(printf '%s' "$KA" | field p256dh); A_A=$(printf '%s' "$KA" | field auth); A_D=$(printf '%s' "$KA" | field d)
R_P=$(printf '%s' "$KR" | field p256dh); R_A=$(printf '%s' "$KR" | field auth); R_D=$(printf '%s' "$KR" | field d)
N_P=$(printf '%s' "$KN" | field p256dh); N_A=$(printf '%s' "$KN" | field auth)
sub() { printf '{"endpoint":"%s","expirationTime":null,"keys":{"p256dh":"%s","auth":"%s"}%s}' "$1" "$2" "$3" "${4:-}"; }
req GET /api/push/key; check "push key" 200 "$STATUS"; contains "public key served" "$BODY" "\"publicKey\":\"$VPUB\""
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub https://evil.example/x "$A_P" "$A_A")"; check "unknown push host refused" 400 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub http://web.push.apple.com/x "$A_P" "$A_A")"; check "http push endpoint refused" 400 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub https://web.push.apple.com.evil.example/x "$A_P" "$A_A")"; check "lookalike push host refused" 400 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub "$PB/p/admin" AAAA "$A_A")"; check "bad p256dh refused" 400 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub "$PB/p/admin" "$A_P" AAAAAAAA)"; check "short auth refused" 400 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub "$PB/p/admin" "$A_P" "$A_A" ',"prefs":{"report":"yes"}')"; check "non-boolean prefs refused" 400 "$STATUS"
req POST /api/push/subscribe -H 'Content-Type: application/json' -d "$(sub "$PB/p/admin" "$A_P" "$A_A")"; check "subscribe needs Origin" 403 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" "${MACHINE[@]}" -d "$(sub "$PB/p/admin" "$A_P" "$A_A")"; check "machine cannot subscribe" 403 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub "$PB/p/admin" "$A_P" "$A_A")"; check "admin subscribes" 201 "$STATUS" "$BODY"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub "$PB/p/admin" "$A_P" "$A_A")"; check "re-subscribe is an update" 200 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" "${READER[@]}" -d "$(sub "$PB/p/reader" "$R_P" "$R_A")"; check "reader subscribes" 201 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -d "$(sub "$PB/gone/admin2" "$N_P" "$N_A")"; check "expiring device subscribes" 201 "$STATUS"
req POST /api/push/subscribe "${JSONH[@]}" -H 'X-Dev-Email: admin.one@example.org' -d "$(sub "$PB/p/noreport" "$N_P" "$N_A" ',"prefs":{"report":false,"alarm":false}')"; check "subscribe with prefs" 201 "$STATUS"
req POST /api/push/unsubscribe "${JSONH[@]}" "${READER[@]}" -d "{\"endpoint\":\"$PB/p/admin\"}"; check "unsubscribe call" 200 "$STATUS"; contains "cannot remove another user's device" "$BODY" '"removed":0'
req GET /api/admin/status; contains "4 subscriptions" "$BODY" '"subscriptions":4'
req GET "/api/export/all" "${MACHINE[@]}"; check "export all (machine)" 200 "$STATUS"
contains "export has users" "$BODY" '"users":\['; contains "export has audit" "$BODY" '"audit_log":\['; contains "export has security log" "$BODY" '"security_log":\['
contains "export has reads" "$BODY" '"reads":\['; contains "export has updates" "$BODY" '"updates":\['; contains "export counts subscriptions" "$BODY" '"push_subscription_count":4'
if printf '%s' "$BODY" | grep -q -e "$A_P" -e '"p256dh"' -e '"auth"'; then FAIL=$((FAIL+1)); echo "  FAIL  export leaks push keys"; else PASS=$((PASS+1)); echo "  ok    export has no push keys"; fi
req GET "/api/export/all";                 check "user cannot export all" 403 "$STATUS"

echo "Version 3: missing-report alarm (cron)"
CRON="$BASE/cdn-cgi/handler/scheduled?cron=*/30+3-9+*+*+*"
AD=2026-10-05   # a date with no report
curl -s -o /dev/null "$CRON&time=$(node -e "console.log(Date.parse('${AD}T04:00:00Z'))")"; sleep 1
req GET /api/me; contains "06:00 Stockholm: no alarm yet" "$BODY" '"alarm":{"missing_report":null}'
curl -s -o /dev/null "$CRON&time=$(node -e "console.log(Date.parse('${AD}T05:00:00Z'))")"; sleep 2
req GET /api/me; contains "07:00 Stockholm: alarm raised" "$BODY" "\"missing_report\":\"$AD\""
req GET /api/me "${READER[@]}"; contains "readers see the alarm too" "$BODY" "\"missing_report\":\"$AD\""
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/admin "$A_D" "$A_P" "$A_A" "$VPUB")
contains "admin got the alarm push" "$OUT" 'Dagens rapport har inte kommit'
contains "VAPID JWT verifies" "$OUT" '"jwtOk":true'; contains "aud is the push origin" "$OUT" "\"aud\":\"$PB\""
contains "aes128gcm on the wire" "$OUT" '"encoding":"aes128gcm"'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB"); contains "reader got no alarm push" "$OUT" '"count":0'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/noreport x "$N_P" "$N_A" "$VPUB"); contains "alarm pref off respected" "$OUT" '"count":0'
req GET /api/admin/status; contains "status shows alarm" "$BODY" "\"missing_report\":\"$AD\""; contains "expired (410) subscription deleted" "$BODY" '"subscriptions":3'
curl -s -o /dev/null "$CRON&time=$(node -e "console.log(Date.parse('${AD}T05:30:00Z'))")"; sleep 1
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/admin "$A_D" "$A_P" "$A_A" "$VPUB"); contains "alarm pushed once per date" "$OUT" '"count":1'
req GET /api/admin/audit; contains "audit has alarm" "$BODY" '"action":"alarm"'
req PUT "/api/ingest/reports/$AD" "${JSONH[@]}" "${MACHINE[@]}" -d "{\"date\":\"$AD\",\"threat_index\":9.9,\"events\":[{\"id\":\"$AD-e1\",\"score\":10,\"title_sv\":\"x\"}]}"; check "late report ingested" 200 "$STATUS"
sleep 1
req GET /api/me; contains "alarm cleared by the report" "$BODY" '"alarm":{"missing_report":null}'
req GET /api/admin/audit; contains "audit has alarm_cleared" "$BODY" '"action":"alarm_cleared"'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB"); contains "report for another day pushes nothing" "$OUT" '"count":0'

echo "Version 3: report push"
TODAY=$(node -e 'const p=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Stockholm",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));console.log(`${p.year}-${p.month}-${p.day}`)')
req GET /api/reports
PREV=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).filter(x=>x.date<process.argv[1]&&x.threat_index!=null).sort((a,b)=>a.date<b.date?1:-1);console.log(r.length?r[0].threat_index:6)})' "$TODAY")
req GET "/api/reports/$TODAY"; ORIG=""; [ "$STATUS" = 200 ] && ORIG="$BODY"
NEWIDX=$(node -e "console.log(Math.round((${PREV}+0.6)*10)/10)")
TB=$(node -e 'const [d,idx,orig]=process.argv.slice(1);const b=orig?JSON.parse(orig):{date:d,events:[]};b.threat_index=Number(idx);b.executive_sv={...(b.executive_sv||{}),top:"Testrapport för push"};b.events=(b.events||[]).map(e=>({...e,score:Math.min(e.score||0,8)}));b.events.push({id:d+"-e99",score:10,title_sv:"Testhändelse"});console.log(JSON.stringify(b))' "$TODAY" "$NEWIDX" "$ORIG")
req PUT "/api/ingest/reports/$TODAY" "${JSONH[@]}" "${MACHINE[@]}" --data-binary "$TB"; check "today's report ingested" 200 "$STATUS"
sleep 2
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB")
contains "reader got the report push" "$OUT" '"count":1'; contains "title names the index move" "$OUT" 'Hotindex .*(+0,6)'
contains "body counts the 9-10 event" "$OUT" '1 händelse med poäng 9–10'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/admin "$A_D" "$A_P" "$A_A" "$VPUB"); contains "admin got it too" "$OUT" '"count":2'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/noreport x "$N_P" "$N_A" "$VPUB"); contains "report pref off respected" "$OUT" '"count":0'
req PUT "/api/ingest/reports/$TODAY" "${JSONH[@]}" "${MACHINE[@]}" --data-binary "$TB"; sleep 2
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB"); contains "re-upload does not notify again" "$OUT" '"count":1'
req GET /api/admin/status; contains "last push recorded" "$BODY" '"last":{"at":"20'
# Put today's report back as it was.
if [ -n "$ORIG" ]; then req PUT "/api/ingest/reports/$TODAY" "${JSONH[@]}" "${MACHINE[@]}" --data-binary "$ORIG"; check "restore today's report" 200 "$STATUS"; fi
echo "Version 3.2: notices"
NTITLE="Ny version av appen"
req POST /api/admin/notices "${JSONH[@]}" "${READER[@]}" -d "{\"title\":\"$NTITLE\",\"body\":\"x\"}"; check "reader cannot post a notice" 403 "$STATUS"
req POST /api/admin/notices -H 'Content-Type: application/json' -d "{\"title\":\"$NTITLE\",\"body\":\"x\"}"; check "notice needs Origin" 403 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d '{"title":"","body":"x"}'; check "empty title refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d "{\"title\":\"$(printf 'a%.0s' $(seq 1 81))\",\"body\":\"x\"}"; check "81-char title refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d "{\"title\":\"t\",\"body\":\"$(printf 'b%.0s' $(seq 1 501))\"}"; check "501-char body refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d '{"title":"t","body":"x","url":"https://evil.example/"}'; check "external url refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d '{"title":"t","body":"x","url":"//evil.example/"}'; check "protocol-relative url refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d '{"title":"t","body":"x","expires_days":0}'; check "expires_days 0 refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" -d '{"title":"t","body":"x","push":"yes"}'; check "non-boolean push refused" 400 "$STATUS"
req POST /api/admin/notices "${JSONH[@]}" "${MACHINE[@]}" -d '{"title":"t","body":"x"}'; check "machine cannot post a notice" 403 "$STATUS"
BEFORE=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))')
req POST /api/admin/notices "${JSONH[@]}" -d "{\"title\":\"$NTITLE\",\"body\":\"Öppna appen en gång så laddas den nya versionen.\",\"url\":\"#/bedom\",\"push\":true,\"expires_days\":3}"
check "admin posts a pushed notice" 201 "$STATUS" "$BODY"; contains "notice pushed to devices" "$BODY" '"pushed":[1-9]'
NID=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).notice.id))')
sleep 1
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB")
contains "reader got the notice push" "$OUT" "\"count\":$((BEFORE+1))"; contains "notice push title" "$OUT" "\"title\":\"$NTITLE\""; contains "notice push links in-app" "$OUT" '"url":"/#/bedom"'
req GET /api/notices "${READER[@]}"; check "reader lists notices" 200 "$STATUS"; contains "notice listed" "$BODY" "$NTITLE"
req POST /api/admin/notices "${JSONH[@]}" -d '{"title":"Tyst meddelande","body":"utan notis"}'; check "notice without push" 201 "$STATUS"; contains "no push sent" "$BODY" '"pushed":0'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB"); contains "silent notice pushed nothing" "$OUT" "\"count\":$((BEFORE+1))"
req GET /api/admin/audit; contains "audit has notice" "$BODY" '"action":"notice"'
req DELETE "/api/admin/notices/$NID" "${JSONH[@]}" "${READER[@]}"; check "reader cannot remove a notice" 403 "$STATUS"
req DELETE "/api/admin/notices/00000000-0000-4000-8000-000000000000" "${JSONH[@]}"; check "unknown notice 404" 404 "$STATUS"
req DELETE "/api/admin/notices/$NID" "${JSONH[@]}"; check "admin removes the notice" 200 "$STATUS"
req GET /api/notices; if printf '%s' "$BODY" | grep -q "$NID"; then FAIL=$((FAIL+1)); echo "  FAIL  removed notice still listed"; else PASS=$((PASS+1)); echo "  ok    removed notice no longer listed"; fi
req GET /api/admin/audit; contains "audit has notice_removed" "$BODY" '"action":"notice_removed"'
req GET /api/admin/security?days=1; contains "notice validation logged" "$BODY" 'title must be 1-80'

echo "Version 3.3: invites"
INV="invitee-$RANDOM$RANDOM@example.com"
req POST /api/admin/users "${JSONH[@]}" -d "{\"email\":\"$INV\",\"role\":\"reader\"}"; check "add queues an invite" 201 "$STATUS"; contains "invite pending" "$BODY" '"invite_status":"pending"'
req GET /api/export/invites;               check "user cannot read the invite queue" 403 "$STATUS"
req GET /api/export/invites "${MACHINE[@]}"; check "machine reads the queue" 200 "$STATUS"; contains "queue has the invitee" "$BODY" "$INV"; contains "queue carries the role" "$BODY" '"role":"reader"'
IID=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(x=>x.email===process.argv[1]);console.log(r?r.id:"")})' "$INV")
req PUT "/api/ingest/invites/$IID" "${JSONH[@]}" -d '{"status":"sent"}'; check "user cannot report an invite" 403 "$STATUS"
req PUT "/api/ingest/invites/$IID" "${JSONH[@]}" "${MACHINE[@]}" -d '{"status":"maybe"}'; check "bad invite status" 400 "$STATUS"
req PUT "/api/ingest/invites/not-an-id" "${JSONH[@]}" "${MACHINE[@]}" -d '{"status":"sent"}'; check "bad invite id" 400 "$STATUS"
req PUT "/api/ingest/invites/00000000-0000-4000-8000-000000000000" "${JSONH[@]}" "${MACHINE[@]}" -d '{"status":"sent"}'; check "unknown invite" 404 "$STATUS"
req PUT "/api/ingest/invites/$IID" "${JSONH[@]}" "${MACHINE[@]}" -d '{"status":"failed","error":"SMTP nere"}'; check "failure reported" 200 "$STATUS"; contains "one failure is retried" "$BODY" '"status":"pending"'
req PUT "/api/ingest/invites/$IID" "${JSONH[@]}" "${MACHINE[@]}" -d '{"status":"sent"}'; check "sent reported" 200 "$STATUS"; contains "invite sent" "$BODY" '"status":"sent"'
req GET /api/export/invites "${MACHINE[@]}"; if printf '%s' "$BODY" | grep -q "$INV"; then FAIL=$((FAIL+1)); echo "  FAIL  sent invite still queued"; else PASS=$((PASS+1)); echo "  ok    sent invite leaves the queue"; fi
req GET /api/admin/users; contains "user list shows the sent invite" "$BODY" "\"email\":\"$INV\"[^}]*\"invite_status\":\"sent\""
req POST "/api/admin/users/$INV/invite" "${JSONH[@]}" "${READER[@]}" -d '{}'; check "reader cannot resend" 403 "$STATUS"
req POST "/api/admin/users/$INV/invite" "${JSONH[@]}" -d '{}'; check "admin resends" 201 "$STATUS"; contains "resend pending" "$BODY" '"invite_status":"pending"'
req POST "/api/admin/users/$INV/invite" "${JSONH[@]}" -d '{}'; check "resend again" 201 "$STATUS"
req GET /api/export/invites "${MACHINE[@]}"; N=$(printf '%s' "$BODY" | grep -o "$INV" | wc -l | tr -d ' '); check "one open invite per person" 1 "$N"
req DELETE "/api/admin/users/$INV" -H "Origin: $BASE"; check "remove the invitee" 200 "$STATUS"
req GET /api/export/invites "${MACHINE[@]}"; if printf '%s' "$BODY" | grep -q "$INV"; then FAIL=$((FAIL+1)); echo "  FAIL  removed user's invite still queued"; else PASS=$((PASS+1)); echo "  ok    removing a user cancels the invite"; fi
req POST "/api/admin/users/$INV/invite" "${JSONH[@]}" -d '{}'; check "no invite for a removed user" 409 "$STATUS"
req POST /api/admin/users "${JSONH[@]}" -d "{\"email\":\"$INV\",\"role\":\"reader\"}"; check "reactivate" 200 "$STATUS"
req GET /api/export/invites "${MACHINE[@]}"; if printf '%s' "$BODY" | grep -q "$INV"; then FAIL=$((FAIL+1)); echo "  FAIL  reactivation mailed without asking"; else PASS=$((PASS+1)); echo "  ok    reactivation sends no invite unasked"; fi
NOINV="quiet-$RANDOM$RANDOM@example.com"
req POST /api/admin/users "${JSONH[@]}" -d "{\"email\":\"$NOINV\",\"role\":\"reader\",\"invite\":false}"; check "add without invite" 201 "$STATUS"
req GET /api/export/invites "${MACHINE[@]}"; if printf '%s' "$BODY" | grep -q "$NOINV"; then FAIL=$((FAIL+1)); echo "  FAIL  invite:false still queued"; else PASS=$((PASS+1)); echo "  ok    invite:false queues nothing"; fi
req POST /api/admin/users "${JSONH[@]}" -d "{\"email\":\"x$NOINV\",\"role\":\"reader\",\"invite\":\"yes\"}"; check "non-boolean invite refused" 400 "$STATUS"
req GET /api/admin/status; contains "status shows the invite queue" "$BODY" '"invites":{"pending":'
req GET /api/admin/audit; contains "audit has invite" "$BODY" '"action":"invite"'
req DELETE "/api/admin/users/$INV" -H "Origin: $BASE"; req DELETE "/api/admin/users/$NOINV" -H "Origin: $BASE"

echo "Version 3.3: update everyone"
req POST /api/admin/refresh "${JSONH[@]}" "${READER[@]}" -d '{}'; check "reader cannot refresh everyone" 403 "$STATUS"
req POST /api/admin/refresh -H 'Content-Type: application/json' -d '{}'; check "refresh needs Origin" 403 "$STATUS"
req POST /api/admin/refresh "${JSONH[@]}" -d "{\"message\":\"$(printf 'm%.0s' $(seq 1 201))\"}"; check "201-char message refused" 400 "$STATUS"
BEFORE=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).count))')
req POST /api/admin/refresh "${JSONH[@]}" -d '{"message":"Rättad poäng i dagens rapport"}'; check "admin refreshes everyone" 201 "$STATUS" "$BODY"; contains "refresh pushed" "$BODY" '"pushed":[1-9]'
sleep 1
req GET /api/me "${READER[@]}"; contains "readers see the refresh in /api/me" "$BODY" '"refresh":{"id":"'; contains "with the message" "$BODY" 'Rättad poäng'
OUT=$(node scripts/push_helper.mjs last "$PUSH_LOG" /p/reader "$R_D" "$R_P" "$R_A" "$VPUB")
contains "reader got the refresh push" "$OUT" "\"count\":$((BEFORE+1))"; contains "push says updated" "$OUT" 'Hotmonitor har uppdaterats'; contains "push is kind refresh" "$OUT" '"kind":"refresh"'
req POST /api/admin/refresh "${JSONH[@]}" -d '{}'; check "second refresh within 30 s refused" 429 "$STATUS"
req GET /api/admin/audit; contains "audit has refresh" "$BODY" '"action":"refresh"'

kill $PUSH_PID 2>/dev/null; rm -f "$PUSH_LOG"

echo "Web Push and clock (unit)"
if node scripts/push_test.mjs >/dev/null; then PASS=$((PASS+1)); echo "  ok    push_test.mjs (RFC 8291 vector, VAPID)"; else FAIL=$((FAIL+1)); echo "  FAIL  push_test.mjs"; fi
if node scripts/clock_test.mjs >/dev/null; then PASS=$((PASS+1)); echo "  ok    clock_test.mjs (Stockholm DST)"; else FAIL=$((FAIL+1)); echo "  FAIL  clock_test.mjs"; fi

echo "JWT verification (unit)"
if node scripts/auth_test.mjs; then PASS=$((PASS+1)); echo "  ok    auth_test.mjs"; else FAIL=$((FAIL+1)); echo "  FAIL  auth_test.mjs"; fi

echo
echo "Smoke test: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
