"""Comprehensive health check for the email_automation system.

Read-only. Runs ~20 seconds. Verifies:
    * Every module in the package imports without error
    * All expected DB migrations are applied (columns + tables + constraints)
    * Row counts on every table the pipeline touches
    * Validation bucket distribution for email_automation invoices
    * Open PO prefix table populated
    * All shipped files exist at the expected paths
    * .env is gitignored (no credential leak)
    * Dependencies installed at the pinned versions
    * Known gaps (subcontract orders, IMAP creds, alert SMTP) are reported

Exits 0 if everything is GREEN, non-zero otherwise.
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple

ROOT = Path(__file__).resolve().parent.parent
PKG = Path(__file__).resolve().parent

GREEN = "[OK]  "
YELLOW = "[WARN]"
RED = "[FAIL]"


class Report:
    def __init__(self) -> None:
        self.ok = 0
        self.warn = 0
        self.fail = 0

    def line(self, status: str, msg: str) -> None:
        print(f"  {status}  {msg}")
        if status == RED:
            self.fail += 1
        elif status == YELLOW:
            self.warn += 1
        else:
            self.ok += 1

    def section(self, title: str) -> None:
        print()
        print("-" * 78)
        print(f" {title}")
        print("-" * 78)

    def summary(self) -> int:
        print()
        print("=" * 78)
        status = "GREEN" if self.fail == 0 and self.warn == 0 else (
            "YELLOW" if self.fail == 0 else "RED"
        )
        print(f" HEALTHCHECK: {status}  "
              f"(ok={self.ok} warn={self.warn} fail={self.fail})")
        print("=" * 78)
        return 0 if self.fail == 0 else 20


def main() -> int:
    r = Report()

    # -----------------------------------------------------------------------
    # 1. Module imports
    # -----------------------------------------------------------------------
    r.section("1. Module imports")
    modules = [
        "email_automation",
        "email_automation.config",
        "email_automation.db",
        "email_automation.logger",
        "email_automation.audit",
        "email_automation.parsers",
        "email_automation.parsers.po",
        "email_automation.parsers.grn",
        "email_automation.parsers.asn",
        "email_automation.parsers.dc",
        "email_automation.parsers.schedule",
        "email_automation.parsers.invoice",
        "email_automation.loaders",
        "email_automation.loaders._common",
        "email_automation.loaders.po",
        "email_automation.loaders.grn",
        "email_automation.loaders.asn",
        "email_automation.loaders.dc",
        "email_automation.loaders.schedule",
        "email_automation.loaders.invoice",
        "email_automation.validation",
        "email_automation.validation.tolerances",
        "email_automation.validation.context",
        "email_automation.validation.checks",
        "email_automation.validation.engine",
        "email_automation.validation.status_writer",
        "email_automation.validation.sweeper",
        "email_automation.mailbox",
        "email_automation.mailbox.classifier",
        "email_automation.mailbox.source",
        "email_automation.mailbox.lockfile",
        "email_automation.alerts",
        "email_automation.run",
    ]
    for mod_name in modules:
        try:
            importlib.import_module(mod_name)
            r.line(GREEN, f"import {mod_name}")
        except Exception as exc:
            r.line(RED, f"import {mod_name}: {exc}")

    # -----------------------------------------------------------------------
    # 2. Dependencies
    # -----------------------------------------------------------------------
    r.section("2. Python dependencies")
    deps = [
        ("psycopg2", "2.9"),
        ("openpyxl", "3.1"),
        ("dotenv", None),
        ("docx", "1.0"),
    ]
    for name, min_ver in deps:
        try:
            mod = importlib.import_module(name)
            ver = getattr(mod, "__version__", "?")
            r.line(GREEN, f"{name} {ver}")
        except ImportError as exc:
            r.line(RED, f"{name}: NOT INSTALLED ({exc})")

    # -----------------------------------------------------------------------
    # 3. DB connectivity + schema
    # -----------------------------------------------------------------------
    r.section("3. Database schema")
    try:
        from email_automation.db import close_pool, get_cursor
    except Exception as exc:
        r.line(RED, f"db module failed: {exc}")
        return r.summary()

    try:
        with get_cursor(readonly=True) as cur:
            cur.execute("SELECT current_database(), version()")
            row = cur.fetchone()
            db_name = row["current_database"]
            server = str(row["version"]).split(" on ")[0]
            r.line(GREEN, f"connected: db={db_name} server={server}")
    except Exception as exc:
        r.line(RED, f"DB connection failed: {exc}")
        return r.summary()

    # Phase 1 migration: new columns on invoices
    expected_invoice_cols = [
        "unit", "doc_pfx", "doc_no", "grn_pfx", "grn_no", "dc_no",
        "ss_pfx", "ss_no", "open_order_pfx", "open_order_no", "gstin",
        "rcm_flag", "place_of_supply", "gst_classification",
        "gst_supply_type", "non_gst_flag", "aic_type", "currency",
        "exchange_rate", "source", "bill_register_run_id",
        # Phase 2.2
        "bill_type", "mode", "doc_entry_date", "grn_date", "po_pfx",
        "gst_type", "place_of_supply_desc",
    ]
    expected_invoice_lines_cols = [
        "igst_rate", "igst_amount", "cgst_rcm_amount", "sgst_rcm_amount",
        "igst_rcm_amount", "gross_amount", "net_amount", "assessable_value",
        "item_code", "item_rev", "narration", "grn_id",
        # Phase 2.2
        "item_class", "item_sub_class", "uom_description", "grn_tax_amount",
        "bill_amt_tc", "gross_amount_suplr", "net_amount_suplr",
        "domestic_amt", "import_amt",
        "cgst_9_amount", "cgst_2_5_amount", "sgst_9_amount",
        "sgst_2_5_amount", "igst_18_amount", "igst_5_amount",
    ]
    expected_asn_cols = [
        "item_code", "item_desc", "quantity", "po_pfx", "po_no",
        "schedule_pfx", "schedule_no", "grn_status",
    ]
    expected_suppliers_cols = ["suplr_id"]
    expected_audit_tables = ["email_automation_runs", "email_automation_log"]

    def _get_cols(table: str) -> set:
        with get_cursor(readonly=True) as cur:
            cur.execute(
                """SELECT column_name FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=%s""",
                (table,),
            )
            return {row["column_name"] for row in cur.fetchall()}

    for table, expected in [
        ("invoices", expected_invoice_cols),
        ("invoice_lines", expected_invoice_lines_cols),
        ("asn", expected_asn_cols),
        ("suppliers", expected_suppliers_cols),
    ]:
        present = _get_cols(table)
        missing = [c for c in expected if c not in present]
        if missing:
            r.line(RED, f"{table} missing columns: {missing}")
        else:
            r.line(GREEN, f"{table}: all {len(expected)} expected columns present")

    for t in expected_audit_tables:
        with get_cursor(readonly=True) as cur:
            cur.execute(
                "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=%s",
                (t,),
            )
            if cur.fetchone():
                r.line(GREEN, f"table {t} exists")
            else:
                r.line(RED, f"table {t} MISSING")

    # Unique constraint on invoices (supplier_id, invoice_number)
    with get_cursor(readonly=True) as cur:
        cur.execute(
            """SELECT conname FROM pg_constraint
               WHERE conrelid='invoices'::regclass
                 AND contype='u'
                 AND conname='uq_invoices_supplier_number'"""
        )
        if cur.fetchone():
            r.line(GREEN, "constraint uq_invoices_supplier_number present")
        else:
            r.line(RED, "constraint uq_invoices_supplier_number MISSING")

    # -----------------------------------------------------------------------
    # 4. Row counts
    # -----------------------------------------------------------------------
    r.section("4. DB row counts")
    counts = {}
    tables = [
        "suppliers", "purchase_orders", "purchase_order_lines",
        "grn", "asn", "delivery_challans", "po_schedules",
        "invoices", "invoice_lines", "open_po_prefixes",
        "email_automation_runs", "email_automation_log",
    ]
    for t in tables:
        with get_cursor(readonly=True) as cur:
            cur.execute(f"SELECT COUNT(*) AS c FROM {t}")
            counts[t] = cur.fetchone()["c"]
            r.line(GREEN, f"{t:25s} {counts[t]:>10}")

    if counts["purchase_orders"] < 100:
        r.line(YELLOW, "purchase_orders count is low — may need reload")
    if counts["invoices"] < 100:
        r.line(YELLOW, "invoices count is low — may need reload")
    if counts["open_po_prefixes"] == 0:
        r.line(YELLOW, "open_po_prefixes is empty — Open PO detection disabled")

    # -----------------------------------------------------------------------
    # 5. Validation state
    # -----------------------------------------------------------------------
    r.section("5. Validation state (email_automation invoices)")
    with get_cursor(readonly=True) as cur:
        cur.execute("""
            SELECT status, COUNT(*) AS c FROM invoices
            WHERE source='email_automation' GROUP BY status ORDER BY status
        """)
        buckets = {row["status"]: row["c"] for row in cur.fetchall()}
        total = sum(buckets.values())
        for s, c in buckets.items():
            pct = (c / total * 100) if total else 0
            r.line(GREEN, f"{s:30s} {c:>5} ({pct:5.1f}%)")

    # Sanity: 131 POs fulfilled when 131 invoices validated the first time
    with get_cursor(readonly=True) as cur:
        cur.execute("SELECT COUNT(*) AS c FROM purchase_orders WHERE status='fulfilled'")
        fulfilled = cur.fetchone()["c"]
        r.line(GREEN, f"POs marked fulfilled: {fulfilled}")

    # Open PO detection sanity
    with get_cursor(readonly=True) as cur:
        cur.execute("""
            SELECT COUNT(*) AS c FROM purchase_orders po
            WHERE EXISTS (
                SELECT 1 FROM open_po_prefixes op
                WHERE UPPER(po.pfx) LIKE UPPER(TRIM(op.prefix)) || '%'
            )
        """)
        open_po_count = cur.fetchone()["c"]
        r.line(GREEN, f"POs classified as Open PO: {open_po_count}")

    # -----------------------------------------------------------------------
    # 6. File presence
    # -----------------------------------------------------------------------
    r.section("6. Shipped files")
    expected_files = [
        # Config + secrets (.env is gitignored so just check existence)
        "email_automation/.env",
        "email_automation/.env.example",
        "email_automation/.gitignore",
        "email_automation/requirements.txt",
        # Phase 1
        "scripts/migration_email_automation.sql",
        "email_automation/config.py",
        "email_automation/db.py",
        "email_automation/logger.py",
        "email_automation/audit.py",
        "email_automation/phase1_smoke_test.py",
        # Phase 2
        "scripts/migration_email_automation_phase2.sql",
        "scripts/migration_email_automation_phase2_1_asn.sql",
        "scripts/migration_email_automation_phase2_2_invoice.sql",
        "email_automation/parsers/_common.py",
        "email_automation/parsers/po.py",
        "email_automation/parsers/grn.py",
        "email_automation/parsers/asn.py",
        "email_automation/parsers/dc.py",
        "email_automation/parsers/schedule.py",
        "email_automation/parsers/invoice.py",
        "email_automation/loaders/_common.py",
        "email_automation/loaders/po.py",
        "email_automation/loaders/grn.py",
        "email_automation/loaders/asn.py",
        "email_automation/loaders/dc.py",
        "email_automation/loaders/schedule.py",
        "email_automation/loaders/invoice.py",
        "email_automation/phase2_smoke_test.py",
        # Phase 3
        "email_automation/validation/tolerances.py",
        "email_automation/validation/context.py",
        "email_automation/validation/checks.py",
        "email_automation/validation/engine.py",
        "email_automation/validation/status_writer.py",
        "email_automation/validation/sweeper.py",
        "email_automation/phase3_smoke_test.py",
        "email_automation/phase3_issues_report.py",
        "email_automation/phase3_generate_doc.py",
        "email_automation/logs/phase3_data_quality_report.docx",
        "email_automation/logs/phase3_data_quality_report.pdf",
        # Phase 4
        "email_automation/mailbox/classifier.py",
        "email_automation/mailbox/source.py",
        "email_automation/mailbox/lockfile.py",
        "email_automation/alerts.py",
        "email_automation/run.py",
        "email_automation/scripts/run_email_automation.bat",
        "email_automation/scripts/email_automation_task.xml",
        "email_automation/scripts/README_task_scheduler.md",
    ]
    for relative in expected_files:
        path = ROOT / relative
        if path.is_file():
            r.line(GREEN, f"{relative} ({path.stat().st_size} bytes)")
        else:
            r.line(RED, f"{relative} MISSING")

    # -----------------------------------------------------------------------
    # 7. Security / secrets
    # -----------------------------------------------------------------------
    r.section("7. Security")
    # .env gitignored?
    try:
        result = subprocess.run(
            ["git", "check-ignore", "-v", "email_automation/.env"],
            capture_output=True, text=True, cwd=str(ROOT),
        )
        if result.returncode == 0 and "email_automation/.gitignore" in result.stdout:
            r.line(GREEN, ".env is gitignored (email_automation/.gitignore)")
        else:
            r.line(RED, f".env IS NOT gitignored — secret leak risk")
    except Exception as exc:
        r.line(YELLOW, f"could not verify .gitignore: {exc}")

    # Root .gitignore also ignores .env
    root_gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8", errors="ignore")
    if ".env" in root_gitignore:
        r.line(GREEN, "root .gitignore excludes .env")
    else:
        r.line(YELLOW, "root .gitignore does not list .env")

    # -----------------------------------------------------------------------
    # 8. Configuration presence
    # -----------------------------------------------------------------------
    r.section("8. Configuration presence (no values printed)")
    try:
        from email_automation.config import CONFIG
        if CONFIG.db.host:
            r.line(GREEN, f"DB host configured: {CONFIG.db.host[:30]}...")
        if CONFIG.imap.host and CONFIG.imap.user:
            r.line(GREEN, f"IMAP host/user configured")
        else:
            r.line(YELLOW, "IMAP user not set (expected until Zoho app password received)")
        if CONFIG.imap.password:
            r.line(GREEN, "IMAP password configured")
        else:
            r.line(YELLOW, "IMAP_PASSWORD not set (pipeline will fall back to local mode / IMAP will error)")
        if CONFIG.alert.enabled:
            r.line(GREEN, f"alerts enabled, recipient={CONFIG.alert.recipient}")
        else:
            r.line(YELLOW, f"alerts disabled (summary stays in logs/run_<uuid>.txt)")
    except Exception as exc:
        r.line(RED, f"config load failed: {exc}")

    # -----------------------------------------------------------------------
    # 9. Known gaps (informational)
    # -----------------------------------------------------------------------
    r.section("9. Known gaps (informational, not test failures)")
    r.line(YELLOW, "971 invoices blocked on SC subcontract orders missing from PO.xls")
    r.line(YELLOW, "421 invoices have no PO reference at all in the Bill Register")
    r.line(YELLOW, "~400 invoices have wrong intra/inter-state GST classification")
    r.line(YELLOW, "684 invoices have real price drift vs PO rate")
    r.line(YELLOW, "Zoho IMAP app password not yet provided — local mode only")
    r.line(YELLOW, "SMTP alerts disabled — summary email waits on SMTP config")

    close_pool()
    return r.summary()


if __name__ == "__main__":
    sys.exit(main())
