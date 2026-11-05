# Deploying Hotmonitor to Cloudflare

Prerequisite: a Cloudflare account with Zero Trust enabled (Free plan, a
team name chosen, e.g. `hotmonitor` -> team domain
`hotmonitor.cloudflareaccess.com`), and `npx wrangler login` done in this
folder. All commands run from `webapp/`.

The Worker refuses every `/api` request until step 5 is done (fail closed),
so deploying before Access is configured exposes nothing but the static app
shell, which holds no report data.

## 1. Database

```sh
npx wrangler d1 create hotmonitor
```

Copy the printed `database_id` into `wrangler.jsonc`
(`d1_databases[0].database_id`, replacing `REPLACE_AT_DEPLOY`), then:

```sh
npx wrangler d1 migrations apply hotmonitor --remote
```

## 2. Deploy

```sh
npx wrangler deploy
```

Note the URL it prints: `https://hotmonitor.<account-subdomain>.workers.dev`.
`npx wrangler whoami` shows the account id, which the API calls below need.

## 3. Access in front of the hostname

**Dashboard (simplest):** Workers & Pages -> hotmonitor -> Settings ->
Domains & Routes -> workers.dev -> *Enable Cloudflare Access*. Then
*Manage Cloudflare Access* and set:

- Login method: One-time PIN only.
- Session duration: 30 days (`720h`).
- Policy "Hotmonitor users" (Allow): Include -> Emails -> the addresses in
  `ADMINS` and `READERS`.
- Policy "Hotmonitor Mac" (Service Auth): Include -> Service Token ->
  the token from step 4.
- Copy the *Application Audience (AUD) Tag*.

**API (scriptable).** Needs an API token with *Access: Apps and Policies
Edit*, *Access: Service Tokens Edit*, *Access: Organizations, Identity
Providers, and Groups Edit* (read is enough if One-time PIN already exists).
Keep it in `~/.zshrc`, never in the repo.

```sh
ACC=<account id>; H=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
API=https://api.cloudflare.com/client/v4/accounts/$ACC/access

# Team domain (-> TEAM_DOMAIN)
curl -s "${H[@]}" $API/organizations | jq -r .result.auth_domain

# One-time PIN login (skip the POST if the GET already lists type "onetimepin")
curl -s "${H[@]}" $API/identity_providers | jq '.result[] | {id, type}'
curl -s "${H[@]}" -X POST $API/identity_providers \
  -d '{"name":"One-time PIN","type":"onetimepin","config":{}}' | jq -r .result.id      # -> OTP_ID

# Allow policy for the people
curl -s "${H[@]}" -X POST $API/policies -d '{
  "name":"Hotmonitor users","decision":"allow","session_duration":"720h",
  "include":[{"email":{"email":"admin.one@example.org"}},
             {"email":{"email":"admin.two@example.org"}},
             {"email":{"email":"the.owner@example.org"}}]}' | jq -r .result.id  # -> USERS_POLICY

# Service token for the Mac (client_secret is shown ONCE - store it now)
curl -s "${H[@]}" -X POST $API/service_tokens \
  -d '{"name":"hotmonitor-mac","duration":"8760h"}' | jq '.result | {id, client_id, client_secret}'
curl -s "${H[@]}" -X POST $API/policies -d '{
  "name":"Hotmonitor Mac","decision":"non_identity",
  "include":[{"service_token":{"token_id":"<service token id>"}}]}' | jq -r .result.id   # -> MAC_POLICY

# The application (-> its "aud" is ACCESS_AUD)
curl -s "${H[@]}" -X POST $API/apps -d '{
  "name":"Hotmonitor","type":"self_hosted",
  "domain":"hotmonitor.<account-subdomain>.workers.dev",
  "session_duration":"720h","allowed_idps":["<OTP_ID>"],
  "auto_redirect_to_identity":true,"app_launcher_visible":false,
  "policies":[{"id":"<USERS_POLICY>","precedence":1},{"id":"<MAC_POLICY>","precedence":2}]}' \
  | jq '.result | {id, aud}'
```

If the API refuses the `workers.dev` domain for a self-hosted app, use the
dashboard toggle above for the application and attach the two policies to
it there; the policies and service token made by API still apply.

## 4. The Mac's credentials

Add to `~/.zshrc` (the secret never goes into the repo or the Worker):

```sh
export HOTMONITOR_URL="https://hotmonitor.<account-subdomain>.workers.dev"
export CF_ACCESS_CLIENT_ID="<client_id>"
export CF_ACCESS_CLIENT_SECRET="<client_secret>"
```

The Mac sends them as `CF-Access-Client-Id` / `CF-Access-Client-Secret`
headers; Access exchanges them for a JWT whose `common_name` is the client id.

## 5. Tell the Worker about Access, and redeploy

In `wrangler.jsonc` `vars` (none of these are secrets):

- `TEAM_DOMAIN`: e.g. `hotmonitor.cloudflareaccess.com` (no `https://`)
- `ACCESS_AUD`: the AUD tag from step 3
- `MACHINE_CLIENT_ID`: the service token's `client_id` (ends in `.access`)
- `ADMINS` / `READERS`: must match the emails in the Allow policy

```sh
npx wrangler deploy
```

## 6. Check

```sh
# Without credentials: Access answers with its login page / 302, never data
curl -s -o /dev/null -w "%{http_code}\n" $HOTMONITOR_URL/api/reports

# As the Mac: 200 and [] (no assessments yet)
curl -s -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$HOTMONITOR_URL/api/export/assessments?since="
```

Then open the URL on a phone, log in with the one-time PIN, and check that
`/api/me` shows the right role.

## Adding or removing a person

Update the Allow policy (dashboard or `PUT $API/policies/<id>`) AND
`ADMINS`/`READERS` in `wrangler.jsonc`, then `npx wrangler deploy`. Both
must list them: Access decides who reaches the app, the Worker decides the
role.

## Backups

D1 Time Travel restores the database to any minute of the last 30 days
(`npx wrangler d1 time-travel restore hotmonitor --timestamp=<ISO>`).
For an off-Cloudflare copy:

```sh
npx wrangler d1 export hotmonitor --remote --output=../data/backups/hotmonitor-$(date +%F).sql
```

## Local development

```sh
cp .dev.vars.example .dev.vars   # or write it: see below
npx wrangler d1 migrations apply hotmonitor --local
npx wrangler dev --port 8787
node scripts/seed_local.mjs      # loads ../reports/*_report_data.json
scripts/smoke_test.sh            # 48 checks incl. JWT verification
```

`.dev.vars` (gitignored, never deployed):

```
DEV_AUTH_EMAIL=the.owner@example.org
DEV_AUTH_MACHINE=1
READERS=reader@example.com
```

The dev bypass works only on `localhost`/`127.0.0.1` and only with these
vars set; `X-Dev-Email: <addr>` picks another identity and
`X-Dev-Machine: 1` acts as the Mac.

## Version 2: the app decides who gets in

From version 2 (CONTRACT.md, "Version 2") Access only proves that the
visitor owns an email address; the Worker decides who is let in from
the D1 `users` table, managed on the app's admin page. Deploy in this
order, so the new gate is in place before Access opens up:

1. Apply the new tables to the live database:

   ```sh
   npx wrangler d1 migrations apply hotmonitor --remote
   ```

2. Deploy the Worker (`OWNER`, `READERS` and `SERVICE_TOKEN_EXPIRES` are
   in `wrangler.jsonc`):

   ```sh
   npx wrangler deploy
   ```

   The first request after this seeds `users` - it is empty - from
   `OWNER` and `ADMINS` (admins) and `READERS` (readers), and writes a
   `seed` row to `audit_log`. After that the vars no longer matter except
   `OWNER`, who is always an active admin (break-glass: the owner cannot
   be locked out, demoted or removed).

3. Open the Access allow policy to any verified email (One-time PIN is
   still the only login method, so every visitor has proven their
   address). With `CLOUDFLARE_API_TOKEN` (Access: Apps and Policies Edit):

   ```sh
   ACC=b117299f0c6ac472366156984ab0c796
   POLICY=06b01c26-3cf8-4836-8131-b05b0c038921   # "Hotmonitor users"
   curl -s -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     https://api.cloudflare.com/client/v4/accounts/$ACC/access/policies/$POLICY -d '{
       "name":"Hotmonitor verified email","decision":"allow","session_duration":"720h",
       "include":[{"everyone":{}}]}' | jq '.success, .result.include'
   ```

   Someone not in `users` can now reach the app shell (which holds no
   data) but every `/api` call answers 403 and is logged as
   `not_allowed` on the admin page's Säkerhet tab.

4. Check: `/api/me` as an admin shows `is_owner` for the owner; the admin
   page lists the five seeded users; an address not in the list gets 403.

Rate limiting is per Worker isolate (in memory, ~120 requests a minute per
email, or per IP without a valid login) - no binding or extra setup.
Security log rows older than 90 days are pruned by the Worker itself.

## Version 3: push, missing-report alarm, home screen, backup export

Run from `webapp/`, in this order (with the OAuth login, not the Access
API token: `env -u CLOUDFLARE_API_TOKEN npx wrangler ...`):

1. The VAPID private key, as a Worker secret (never in wrangler.jsonc or
   the repo). The matching public key is already in `vars.VAPID_PUBLIC_KEY`.
   ```sh
   npx wrangler secret put VAPID_PRIVATE_KEY < /path/to/vapid_private.txt
   ```
   The value is the base64url private scalar `d` (a JWK also works).
   Rotating the pair means every device must subscribe again.
2. The migration (push_subscriptions; users.installed_at, users.platform):
   ```sh
   npx wrangler d1 migrations apply hotmonitor --remote
   ```
3. Deploy. This also registers the cron trigger `*/30 3-9 * * *` (UTC)
   from `wrangler.jsonc`; the handler checks Stockholm time itself.
   ```sh
   npx wrangler deploy
   ```
4. Check:
   - `/api/push/key` (signed in) returns the public key.
   - Workers & Pages -> hotmonitor -> Settings -> Trigger Events lists the cron.
   - Machine: `curl -H "CF-Access-Client-Id: ..." -H "CF-Access-Client-Secret: ..."
     https://<host>/api/export/all` returns users/audit/security/reads/updates
     and no push keys.

Pushes go out only for reports dated today or yesterday (Stockholm), so
`app_sync.py push-all` of old reports never notifies anyone. The alarm
push goes to admins; report pushes to every subscribed active user,
respecting `prefs.report` / `prefs.alarm` = false.

Local testing: `.dev.vars` holds a separate local VAPID pair and
`DEV_PUSH_ALLOW=http://127.0.0.1:8799` (a fake push server, honoured only
together with the DEV_AUTH bypass). Run `npx wrangler dev --port 8787
--test-scheduled` and `scripts/smoke_test.sh`; the cron is triggered via
`/cdn-cgi/handler/scheduled?cron=...&time=<ms>`.

## Version 3.2 - notices, broadcast push, auto-update

From `webapp/`, logged in with `wrangler login` (unset any CLOUDFLARE_API_TOKEN):

```sh
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 migrations apply hotmonitor --remote   # 0004_notices.sql
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
```

No new secrets or vars. Open apps pick the new version up on their next
open: the new service worker takes control and the page reloads once.
Apps still on hm-v3.3 or older reload by themselves only from this
version on; they get it the first time they are opened after the deploy
(that open may show the old version once).

## Version 3.3 - invitation emails, "Uppdatera alla appar"

From `webapp/` (unset any CLOUDFLARE_API_TOKEN):

```sh
env -u CLOUDFLARE_API_TOKEN npx wrangler d1 migrations apply hotmonitor --remote   # 0005_invites.sql
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
```

On the Mac, the job that mails the invites (uses the SMTP settings and
the service token already in `~/.zshrc`):

```sh
cp ../schedule/launchd/se.threatmonitor.invites.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/se.threatmonitor.invites.plist
tail -f ../data/logs/invites.log
```

No new secrets or vars. People already in the list get no mail; use
"Skicka inbjudan" on their card if they need one.

## Version 3.8: the Worker starts the scheduled runs

1. On GitHub: Settings → Developer settings → Fine-grained personal access
   tokens → Generate new token. Repository access: only
   `jeaneclaude621-ui/threat_monitor`; permissions: Actions **Read and
   write** (Metadata read-only comes with it). Pick the longest expiry and
   note the date: when it runs out the runs fall back to GitHub's own,
   unreliable schedule and the admins get an alarm push at each start.
2. Store it as a Worker secret (run from `webapp/`, paste the token):
   ```sh
   npx wrangler secret put GITHUB_DISPATCH_TOKEN
   ```
3. Deploy. This registers the second cron trigger,
   `0 2,3,10,11,14,15,19,20 * * *` (UTC).
   ```sh
   npx wrangler deploy
   ```

## Version 3.9: trends

```sh
npx wrangler d1 migrations apply hotmonitor --remote   # 0008_trends.sql
npx wrangler deploy                                     # adds 06/07 UTC to the dispatch cron
```

## Version 3.10: the Swedish authorities

```sh
npx wrangler d1 migrations apply hotmonitor --remote   # 0010_authorities.sql
npx wrangler deploy                                     # adds 05 and 16 UTC to the dispatch cron
```

## Version 3.11: Russia's courses of action

```sh
npx wrangler d1 migrations apply hotmonitor --remote   # 0011_courses.sql
npx wrangler deploy
```

## Version 3.12: the forces map

```sh
npx wrangler d1 migrations apply hotmonitor --remote   # 0012_forces.sql
npx wrangler deploy
```

## Version 3.13: the bases' weekly survey and the strike map

```sh
npx wrangler d1 migrations apply hotmonitor --remote   # 0013_strikes.sql
npx wrangler deploy
```

The strike map needs a Kaggle account: GitHub secrets `KAGGLE_USERNAME`
and `KAGGLE_KEY` (Kaggle > Settings > API > Create New Token).

## Version 3.17: open to everyone, login only for the rest

The Worker now lets anyone read the public views as a guest
(`PUBLIC_READ` = `"1"` in `wrangler.jsonc`). Access must therefore stop
covering the whole hostname and only guard the login and the Mac's paths.
The Worker still checks every token itself, so a gap in Access exposes
nothing beyond what guests see anyway.

Do the steps in this order. The Mac's nightly upload keeps working
throughout.

**Or let a script do all of it** (it checks what is already there, fixes
it, adds the AUD tag, deploys, and asks before removing the old
protection). It needs an API token you make yourself and paste when asked;
the permissions are listed at the top of the script.

```sh
git checkout main && git pull
node webapp/scripts/open_app.mjs --check   # only report
node webapp/scripts/open_app.mjs           # do it
```

1. **New Access application for the protected paths.** Zero Trust ->
   Access -> Applications -> Add an application -> Self-hosted.
   - Name: `Hotmonitor inloggning`.
   - Destinations (public hostname `hotmonitor.<account-subdomain>.workers.dev`),
     one line per path: `login`, `api/ingest/*`, `api/export/*`.
   - Login method: One-time PIN only. Session duration: 30 days.
   - Policies: the existing "Hotmonitor users" (Allow) and "Hotmonitor Mac"
     (Service Auth).
   - Under cookie settings, leave *Cookie path attribute* **off**: the
     cookie set at `/login` must reach the whole hostname, or a logged-in
     person would read as a guest.
   - Copy the new application's *AUD tag*.
2. **Both AUD tags in the Worker.** In `wrangler.jsonc`, `ACCESS_AUD`
   becomes `"<old AUD>,<new AUD>"` (comma-separated, no secret). Then
   from `webapp/`:
   ```sh
   env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
   ```
3. **Turn the hostname-wide Access off.** Workers & Pages -> hotmonitor ->
   Settings -> Domains & Routes -> workers.dev -> *Disable Cloudflare
   Access* (or, if the old application was made by hand, delete it in Zero
   Trust -> Access -> Applications). The new application keeps the three
   paths guarded.
4. **Check** (no credentials):
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" $HOTMONITOR_URL/api/reports           # 200: guests read
   curl -s $HOTMONITOR_URL/api/me                                                 # {"role":"guest",...}
   curl -s -o /dev/null -w "%{http_code}\n" $HOTMONITOR_URL/api/reads             # 401
   curl -s -o /dev/null -w "%{http_code}\n" $HOTMONITOR_URL/api/export/assessments # 302 to Access
   ```
   and the Mac check from step 6 above (200). On a phone: the app opens
   without a login, *Logga in* goes through the one-time PIN and back,
   and the Bedöm tab returns for admins.

To close it again: set `PUBLIC_READ` to `"0"` and deploy; guests then get
401 on everything, even before Access is turned back on.

**Free-plan limits** (checked 3 Nov 2026, developers.cloudflare.com):

| What | Free plan | What it means here |
|---|---|---|
| Worker requests | 100 000 a day, reset 00:00 UTC; over it, error 1027 | Only `/api/*` and `/login` count; the app's files are static assets, free and unlimited. A visit makes about 6-10 API calls, the archive more: roughly 10 000 visits a day. |
| Worker CPU | 10 ms a request | Guests' answers are cached a minute per isolate and in the browser (`max-age=60`); the first answer is parsed once to replace e-mail addresses. |
| D1 | 5 million rows read and 100 000 written a day | Guests write nothing; the cache keeps reads to roughly one per path a minute per isolate. |
| Access | 50 seats | Guests never pass Access and take no seat. |

Above that, Workers Paid is $5 a month (10 million requests). The rate
limit of 120 requests a minute per IP still applies to guests.

## Deploying from GitHub Actions

`.github/workflows/deploy.yml` deploys the web app when a push to main
changes `webapp/`, or by hand (Actions -> Deploy web app -> Run workflow).
It runs the Worker tests first. It needs two repository secrets, which only
the owner adds (Settings -> Secrets and variables -> Actions):

- `CLOUDFLARE_API_TOKEN`: dash.cloudflare.com -> My Profile -> API Tokens
  -> Create Token -> template *Edit Cloudflare Workers* -> your account.
- `CLOUDFLARE_ACCOUNT_ID`: Workers & Pages -> the Account ID on the right.

Database migrations are still run by hand (`npm run migrate:remote`).
