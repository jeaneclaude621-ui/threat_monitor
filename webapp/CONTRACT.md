# Hotmonitor web app - data and API contract

The Mac pipeline (`src/`), the Worker (`webapp/src/`) and the web app
(`webapp/public/`) all build against this file. Change it first, then the code.

## Hosting

One Cloudflare Worker serves the static app (`public/`, Workers Static
Assets) and the API (`/api/*`, handled by the Worker first). Data lives in
Cloudflare D1. Cloudflare Access sits in front of the whole hostname; the
Worker also verifies the Access JWT itself and fails closed without it.

## Report JSON (uploaded by the Mac, one per day)

The existing `reports/<date>_report_data.json`, plus:

```jsonc
{
  "date": "2026-09-30",
  "executive_sv": { "index_line": "...", "top": "...",
                    "sections": [{ "heading": "...", "items": [{ "label": "...", "text": "..." }] }] },
  "events": [{
    "id": "2026-09-30-e1",            // <date>-e<1-based index>
    "title": "...", "detail": "...", "sources": "...",
    "score": 9.3,                      // final score, operator adjustment applied (one decimal)
    "model_score": 9,                  // the model's own score before it
    "title_sv": "...", "summary_sv": "...",
    "topics": ["Sabotage"],            // from TOPICS below
    "countries": ["EE"],               // ISO 3166-1 alpha-2
    "direction": "escalating",         // escalating | de-escalating | neutral: which way
                                       // the event pushes the general index
    "articles": [{ "id": "a1b2c3d4e5f60718", "outlet": "Reuters",
                   "title": "..." , "url": "https://..." , "tier": 1 }],  // url/title may be null
    "operator": { "delta": 0.0, "divergent": false,
                  "trace": [{ "assessment_id": "...", "article_id": "...", "outlet": "...",
                              "value": 1, "date": "2026-09-29", "weight": 0.8, "effect": 0.4 }] }
  }],
  "operator_influence": { "index_delta": 0.0,   // applied to threat_index, after the band limit
                          "computed_delta": 0.0, // before the band limit
                          "note_sv": "...",
                          "trace": [/* same shape as events[].operator.trace */] }
}
```

Reports from before this contract (19-30 Sep) are backfilled with
`id`, `title_sv`, `summary_sv`, `topics`, `countries` and `articles`
(outlet names from `sources`, `url: null`). `operator` may be absent:
treat as no influence.

TOPICS (fixed, Swedish, used as ids and labels):
`Drönare`, `Sabotage`, `IT-hot`, `Skuggflotta`, `Sanktioner`,
`Diplomati`, `Arktis`, `Desinformation`, `Kinetiskt`.

Map countries: NO SE FI DK EE LV LT PL DE BY UA RU SK RO MD (others may
appear in data; the map only draws these).

Article id: first 16 hex chars of sha1(url) when there is a url, else of
sha1("<date>|<event index>|<outlet>").

## Operator assessments

Append-only. A change is a new row with `supersedes` = the row it
replaces. The latest row in a chain is the current verdict.

| value | meaning (Swedish label in the app) |
|---|---|
| +2 | Mycket trovärdig |
| +1 | Trovärdig |
| -1 | Tveksam |
| -2 | Inte trovärdig |
| 0  | Återkallad (withdrawn) |

A skipped card stores nothing.

Row: `{ id, ts, operator, article_id, report_date, event_id, outlet, value, supersedes, client_id }`
- `id`: server-generated uuid. `ts`: server time, ISO 8601 UTC.
- `operator`: the email from the verified Access JWT - never from the client.
- `client_id`: uuid made on the phone, for idempotent retries of an offline queue.

## API

All responses JSON. Errors: `{ "error": "..." }` with 4xx/5xx.

| Method | Path | Who | Returns |
|---|---|---|---|
| GET | `/api/me` | any user | `{ email, role }`, role `admin` or `reader` |
| GET | `/api/reports` | any user | `[{ date, threat_index, threat_index_30d, top_sv }]`, newest first |
| GET | `/api/reports/:date` | any user | the full report JSON |
| GET | `/api/assessments` | any user | all rows, oldest first |
| POST | `/api/assessments` | admin | body `{ article_id, report_date, event_id, outlet, value, supersedes, client_id }` -> the stored row (same row again for a repeated `client_id`) |
| PUT | `/api/ingest/reports/:date` | machine | body = report JSON -> `{ ok: true }` (replaces that date) |
| GET | `/api/export/assessments?since=<ts>` | machine | rows with `ts > since`, oldest first |

Roles: `ADMINS` and `READERS` (comma-separated emails, Worker vars).
Machine = an Access service token whose JWT `common_name` equals
`MACHINE_CLIENT_ID`. The Mac sends `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers; Access turns them into the JWT.

## Operator weighting (applied on the Mac, in `src/operator_weight.py`)

High, never decisive. Caps are enforced in code, not left to the model.
- Per article: current verdicts, each decayed with a 30-day half-life.
- Per outlet: the operator's decayed mean verdict, blended into the
  outlet's credibility at most 35 %.
- Per event: score moves at most +/-1 (on 1-10) from the model's score;
  the operator can never alone make a claim confirmed.
- Index: at most +/-0.3, and never across the anchor band.
- When operator and model clearly disagree, `divergent: true`: the report
  shows "Operatören avviker" instead of overriding.
Every effect is listed in a `trace` so the app can show why.

---

# Version 2 (1 Oct 2026)

## Access model: A - the app decides who gets in

Cloudflare Access only proves the visitor owns an email address
(one-time PIN, policy "Hotmonitor verified email": include everyone,
login method OTP only). The Worker decides who is let in, from the D1
`users` table. Unknown or removed emails get 403 and are logged. The
Mac's service token policy is unchanged.

`OWNER` (Worker secret, the owner's address) is always an active
admin, whatever the table says - the break-glass key so nobody can lock
the owner out. `ADMINS`/`READERS` (optional Worker secrets) only seed the table on first use.

## New D1 tables

- `users(email PK, role 'admin'|'reader', active 0/1, created_at, created_by, last_seen)`
- `audit_log(id, ts, actor, action, target, detail)` - append-only (triggers), every user change
- `security_log(id, ts, email, ip_country, path, method, reason, detail)` - reasons:
  `not_allowed` (verified email not in users / inactive), `invalid_jwt`,
  `forbidden` (role may not do this), `bad_request` (validation failed),
  `rate_limited`, `bad_origin`. Kept 90 days.
- `reads(email, item_id, ts, PK(email,item_id))` - item_id is an event id
  (`2026-09-30-e1`) or an update id.
- `updates(id PK, ts, thread_id, thread_label, classification, title_sv, summary_sv, outlets TEXT json, report_date)`
  - the live feed from the Mac's hourly monitor.

## New and changed API

| Method | Path | Who | |
|---|---|---|---|
| GET | `/api/me` | user | `{ email, role, is_owner }` |
| GET | `/api/updates?since=<ts>` | user | live feed rows, newest first (default last 7 days) |
| GET | `/api/reads` | user | `{ item_ids: [...], last_visit }` for me |
| POST | `/api/reads` | user | `{ item_ids: [...] }` or `{ all_before: <ts> }` -> marks read |
| GET | `/api/admin/users` | admin | users with last_seen and assessment counts |
| POST | `/api/admin/users` | admin | `{ email, role }` add (or reactivate) |
| PATCH | `/api/admin/users/:email` | admin | `{ role }` or `{ active: false }` |
| DELETE | `/api/admin/users/:email` | admin | deactivate (kept for history) |
| GET | `/api/admin/security?days=7` | admin | `{ counts: {reason: n} for 24h and 7d, rows: [...] }` newest first, max 200 |
| GET | `/api/admin/audit` | admin | audit rows newest first |
| GET | `/api/admin/status` | admin | `{ last_report_date, last_report_uploaded_at, last_update_at, last_machine_pull_at, counts: {reports, events, assessments, users}, service_token_expires }` |
| PUT | `/api/ingest/updates` | machine | `[update rows]`, upsert by id |

Rules: the last active admin cannot be demoted or removed; OWNER can't
be demoted or removed. Every mutating request must carry
`Origin` equal to the app's own origin (else `bad_origin`). Per-email
rate limit ~120 requests/min (else 429 `rate_limited`).

## Richer report JSON (from 2 Oct reports; older ones lack these - render only if present)

Per event: `known_sv` [strings], `unknown_sv` [strings], `thread_id`
(one of the watchlist thread ids, or null).
Per article: `summary_sv` (2-3 sentences, what this article says),
`published` (YYYY-MM-DD or null), `relation` one of
`bekräftar` | `motsäger` | `tillför` | null.

## App behaviour (frontend)

- New/unread: an event or update not in my reads is "Ny"; an event whose
  thread got an update after I read it is "Uppdaterad". Opening marks read.
  Tab badges show unread counts. "Nytt sedan senast" box on Idag.
- Filter bar: facets = TOPICS + countries, counted over events in the
  chosen period, top 10 by count, shown with counts. Multi-select = AND.
  On Idag, Arkiv, Ämnen and Bedöm; state in the hash (`f=Drönare,RO`).
- Every title, outlet, topic, country and date is a link. Outlet ->
  `#/kalla/<outlet>` (tier, appearances, my verdicts, latest articles).
- External links always go through an in-app warning sheet first
  ("Du lämnar Hotmonitor och öppnar <domän>…" [Stanna kvar] [Öppna originalet]).
- Tap always reads; swipe only in Bedöm (event page source rows become tap targets).
- `#/admin` (admins): Användare, Säkerhet, Systemstatus, Ändringslogg.

---

# Version 3 (1 Oct 2026)

## Report JSON additions (from the Mac)

- `self_check_results`: `[{ event_id, outcome: "CONFIRMED"|"CONTRADICTED"|"UNRESOLVED", note }]`
  - yesterday's events re-checked today (event ids of the PREVIOUS report).
- `operator_track_record`: `{ "<email>": { evaluated, agreed, rate } }` - an
  operator's current verdicts on articles whose event later got a
  CONFIRMED/CONTRADICTED outcome; agreed = (+ and CONFIRMED) or (- and
  CONTRADICTED). rate = agreed/evaluated (null if evaluated = 0). Shown,
  not (yet) used as weight.
- Outlet names are canonical (aliases merged: "Associated Press" -> "AP",
  "The Guardian" -> "Guardian", ...), so the app can group by outlet.

## Missing-report alarm (Worker cron)

Worker `scheduled` handler, cron `*/30 3-9 * * *` (UTC). When Europe/Stockholm
local time is past 07:00 and no report for today's Stockholm date exists,
set `meta.alarm_missing_report = <date>` (once per date), write an
audit row `alarm` and send a push (below) to admins. Cleared when that
date's report is ingested. `/api/admin/status` gains `alarm: { missing_report: <date>|null }`,
and `/api/me` gains `alarm` (same object) so the app can show a red banner
to everyone: "Dagens rapport har inte kommit än".

## Web Push

VAPID keys: public key in var `VAPID_PUBLIC_KEY`, private key as Worker
secret `VAPID_PRIVATE_KEY` (JWK or base64url raw), subject `mailto:<OWNER>`.
- D1 `push_subscriptions(endpoint PK, email, p256dh, auth, created_at, prefs TEXT json)`.
- `GET /api/push/key` -> `{ publicKey }`; `POST /api/push/subscribe` body = PushSubscription JSON
  (+ optional `prefs`); `POST /api/push/unsubscribe` `{ endpoint }`.
- Sent (aes128gcm, RFC 8291/8292, WebCrypto only) on ingest of a report when
  (a) threat_index moved >= 0.5 from the previous report, or (b) any event
  score >= 9 that is new; and for the missing-report alarm (admins only).
  Payload `{ title, body, url }` in Swedish, e.g. "Hotindex 7,1 (+0,6)".
  Expired subscriptions (404/410) are deleted.
- Endpoint host must be a known push service (web.push.apple.com,
  fcm.googleapis.com, updates.push.services.mozilla.com, *.notify.windows.com).

## Home screen

- `POST /api/me/device` `{ standalone: bool, platform: "ios"|"android"|"desktop" }`
  - stored on the user (`users.installed_at` when standalone first seen, `users.platform`).
  Admin users list shows "Hemskärm: ja/nej".
- App: a "Lägg till på hemskärmen" button/card on Idag until the app runs
  standalone (`navigator.standalone` or `display-mode: standalone`). iOS has
  no install prompt: the button opens a sheet with the three Safari steps
  (Dela-ikonen -> Lägg till på hemskärmen -> Lägg till), drawn as inline
  SVG; on Android/Chrome use `beforeinstallprompt`. "Inte nu" hides it 7 days.
  Push can only be enabled once installed on iOS - the push toggle explains that.

## Backup

`GET /api/export/all` (machine): `{ users, audit_log, security_log, reads,
updates, push_subscription_count, exported_at }` - no push keys. The Mac
saves it daily to `data/backups/app-<date>.json` (keeps 30).

---

# Version 3.1 (1 Oct 2026) - Bedöm per news item

- Report JSON gains `favicons`: `{ "<domain>": "data:image/png;base64,..." }` for
  every article domain in the report (domain = url host without `www.`), max
  ~6 KB each, fetched on the Mac. Missing domain -> show a monogram tile.
- Bedöm shows ONE card per event that has >= 1 article with a url. The card:
  event title_sv, summary_sv, topics/countries, the model's score, and a list
  of source previews (favicon or monogram, outlet, tier badge, domain,
  published date, article title, summary_sv, relation chip), each opening the
  original through the external-link warning sheet. Articles without url are
  listed under "Utan länk" but are not assessed.
- One swipe = the event verdict, written as one assessment row per linked
  article (same value; supersedes each article's current row when re-assessing).
  Tapping a source row before swiping lets the user give that source its own
  value (5 small verdict buttons); unset sources take the swipe value.
- An event leaves the deck when every linked article has a current verdict by
  me (including queued outbox rows) or when skipped (skips kept in localStorage
  for 7 days, try/catch). After a swipe the card animates out and the next
  event animates in. Deck order: newest report first, then by score.
- `thread_label` in updates is a short label (<= 120 chars) from the Mac.

---

# Version 3.2 (1 Oct 2026) - notices, broadcast push, auto-update

- D1 `notices(id TEXT PK, ts, author, title, body, url NULL, active INTEGER, expires_at)`.
- `GET /api/notices` (user): active, not expired, newest first.
- `POST /api/admin/notices` (admin, Origin-checked) `{ title (1-80), body (1-500),
  url? ("#/..." or "/..." same-origin path), push: bool, expires_days (1-30, default 7) }`
  -> stores, audit row `notice`; when `push`, Web Push to every subscribed active
  user (skipped where `prefs.notice === false`) with `{ title, body, url: url || "/#/" }`.
  Returns `{ notice, pushed, failed }`.
- `DELETE /api/admin/notices/:id` (admin) -> active = 0, audit row `notice_removed`.
- App: active notices as dismissible cards at the top of Idag (dismissed ids in
  localStorage). Admin sub-tab "Meddelanden": compose, push toggle, expiry,
  device count with notifications on, active list with "Ta bort".
- Auto-update: when a new service worker takes control the page reloads once
  (sessionStorage guard); `registration.update()` on start and when the app
  becomes visible (max once per 10 min). A deploy is picked up on first open.
- Idag shows "Få notiser vid allvarliga händelser" when running standalone,
  notifications are supported, permission is not denied and there is no
  subscription; "Inte nu" hides it 14 days.

---

# Version 3.3 (4 Oct 2026) - invitation emails, "Uppdatera alla appar"

Invitations. The Worker cannot send mail, so it queues and the Mac sends.
- D1 `invites(id TEXT PK, email, role, requested_at, requested_by, status
  'pending'|'sent'|'failed'|'cancelled', sent_at, error, attempts)`.
- `POST /api/admin/users` takes `invite: bool`. A new user is invited unless
  `invite === false`; an existing one (reactivation, role change) only when
  `invite === true`. Audit row `invite`. One open invite per person: queueing
  cancels an older pending one; removing a user cancels theirs.
- `POST /api/admin/users/:email/invite` (admin) -> queues a new invite (409 if
  the user is removed). Returns the user row.
- User rows gain `invite_status`, `invite_requested_at`, `invite_sent_at`,
  `invite_error` (latest invite).
- `GET /api/export/invites` (machine): pending invites for active users,
  `{ id, email, role, requested_at, requested_by, attempts }`, oldest first,
  max 50; records `meta.last_invite_pull_at`.
- `PUT /api/ingest/invites/:id` (machine) `{ status: 'sent' | 'failed', error? }`.
  A failure stays pending (retried next run) until 3 attempts, then `failed`.
- Mac: `src/app_mail.py send-invites` every 2 min (launchd
  `se.threatmonitor.invites`). Mail: link, login steps, role; Reply-To the
  admin who invited; ids mailed kept in `data/app_invites_sent.json` so a lost
  report never mails twice.
- `/api/admin/status` gains `invites: { pending, last_pull_at }`; the app shows
  a tile while any are pending (warn when the Mac has not pulled for 30 min).

"Uppdatera alla appar".
- `POST /api/admin/refresh` (admin, Origin-checked) `{ message? (<= 200) }` ->
  `meta.app_refresh = { id, at, by, message }`, audit row `refresh`, Web Push
  to all (respecting `prefs.notice === false`) with `{ title: "Hotmonitor har
  uppdaterats", body, url: "/#/", tag: "hm-refresh", kind: "refresh",
  refresh_id }`. 429 within 30 s of the previous one. Returns `{ refresh,
  pushed, failed }`.
- `GET /api/me` and `/api/admin/status` gain `refresh` (null if never sent).
- Service worker (hm-v3.5, hm-v3.6): a `kind: "refresh"` push also runs
  `registration.update()` and posts `{ type: "hm-refresh" }` to open windows;
  tapping the notification posts it to the focused window.
- App: when `me.refresh.id` is new to this device (localStorage
  `hm.refreshSeen`) and newer than the page's start (2 min slack), it waits for
  a new service worker if one is installing (max 8 s) and reloads once, then
  shows "Appen har uppdaterats <time> · <message>" at the top until closed. A
  page started after the refresh only shows the line (if under 3 days old);
  a device's first start shows nothing. The admin page that sent it shows
  the line at once without reloading. `hm-refresh` messages and becoming
  visible re-check `/api/me`.

# Version 3.4 (12 Oct 2026) - scheduled runs on the status page

The daily report and the hourly monitor now run on GitHub Actions or the
Mac (`schedule/run_job.py`, which picks the machine from `data/runner`).
Each run reports itself so admins can see that the jobs keep running.
- D1 `runs(id TEXT PK, job 'daily'|'hourly', host 'mac'|'cloud', started_at,
  finished_at, status 'running'|'ok'|'failed', exit_code, warnings JSON
  array, log_url)`. Rows older than 90 days are deleted on each ingest.
- `PUT /api/ingest/runs/:id` (machine; id = 32 hex) `{ job, host,
  started_at, status, finished_at?, exit_code?, warnings? (<= 50 strings of
  <= 500, the job's "!" lines), log_url? (a github.com Actions run URL) }`.
  Sent with `status: 'running'` at the start and again at the end, same id.
  Test runs are not reported.
- `/api/admin/status` gains `runs: { runner, jobs, mac, recent }`.
  `jobs[]` = `{ job, label, due: ['HH:MM'], light, text, last }` with
  `light` green | yellow | red. Stockholm due hours live in `RUN_JOBS`
  (daily 05, hourly 01 and 16):
  - red: the last run failed, has run over twice its expected time, or the
    due run has not started 45 min after its time;
  - yellow: finished with warnings, or no run reported yet;
  - green: finished without warnings, or running normally. Before the 45
    minutes are up, a job keeps the light of its previous run.
  `mac` = the invitation job (hourly on GitHub Actions since 2026-10-24;
  the key keeps its old name), from `meta.last_invite_pull_at`: green
  when heard from in the last 75 min, red when it has been silent over
  150 min and an invitation waits, otherwise yellow. `recent` = the last 30 runs.
- App: Status is the first and default admin tab. On top, the worst light
  ("Allt snurrar" / "Något att hålla koll på" / "Något har gått fel") and
  where the jobs run, then one row per job and the Mac, then the last 15
  runs with their warnings and a link to the GitHub Actions log.
- The missing-report alarm's push and card no longer tell the reader to
  check the Mac.

# Version 3.5 (24 Oct 2026) - sources added in the app
The model (Gemini's free tier) no longer searches; the jobs gather the
articles it reads (`src/news_sources.py`). Admins can add to what is read.
- D1 `sources(id TEXT PK uuid, kind 'rss'|'article', url, title, added_by,
  added_at, active 0|1)`.
- `GET /api/admin/sources` (admin): active sources, newest first.
- `POST /api/admin/sources` (admin) `{ url, kind?: 'auto'|'rss'|'article',
  title? }`. The Worker fetches the URL (8 s): with `auto`, an RSS/Atom
  document becomes `rss`, anything else `article` titled by its og:title
  or <title>; with `rss`, an HTML page is replaced by the feed it announces
  in `<link rel="alternate">`. 400 bad URL, 409 already active, 422 the
  page could not be fetched or has no feed. 201 `{ source }`. Audited as
  `source`.
- `DELETE /api/admin/sources/:id` (admin): sets `active = 0`. Audited as
  `source_removed`.
- `GET /api/export/sources` (machine): active `{ id, kind, url, title,
  added_at }`. Feeds join config/feeds.json in every run; articles are read
  by the hourly checks after they were added and by the daily report for
  three days.
- App: admin tab "Källor" between Status and Användare - a link field with
  "Klistra in", a type choice, and the lists of added feeds and articles,
  each removable.

# Version 3.6 (25 Oct 2026) - schedule and quiet hours

- The hourly monitor runs every hour, day and night
  (`RUN_JOBS.hourly.hours`); invitations are mailed every five minutes,
  so `MAC_QUIET_MIN` is 30. The hourly job fires at :30, so
  `RUN_START_GRACE_MIN` is 75.
- Quiet hours 22:00-07:00 Stockholm time: `pushTo` sends nothing and
  queues the push (at most 20) in `meta.push_deferred`; the cron sends the
  queue on its first run after 07:00. The missing-report alarm moves from
  06:30 to 07:00.
- `OWNER`, `ADMINS` and `READERS` are Worker secrets, no longer vars in
  wrangler.jsonc, so no address lives in the (public) repo.
- Service worker hm-v3.11.

# Version 3.7 (30 Oct 2026) - four runs a day

- The Gemini free tier allows 20 calls a day per model, and the monitor
  used one per thread every hour. The daily report now runs at 04:00 and
  the thread monitor at 12:00, 16:00 and 21:00 Stockholm
  (`RUN_JOBS.daily.hours`, `RUN_JOBS.hourly.hours`); the job keeps its
  name `hourly`. The monitor checks all threads in one call.
