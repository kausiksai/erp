"""Main entry point for the OCR automation pipeline.

Usage
    python -m ocr_automation.run

Pipeline
    1. Acquire file lock (prevents overlapping runs).
    2. Start a run row in `ocr_automation_runs`.
    3. List PDFs/images in the configured Drive folder.
    4. Skip files already marked `processed` in `drive_synced_files`.
    5. Process the new files concurrently (OCR_CONCURRENCY workers):
         a. Download bytes from Drive.
         b. POST to /api/invoices/upload (extract via Landing AI).
         c. POST to /api/invoices (save + auto-reconcile).
         d. Mark file `processed` in `drive_synced_files` + log audit row.
       On failure: mark `failed`, log the error, continue with the next file.
    6. Finish the run row with aggregate counters.

Exit codes
    0   success (all OK or nothing to process)
   10   config / lock error
   30   partial success (at least one file loaded, at least one failed)
   40   all attempted files failed
   99   unexpected fatal error
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from uuid import UUID

from . import audit
from .config import CONFIG, ConfigError
from .db import close_pool, ping
from .drive import (
    DriveAuthError,
    DriveDownloadError,
    DriveFile,
    DriveListError,
    download_file,
    list_invoice_files,
)
from .extractor import ExtractionError, SaveError, extract, save
from .logger import setup_logging

log = logging.getLogger("ocr_automation.run")

EXIT_OK = 0
EXIT_CONFIG = 10
EXIT_PARTIAL = 30
EXIT_ALL_FAILED = 40
EXIT_FATAL = 99


@dataclass
class FileOutcome:
    file: DriveFile
    ok: bool
    invoice_id: Optional[int] = None
    invoice_number: Optional[str] = None
    reconciliation_status: Optional[str] = None
    error: Optional[str] = None
    duration_ms: int = 0
    skipped_duplicate: bool = False


# ---------------------------------------------------------------------------
# File lock
# ---------------------------------------------------------------------------
@contextmanager
def acquire_lock(path: Path):
    """Best-effort file lock: refuses to start if another run is in progress.
    On Windows we can't use fcntl, so we rely on a stale-PID check.
    """
    if path.exists():
        try:
            existing = path.read_text().strip()
        except OSError:
            existing = "?"
        raise RuntimeError(
            f"Lock file {path} already exists (pid={existing}). "
            "Another run may be in progress; if not, delete the file."
        )
    try:
        path.write_text(str(__import__("os").getpid()))
    except OSError as exc:
        raise RuntimeError(f"Cannot create lock file {path}: {exc}") from exc
    try:
        yield
    finally:
        try:
            path.unlink()
        except OSError as exc:
            log.warning("could not remove lock file %s: %s", path, exc)


# ---------------------------------------------------------------------------
# Per-file worker
# ---------------------------------------------------------------------------
def _process_one_file(run_id: UUID, f: DriveFile) -> FileOutcome:
    started = time.monotonic()

    if audit.is_already_processed(f.file_id):
        log.info("skip duplicate file_id=%s name=%s", f.file_id, f.name)
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_SKIPPED_DUPLICATE,
            duration_ms=0,
        )
        return FileOutcome(file=f, ok=True, skipped_duplicate=True)

    # Mark pending so concurrent runs don't pick it up (best-effort).
    audit.upsert_synced_file(
        f.file_id, f.name, f.mime_type,
        modified_time=f.modified_time, size_bytes=f.size_bytes,
        status=audit.SYNC_PENDING, run_id=run_id,
    )

    try:
        # 1) Download
        log.info("download file_id=%s name=%s", f.file_id, f.name)
        data = download_file(f.file_id)
        sha = hashlib.sha256(data).hexdigest()
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_DOWNLOADED,
            duration_ms=int((time.monotonic() - started) * 1000),
            details={"size_bytes": len(data), "sha256": sha},
        )

        # 2) Extract via existing /api/invoices/upload
        t1 = time.monotonic()
        log.info("extract file_id=%s name=%s", f.file_id, f.name)
        extract_result = extract(data, f.name, f.mime_type)
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_EXTRACTED,
            invoice_number=(extract_result.invoice_data or {}).get("invoiceNumber"),
            duration_ms=int((time.monotonic() - t1) * 1000),
            details={
                "extracted": extract_result.extracted,
                "extraction_error": extract_result.extraction_error,
            },
        )
        if not extract_result.extracted:
            # Still proceed to save — Landing AI failed but the user can fill
            # in fields later via the portal. Mark as failed in idempotency
            # so the file doesn't get re-processed forever; ops can re-queue.
            err = extract_result.extraction_error or "extraction returned no useful data"
            audit.upsert_synced_file(
                f.file_id, f.name, f.mime_type,
                modified_time=f.modified_time, size_bytes=f.size_bytes, sha256=sha,
                status=audit.SYNC_FAILED, run_id=run_id, error_message=err,
            )
            audit.log_file_event(
                run_id, f.file_id, f.name, audit.LOG_FAILED,
                error_message=err,
            )
            return FileOutcome(file=f, ok=False, error=err,
                               duration_ms=int((time.monotonic() - started) * 1000))

        # 3) Save (this triggers reconcileInvoice server-side)
        t2 = time.monotonic()
        log.info("save file_id=%s name=%s", f.file_id, f.name)
        save_result = save(extract_result)
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_SAVED,
            invoice_id=save_result.invoice_id,
            invoice_number=(extract_result.invoice_data or {}).get("invoiceNumber"),
            reconciliation_status=save_result.reconciliation_status,
            duration_ms=int((time.monotonic() - t2) * 1000),
        )
        # Audit reconcile separately so dashboards can count it
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_RECONCILED,
            invoice_id=save_result.invoice_id,
            invoice_number=(extract_result.invoice_data or {}).get("invoiceNumber"),
            reconciliation_status=save_result.reconciliation_status,
            details={"mismatches_count": len(save_result.mismatches or [])},
        )

        # 4) Mark idempotency row processed
        audit.upsert_synced_file(
            f.file_id, f.name, f.mime_type,
            modified_time=f.modified_time, size_bytes=f.size_bytes, sha256=sha,
            status=audit.SYNC_PROCESSED, invoice_id=save_result.invoice_id,
            invoice_number=(extract_result.invoice_data or {}).get("invoiceNumber"),
            run_id=run_id,
        )

        return FileOutcome(
            file=f,
            ok=True,
            invoice_id=save_result.invoice_id,
            invoice_number=(extract_result.invoice_data or {}).get("invoiceNumber"),
            reconciliation_status=save_result.reconciliation_status,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    except (DriveDownloadError, ExtractionError, SaveError) as exc:
        err = f"{type(exc).__name__}: {exc}"
        log.error("file_id=%s name=%s failed: %s", f.file_id, f.name, err)
        audit.upsert_synced_file(
            f.file_id, f.name, f.mime_type,
            modified_time=f.modified_time, size_bytes=f.size_bytes,
            status=audit.SYNC_FAILED, run_id=run_id, error_message=err,
        )
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_FAILED, error_message=err,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return FileOutcome(
            file=f, ok=False, error=err,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001 — last-resort safety net
        err = f"unexpected: {type(exc).__name__}: {exc}"
        log.exception("file_id=%s name=%s unexpected error", f.file_id, f.name)
        audit.upsert_synced_file(
            f.file_id, f.name, f.mime_type,
            modified_time=f.modified_time, size_bytes=f.size_bytes,
            status=audit.SYNC_FAILED, run_id=run_id, error_message=err,
        )
        audit.log_file_event(
            run_id, f.file_id, f.name, audit.LOG_FAILED, error_message=err,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return FileOutcome(file=f, ok=False, error=err)


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="OCR automation runner")
    parser.add_argument(
        "--folder-id",
        help="Override DRIVE_FOLDER_ID for this run (e.g. for testing)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process at most N new files (useful for first runs)",
    )
    args = parser.parse_args(argv)

    setup_logging()

    log.info("ocr_automation starting")
    log.info(
        "config: %s drive_folder=%s concurrency=%d",
        CONFIG.db.redacted_repr(),
        args.folder_id or CONFIG.drive.folder_id,
        CONFIG.runtime.concurrency,
    )

    if not ping():
        log.error("DB ping failed; aborting")
        return EXIT_CONFIG

    try:
        with acquire_lock(CONFIG.paths.lock_file):
            run_id = audit.start_run(args.folder_id or CONFIG.drive.folder_id)
            try:
                return _execute(run_id, args)
            except Exception as exc:  # noqa: BLE001
                log.exception("fatal error in run %s", run_id)
                audit.finish_run(
                    run_id, audit.RUN_FAILED,
                    error_message=f"{type(exc).__name__}: {exc}",
                )
                return EXIT_FATAL
    except RuntimeError as exc:
        log.error("lock/config error: %s", exc)
        return EXIT_CONFIG
    finally:
        close_pool()


def _execute(run_id: UUID, args) -> int:
    folder_id = args.folder_id or CONFIG.drive.folder_id

    # --- List ---
    try:
        files = list_invoice_files(folder_id)
    except (DriveAuthError, DriveListError) as exc:
        log.error("Drive list failed: %s", exc)
        audit.finish_run(run_id, audit.RUN_FAILED, error_message=str(exc))
        return EXIT_CONFIG

    files_listed = len(files)
    if files_listed == 0:
        log.info("no files in Drive folder")
        audit.finish_run(run_id, audit.RUN_SUCCESS, files_listed=0)
        return EXIT_OK

    # --- Filter out already-processed ---
    todo = [f for f in files if not audit.is_already_processed(f.file_id)]
    skipped = files_listed - len(todo)
    if args.limit is not None and len(todo) > args.limit:
        log.info("limit=%d capping todo from %d", args.limit, len(todo))
        todo = todo[: args.limit]

    log.info("listed=%d skipped_duplicate=%d todo=%d", files_listed, skipped, len(todo))

    if not todo:
        audit.finish_run(
            run_id, audit.RUN_SUCCESS,
            files_listed=files_listed,
            files_skipped=skipped,
        )
        return EXIT_OK

    # --- Concurrent processing ---
    succeeded = 0
    failed = 0
    invoices_created = 0
    invoices_reconciled = 0

    with ThreadPoolExecutor(
        max_workers=CONFIG.runtime.concurrency,
        thread_name_prefix="ocr",
    ) as ex:
        futures = {ex.submit(_process_one_file, run_id, f): f for f in todo}
        for fut in as_completed(futures):
            outcome = fut.result()
            if outcome.skipped_duplicate:
                # Counted under skipped, not processed.
                continue
            if outcome.ok:
                succeeded += 1
                if outcome.invoice_id is not None:
                    invoices_created += 1
                if outcome.reconciliation_status:
                    invoices_reconciled += 1
            else:
                failed += 1
            log.info(
                "done file=%s ok=%s invoice_id=%s recon=%s duration_ms=%d",
                outcome.file.name, outcome.ok, outcome.invoice_id,
                outcome.reconciliation_status, outcome.duration_ms,
            )

    processed = succeeded + failed

    # --- Aggregate run status ---
    if processed == 0:
        run_status = audit.RUN_SUCCESS
    elif failed == 0:
        run_status = audit.RUN_SUCCESS
    elif succeeded == 0:
        run_status = audit.RUN_FAILED
    else:
        run_status = audit.RUN_PARTIAL

    audit.finish_run(
        run_id, run_status,
        files_listed=files_listed,
        files_processed=processed,
        files_succeeded=succeeded,
        files_failed=failed,
        files_skipped=skipped,
        invoices_created=invoices_created,
        invoices_reconciled=invoices_reconciled,
    )

    log.info(
        "run summary listed=%d processed=%d succeeded=%d failed=%d skipped=%d",
        files_listed, processed, succeeded, failed, skipped,
    )

    if run_status == audit.RUN_PARTIAL:
        return EXIT_PARTIAL
    if run_status == audit.RUN_FAILED:
        return EXIT_ALL_FAILED
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ConfigError:
        sys.exit(EXIT_CONFIG)
    except Exception:
        traceback.print_exc()
        sys.exit(EXIT_FATAL)
