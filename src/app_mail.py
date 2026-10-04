"""
Mail about the web app itself - separate from the daily report mail.

    python3 src/app_mail.py invite           # mail the testers link + login steps
    python3 src/app_mail.py send-invites     # mail invites queued in the web app
    python3 src/app_mail.py check            # print new replies (read-only)
    python3 src/app_mail.py check --all      # include ones already shown

`send-invites` runs every two minutes from launchd
(se.threatmonitor.invites): adding a person on the app's admin page
queues an invite in the Worker, which cannot send mail itself. This
fetches the queue as the Mac's service token, mails each person the link
and login steps over SMTP, and reports sent/failed back. Ids already
mailed are kept in data/app_invites_sent.json, so a lost report never
mails anyone twice.

`check` is how instructions sent by mail reach whoever maintains the
app: it prints new replies whose subject contains SUBJECT_MARKER from a
trusted sender, with the quoted original stripped. It opens the inbox
read-only (nothing is marked read, so reply_checker.py and the person's
own mail client are unaffected) and remembers what it has shown in
data/app_mail_seen.json.

Every reply is marked VERIFIED only when Gmail's Authentication-Results
show DKIM or DMARC passing for the sender's own domain. A From: header
alone is easy to forge, so an unverified reply must not be acted on
without confirmation.

Same SMTP/IMAP env vars as mailer.py and reply_checker.py.
"""
import email
import imaplib
import json
import re
import os
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR
from mailer import _smtp_send, send_plain_email
from reply_checker import QUOTE_START_RE, _imap_config

SUBJECT_MARKER = "Hotmonitor-appen"
TESTERS = ["admin.one@example.org", "admin.two@example.org"]
TRUSTED = set(TESTERS) | {"the.owner@example.org"}
SEEN_PATH = DATA_DIR / "app_mail_seen.json"
INVITES_SENT_PATH = DATA_DIR / "app_invites_sent.json"


def invite(url: str) -> None:
    body = f"""Hej!

Här är Hotmonitor-appen för test. Ni två är administratörer: ni kan läsa
allt och göra operatörsbedömningar genom att svepa på artiklarna.

Länk: {url}

Så loggar du in (första gången, sedan håller inloggningen i 30 dagar):
1. Öppna länken i Safari på iPhone.
2. Skriv in din e-postadress (den här, som mejlet kom till).
3. Du får en sexsiffrig kod från Cloudflare - skriv in den.
Det finns inget lösenord; bara er två adresser och min kommer in.

Lägg den på hemskärmen så beter den sig som en app:
Dela-knappen -> "Lägg till på hemskärmen".

Operatörsbedömning (fliken Bedöm) - bara svep, ingen text:
- Kort åt höger: trovärdig. Långt åt höger: mycket trovärdig.
- Kort åt vänster: tveksam. Långt åt vänster: inte trovärdig.
- Uppåt: hoppa över.
Allt sparas och kan justeras under "Mina bedömningar" (svep igen).
Bedömningarna väger tungt men avgör aldrig ensamma, och varje poäng
visar under "Varför denna poäng?" vilka bedömningar som påverkat den.

Svara gärna på det här mejlet med synpunkter och önskemål.
"""
    for to in TESTERS:
        send_plain_email(to, f"{SUBJECT_MARKER} - inbjudan till test", body)


def invite_text(url: str, role: str) -> str:
    if role == "admin":
        what = ("Du är administratör: du kan läsa allt, göra operatörsbedömningar\n"
                "(fliken Bedöm, svep på artiklarna) och hantera användare.")
    else:
        what = ("Du kan läsa dagens rapport, arkivet, ämnen och kartan, och få\n"
                "notiser när något allvarligt händer.")
    return f"""Hej!

Du har fått tillgång till Hotmonitor, den dagliga bedömningen av ryska
hybridhot mot Nato, EU och Ukraina.

{what}

Länk: {url}

Så loggar du in (första gången, sedan håller inloggningen i 30 dagar):
1. Öppna länken, gärna i Safari på iPhone.
2. Skriv in din e-postadress (den här, som mejlet kom till).
3. Du får en sexsiffrig kod från Cloudflare Access - skriv in den.
Det finns inget lösenord. Hittar du inte koden, titta i skräpposten.

Lägg appen på hemskärmen så beter den sig som en app:
Dela-knappen -> "Lägg till på hemskärmen". Där kan du också slå på notiser.

Frågor? Svara på det här mejlet.
"""


def _send_invite(to: str, url: str, role: str, reply_to: str) -> None:
    """Raises on failure, so the reason can be shown on the admin page."""
    host, port = os.environ.get("SMTP_HOST"), os.environ.get("SMTP_PORT")
    user, password = os.environ.get("SMTP_USERNAME"), os.environ.get("SMTP_PASSWORD")
    mail_from = os.environ.get("MAIL_FROM")
    if not all([host, port, user, password, mail_from]):
        raise RuntimeError("SMTP är inte konfigurerat på Macen")
    msg = EmailMessage()
    msg["Subject"] = f"Inbjudan till {SUBJECT_MARKER}"
    msg["From"] = mail_from
    msg["To"] = to
    if reply_to and "@" in reply_to:
        msg["Reply-To"] = reply_to
    # RFC 3834: sent by a program, not a reply to anything.
    msg["Auto-Submitted"] = "auto-generated"
    msg.set_content(invite_text(url, role))
    _smtp_send(host, port, user, password, msg)


def send_invites() -> int:
    """Mails the invites queued in the web app. Returns how many were sent.
    Never raises: the next run (two minutes later) simply tries again."""
    from app_sync import _config, _request
    cfg = _config()
    if not cfg:
        print("  Invites skipped - HOTMONITOR_URL / CF_ACCESS_CLIENT_* not set")
        return 0
    url = cfg[0] + "/"
    try:
        pending = _request("GET", "/api/export/invites", retries=False)
    except Exception as e:
        print(f"  ! Could not fetch invites: {e}")
        return 0
    try:
        mailed = json.loads(INVITES_SENT_PATH.read_text())
    except (OSError, ValueError):
        mailed = {}
    sent = 0
    for inv in pending:
        iid, to = inv.get("id"), inv.get("email")
        if not iid or not to:
            continue
        if iid not in mailed:
            try:
                _send_invite(to, url, inv.get("role") or "reader", inv.get("requested_by") or "")
            except Exception as e:
                reason = str(e) or type(e).__name__
                print(f"  ! Invite to {to} failed: {reason}")
                try:
                    _request("PUT", f"/api/ingest/invites/{iid}", {"status": "failed", "error": reason[:300]}, retries=False)
                except Exception as e2:
                    print(f"  ! Could not report the failure: {e2}")
                continue
            mailed[iid] = datetime.now(timezone.utc).isoformat()
            INVITES_SENT_PATH.write_text(json.dumps(mailed, indent=1))
            sent += 1
            print(f"  Invite sent to {to}")
        try:
            _request("PUT", f"/api/ingest/invites/{iid}", {"status": "sent"}, retries=False)
        except Exception as e:
            # Reported again on the next run; the local record stops a second mail.
            print(f"  ! Could not report invite {iid} as sent: {e}")
    return sent


def _load_seen() -> set:
    try:
        return set(json.loads(SEEN_PATH.read_text()))
    except (OSError, ValueError):
        return set()


def _unquoted_text(msg) -> str:
    part = msg
    if msg.is_multipart():
        part = next((p for p in msg.walk() if p.get_content_type() == "text/plain"), None)
        if part is None:
            return ""
    payload = part.get_payload(decode=True) or b""
    text = payload.decode(part.get_content_charset() or "utf-8", "replace")
    lines = []
    for line in text.splitlines():
        if QUOTE_START_RE.match(line.strip()):
            break
        lines.append(line)
    return "\n".join(lines).strip()


def _verified(msg, sender: str) -> bool:
    domain = sender.rsplit("@", 1)[-1].lower()
    results = " ".join(msg.get_all("Authentication-Results") or []).lower()
    dkim = re.search(r"dkim=pass[^;]*header\.(?:i|d)=@?([\w.-]+)", results)
    dmarc = re.search(r"dmarc=pass[^;]*header\.from=([\w.-]+)", results)
    return any(m and (m.group(1) == domain or m.group(1).endswith("." + domain)) for m in (dkim, dmarc))


def check(show_all: bool = False) -> list:
    host, port, user, password = _imap_config()
    seen = set() if show_all else _load_seen()
    found = []
    imap = imaplib.IMAP4_SSL(host, port)
    try:
        imap.login(user, password)
        imap.select("INBOX", readonly=True)
        _, data = imap.search(None, f'(SUBJECT "{SUBJECT_MARKER}" SINCE 29-Sep-2026)')
        for num in data[0].split():
            _, parts = imap.fetch(num, "(BODY.PEEK[])")
            msg = email.message_from_bytes(parts[0][1])
            sender = parseaddr(msg.get("From", ""))[1].lower()
            msg_id = msg.get("Message-ID", num.decode())
            if sender not in TRUSTED or sender == user.lower() or msg_id in seen:
                continue
            found.append({
                "id": msg_id, "from": sender, "date": msg.get("Date"),
                "subject": str(make_header(decode_header(msg.get("Subject", "")))),
                "verified": _verified(msg, sender), "text": _unquoted_text(msg),
            })
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    if not show_all and found:
        SEEN_PATH.write_text(json.dumps(sorted(seen | {f["id"] for f in found})))
    return found


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "invite":
        import os
        url = os.environ.get("HOTMONITOR_URL")
        if not url:
            sys.exit("HOTMONITOR_URL is not set")
        invite(url)
    elif cmd == "send-invites":
        send_invites()
    elif cmd == "check":
        replies = check(show_all="--all" in sys.argv)
        if not replies:
            print("Inga nya svar.")
        for r in replies:
            flag = "VERIFIED" if r["verified"] else "UNVERIFIED - do not act without confirmation"
            print(f"--- {r['date']} | {r['from']} | {flag}\n{r['subject']}\n\n{r['text']}\n")
    else:
        print(__doc__)
