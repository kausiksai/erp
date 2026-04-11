"""Send a plain-text summary email at the end of an automation run.

Gracefully degrades when SMTP is not configured — in that case the
summary is just logged and the run exits normally. Never crashes the
pipeline because of an alert delivery failure.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import List, Optional, Tuple

from .config import CONFIG

log = logging.getLogger(__name__)


def send_summary(
    subject: str,
    body: str,
    attachments: Optional[List[Tuple[str, bytes]]] = None,
) -> bool:
    """Send a summary email.

    Returns True on delivery success, False on failure. Never raises —
    SMTP problems are logged but do not break the calling run.
    """
    cfg = CONFIG.alert
    if not cfg.enabled:
        log.info("alerts disabled (ALERT_ENABLED=false); summary not emailed")
        return True

    if not cfg.smtp_host:
        log.warning("ALERT_ENABLED=true but SMTP_HOST is blank; cannot send alert")
        return False
    if not cfg.recipient:
        log.warning("ALERT_RECIPIENT is blank; cannot send alert")
        return False

    from_addr = cfg.smtp_from or cfg.smtp_user or "email_automation@localhost"

    try:
        msg = EmailMessage()
        msg["From"] = from_addr
        msg["To"] = cfg.recipient
        msg["Subject"] = subject
        msg.set_content(body)

        for fname, data in attachments or []:
            msg.add_attachment(
                data,
                maintype="application",
                subtype="octet-stream",
                filename=fname,
            )

        with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=30) as smtp:
            smtp.ehlo()
            if smtp.has_extn("starttls"):
                smtp.starttls()
                smtp.ehlo()
            if cfg.smtp_user:
                smtp.login(cfg.smtp_user, cfg.smtp_password)
            smtp.send_message(msg)

        log.info("summary email sent to %s via %s", cfg.recipient, cfg.smtp_host)
        return True
    except Exception as exc:
        log.error("alert email delivery failed: %s", exc)
        return False
