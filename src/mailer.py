"""
Emails the daily report: an iPhone-friendly HTML digest in the message
body (renders natively in Apple Mail, no tapping into an attachment
required) with the full PPTX deck attached for the complete version.

Configured entirely through environment variables so no credentials
ever live in this repo:
    SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, MAIL_FROM
Optional:
    MAIL_TO   one or more comma-separated addresses
              (defaults to MAIL_FROM)

If the required variables aren't set, sending is skipped with a clear
log line rather than crashing the rest of the daily report - see
README.md for setup (Gmail app-password example included).
"""
import html
import os
import smtplib
import ssl
import time
from email.message import EmailMessage
from pathlib import Path

from common import NETWORK_RETRY_DELAYS, masked


def recipients() -> list:
    """MAIL_TO as a list - it may name several comma-separated people."""
    raw = os.environ.get("MAIL_TO") or os.environ.get("MAIL_FROM", "")
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


def build_executive_html(brief: dict) -> str:
    """The Swedish one-sentence-per-topic summary as a table row for the
    top of the digest. Model text is escaped - it is content, not markup."""
    esc = lambda v: html.escape(str(v or ""))
    rows = ""
    for section in brief.get("sections", []):
        items = ""
        for item in section.get("items", []):
            label = f'<span style="font-weight:700;color:#1B2340;">{esc(item.get("label"))}:</span> ' if item.get("label") else ""
            items += f'<div style="color:#1B2340;font-size:14px;line-height:1.45;margin-top:4px;">{label}{esc(item.get("text"))}</div>'
        rows += f"""<div style="color:#D98A2B;font-size:11px;font-weight:700;letter-spacing:1px;margin-top:14px;">{esc(section.get('heading')).upper()}</div>
        {items}"""
    return f"""<tr>
      <td style="background:#ffffff;padding:18px 20px;border-bottom:4px solid #141B47;">
        <div style="color:#141B47;font-size:17px;font-weight:700;">Svensk Super Executive</div>
        <div style="color:#1B2340;font-size:15px;font-weight:700;margin-top:8px;line-height:1.4;">{esc(brief.get('index_line'))}</div>
        <div style="color:#1B2340;font-size:14px;margin-top:6px;line-height:1.45;">{esc(brief.get('top'))}</div>
        {rows}
      </td>
    </tr>"""


def build_html_digest(report_data: dict, executive: dict = None) -> str:
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
    executive_html = build_executive_html(executive) if executive else ""
    app_url = os.environ.get("HOTMONITOR_URL")
    app_html = f"""<tr>
      <td style="background:#ffffff;padding:14px 20px;text-align:center;border-bottom:1px solid #E3E7F1;">
        <a href="{html.escape(app_url)}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#141B47;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">Öppna i Hotmonitor-appen</a>
        <div style="color:#6B7591;font-size:12px;margin-top:6px;">Arkiv, sök, karta och operatörsbedömning</div>
      </td>
    </tr>""" if app_url else ""

    forecast_cell = forecast_reading = ""
    if d.get("threat_index_30d") is not None:
        forecast_cell = f"""<td style="vertical-align:top;width:50%;">
              <div style="color:#CADCFC;font-size:11px;font-weight:700;letter-spacing:1px;">NEXT 30 DAYS</div>
              <div style="color:#ffffff;font-size:48px;font-weight:700;line-height:1.1;margin-top:4px;">{d['threat_index_30d']:.1f}<span style="font-size:18px;color:#8A93B5;"> / 10</span></div>
              <div style="color:#8A93B5;font-size:13px;font-weight:700;margin-top:4px;">Forecast</div>
            </td>"""
        forecast_reading = f"""<div style="color:#D98A2B;font-size:11px;font-weight:700;letter-spacing:1px;margin-top:14px;">30-DAY OUTLOOK</div>
        <div style="color:#CADCFC;font-size:13px;margin-top:4px;line-height:1.4;">{d.get('threat_reading_30d','')}</div>"""

    return f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F4F6FB;font-family:-apple-system,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#F4F6FB;">
    <tr>
      <td style="background:#141B47;padding:24px 20px;">
        <div style="color:#CADCFC;font-size:12px;font-weight:700;letter-spacing:1px;">RUSSIA &rarr; NATO / EU / UKRAINE</div>
        <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">Hybrid Threat Monitor</div>
        <div style="color:#8A93B5;font-size:13px;margin-top:4px;">{d.get('date','')} &middot; consolidated 04:00 CET</div>
      </td>
    </tr>
    {app_html}
    {executive_html}
    <tr>
      <td style="background:#1E2761;padding:20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;width:50%;">
              <div style="color:#CADCFC;font-size:11px;font-weight:700;letter-spacing:1px;">THREAT INDEX &middot; GENERAL</div>
              <div style="color:{trend_color};font-size:48px;font-weight:700;line-height:1.1;margin-top:4px;">{d.get('threat_index',0):.1f}<span style="font-size:18px;color:#8A93B5;"> / 10</span></div>
              <div style="color:{trend_color};font-size:13px;font-weight:700;margin-top:4px;">{d.get('trend_label','')}</div>
            </td>
            {forecast_cell}
          </tr>
        </table>
        <div style="color:#CADCFC;font-size:13px;margin-top:10px;line-height:1.4;">{d.get('threat_reading','')}</div>
        {forecast_reading}
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


def send_daily_email(report_data: dict, pptx_path: str, executive: dict = None) -> bool:
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
    subject = f"Hybrid Threat Monitor - {report_data.get('date','')} - Index {report_data.get('threat_index',0):.1f}/10"
    if report_data.get("threat_index_30d") is not None:
        subject += f", 30d {report_data['threat_index_30d']:.1f}"
    msg["Subject"] = subject
    msg["From"] = mail_from
    msg["To"] = mail_to
    msg.set_content("This report needs an HTML-capable mail client to view the digest. The full deck is attached as a PowerPoint file.")
    msg.add_alternative(build_html_digest(report_data, executive=executive), subtype="html")

    pptx_file = Path(pptx_path)
    if pptx_file.exists():
        msg.add_attachment(
            pptx_file.read_bytes(),
            maintype="application",
            subtype="vnd.openxmlformats-officedocument.presentationml.presentation",
            filename=pptx_file.name,
        )

    for delay in NETWORK_RETRY_DELAYS + [None]:
        try:
            _smtp_send(host, port, user, password, msg)
            print(f"  Email sent to {masked(mail_to)}")
            return True
        except smtplib.SMTPResponseException as e:
            # The server answered and said no (bad login, rejected
            # recipient) - waiting won't change that. Checked first because
            # SMTP exceptions are OSError subclasses.
            print(f"  ! Email failed to send: {e}")
            return False
        except OSError as e:
            # Network trouble (DNS, refused, timeout, dropped connection).
            if delay is None:
                print(f"  ! Email failed to send: {e}")
                return False
            print(f"  ! SMTP unreachable ({e}); retrying in {delay}s")
            time.sleep(delay)
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
        print(f"  Confirmation sent to {masked(to)}")
        return True
    except Exception as e:
        print(f"  ! Confirmation email failed to send: {e}")
        return False
