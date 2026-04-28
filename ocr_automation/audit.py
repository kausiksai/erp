"""Audit logging — writes ocr_automation_runs and ocr_automation_log,
plus the drive_synced_files idempotency table.
"""

from __future__ import annotations

import logging
import socket
from datetime import datetime
from typing import Any, Optional
from uuid import UUID, uuid4

import psycopg2
from psycopg2.extras import Json

from .db import get_conn

log = logging.getLogger(__name__)

# ---- Run statuses ----------------------------------------------------------
RUN_RUNNING = "running"
RUN_SUCCESS = "success"
RUN_PARTIAL = "partial"
RUN_FAILED = "failed"
VALID_RUN_STATUSES = {RUN_RUNNING, RUN_SUCCESS, RUN_PARTIAL, RUN_FAILED}

# ---- Log entry statuses ----------------------------------------------------
LOG_DOWNLOADED = "downloaded"
LOG_EXTRACTED = "extracted"
LOG_SAVED = "saved"
LOG_RECONCILED = "reconciled"
LOG_FAILED = "failed"
LOG_SKIPPED_DUPLICATE = "skipped_duplicate"
VALID_LOG_STATUSES = {
    LOG_DOWNLOADED, LOG_EXTRACTED, LOG_SAVED,
    LOG_RECONCILED, LOG_FAILED, LOG_SKIPPED_DUPLICATE,
}

# ---- drive_synced_files statuses ------------------------------------------
SYNC_PENDING = "pending"
SYNC_PROCESSED = "processed"
SYNC_FAILED = "failed"
SYNC_SKIPPED = "skipped"


class AuditError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------
def start_run(drive_folder_id: str) -> UUID:
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
                    INSERT INTO ocr_automation_runs
                        (run_id, started_at, status, host, drive_folder_id)
                    VALUES (%s, NOW(), %s, %s, %s)
                    """,
                    (str(run_id), RUN_RUNNING, host, drive_folder_id),
                )
    except psycopg2.Error as exc:
        raise AuditError(f"Failed to start run {run_id}: {exc}") from exc
    log.info("run started id=%s host=%s folder=%s", run_id, host, drive_folder_id)
    return run_id


def finish_run(
    run_id: UUID,
    status: str,
    *,
    files_listed: int = 0,
    files_processed: int = 0,
    files_succeeded: int = 0,
    files_failed: int = 0,
    files_skipped: int = 0,
    invoices_created: int = 0,
    invoices_reconciled: int = 0,
    error_message: Optional[str] = None,
) -> None:
    if status not in VALID_RUN_STATUSES:
        raise AuditError(f"Invalid run status {status!r}")
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE ocr_automation_runs SET
                        finished_at         = NOW(),
                        status              = %s,
                        files_listed        = %s,
                        files_processed     = %s,
                        files_succeeded     = %s,
                        files_failed        = %s,
                        files_skipped       = %s,
                        invoices_created    = %s,
                        invoices_reconciled = %s,
                        error_message       = %s
                    WHERE run_id = %s
                    """,
                    (
                        status,
                        files_listed,
                        files_processed,
                        files_succeeded,
                        files_failed,
                        files_skipped,
                        invoices_created,
                        invoices_reconciled,
                        error_message,
                        str(run_id),
                    ),
                )
    except psycopg2.Error as exc:
        raise AuditError(f"Failed to finish run {run_id}: {exc}") from exc
    log.info(
        "run finished id=%s status=%s processed=%s succeeded=%s failed=%s",
        run_id, status, files_processed, files_succeeded, files_failed,
    )


# ---------------------------------------------------------------------------
# Per-file audit log
# ---------------------------------------------------------------------------
def log_file_event(
    run_id: UUID,
    file_id: str,
    file_name: str,
    status: str,
    *,
    invoice_id: Optional[int] = None,
    invoice_number: Optional[str] = None,
    reconciliation_status: Optional[str] = None,
    duration_ms: Optional[int] = None,
    error_message: Optional[str] = None,
    details: Optional[dict] = None,
) -> None:
    if status not in VALID_LOG_STATUSES:
        raise AuditError(f"Invalid log status {status!r}")
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO ocr_automation_log
                        (run_id, file_id, file_name, status,
                         invoice_id, invoice_number, reconciliation_status,
                         duration_ms, error_message, details)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(run_id), file_id, file_name, status,
                        invoice_id, invoice_number, reconciliation_status,
                        duration_ms, error_message,
                        Json(details) if details is not None else None,
                    ),
                )
    except psycopg2.Error as exc:
        # Don't crash the worker — log loudly so ops can act, but keep going.
        log.error("audit insert failed for file_id=%s: %s", file_id, exc)


# ---------------------------------------------------------------------------
# drive_synced_files — idempotency
# ---------------------------------------------------------------------------
def is_already_processed(file_id: str) -> bool:
    """Check whether we've already successfully processed this Drive file_id."""
    with get_conn(readonly=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM drive_synced_files WHERE file_id = %s",
                (file_id,),
            )
            row = cur.fetchone()
            if not row:
                return False
            return row[0] == SYNC_PROCESSED


def upsert_synced_file(
    file_id: str,
    file_name: str,
    mime_type: str,
    *,
    modified_time: Optional[datetime] = None,
    size_bytes: Optional[int] = None,
    sha256: Optional[str] = None,
    status: str = SYNC_PENDING,
    invoice_id: Optional[int] = None,
    invoice_number: Optional[str] = None,
    run_id: Optional[UUID] = None,
    error_message: Optional[str] = None,
) -> None:
    set_processed_at = "NOW()" if status == SYNC_PROCESSED else "NULL"
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    INSERT INTO drive_synced_files (
                        file_id, file_name, mime_type, modified_time, size_bytes,
                        sha256, status, invoice_id, invoice_number, run_id,
                        error_message, attempts, processed_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1, {set_processed_at})
                    ON CONFLICT (file_id) DO UPDATE SET
                        file_name      = EXCLUDED.file_name,
                        mime_type      = EXCLUDED.mime_type,
                        modified_time  = COALESCE(EXCLUDED.modified_time, drive_synced_files.modified_time),
                        size_bytes     = COALESCE(EXCLUDED.size_bytes, drive_synced_files.size_bytes),
                        sha256         = COALESCE(EXCLUDED.sha256, drive_synced_files.sha256),
                        status         = EXCLUDED.status,
                        invoice_id     = COALESCE(EXCLUDED.invoice_id, drive_synced_files.invoice_id),
                        invoice_number = COALESCE(EXCLUDED.invoice_number, drive_synced_files.invoice_number),
                        run_id         = EXCLUDED.run_id,
                        error_message  = EXCLUDED.error_message,
                        attempts       = drive_synced_files.attempts + 1,
                        processed_at   = CASE WHEN EXCLUDED.status = '{SYNC_PROCESSED}'
                                              THEN NOW()
                                              ELSE drive_synced_files.processed_at END
                    """,
                    (
                        file_id, file_name, mime_type, modified_time, size_bytes,
                        sha256, status, invoice_id, invoice_number,
                        str(run_id) if run_id else None,
                        error_message,
                    ),
                )
    except psycopg2.Error as exc:
        log.error("drive_synced_files upsert failed for file_id=%s: %s", file_id, exc)
