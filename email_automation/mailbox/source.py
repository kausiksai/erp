"""Email sources: Zoho IMAP (production) and Local (for smoke testing).

The run.py orchestrator depends only on the `MailSource` interface so the
real IMAP fetcher can be substituted with a local fixture for end-to-end
tests that don't need live Zoho credentials.
"""

from __future__ import annotations

import email
import email.utils
import hashlib
import imaplib
import logging
import ssl
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, List, Optional

from ..config import CONFIG

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class FetchedAttachment:
    file_name: str
    content: bytes
    sha256: str
    size: int


@dataclass
class FetchedMessage:
    message_id: str
    uid: Optional[int]
    sender: str
    subject: str
    received_at: Optional[datetime]
    attachments: List[FetchedAttachment] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Interface
# ---------------------------------------------------------------------------
class MailSource(ABC):
    @abstractmethod
    def fetch(self) -> Iterator[FetchedMessage]:
        ...

    def mark_seen(self, uid: int) -> None:  # noqa: D401 - default no-op
        """Mark a message as read. Default: no-op (only IMAP implements this)."""

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Zoho IMAP implementation
# ---------------------------------------------------------------------------
class ZohoMailSource(MailSource):
    """Real Zoho IMAP fetcher.

    * Connects over SSL to `CONFIG.imap.host:CONFIG.imap.port`
    * Authenticates with the app-specific password
    * Searches `INBOX` for UNSEEN mails from ALLOWED_SENDER received today
    * Yields one `FetchedMessage` per email with all attachments decoded
    * `mark_seen()` should be called only after the DB write has committed
    """

    def __init__(self) -> None:
        self.cfg = CONFIG.imap
        self.client: Optional[imaplib.IMAP4_SSL] = None

    def _connect(self) -> None:
        if not self.cfg.user or not self.cfg.password:
            raise RuntimeError(
                "IMAP_USER / IMAP_PASSWORD not set in email_automation/.env. "
                "Create an app-specific password at Zoho -> Settings -> "
                "Security -> App Passwords."
            )
        log.info("connecting to %s:%d as %s", self.cfg.host, self.cfg.port, self.cfg.user)
        ssl_ctx = ssl.create_default_context()
        self.client = imaplib.IMAP4_SSL(self.cfg.host, self.cfg.port, ssl_context=ssl_ctx)
        self.client.login(self.cfg.user, self.cfg.password)
        self.client.select(self.cfg.mailbox, readonly=False)

    def fetch(self) -> Iterator[FetchedMessage]:
        if self.client is None:
            self._connect()
        assert self.client is not None

        today = datetime.now().strftime("%d-%b-%Y")
        # One search per allowed sender, then merge UIDs (de-duplicated).
        # Cleaner and more debuggable than one nested OR clause, and works
        # the same whether there's one sender or many.
        seen_uids = set()
        uid_list: list[bytes] = []
        for sender in self.cfg.allowed_senders:
            criteria = f'(UNSEEN FROM "{sender}" SINCE "{today}")'
            log.info("IMAP search: %s", criteria)
            typ, data = self.client.search(None, criteria)
            if typ != "OK":
                log.error("IMAP search failed for sender=%s: %s", sender, data)
                continue
            uids = data[0].split() if data and data[0] else []
            log.info("IMAP returned %d message(s) from %s", len(uids), sender)
            for u in uids:
                if u not in seen_uids:
                    seen_uids.add(u)
                    uid_list.append(u)
        log.info(
            "IMAP search total %d unique message(s) across %d sender(s)",
            len(uid_list), len(self.cfg.allowed_senders),
        )

        for uid_bytes in uid_list:
            try:
                uid = int(uid_bytes)
            except ValueError:
                continue
            typ, msg_data = self.client.fetch(uid_bytes, "(RFC822)")
            if typ != "OK" or not msg_data or not msg_data[0]:
                log.warning("IMAP fetch failed for uid=%s", uid)
                continue
            raw = msg_data[0][1]
            if not isinstance(raw, (bytes, bytearray)):
                log.warning("unexpected payload shape for uid=%s", uid)
                continue
            msg = email.message_from_bytes(raw)
            fetched = self._parse_message(uid, msg)
            if fetched:
                yield fetched

    def _parse_message(self, uid: int, msg: email.message.Message) -> Optional[FetchedMessage]:
        message_id = (msg.get("Message-ID") or f"zoho-uid-{uid}").strip()
        sender_raw = msg.get("From", "")
        _name, addr = email.utils.parseaddr(sender_raw)
        sender = addr or sender_raw
        subject = msg.get("Subject", "") or ""
        date_str = msg.get("Date", "")
        try:
            received_at = email.utils.parsedate_to_datetime(date_str) if date_str else None
        except (TypeError, ValueError):
            received_at = None

        attachments: List[FetchedAttachment] = []
        for part in msg.walk():
            if part.is_multipart():
                continue
            disp = (part.get("Content-Disposition") or "").lower()
            if "attachment" not in disp:
                continue
            file_name = part.get_filename()
            if not file_name:
                continue
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            sha = hashlib.sha256(payload).hexdigest()
            attachments.append(
                FetchedAttachment(
                    file_name=file_name,
                    content=payload,
                    sha256=sha,
                    size=len(payload),
                )
            )

        if not attachments:
            log.debug("message uid=%s has no attachments, skipping", uid)
            return None

        return FetchedMessage(
            message_id=message_id,
            uid=uid,
            sender=sender,
            subject=subject,
            received_at=received_at,
            attachments=attachments,
        )

    def mark_seen(self, uid: int) -> None:
        if self.client is None:
            return
        try:
            self.client.store(str(uid).encode(), "+FLAGS", "\\Seen")
        except Exception as exc:
            log.warning("mark_seen failed for uid=%s: %s", uid, exc)

    def close(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
                self.client.logout()
            except Exception as exc:
                log.debug("IMAP close benign error: %s", exc)
            finally:
                self.client = None


# ---------------------------------------------------------------------------
# Local fixture source (for smoke testing without Zoho)
# ---------------------------------------------------------------------------
class LocalMailSource(MailSource):
    """Fake mail source that reads files from a folder and synthesises one
    email per file with a realistic subject line.

    Intended for end-to-end pipeline tests that don't need live IMAP.
    """

    # Glob pattern -> (doc_type, subject-template).
    # Patterns are case-sensitive on Linux/macOS, case-insensitive on Windows.
    # Multiple files matching the same pattern are all picked up — handy
    # when the source ERP splits a day's data across two exports (e.g.
    # GRN.xls and GRN_2.xls). The downstream loader combines them and
    # truncates the destination table once before the combined insert.
    #
    # Subject strings here are the *expected Zoho format* the classifier
    # recognises. If real Zoho subjects differ, adjust here and in
    # classifier SUBJECT_KEYWORDS.
    FILE_MAP: List[tuple] = [
        ("PO*.xls*",                    "po",       "Notification - Purchase Order Details(DD-MMM-YYYY)"),
        ("ASN*.xls*",                   "asn",      "Notification - Advance Shipment Notice report(DD-MMM-YYYY)"),
        ("GRN*.xls*",                   "grn",      "Notification - GRN Details(DD-MMM-YYYY)"),
        ("DC*.xls*",                    "dc",       "Notification - DC Transaction(DD-MMM-YYYY)"),
        ("schedule*.xls*",              "schedule", "Notification - Supplier Schedule(DD-MMM-YYYY)"),
        ("Bill Register*.xls*",         "invoice",  "Notification - Bill Register(DD-MMM-YYYY)"),
    ]

    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)

    def fetch(self) -> Iterator[FetchedMessage]:
        date_str = datetime.now().strftime("%d-%b-%Y").upper()
        for pattern, _doc_type, subject_tpl in self.FILE_MAP:
            matches = sorted(self.folder.glob(pattern))
            # Skip Excel temp/lock files Excel creates while a workbook is open
            matches = [p for p in matches if p.is_file() and not p.name.startswith("~$")]
            if not matches:
                log.warning("LocalMailSource: no files matching %s in %s", pattern, self.folder)
                continue
            for path in matches:
                content = path.read_bytes()
                sha = hashlib.sha256(content).hexdigest()
                att = FetchedAttachment(
                    file_name=path.name,
                    content=content,
                    sha256=sha,
                    size=len(content),
                )
                subject = subject_tpl.replace("DD-MMM-YYYY", date_str)
                yield FetchedMessage(
                    message_id=f"local-{path.name}-{sha[:16]}@local.test",
                    uid=None,
                    sender=CONFIG.imap.allowed_senders[0],
                    subject=subject,
                    received_at=datetime.now(timezone.utc),
                    attachments=[att],
                )


# ---------------------------------------------------------------------------
# Downloaded archive source — replay a past day's saved files
# ---------------------------------------------------------------------------
class DownloadedMailSource(MailSource):
    """Replay every file the pipeline downloaded on a given date.

    The Zoho-source path saves attachments under
    ``<downloaded>/<doc_type>/<YYYY-MM-DD>/<filename>`` (see
    run._save_attachment). This source walks that tree for a chosen date
    and yields each file as a synthetic FetchedMessage, so an ad-hoc run
    can re-load any past day's data without going through IMAP again.

    Multiple files in the same date folder for the same doc_type are all
    picked up — the loader loop combines them and truncates the
    destination table once before the combined insert.
    """

    # doc_type -> subject template the classifier expects.
    DOC_TYPES: List[tuple] = [
        ("po",       "Notification - Purchase Order Details(DD-MMM-YYYY)"),
        ("asn",      "Notification - Advance Shipment Notice report(DD-MMM-YYYY)"),
        ("grn",      "Notification - GRN Details(DD-MMM-YYYY)"),
        ("dc",       "Notification - DC Transaction(DD-MMM-YYYY)"),
        ("schedule", "Notification - Supplier Schedule(DD-MMM-YYYY)"),
        ("invoice",  "Notification - Bill Register(DD-MMM-YYYY)"),
    ]

    def __init__(self, downloaded_root: Path, date_str: str) -> None:
        self.root = Path(downloaded_root)
        self.date_str = date_str  # expected format: YYYY-MM-DD

    def fetch(self) -> Iterator[FetchedMessage]:
        # Build the subject's date string from the requested date.
        try:
            d = datetime.strptime(self.date_str, "%Y-%m-%d")
            date_subject_str = d.strftime("%d-%b-%Y").upper()
        except ValueError:
            log.warning("DownloadedMailSource: bad date %r, expected YYYY-MM-DD", self.date_str)
            date_subject_str = self.date_str
        for doc_type, subject_tpl in self.DOC_TYPES:
            folder = self.root / doc_type / self.date_str
            if not folder.is_dir():
                log.warning("DownloadedMailSource: no folder %s", folder)
                continue
            paths = sorted(p for p in folder.glob("*") if p.is_file() and not p.name.startswith("~$"))
            if not paths:
                log.warning("DownloadedMailSource: no files in %s", folder)
                continue
            log.info("DownloadedMailSource: %d %s file(s) in %s", len(paths), doc_type, folder)
            for path in paths:
                content = path.read_bytes()
                sha = hashlib.sha256(content).hexdigest()
                att = FetchedAttachment(
                    file_name=path.name,
                    content=content,
                    sha256=sha,
                    size=len(content),
                )
                subject = subject_tpl.replace("DD-MMM-YYYY", date_subject_str)
                yield FetchedMessage(
                    message_id=f"replay-{self.date_str}-{path.name}-{sha[:16]}@local.test",
                    uid=None,
                    sender=CONFIG.imap.allowed_senders[0],
                    subject=subject,
                    received_at=datetime.now(timezone.utc),
                    attachments=[att],
                )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------
def make_source(
    kind: str = "zoho",
    *,
    local_folder: Optional[Path] = None,
    replay_date: Optional[str] = None,
) -> MailSource:
    if kind == "zoho":
        return ZohoMailSource()
    if kind == "local":
        folder = local_folder or (Path(__file__).resolve().parents[2] / "docs")
        return LocalMailSource(folder)
    if kind == "downloaded":
        if not replay_date:
            raise ValueError("--source=downloaded requires --date YYYY-MM-DD")
        return DownloadedMailSource(CONFIG.paths.downloaded, replay_date)
    raise ValueError(f"unknown mail source kind: {kind!r} (expected 'zoho', 'local', or 'downloaded')")
