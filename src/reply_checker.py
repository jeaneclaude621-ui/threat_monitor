"""
Reads replies to the daily report email and resolves the pending
methodology proposal from them - this is what makes the "reply accept
or deny to this email" line in the digest actually work.

Polls the MAIL_FROM inbox over IMAP for unread replies whose subject
contains "Hybrid Threat Monitor", from a trusted sender (MAIL_TO or the
monitor's own address). The first "accept" or "deny" in the un-quoted
part of the reply decides the proposal; a short confirmation is mailed
back. Runs at the start of every hourly and daily run, or standalone:

    python3 src/reply_checker.py             # process replies
    python3 src/reply_checker.py --dry-run   # report only, change nothing

Env (all optional - defaults match the Gmail SMTP setup in README.md):
    IMAP_HOST      default imap.gmail.com
    IMAP_PORT      default 993
    IMAP_USERNAME  default SMTP_USERNAME
    IMAP_PASSWORD  default SMTP_PASSWORD

Never raises - a mailbox problem must not take down the monitor run.
"""
import argparse
import email
import imaplib
import os
import re
import sys
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_state, resolve_proposal
from mailer import DEFAULT_RECIPIENT, send_plain_email

SUBJECT_MARKER = "Hybrid Threat Monitor"
DECISION_RE = re.compile(r"\b(accept(?:ed)?|den(?:y|ied))\b", re.IGNORECASE)
# Lines at/after which a mail client's quoted original usually starts.
QUOTE_START_RE = re.compile(
    r"^(>|On .{0,120}wrote:|From: |-----Original Message-----|_{5,}|Den .{0,120}skrev)",
    re.IGNORECASE,
)


def _imap_config():
    return (
        os.environ.get("IMAP_HOST", "imap.gmail.com"),
        int(os.environ.get("IMAP_PORT", "993")),
        os.environ.get("IMAP_USERNAME") or os.environ.get("SMTP_USERNAME"),
        os.environ.get("IMAP_PASSWORD") or os.environ.get("SMTP_PASSWORD"),
    )


def _trusted_senders():
    senders = {os.environ.get("MAIL_TO", DEFAULT_RECIPIENT)}
    for var in ("MAIL_FROM", "SMTP_USERNAME"):
        if os.environ.get(var):
            senders.add(os.environ[var])
    return {s.lower() for s in senders}


def _decode(value) -> str:
    """Decoded header as a single line - mail clients fold long subjects
    across lines, and EmailMessage refuses header values with newlines."""
    if not value:
        return ""
    return re.sub(r"\s+", " ", str(make_header(decode_header(value)))).strip()


def _plain_body(msg) -> str:
    """text/plain part if there is one, else the HTML part with tags
    stripped - iPhone Mail replies are sometimes HTML-only."""
    plain, html = None, None
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.get_content_disposition() == "attachment":
            continue
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            continue
        if payload is None:
            continue
        text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if ctype == "text/plain" and plain is None:
            plain = text
        elif ctype == "text/html" and html is None:
            html = text
    if plain is not None:
        return plain
    if html is not None:
        html = re.sub(r"<(br|/p|/div|/tr)\s*/?>", "\n", html, flags=re.IGNORECASE)
        html = re.sub(r"<blockquote.*", "", html, flags=re.IGNORECASE | re.DOTALL)
        return re.sub(r"<[^>]+>", "", html)
    return ""


def _unquoted(text: str) -> str:
    """Everything the sender typed themselves, above the quoted report."""
    kept = []
    for line in text.splitlines():
        if QUOTE_START_RE.match(line.strip()):
            break
        kept.append(line)
    return "\n".join(kept)


def parse_decision(body: str):
    """'accept' or 'deny' from the sender's own text; None if neither
    is there, or if both are (ambiguous - don't guess)."""
    found = {("accept" if m.lower().startswith("accept") else "deny")
             for m in DECISION_RE.findall(_unquoted(body))}
    if len(found) != 1:
        return None
    return found.pop()


def check_replies(state, dry_run: bool = False) -> int:
    """Returns the number of proposals resolved. Marks handled replies
    as read (unless dry_run) so they are not processed twice."""
    host, port, user, password = _imap_config()
    if not user or not password:
        print("  ! Reply check skipped - SMTP/IMAP credentials not set")
        return 0

    trusted = _trusted_senders()
    resolved = 0
    try:
        with imaplib.IMAP4_SSL(host, port) as imap:
            imap.login(user, password)
            imap.select("INBOX")
            status, data = imap.search(None, "UNSEEN", "SUBJECT", f'"{SUBJECT_MARKER}"')
            ids = data[0].split() if status == "OK" else []
            seen_replies = 0

            for uid in ids:  # oldest first
                status, parts = imap.fetch(uid, "(BODY.PEEK[])")
                if status != "OK":
                    continue
                msg = email.message_from_bytes(parts[0][1])
                sender = parseaddr(msg.get("From", ""))[1].lower()
                subject = _decode(msg.get("Subject"))

                # Only actual replies - the monitor's own outgoing copies
                # also land here when MAIL_TO is the sending account.
                is_reply = bool(msg.get("In-Reply-To")) or re.match(r"^\s*(re|sv|aw|fwd?)\s*:", subject, re.IGNORECASE)
                if not is_reply:
                    continue
                # Skip our own confirmations and out-of-office autoresponders.
                if msg.get("Auto-Submitted", "no").strip().lower() != "no":
                    if not dry_run:
                        imap.store(uid, "+FLAGS", "\\Seen")
                    continue
                seen_replies += 1

                if sender not in trusted:
                    print(f"  Reply check: ignoring '{subject}' from untrusted sender {sender}")
                    continue

                decision = parse_decision(_plain_body(msg))
                if decision is None:
                    print(f"  Reply check: no accept/deny found in reply from {sender} ('{subject}') - "
                          f"use: python3 src/daily_report.py --resolve accept|deny")
                    if not dry_run:
                        imap.store(uid, "+FLAGS", "\\Seen")
                    continue

                pending = state.get("pending_proposal")
                if dry_run:
                    print(f"  [dry-run] would {decision} "
                          f"'{pending['title'] if pending else '(no pending proposal)'}' "
                          f"per reply from {sender}")
                    continue

                proposal = resolve_proposal(state, decision)
                imap.store(uid, "+FLAGS", "\\Seen")
                if proposal:
                    resolved += 1
                    verb = "accepted" if decision == "accept" else "denied"
                    send_plain_email(
                        to=sender,
                        subject=f"Re: {subject}" if not subject.lower().startswith("re:") else subject,
                        body=(f"Methodology proposal {verb}: {proposal['title']}\n\n"
                              f"{proposal['change_detail']}\n\n"
                              f"{'This rule now applies to all future research prompts.' if decision == 'accept' else 'No change made.'}\n"
                              f"- Hybrid Threat Monitor"),
                        in_reply_to=_decode(msg.get("Message-ID")),
                    )
                else:
                    send_plain_email(
                        to=sender,
                        subject=f"Re: {subject}" if not subject.lower().startswith("re:") else subject,
                        body=(f"Got your '{decision}', but there is no open proposal right now - "
                              f"it was probably already resolved. Nothing changed.\n- Hybrid Threat Monitor"),
                        in_reply_to=_decode(msg.get("Message-ID")),
                    )
            if not seen_replies:
                print("  Reply check: no new replies")
    except Exception as e:
        print(f"  ! Reply check failed: {e}")
    return resolved


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Report what would happen without resolving or marking mail as read.")
    args = parser.parse_args()
    check_replies(load_state(), dry_run=args.dry_run)
