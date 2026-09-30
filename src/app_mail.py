"""
Mail about the web app itself - separate from the daily report mail.

    python3 src/app_mail.py invite           # mail the testers link + login steps
    python3 src/app_mail.py check            # print new replies (read-only)
    python3 src/app_mail.py check --all      # include ones already shown

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
import sys
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR
from mailer import send_plain_email
from reply_checker import QUOTE_START_RE, _imap_config

SUBJECT_MARKER = "Hotmonitor-appen"
TESTERS = ["admin.one@example.org", "admin.two@example.org"]
TRUSTED = set(TESTERS) | {"the.owner@example.org"}
SEEN_PATH = DATA_DIR / "app_mail_seen.json"


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
    elif cmd == "check":
        replies = check(show_all="--all" in sys.argv)
        if not replies:
            print("Inga nya svar.")
        for r in replies:
            flag = "VERIFIED" if r["verified"] else "UNVERIFIED - do not act without confirmation"
            print(f"--- {r['date']} | {r['from']} | {flag}\n{r['subject']}\n\n{r['text']}\n")
    else:
        print(__doc__)
