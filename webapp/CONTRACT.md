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
    "score": 9,                        // final score, operator adjustment applied
    "model_score": 9,                  // the model's own score before it
    "title_sv": "...", "summary_sv": "...",
    "topics": ["Sabotage"],            // from TOPICS below
    "countries": ["EE"],               // ISO 3166-1 alpha-2
    "articles": [{ "id": "a1b2c3d4e5f60718", "outlet": "Reuters",
                   "title": "..." , "url": "https://..." , "tier": 1 }],  // url/title may be null
    "operator": { "delta": 0.0, "divergent": false,
                  "trace": [{ "assessment_id": "...", "article_id": "...", "outlet": "...",
                              "value": 1, "date": "2026-09-29", "weight": 0.8, "effect": 0.4 }] }
  }],
  "operator_influence": { "index_delta": 0.0, "note_sv": "...",
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
