"""Main entry point for the daily email automation pipeline.

Usage
    python -m email_automation.run [--source zoho|local]

Pipeline
    1. Acquire file lock (prevents overlapping runs).
    2. Start a run row in `email_automation_runs`.
    3. Pre-sweep: re-validate all pending invoices from prior runs.
       (Picks up invoices whose reference PO / GRN / ASN finally arrived.)
    4. Fetch emails from the configured MailSource.
    5. For every attachment:
         a. Dedup via (message_id, sha256) against `email_automation_log`.
         b. Classify subject + filename -> doc_type.
         c. Save to downloaded/<doc_type>/<YYYY-MM-DD>/<filename>.
         d. Log `downloaded` row to audit.
    6. Process classified attachments in the fixed dependency order
           PO -> ASN -> GRN -> DC -> Schedule -> Invoice
       (parser then loader, each file in its own DB transaction).
       On failure: move file to failed/<doc_type>/ with .error.txt and
       continue with the next file so one bad email never blocks a run.
    7. Mark Zoho messages as read (only after DB commit).
    8. Post-sweep: re-validate everything again so newly-loaded invoices
       get their decision.
    9. Finish the run row with a final status + counters.
   10. Send summary email (if SMTP configured).
   11. Release the file lock.

Exit codes
    0  success (all ok or nothing to process)
   10  config / lock error
   30  partial success (at least one file loaded, at least one failed)
   40  all attempted files failed
   99  unexpected fatal error
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
import traceback
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from .alerts import send_summary
from .audit import (
    RUN_STATUS_FAILED,
    RUN_STATUS_PARTIAL,
    RUN_STATUS_SUCCESS,
    STATUS_DOWNLOADED,
    STATUS_FAILED,
    STATUS_LOADED,
    STATUS_SKIPPED_DUPLICATE,
    STATUS_SKIPPED_UNCLASSIFIED,
    AttachmentLogEntry,
    already_processed,
    finish_run,
    log_attachment,
    start_run,
)
from .config import CONFIG
from .db import close_pool, get_conn
from .loaders import asn as asn_loader
from .loaders import dc as dc_loader
from .loaders import grn as grn_loader
from .loaders import invoice as invoice_loader
from .loaders import po as po_loader
from .loaders import schedule as schedule_loader
from .loaders._common import POResolver, SupplierResolver
from .logger import setup_logging
from .mailbox import (
    ClassificationResult,
    FetchedAttachment,
    FetchedMessage,
    FileLock,
    LockError,
    MailSource,
    ZohoMailSource,
    classify,
    make_source,
)
from .parsers import asn as asn_parser
from .parsers import dc as dc_parser
from .parsers import grn as grn_parser
from .parsers import invoice as invoice_parser
from .parsers import po as po_parser
from .parsers import schedule as schedule_parser
from .validation.sweeper import revalidate_pending

log = logging.getLogger(__name__)

# doc_type -> (parser_module, loader_module)
PARSER_LOADER_MAP = {
    "po":       (po_parser, po_loader),
    "asn":      (asn_parser, asn_loader),
    "grn":      (grn_parser, grn_loader),
    "dc":       (dc_parser, dc_loader),
    "schedule": (schedule_parser, schedule_loader),
    "invoice":  (invoice_parser, invoice_loader),
}

# Dependency order — reference data before invoices.
PROCESS_ORDER = ["po", "asn", "grn", "dc", "schedule", "invoice"]


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------
def _save_attachment(doc_type: str, att: FetchedAttachment, run_date: datetime) -> Path:
    folder = CONFIG.paths.downloaded / doc_type / run_date.strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / att.file_name
    path.write_bytes(att.content)
    return path


def _save_failed(
    doc_type: Optional[str],
    att: FetchedAttachment,
    error: str,
    run_date: datetime,
) -> Path:
    label = doc_type or "unclassified"
    folder = CONFIG.paths.failed / label / run_date.strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / att.file_name
    try:
        path.write_bytes(att.content)
    except OSError as exc:
        log.warning("could not persist failed attachment: %s", exc)
    try:
        (path.with_suffix(path.suffix + ".error.txt")).write_text(
            error, encoding="utf-8"
        )
    except OSError:
        pass
    return path


# ---------------------------------------------------------------------------
# Summary formatting
# ---------------------------------------------------------------------------
def _format_summary(
    run_id: UUID,
    started: datetime,
    finished: datetime,
    counters: Dict[str, int],
    file_lines: List[str],
    pre_sweep: Any,
    post_sweep: Any,
) -> str:
    duration = (finished - started).total_seconds()
    lines: List[str] = []
    lines.append("=" * 70)
    lines.append(" EMAIL AUTOMATION RUN SUMMARY")
    lines.append("=" * 70)
    lines.append(f"Run ID:   {run_id}")
    lines.append(f"Started:  {started.isoformat(timespec='seconds')}")
    lines.append(f"Finished: {finished.isoformat(timespec='seconds')}")
    lines.append(f"Duration: {duration:.0f}s")
    lines.append("")
    lines.append("Counts")
    lines.append(f"  Emails fetched    : {counters['emails_fetched']}")
    lines.append(f"  Attachments total : {counters['processed']}")
    lines.append(f"    succeeded       : {counters['succeeded']}")
    lines.append(f"    failed          : {counters['failed']}")
    lines.append(f"    skipped (dup)   : {counters['skipped_dup']}")
    lines.append(f"    unclassified    : {counters['skipped_unclassified']}")
    lines.append("")
    lines.append("Pre-sweep (pending invoices from prior runs)")
    lines.append(
        f"  evaluated={pre_sweep.invoices_evaluated} "
        f"validated={pre_sweep.validated} "
        f"shortfall={pre_sweep.waiting_for_re_validation} "
        f"exception={pre_sweep.exception_approval} "
        f"still_waiting={pre_sweep.still_waiting}"
    )
    lines.append("")
    lines.append("Post-sweep (after loading new files)")
    lines.append(
        f"  evaluated={post_sweep.invoices_evaluated} "
        f"validated={post_sweep.validated} "
        f"shortfall={post_sweep.waiting_for_re_validation} "
        f"exception={post_sweep.exception_approval} "
        f"still_waiting={post_sweep.still_waiting}"
    )
    lines.append("")
    lines.append("Files processed")
    if file_lines:
        for line in file_lines:
            lines.append(f"  {line}")
    else:
        lines.append("  (none)")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------
def run(args: argparse.Namespace) -> int:
    setup_logging()
    started = datetime.now()
    log.info("starting run at %s (source=%s)", started.isoformat(), args.source)

    lock = FileLock(CONFIG.paths.lock_file)
    try:
        lock.acquire()
    except LockError as exc:
        log.error("lock error: %s", exc)
        return 10

    exit_code = 0
    run_id: Optional[UUID] = None
    source: Optional[MailSource] = None

    counters = {
        "emails_fetched": 0,
        "processed": 0,
        "succeeded": 0,
        "failed": 0,
        "skipped_dup": 0,
        "skipped_unclassified": 0,
    }
    file_lines: List[str] = []
    fatal_error: Optional[str] = None

    class _EmptyReport:
        invoices_evaluated = 0
        validated = 0
        waiting_for_re_validation = 0
        exception_approval = 0
        still_waiting = 0
        load_errors = 0

    pre_sweep: Any = _EmptyReport()
    post_sweep: Any = _EmptyReport()

    try:
        run_id = start_run()
        log.info("run %s started", run_id)

        # -- Step 1: pre-sweep ------------------------------------------------
        if args.skip_sweeps:
            log.info("pre-sweep: SKIPPED (--skip-sweeps)")
        else:
            log.info("pre-sweep: revalidating pending invoices")
            try:
                pre_sweep = revalidate_pending(run_id=run_id, log_to_audit=False)
                log.info("pre-sweep: %s", pre_sweep.summary())
            except Exception as exc:
                log.error("pre-sweep failed: %s", exc)
                traceback.print_exc()

        # -- Step 2: fetch emails --------------------------------------------
        source = make_source(args.source)
        try:
            messages: List[FetchedMessage] = list(source.fetch())
        except Exception as exc:
            log.error("mailbox fetch failed: %s", exc)
            fatal_error = f"mailbox fetch failed: {exc}"
            raise
        counters["emails_fetched"] = len(messages)
        log.info("fetched %d messages with attachments", len(messages))

        # -- Step 3: classify + dedup + save --------------------------------
        pending: Dict[str, List[Tuple[FetchedMessage, FetchedAttachment, Path]]] = defaultdict(list)
        for msg in messages:
            if not msg.attachments:
                continue
            log.info(
                "processing email uid=%s sender=%s subject=%r",
                msg.uid, msg.sender, msg.subject,
            )
            for att in msg.attachments:
                counters["processed"] += 1

                # Dedup
                try:
                    is_dup = already_processed(msg.message_id, att.sha256)
                except Exception as exc:
                    log.error("dedup check failed: %s", exc)
                    is_dup = False
                if is_dup:
                    counters["skipped_dup"] += 1
                    log.info(
                        "  [DUP]  %s (already processed in a prior run)", att.file_name
                    )
                    try:
                        log_attachment(
                            AttachmentLogEntry(
                                run_id=run_id,
                                message_id=msg.message_id,
                                email_uid=msg.uid,
                                sender=msg.sender,
                                subject=msg.subject,
                                received_at=msg.received_at,
                                attachment_name=att.file_name,
                                attachment_sha256=att.sha256,
                                doc_type=None,
                                status=STATUS_SKIPPED_DUPLICATE,
                            )
                        )
                    except Exception as exc:
                        log.warning("audit log (dup) failed: %s", exc)
                    file_lines.append(f"[DUP]       {att.file_name}")
                    continue

                # Classify
                cls: ClassificationResult = classify(msg.subject, att.file_name)
                if cls.doc_type is None:
                    counters["skipped_unclassified"] += 1
                    log.warning(
                        "  [UNK]  %s -> %s", att.file_name, cls.reason
                    )
                    path = _save_failed(None, att, f"unclassified: {cls.reason}", started)
                    try:
                        log_attachment(
                            AttachmentLogEntry(
                                run_id=run_id,
                                message_id=msg.message_id,
                                email_uid=msg.uid,
                                sender=msg.sender,
                                subject=msg.subject,
                                received_at=msg.received_at,
                                attachment_name=att.file_name,
                                attachment_sha256=att.sha256,
                                doc_type="unknown",
                                status=STATUS_SKIPPED_UNCLASSIFIED,
                                error_message=cls.reason,
                                file_path=str(path),
                            )
                        )
                    except Exception as exc:
                        log.warning("audit log (unclassified) failed: %s", exc)
                    file_lines.append(f"[UNK]       {att.file_name}  ({cls.reason})")
                    continue

                # Save to downloaded/
                try:
                    dl_path = _save_attachment(cls.doc_type, att, started)
                except OSError as exc:
                    log.error("could not save %s: %s", att.file_name, exc)
                    counters["failed"] += 1
                    fail_path = _save_failed(cls.doc_type, att, f"save error: {exc}", started)
                    log_attachment(
                        AttachmentLogEntry(
                            run_id=run_id,
                            message_id=msg.message_id,
                            email_uid=msg.uid,
                            sender=msg.sender,
                            subject=msg.subject,
                            received_at=msg.received_at,
                            attachment_name=att.file_name,
                            attachment_sha256=att.sha256,
                            doc_type=cls.doc_type,
                            status=STATUS_FAILED,
                            error_message=str(exc),
                            file_path=str(fail_path),
                        )
                    )
                    continue

                log.info(
                    "  [DL]   %s -> %s (%s, %.1f KB)",
                    att.file_name, dl_path, cls.doc_type, att.size / 1024,
                )
                try:
                    log_attachment(
                        AttachmentLogEntry(
                            run_id=run_id,
                            message_id=msg.message_id,
                            email_uid=msg.uid,
                            sender=msg.sender,
                            subject=msg.subject,
                            received_at=msg.received_at,
                            attachment_name=att.file_name,
                            attachment_sha256=att.sha256,
                            doc_type=cls.doc_type,
                            status=STATUS_DOWNLOADED,
                            file_path=str(dl_path),
                        )
                    )
                except Exception as exc:
                    log.warning("audit log (downloaded) failed: %s", exc)

                pending[cls.doc_type].append((msg, att, dl_path))

        # -- Step 4: prime resolvers once per run ----------------------------
        with get_conn() as prime_conn:
            supplier_resolver = SupplierResolver(prime_conn)
            po_resolver = POResolver(prime_conn)
            supplier_resolver.prefetch()
            po_resolver.prefetch()

        # -- Step 5: process in dependency order -----------------------------
        seen_uids: set = set()
        for doc_type in PROCESS_ORDER:
            for msg, att, dl_path in pending.get(doc_type, []):
                log.info(
                    "loading %s: %s (%.1f KB)", doc_type, att.file_name, att.size / 1024
                )
                file_started = time.time()
                try:
                    parser_mod, loader_mod = PARSER_LOADER_MAP[doc_type]
                    parsed = parser_mod.parse(att.content)
                    with get_conn() as conn:
                        if doc_type == "invoice":
                            lr = loader_mod.load(
                                conn,
                                parsed,
                                supplier_resolver=supplier_resolver,
                                po_resolver=po_resolver,
                                run_id=run_id,
                            )
                        else:
                            lr = loader_mod.load(
                                conn,
                                parsed,
                                supplier_resolver=supplier_resolver,
                                po_resolver=po_resolver,
                            )
                    counters["succeeded"] += 1
                    elapsed = time.time() - file_started
                    log.info("  [OK]   %s", lr.summary())
                    file_lines.append(
                        f"[OK]   {doc_type:8s} {att.file_name:32s} "
                        f"processed={lr.rows_processed} "
                        f"inserted={lr.rows_inserted} updated={lr.rows_updated} "
                        f"skipped={lr.rows_skipped}  ({elapsed:.1f}s)"
                    )
                    try:
                        log_attachment(
                            AttachmentLogEntry(
                                run_id=run_id,
                                message_id=msg.message_id,
                                email_uid=msg.uid,
                                sender=msg.sender,
                                subject=msg.subject,
                                received_at=msg.received_at,
                                attachment_name=att.file_name,
                                attachment_sha256=att.sha256,
                                doc_type=doc_type,
                                status=STATUS_LOADED,
                                file_path=str(dl_path),
                                rows_processed=lr.rows_processed,
                                rows_inserted=lr.rows_inserted,
                                rows_updated=lr.rows_updated,
                                rows_skipped=lr.rows_skipped,
                            )
                        )
                    except Exception as exc:
                        log.warning("audit log (loaded) failed: %s", exc)
                    if msg.uid is not None:
                        seen_uids.add(msg.uid)
                except Exception as exc:
                    counters["failed"] += 1
                    error_text = f"{type(exc).__name__}: {exc}"
                    tb_text = traceback.format_exc()
                    log.error("  [FAIL] %s %s: %s\n%s", doc_type, att.file_name, error_text, tb_text)
                    fail_path = _save_failed(doc_type, att, tb_text, started)
                    file_lines.append(
                        f"[FAIL] {doc_type:8s} {att.file_name:32s} {error_text[:80]}"
                    )
                    try:
                        log_attachment(
                            AttachmentLogEntry(
                                run_id=run_id,
                                message_id=msg.message_id,
                                email_uid=msg.uid,
                                sender=msg.sender,
                                subject=msg.subject,
                                received_at=msg.received_at,
                                attachment_name=att.file_name,
                                attachment_sha256=att.sha256,
                                doc_type=doc_type,
                                status=STATUS_FAILED,
                                error_message=error_text,
                                file_path=str(fail_path),
                            )
                        )
                    except Exception as exc:
                        log.warning("audit log (failed) failed: %s", exc)

        # -- Step 6: mark Zoho messages as seen ------------------------------
        if isinstance(source, ZohoMailSource):
            for uid in seen_uids:
                source.mark_seen(uid)

        # -- Step 7: post-sweep ---------------------------------------------
        if args.skip_sweeps:
            log.info("post-sweep: SKIPPED (--skip-sweeps)")
        else:
            log.info("post-sweep: revalidating after load")
            try:
                post_sweep = revalidate_pending(run_id=run_id, log_to_audit=False)
                log.info("post-sweep: %s", post_sweep.summary())
            except Exception as exc:
                log.error("post-sweep failed: %s", exc)
                traceback.print_exc()

        # -- Step 8: compose summary + persist + email -----------------------
        finished = datetime.now()
        summary_text = _format_summary(
            run_id, started, finished, counters, file_lines, pre_sweep, post_sweep
        )
        try:
            print(summary_text)
        except UnicodeEncodeError:
            print(summary_text.encode("ascii", errors="replace").decode("ascii"))

        summary_path = CONFIG.paths.logs / f"run_{run_id}.txt"
        try:
            summary_path.write_text(summary_text, encoding="utf-8")
        except OSError as exc:
            log.warning("could not save run summary: %s", exc)

        # Classify run outcome
        if counters["processed"] == 0:
            run_status = RUN_STATUS_SUCCESS
        elif counters["failed"] == 0:
            run_status = RUN_STATUS_SUCCESS
        elif counters["succeeded"] > 0:
            run_status = RUN_STATUS_PARTIAL
        else:
            run_status = RUN_STATUS_FAILED

        try:
            finish_run(
                run_id,
                run_status,
                emails_fetched=counters["emails_fetched"],
                attachments_processed=counters["processed"],
                attachments_succeeded=counters["succeeded"],
                attachments_failed=counters["failed"],
                attachments_skipped=counters["skipped_dup"] + counters["skipped_unclassified"],
                revalidated_invoices=post_sweep.invoices_evaluated,
                error_message=None if run_status == RUN_STATUS_SUCCESS else fatal_error,
            )
        except Exception as exc:
            log.error("finish_run failed: %s", exc)

        subject = f"[email_automation] {run_status.upper()} — {counters['succeeded']} ok / {counters['failed']} failed"
        send_summary(subject, summary_text)

        exit_code = {
            RUN_STATUS_SUCCESS: 0,
            RUN_STATUS_PARTIAL: 30,
            RUN_STATUS_FAILED: 40,
        }[run_status]

    except Exception as exc:
        log.exception("run failed unexpectedly")
        fatal_error = f"{type(exc).__name__}: {exc}"
        if run_id is not None:
            try:
                finish_run(
                    run_id,
                    RUN_STATUS_FAILED,
                    emails_fetched=counters["emails_fetched"],
                    attachments_processed=counters["processed"],
                    attachments_succeeded=counters["succeeded"],
                    attachments_failed=counters["failed"],
                    attachments_skipped=counters["skipped_dup"] + counters["skipped_unclassified"],
                    error_message=fatal_error,
                )
            except Exception:
                pass
        exit_code = 99
    finally:
        if source is not None:
            try:
                source.close()
            except Exception:
                pass
        try:
            close_pool()
        except Exception:
            pass
        lock.release()

    log.info("run finished exit=%d", exit_code)
    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m email_automation.run",
        description="Daily email ingestion pipeline for the billing system",
    )
    parser.add_argument(
        "--source",
        choices=["zoho", "local"],
        default="zoho",
        help="mail source: 'zoho' hits Zoho IMAP, 'local' reads docs/ folder as fake emails",
    )
    parser.add_argument(
        "--skip-sweeps",
        action="store_true",
        help="skip pre- and post-validation sweeps (fast path for smoke tests only)",
    )
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
