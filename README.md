# Russia \u2192 NATO/EU/Ukraine Hybrid Threat Monitor

A local app that watches mainstream reporting on Russia's hybrid activity
toward NATO/EU/Ukraine, checks hourly for corrections and narrative
drift, tracks source and author transparency over time, and produces a
consolidated PowerPoint status report every morning at 05:00.

## What it does

- **Every hour, 24/day**: rechecks a watchlist of 6 active threads
  against their last known status. Logs whether each is unchanged, has
  a new development, was formally corrected by an outlet, or shows a
  narrative shift without a formal correction.
- **Every day at 05:00**: self-checks yesterday's scored claims against
  what actually happened since; runs a broad research sweep for new
  developments; recomputes the two 1\u201310 threat indices (see "Threat
  indices" below); refreshes the
  watchlist; proposes exactly one concrete methodology improvement; and
  builds `reports/YYYY-MM-DD_hybrid_threat_monitor.pptx`. If email is
  configured (see "Email delivery" below), it then sends the report to
  admin.one@example.org as an iPhone-friendly HTML digest with the deck attached.
- Persists everything in `data/state.json`: source-tier methodology,
  outlet transparency scores, author track records (evidence-based
  only \u2014 corrections and contradictions, never subjective judgments),
  and the threat-index history.

## Setup

1. **Get an Anthropic API key** at https://console.anthropic.com \u2014
   this is separate from a claude.ai login and runs on metered billing
   (pay-per-use, not your Claude subscription).

2. **Install Python 3.9+** if you don't have it — and if you're not sure
   what you have, or already know you don't, the easiest path is:
   ```
   bash setup/check_environment.sh
   ```
   This only checks and reports — it changes nothing. It tells you
   exactly what's missing (Xcode Command Line Tools, Homebrew, Python,
   pip, the project's Python packages, your API key). Then:
   ```
   bash setup/install_missing.sh
   ```
   installs only what that check found missing, skips what's already
   there, and is safe to re-run. If it stops partway (e.g. after
   installing Xcode Command Line Tools, which needs a one-time GUI
   click-through), just run both commands again once it tells you to.

3. **Install dependencies** (skip this if `install_missing.sh` already
   did it for you):
   ```
   python3 -m pip install -r requirements.txt
   ```
   (On Mac/Linux, Python's pip is invoked via `python3 -m pip`, not a
   bare `pip` command, unless you've separately aliased it.)

4. **Set your API key** as an environment variable:
   - macOS/Linux: `export ANTHROPIC_API_KEY=sk-ant-...`
   - Windows (PowerShell): `$env:ANTHROPIC_API_KEY="sk-ant-..."`

   For scheduled/unattended runs, this needs to be set permanently
   (system environment variable on Windows; directly in the crontab
   on macOS/Linux) \u2014 see the scripts in `schedule/`.

5. **Do one manual run first** to seed the data folder and check
   everything works before scheduling anything:
   ```
   python3 src/hourly_monitor.py
   python3 src/daily_report.py
   ```
   Open the resulting file in `reports/` to check it looks right.

6. **Set up the schedule:**
   - Windows: open PowerShell as Administrator in this folder, run
     `schedule/setup_windows.ps1`
   - macOS/Linux: run `bash schedule/setup_macos_linux.sh`

   Both register an hourly run and a 05:00 daily run without touching
   any other scheduled tasks/cron entries you already have.

   **On macOS, prefer launchd over cron** (`schedule/launchd/*.plist`):

   ```
   cp schedule/launchd/*.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/se.threatmonitor.daily.plist
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/se.threatmonitor.hourly.plist
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/se.threatmonitor.invites.plist   # app invitation emails, every 2 min
   ```

   cron silently skips any run scheduled while the Mac is asleep and
   never replays it - two daily reports were lost that way. launchd
   runs a missed job as soon as the machine wakes. The plists source
   `~/.zshrc`, so credentials stay in one place rather than being
   copied into them. To have the report arrive on time rather than at
   wake, also schedule a wake:

   ```
   sudo pmset repeat wakeorpoweron MTWRFSU 04:55:00
   ```

   **Keep the project outside `~/Documents`, `~/Desktop` and
   `~/Downloads`.** macOS guards those folders, and a launchd agent
   (running as zsh/python, not as an app you can grant access to)
   fails there with `Operation not permitted` before it reads a single
   file. `~/threat_monitor` works without any privacy exemption.

## Spoken Swedish briefing (podcast mode)

Each daily report is also rendered as a ~4 minute spoken briefing in
Swedish and attached to the email as an `.m4a`, which plays inline in
Apple Mail on an iPhone. It covers results only - no sources, no
outlet names, no scores read aloud.

The script is written by Claude from the finished report data and saved
next to the deck as `<date>_briefing_sv.txt`; the audio is rendered
locally by macOS `say` with the Swedish voice Alva and converted with
`afconvert`, so it needs no extra service or API key. On a machine
without those tools the script is still produced and the report goes
out as before - the briefing is best-effort and never blocks the run.

```
python3 src/podcast.py                 # today's report
python3 src/podcast.py 2026-09-21      # a specific date
python3 src/podcast.py --script-only   # script, no audio
```

## Svensk Super Executive

The top of each morning email carries a one-screen Swedish summary:
both indices, the top development, then every heading of the deck with
one short sentence per topic. Claude writes it from the finished report
data as structured JSON, saved as `<date>_executive_sv.json`. Like the
podcast it is best-effort: if it fails, the email goes out without it.

```
python3 src/executive_sv.py              # today's report
python3 src/executive_sv.py 2026-09-28   # a specific date
```

## Web app and operator assessments

`webapp/` is a private web app for iPhone (add it to the home screen):
today's report, the archive, search and topics, a country map, and each
event with its articles and links. It runs on Cloudflare - a Worker for
the app and API, D1 for the data, and Cloudflare Access in front, so
only the listed email addresses get in (one-time code by mail, no
password). `webapp/CONTRACT.md` defines the data and API;
`webapp/DEPLOY.md` the setup.

Admins also make **operator assessments**: in the Bedöm tab each article
is a card, swiped right (credible, far right very credible), left
(doubtful / not credible) or up (skip). No text input. Assessments are
append-only - a change is a new row that supersedes the old one - and
can be adjusted under Mina bedömningar by swiping again.

They weigh in with high but never decisive weight (`src/operator_weight.py`,
caps enforced in code): a verdict halves in weight every 30 days, one on
another article from the same outlet counts 35 %, an event's score moves
at most +/-1 from the model's own score, and the index at most +/-0.3 and
never out of its anchor band. Clear disagreement is flagged "Operatören
avviker" instead of overriding. Every effect lists the assessment ids
behind it, so the app can show why a score is what it is.

The daily run pulls new assessments first (`data/operator_assessments.jsonl`
is the local copy) and uploads the finished report last:

```
python3 src/app_sync.py pull
python3 src/app_sync.py push 2026-09-30
python3 src/app_sync.py push-all
python3 src/backfill_app.py      # app fields for reports older than the app
python3 src/app_mail.py check    # new mail replies about the app (read-only)
```

Article links in the app are only ones the web search actually
retrieved; reports from before 1 Oct have no links.

## Threat indices

Each report carries two indices, both scored against the anchor bands in
`config/methodology.json` (each band names an observable condition that
must be met):

- **General** \u2014 where the Russia\u2013NATO/EU relationship stands today.
- **Next 30 days** \u2014 a forecast: the band expected to best describe
  the relationship over the coming 30 days, from dated drivers inside
  that window (deadlines, summits, exercises, expiring measures) and the
  direction of current trends. It can sit above or below the general one.

To rescore the whole history against the current methodology (after the
anchors change, say):

```
python3 src/recalibrate.py --dry-run   # print old vs new, save nothing
python3 src/recalibrate.py             # save to state and data/recalibration.json
```

Each past day is rescored blind, from the evidence its own report
recorded, without web search and without its old value. Sent reports are
not changed.

## Responding to the daily methodology proposal

Each day's report ends with one proposed, scoped change to the scoring
methodology. Resolve it before the next day's report runs - either by
**replying to the report email** with a single word, `accept` or `deny`
(the reply is picked up at the start of the next scheduled run, and a
short confirmation is mailed back), or from the command line:

```
python3 src/daily_report.py --resolve accept
python3 src/daily_report.py --resolve deny
```

Email replies are read from the `MAIL_FROM` inbox over IMAP using the
same credentials as sending (`src/reply_checker.py`; Gmail needs IMAP
access enabled, which it is by default). Only replies from an address in `MAIL_TO` or
the sending address count; a reply containing both words, or neither,
is logged and ignored. `python3 src/reply_checker.py --dry-run` shows
what would happen without changing anything. Override the mailbox with
`IMAP_HOST` / `IMAP_PORT` / `IMAP_USERNAME` / `IMAP_PASSWORD` if it is
not the same Gmail account.

Accepted changes are appended to `state.json` and are included as
context in every future research prompt. If a proposal is left
unresolved, the next daily run keeps it pending rather than generating
a new one \u2014 only one proposal is ever open at a time.

## Email delivery (optional)

The 05:00 run emails the report to **admin.one@example.org** automatically
once you configure SMTP - an iPhone-friendly HTML digest in the
message body (renders directly in Apple Mail, no attachment tap
needed) plus the full deck attached as a PowerPoint file. If SMTP
isn't configured, this step is skipped with a log line - it never
blocks or breaks the rest of the report.

Set these environment variables the same way you set
`ANTHROPIC_API_KEY` (permanently, so the scheduled/cron runs see
them too):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=your.address@gmail.com
SMTP_PASSWORD=your-app-password
MAIL_FROM=your.address@gmail.com
MAIL_TO=admin.one@example.org,reader.one@example.org   # optional - comma-separated;
                                                      # defaults to admin.one@example.org alone
```

**Gmail example:** use an **app password**, not your normal Gmail
password - Google blocks plain-password SMTP logins. Create one at
https://myaccount.google.com/apppasswords (requires 2-Step
Verification to be on). Any standard SMTP provider works the same
way (iCloud Mail, Outlook, a custom domain's mail host, etc.) - just
point `SMTP_HOST`/`SMTP_PORT` at it and use that provider's own app
password or SMTP credential, never your main account password.

To test it once by hand before trusting the schedule:
```
python3 -c "from src.mailer import send_daily_email; import json; d=json.load(open('reports/<today>_report_data.json')); send_daily_email(d, 'reports/<today>_hybrid_threat_monitor.pptx')"
```


`config/methodology.json` is the starting configuration (only read the
very first time the app runs, to seed `data/state.json`). After that,
`data/state.json` is the live copy \u2014 edit it directly if you want to
hand-adjust the source tiers, the watchlist, or anything else. It's
plain JSON.

## Cost note

Each hourly run makes one Claude API call per watchlist thread (6 by
default) with web search enabled; the daily run makes a few larger
calls. This is ongoing, metered API usage on your own key \u2014 check
https://console.anthropic.com for current pricing and keep an eye on
usage for the first few days to see what a day/week actually costs
before leaving it running long-term.

## Files

```
threat_monitor/
  setup/check_environment.sh   diagnoses what's missing on your Mac (no changes)
  setup/install_missing.sh     installs only what the check found missing
  config/methodology.json      starting source-tier & watchlist config
  src/common.py                state persistence, logging, API wrapper
  src/hourly_monitor.py        hourly thread-check
  src/daily_report.py          05:00 consolidation, self-check, proposal, deck build
  src/recalibrate.py           rescores the threat-index history against current rules
  src/pptx_builder.py          PowerPoint generation (python-pptx)
  src/mailer.py                daily HTML digest email + PPTX attachment
  schedule/setup_windows.ps1   Windows Task Scheduler setup
  schedule/setup_macos_linux.sh cron setup for macOS/Linux
  data/state.json              persistent state (created on first run)
  data/logs/                   hourly logs (rolled into daily summaries)
  reports/                     daily PPTX + JSON output
```

## A few honest caveats

- The 1\u201310 threat indices and the byline/outlet scores are Claude's
  ongoing analytical synthesis of the reporting it finds \u2014 not an
  official metric. Treat the deck as a structured read, not ground
  truth.
- Web search results depend on what's indexed and discoverable at run
  time; a quiet hour in search results doesn't always mean nothing
  happened.
- This is unattended and unsupervised by design. Check in on it
  periodically \u2014 especially the accepted-changes list \u2014 rather than
  treating it as fire-and-forget forever.
