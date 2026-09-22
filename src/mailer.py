"""
Emails the daily report: an iPhone-friendly HTML digest in the message
body (renders natively in Apple Mail, no tapping into an attachment
required) with the full PPTX deck attached for the complete version.

Configured entirely through environment variables so no credentials
ever live in this repo:
    SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM
Optional:
    MAIL_TO   one or more comma-separated addresses
              (defaults to admin.one@example.org)

If the required variables aren't set, sending is skipped with a clear
log line rather than crashing the rest of the daily report - see
README.md for setup (Gmail app-password example included).
"""
import os
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path

DEFAULT_RECIPIENT = "admin.one@example.org"


def recipients() -> list:
    """MAIL_TO as a list - it may name several comma-separated people."""
    raw = os.environ.get("MAIL_TO") or DEFAULT_RECIPIENT
    return [addr.strip() for addr in raw.split(",") if addr.strip()]


def recipients_str() -> str:
    """MAIL_TO as a single To: header value."""
    return ", ".join(recipients())


def _trend_color(trend_label: str) -> str:
    t = trend_label.lower()
    if "up" in t:
        return "#D98A2B"
    if "down" in t:
        return "#2E7D5B"
    return "#5A6B8C"


def _score_color(score) -> str:
    try:
        score = float(score)
    except (TypeError, ValueError):
        return "#5A6B8C"
    if score >= 8:
        return "#2E7D5B"
    if score >= 5:
        return "#D98A2B"
    return "#B3261E"


def build_html_digest(report_data: dict) -> str:
    """Single-column, inline-CSS HTML email - deliberately simple
    markup (tables + inline styles) since that's what survives Apple
    Mail's rendering on iPhone, unlike a linked stylesheet."""
    d = report_data
    events_html = ""
    for e in d.get("events", [])[:6]:
        events_html += f"""
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #E3E7F1;">
            <div style="font-weight:600;color:#1B2340;font-size:15px;">{e.get('title','')}</div>
            <div style="color:#6B7591;font-size:13px;margin-top:2px;">{e.get('detail','')}</div>
            <div style="color:#9AA3BC;font-size:11px;font-style:italic;margin-top:2px;">{e.get('sources','')}</div>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #E3E7F1;text-align:right;vertical-align:top;width:40px;">
            <span style="display:inline-block;width:30px;height:30px;line-height:30px;
              border-radius:50%;background:{_score_color(e.get('score'))};color:#ffffff;
              font-weight:700;font-size:13px;text-align:center;">{e.get('score','')}</span>
          </td>
        </tr>"""

    proposal = d.get("proposal") or {}
    trend_color = _trend_color(d.get("trend_label", ""))

    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:-apple-system,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#F4F6FB;">
    <tr>
      <td style="background:#141B47;padding:24px 20px;">
        <div style="color:#CADCFC;font-size:12px;font-weight:700;letter-spacing:1px;">RUSSIA &rarr; NATO / EU / UKRAINE</div>
        <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">Hybrid Threat Monitor</div>
        <div style="color:#8A93B5;font-size:13px;margin-top:4px;">{d.get('date','')} &middot; consolidated 05:00 CET</div>
      </td>
    </tr>
    <tr>
      <td style="background:#1E2761;padding:20px;">
        <div style="color:#CADCFC;font-size:11px;font-weight:700;letter-spacing:1px;">THREAT INDEX</div>
        <div style="color:{trend_color};font-size:48px;font-weight:700;line-height:1.1;margin-top:4px;">{d.get('threat_index',0):.1f}<span style="font-size:18px;color:#8A93B5;"> / 10</span></div>
        <div style="color:{trend_color};font-size:13px;font-weight:700;margin-top:4px;">{d.get('trend_label','')}</div>
        <div style="color:#CADCFC;font-size:13px;margin-top:10px;line-height:1.4;">{d.get('threat_reading','')}</div>
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;padding:18px 20px 0 20px;">
        <div style="color:#D98A2B;font-size:11px;font-weight:700;letter-spacing:1px;">SELF-CHECK</div>
        <div style="color:#1B2340;font-size:14px;margin-top:4px;line-height:1.4;">{d.get('self_check_summary','')}</div>
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;padding:16px 20px 0 20px;">
        <div style="color:#D98A2B;font-size:11px;font-weight:700;letter-spacing:1px;">TOP DEVELOPMENT</div>
        <div style="color:#1B2340;font-size:14px;margin-top:4px;line-height:1.4;">{d.get('top_development','')}</div>
      </td>
    </tr>
    <tr>
      <td style="background:#ffffff;padding:16px 20px 8px 20px;">
        <div style="color:#D98A2B;font-size:11px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">LAST-24H EVENTS</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          {events_html}
        </table>
      </td>
    </tr>
    <tr>
      <td style="background:#141B47;padding:20px;">
        <div style="color:#D98A2B;font-size:11px;font-weight:700;letter-spacing:1px;">PROPOSED METHODOLOGY CHANGE</div>
        <div style="color:#ffffff;font-size:15px;font-weight:700;margin-top:6px;">{proposal.get('title','')}</div>
        <div style="color:#CADCFC;font-size:13px;margin-top:6px;line-height:1.4;">{proposal.get('rationale','')}</div>
        <div style="color:#8A93B5;font-size:12px;margin-top:10px;">Reply "accept" or "deny" to this email, or run: python3 src/daily_report.py --resolve accept|deny</div>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 20px;text-align:center;">
        <div style="color:#9AA3BC;font-size:11px;">Full deck attached (PowerPoint) &middot; Automated OSINT synthesis, not for operational decision-making</div>
      </td>
    </tr>
  </table>
</body>
</html>"""


def send_daily_email(report_data: dict, pptx_path: str) -> bool:
    """Returns True if sent, False if skipped or failed. Never raises -
    a mail problem should never take down the rest of the daily run."""
    host = os.environ.get("SMTP_HOST")
    port = os.environ.get("SMTP_PORT")
    user = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    mail_from = os.environ.get("MAIL_FROM")
    mail_to = recipients_str()

    missing = [name for name, val in [
        ("SMTP_HOST", host), ("SMTP_PORT", port), ("SMTP_USERNAME", user),
        ("SMTP_PASSWORD", password), ("MAIL_FROM", mail_from),
    ] if not val]
    if missing:
        print(f"  ! Email skipped - missing env vars: {', '.join(missing)} (see README.md 'Email delivery')")
        return False

    msg = EmailMessage()
    msg["Subject"] = f"Hybrid Threat Monitor - {report_data.get('date','')} - Index {report_data.get('threat_index',0):.1f}/10"
    msg["From"] = mail_from
    msg["To"] = mail_to
    msg.set_content("This report needs an HTML-capable mail client to view the digest. The full deck is attached as a PowerPoint file.")
    msg.add_alternative(build_html_digest(report_data), subtype="html")

    pptx_file = Path(pptx_path)
    if pptx_file.exists():
        msg.add_attachment(
            pptx_file.read_bytes(),
            maintype="application",
            subtype="vnd.openxmlformats-officedocument.presentationml.presentation",
            filename=pptx_file.name,
        )

    try:
        _smtp_send(host, port, user, password, msg)
        print(f"  Email sent to {mail_to}")
        return True
    except Exception as e:
        print(f"  ! Email failed to send: {e}")
        return False


def _smtp_send(host, port, user, password, msg):
    port_num = int(port)
    context = ssl.create_default_context()
    if port_num == 465:
        with smtplib.SMTP_SSL(host, port_num, context=context) as server:
            server.login(user, password)
            server.send_message(msg)
    else:
        with smtplib.SMTP(host, port_num) as server:
            server.starttls(context=context)
            server.login(user, password)
            server.send_message(msg)


def send_plain_email(to: str, subject: str, body: str, in_reply_to: str = None) -> bool:
    """Short plain-text message (used to confirm an accept/deny reply).
    Same env-var config and same never-raises contract as the digest."""
    host = os.environ.get("SMTP_HOST")
    port = os.environ.get("SMTP_PORT")
    user = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    mail_from = os.environ.get("MAIL_FROM")
    if not all([host, port, user, password, mail_from]):
        print("  ! Confirmation email skipped - SMTP env vars not set")
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = mail_from
    msg["To"] = to
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    # RFC 3834: lets reply_checker (and other people's autoresponders)
    # tell this apart from a human reply.
    msg["Auto-Submitted"] = "auto-replied"
    msg.set_content(body)
    try:
        _smtp_send(host, port, user, password, msg)
        print(f"  Confirmation sent to {to}")
        return True
    except Exception as e:
        print(f"  ! Confirmation email failed to send: {e}")
        return False
