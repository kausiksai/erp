"""Audit logging helpers for the email automation pipeline.

Two tables back this module (see scripts/migration_email_automation.sql):

    email_automation_runs   one row per automation run
    email_automation_log    one row per attachment-processing attempt

Every run should:
    1. Call `start_run()` at the top → get a UUID
    2. Call `log_attachment(...)` for each processed attachment
    3. Call `finish_run(...)` at the end with an aggregate status

The module is deliberately dependency-free apart from db.py so it can be
imported from any phase without creating import cycles.
"""

from __future__ import annotations

import logging
import socket
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional
from uuid import UUID, uuid4

import psycopg2
from psycopg2.extras import Json

from .db import get_conn

log = logging.getLogger(__name__)

# ---- Status constants ------------------------------------------------------
STATUS_DOWNLOADED = "downloaded"
STATUS_PARSED = "parsed"
STATUS_LOADED = "loaded"
STATUS_VALIDATED = "validated"
STATUS_FAILED = "failed"
STATUS_SKIPPED_DUPLICATE = "skipped_duplicate"
STATUS_SKIPPED_UNCLASSIFIED = "skipped_unclassified"

VALID_ATTACHMENT_STATUSES = {
    STATUS_DOWNLOADED,
    STATUS_PARSED,
    STATUS_LOADED,
    STATUS_VALIDATED,
    STATUS_FAILED,
    STATUS_SKIPPED_DUPLICATE,
    STATUS_SKIPPED_UNCLASSIFIED,
}

RUN_STATUS_RUNNING = "running"
RUN_STATUS_SUCCESS = "success"
RUN_STATUS_PARTIAL = "partial"
RUN_STATUS_FAILED = "failed"

VALID_RUN_STATUSES = {
    RUN_STATUS_RUNNING,
    RUN_STATUS_SUCCESS,
    RUN_STATUS_PARTIAL,
    RUN_STATUS_FAILED,
}

VALID_DOC_TYPES = {"po", "grn", "asn", "dc", "schedule", "invoice", "unknown"}


class AuditError(RuntimeError):
    """Raised on audit logging failures."""


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------
def start_run() -> UUID:
    """Insert a new email_automation_runs row in state `running`."""
    run_id = uuid4()
    try:
        host = socket.gethostname()
    except OSError:
        host = None
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO email_automation_runs
                        (run_id, started_at, status, host)
                    VALUES (%s, NOW(), %s, %s)
                    """,
                    (str(run_id), RUN_STATUS_RUNNING, host),
                )
    except psycopg2.Error as exc:
        raise AuditError(f"Failed to start run {run_id}: {exc}") from exc
    log.info("run started id=%s host=%s", run_id, host)
    return run_id


def finish_run(
    run_id: UUID,
    status: str,
    *,
    emails_fetched: int = 0,
    attachments_processed: int = 0,
    attachments_succeeded: int = 0,
    attachments_failed: int = 0,
    attachments_skipped: int = 0,
    revalidated_invoices: int = 0,
    error_message: Optional[str] = None,
) -> None:
    """Mark a run complete with the aggregate counters."""
    if status not in VALID_RUN_STATUSES:
        raise AuditError(f"Invalid run status {status!r}")
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE email_automation_runs SET
                        finished_at           = NOW(),
                        status                = %s,
                        emails_fetched        = %s,
                        attachments_processed = %s,
                        attachments_succeeded = %s,
                        attachments_failed    = %s,
                        attachments_skipped   = %s,
                        revalidated_invoices  = %s,
                        error_message         = %s
                    WHERE run_id = %s
                    """,
                    (
                        status,
                        emails_fetched,
                        attachments_processed,
                        attachments_succeeded,
                        attachments_failed,
                        attachments_skipped,
                        revalidated_invoices,
                        error_message,
                        str(run_id),
                    ),
                )
                if cur.rowcount != 1:
                    log.warning(
                        "finish_run did not update exactly one row "
                        "(rowcount=%s, run_id=%s)",
                        cur.rowcount,
                        run_id,
                    )
    except psycopg2.Error as exc:
        raise AuditError(f"Failed to finish run {run_id}: {exc}") from exc
    log.info(
        "run finished id=%s status=%s processed=%d succeeded=%d failed=%d skipped=%d revalidated=%d",
        run_id,
        status,
        attachments_processed,
        attachments_succeeded,
        attachments_failed,
        attachments_skipped,
        revalidated_invoices,
    )


# ---------------------------------------------------------------------------
# Attachment log
# ---------------------------------------------------------------------------
@dataclass
class AttachmentLogEntry:
    """Optional convenience for callers that assemble fields incrementally."""

    run_id: UUID
    message_id: Optional[str] = None
    email_uid: Optional[int] = None
    sender: Optional[str] = None
    subject: Optional[str] = None
    received_at: Optional[datetime] = None
    attachment_name: Optional[str] = None
    attachment_sha256: Optional[str] = None
    doc_type: Optional[str] = None
    status: str = STATUS_DOWNLOADED
    file_path: Optional[str] = None
    invoice_id: Optional[int] = None
    po_id: Optional[int] = None
    validation_result: Optional[dict] = None
    error_message: Optional[str] = None
    rows_processed: Optional[int] = None
    rows_inserted: Optional[int] = None
    rows_updated: Optional[int] = None
    rows_skipped: Optional[int] = None


def log_attachment(entry: AttachmentLogEntry) -> int:
    """Upsert a row into email_automation_log; return its id.

    A single attachment walks through multiple statuses in one run:
        downloaded -> loaded / failed / validated
    Each transition calls this function. Previously every call was a
    plain INSERT, so the later transitions hit the partial unique index
    on (message_id, attachment_sha256) and were silently swallowed,
    leaving the audit row stuck at 'downloaded' — which made the
    Dashboard "saved cleanly" count read zero even when all loaders had
    succeeded. Now the second and later calls UPDATE the same row so
    status and row counters always reflect the terminal state.

    Entries with NULL message_id or NULL sha256 fall through to a plain
    INSERT because the partial unique index does not cover them; that
    preserves the prior behaviour for synthetic / internal entries.
    """
    if entry.status not in VALID_ATTACHMENT_STATUSES:
        raise AuditError(f"Invalid attachment status {entry.status!r}")
    doc_type = entry.doc_type
    if doc_type is not None and doc_type not in VALID_DOC_TYPES:
        log.warning("unknown doc_type %r coerced to 'unknown'", doc_type)
        doc_type = "unknown"

    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO email_automation_log (
                        run_id, message_id, email_uid, sender, subject, received_at,
                        attachment_name, attachment_sha256, doc_type, status,
                        invoice_id, po_id, validation_result, error_message, file_path,
                        rows_processed, rows_inserted, rows_updated, rows_skipped
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s,
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (message_id, attachment_sha256)
                    WHERE message_id IS NOT NULL AND attachment_sha256 IS NOT NULL
                    DO UPDATE SET
                        run_id            = EXCLUDED.run_id,
                        status            = EXCLUDED.status,
                        doc_type          = COALESCE(EXCLUDED.doc_type, email_automation_log.doc_type),
                        file_path         = COALESCE(EXCLUDED.file_path, email_automation_log.file_path),
                        error_message     = EXCLUDED.error_message,
                        invoice_id        = COALESCE(EXCLUDED.invoice_id, email_automation_log.invoice_id),
                        po_id             = COALESCE(EXCLUDED.po_id, email_automation_log.po_id),
                        validation_result = COALESCE(EXCLUDED.validation_result, email_automation_log.validation_result),
                        rows_processed    = COALESCE(EXCLUDED.rows_processed, email_automation_log.rows_processed),
                        rows_inserted     = COALESCE(EXCLUDED.rows_inserted, email_automation_log.rows_inserted),
                        rows_updated      = COALESCE(EXCLUDED.rows_updated, email_automation_log.rows_updated),
                        rows_skipped      = COALESCE(EXCLUDED.rows_skipped, email_automation_log.rows_skipped),
                        processed_at      = NOW()
                    RETURNING id
                    """,
                    (
                        str(entry.run_id),
                        entry.message_id,
                        entry.email_uid,
                        entry.sender,
                        entry.subject,
                        entry.received_at,
                        entry.attachment_name,
                        entry.attachment_sha256,
                        doc_type,
                        entry.status,
                        entry.invoice_id,
                        entry.po_id,
                        Json(entry.validation_result) if entry.validation_result is not None else None,
                        entry.error_message,
                        entry.file_path,
                        entry.rows_processed,
                        entry.rows_inserted,
                        entry.rows_updated,
                        entry.rows_skipped,
                    ),
                )
                row = cur.fetchone()
                return int(row[0]) if row else -1
    except psycopg2.Error as exc:
        raise AuditError(f"Failed to log attachment: {exc}") from exc


def already_processed(message_id: Optional[str], attachment_sha256: Optional[str]) -> bool:
    """Return True if this (message_id, sha256) pair is already in the log."""
    if not message_id or not attachment_sha256:
        return False
    try:
        with get_conn(readonly=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1 FROM email_automation_log
                    WHERE message_id = %s AND attachment_sha256 = %s
                    LIMIT 1
                    """,
                    (message_id, attachment_sha256),
                )
                return cur.fetchone() is not None
    except psycopg2.Error as exc:
        raise AuditError(f"Dedup lookup failed: {exc}") from exc
