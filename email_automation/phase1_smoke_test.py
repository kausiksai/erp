"""Phase 1 smoke test for the email automation pipeline.

Runs end-to-end verification of the Phase 1 foundation:

    1. Loads config from email_automation/.env and reports what it loaded.
    2. Initialises the Postgres pool and runs a trivial query.
    3. Executes scripts/migration_email_automation.sql.
    4. Verifies the new columns exist on invoices / invoice_lines.
    5. Verifies email_automation_runs and email_automation_log tables exist.
    6. Round-trips a test run: start_run -> log_attachment -> finish_run
       -> delete the test run row (clean up after itself).

Run with:
    python -m email_automation.phase1_smoke_test

Exits 0 on full success, non-zero on any failure.
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path
from typing import List, Tuple

import psycopg2

from .audit import (
    STATUS_DOWNLOADED,
    RUN_STATUS_SUCCESS,
    AttachmentLogEntry,
    AuditError,
    finish_run,
    log_attachment,
    start_run,
)
from .config import CONFIG
from .db import DatabaseError, close_pool, get_cursor, ping
from .logger import setup_logging

MIGRATION_FILE = (
    Path(__file__).resolve().parent.parent / "scripts" / "migration_email_automation.sql"
)

EXPECTED_INVOICE_COLS = {
    "unit",
    "doc_pfx",
    "doc_no",
    "grn_pfx",
    "grn_no",
    "dc_no",
    "ss_pfx",
    "ss_no",
    "open_order_pfx",
    "open_order_no",
    "gstin",
    "rcm_flag",
    "place_of_supply",
    "gst_classification",
    "gst_supply_type",
    "non_gst_flag",
    "aic_type",
    "currency",
    "exchange_rate",
    "source",
    "bill_register_run_id",
}

EXPECTED_INVOICE_LINE_COLS = {
    "igst_rate",
    "igst_amount",
    "cgst_rcm_amount",
    "sgst_rcm_amount",
    "igst_rcm_amount",
    "gross_amount",
    "net_amount",
    "assessable_value",
    "item_code",
    "item_rev",
    "narration",
    "grn_id",
}

EXPECTED_TABLES = {"email_automation_runs", "email_automation_log"}


def _header(title: str) -> None:
    print()
    print("=" * 72)
    print(f" {title}")
    print("=" * 72)


def _ok(msg: str) -> None:
    print(f"  [OK]  {msg}")


def _fail(msg: str) -> None:
    print(f"  [FAIL] {msg}")


def step_report_config() -> None:
    _header("Step 1/6 - Configuration")
    print(f"  db       : {CONFIG.db.redacted_repr()}")
    print(f"  paths    : root={CONFIG.paths.root}")
    print(f"             downloaded={CONFIG.paths.downloaded}")
    print(f"             failed={CONFIG.paths.failed}")
    print(f"             logs={CONFIG.paths.logs}")
    print(f"  runtime  : tz={CONFIG.runtime.timezone} "
          f"window={CONFIG.runtime.window_start_hour}-{CONFIG.runtime.window_end_hour} "
          f"log_level={CONFIG.runtime.log_level}")
    print(f"  imap     : host={CONFIG.imap.host}:{CONFIG.imap.port} "
          f"user={CONFIG.imap.user or '<not set>'} "
          f"allowed_sender={CONFIG.imap.allowed_sender}")
    print(f"  alert    : enabled={CONFIG.alert.enabled} recipient={CONFIG.alert.recipient}")


def step_ping() -> bool:
    _header("Step 2/6 - Database ping")
    ok = ping()
    if ok:
        _ok("DB reachable")
    else:
        _fail("DB ping failed (see logs above)")
    return ok


def step_run_migration() -> bool:
    _header("Step 3/6 - Run migration")
    if not MIGRATION_FILE.is_file():
        _fail(f"Migration file not found: {MIGRATION_FILE}")
        return False
    sql = MIGRATION_FILE.read_text(encoding="utf-8")
    print(f"  migration : {MIGRATION_FILE}")
    print(f"  size      : {len(sql)} bytes")
    try:
        # The migration itself wraps the statements in BEGIN/COMMIT, so we
        # execute it with autocommit enabled to let those markers drive the
        # transaction explicitly.
        with get_cursor(autocommit=True, dict_rows=False) as cur:
            cur.execute(sql)
    except (DatabaseError, psycopg2.Error) as exc:
        _fail(f"Migration failed: {exc}")
        return False
    _ok("Migration executed")
    return True


def step_verify_columns() -> bool:
    _header("Step 4/6 - Verify schema changes")
    all_ok = True
    try:
        with get_cursor(readonly=True) as cur:
            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'invoices'
                """
            )
            present = {row["column_name"] for row in cur.fetchall()}
            missing = EXPECTED_INVOICE_COLS - present
            if missing:
                _fail(f"invoices missing columns: {sorted(missing)}")
                all_ok = False
            else:
                _ok(f"invoices: all {len(EXPECTED_INVOICE_COLS)} new columns present")

            cur.execute(
                """
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'invoice_lines'
                """
            )
            present = {row["column_name"] for row in cur.fetchall()}
            missing = EXPECTED_INVOICE_LINE_COLS - present
            if missing:
                _fail(f"invoice_lines missing columns: {sorted(missing)}")
                all_ok = False
            else:
                _ok(f"invoice_lines: all {len(EXPECTED_INVOICE_LINE_COLS)} new columns present")

            cur.execute(
                """
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = ANY(%s)
                """,
                (list(EXPECTED_TABLES),),
            )
            present = {row["table_name"] for row in cur.fetchall()}
            missing = EXPECTED_TABLES - present
            if missing:
                _fail(f"missing tables: {sorted(missing)}")
                all_ok = False
            else:
                _ok(f"audit tables present: {sorted(EXPECTED_TABLES)}")
    except (DatabaseError, psycopg2.Error) as exc:
        _fail(f"Schema verification failed: {exc}")
        return False
    return all_ok


def step_audit_roundtrip() -> bool:
    _header("Step 5/6 - Audit round-trip")
    try:
        run_id = start_run()
        _ok(f"start_run -> {run_id}")
    except AuditError as exc:
        _fail(f"start_run failed: {exc}")
        return False

    try:
        log_id = log_attachment(
            AttachmentLogEntry(
                run_id=run_id,
                message_id=f"phase1-smoke-{run_id}@local",
                email_uid=None,
                sender="smoke-test@local",
                subject="Phase 1 smoke test",
                received_at=None,
                attachment_name="smoke.xlsx",
                attachment_sha256="0" * 64,
                doc_type="unknown",
                status=STATUS_DOWNLOADED,
                file_path="/dev/null",
            )
        )
        _ok(f"log_attachment -> id={log_id}")
    except AuditError as exc:
        _fail(f"log_attachment failed: {exc}")
        return False

    try:
        finish_run(
            run_id,
            RUN_STATUS_SUCCESS,
            emails_fetched=0,
            attachments_processed=1,
            attachments_succeeded=0,
            attachments_failed=0,
            attachments_skipped=1,
            revalidated_invoices=0,
            error_message="phase1 smoke test",
        )
        _ok("finish_run")
    except AuditError as exc:
        _fail(f"finish_run failed: {exc}")
        return False

    # Clean up the smoke-test rows so the audit tables stay pristine.
    try:
        with get_cursor(dict_rows=False) as cur:
            cur.execute(
                "DELETE FROM email_automation_runs WHERE run_id = %s",
                (str(run_id),),
            )
            # email_automation_log rows cascade from the runs FK
        _ok("smoke-test rows cleaned up")
    except (DatabaseError, psycopg2.Error) as exc:
        _fail(f"cleanup failed (leaving smoke row behind): {exc}")
        return False
    return True


def step_teardown() -> None:
    _header("Step 6/6 - Teardown")
    close_pool()
    _ok("pool closed")


def main() -> int:
    setup_logging()
    try:
        step_report_config()
        if not step_ping():
            return 10
        if not step_run_migration():
            return 20
        if not step_verify_columns():
            return 30
        if not step_audit_roundtrip():
            return 40
        step_teardown()
        _header("PHASE 1 SMOKE TEST: SUCCESS")
        return 0
    except Exception as exc:
        print()
        print("!" * 72)
        print(f"UNEXPECTED ERROR: {exc}")
        traceback.print_exc()
        print("!" * 72)
        return 99


if __name__ == "__main__":
    sys.exit(main())
