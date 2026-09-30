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
