"""Phase 2 smoke test.

Loads all six sample files in docs/ into production RDS, in the correct
dependency order:

    PO -> ASN -> GRN -> DC -> Schedule -> Invoice

Each file is loaded inside its own transaction. On failure the current
file's transaction rolls back and subsequent files are still attempted so
that a bad file does not block the rest of the pipeline.

Run with:
    python -m email_automation.phase2_smoke_test

Exits 0 on full success, non-zero on partial/total failure.
"""

from __future__ import annotations

import sys
import time
import traceback
from pathlib import Path
from typing import Dict

from .audit import (
    RUN_STATUS_FAILED,
    RUN_STATUS_PARTIAL,
    RUN_STATUS_SUCCESS,
    STATUS_LOADED,
    AttachmentLogEntry,
    finish_run,
    log_attachment,
    start_run,
)
from .db import close_pool, get_conn, get_cursor
from .loaders import asn as asn_loader
from .loaders import dc as dc_loader
from .loaders import grn as grn_loader
from .loaders import invoice as invoice_loader
from .loaders import po as po_loader
from .loaders import schedule as schedule_loader
from .loaders._common import LoadResult, POResolver, SupplierResolver
from .logger import setup_logging
from .parsers import asn as asn_parser
from .parsers import dc as dc_parser
from .parsers import grn as grn_parser
from .parsers import invoice as invoice_parser
from .parsers import po as po_parser
from .parsers import schedule as schedule_parser

DOCS = Path(__file__).resolve().parent.parent / "docs"

# Fixed dependency order — reference data first, invoices last.
PIPELINE = [
    ("po",       "PO.xls",                    po_parser,       po_loader),
    ("asn",      "ASN.xls",                   asn_parser,      asn_loader),
    ("grn",      "GRN.xls",                   grn_parser,      grn_loader),
    ("dc",       "DC.xls",                    dc_parser,       dc_loader),
    ("schedule", "schedule.xls",              schedule_parser, schedule_loader),
    ("invoice",  "Bill Register Mar-26.xlsx", invoice_parser,  invoice_loader),
]


def _header(title: str) -> None:
    print()
    print("=" * 76)
    print(f" {title}")
    print("=" * 76)


def _check_file(name: str) -> Path:
    p = DOCS / name
    if not p.is_file():
        raise FileNotFoundError(f"Sample file not found: {p}")
    return p


def _pre_counts() -> Dict[str, int]:
    tables = [
        "suppliers",
        "purchase_orders",
        "purchase_order_lines",
        "grn",
        "asn",
        "delivery_challans",
        "po_schedules",
        "invoices",
        "invoice_lines",
    ]
    counts: Dict[str, int] = {}
    with get_cursor(readonly=True) as cur:
        for t in tables:
            cur.execute(f"SELECT COUNT(*) AS c FROM {t}")
            counts[t] = cur.fetchone()["c"]
    return counts


def _run_one(doc_type, file_name, parser_mod, loader_mod, *, run_id, supplier_resolver, po_resolver):
    path = _check_file(file_name)
    print(f"\n--- {doc_type.upper():<8} {file_name}")
    print(f"  parsing  : {path}")
    t_parse = time.time()
    try:
        parsed = parser_mod.parse(path)
    except Exception as exc:
        print(f"  [FAIL] parser error: {exc}")
        log_attachment(
            AttachmentLogEntry(
                run_id=run_id,
                attachment_name=file_name,
                doc_type=doc_type,
                status="failed",
                error_message=f"parser: {exc}",
                file_path=str(path),
            )
        )
        return None
    dt_parse = time.time() - t_parse

    if doc_type == "invoice":
        total_rows = sum(len(inv["lines"]) for inv in parsed)
        print(f"  parsed   : {len(parsed)} invoices / {total_rows} lines in {dt_parse:.2f}s")
    else:
        print(f"  parsed   : {len(parsed)} rows in {dt_parse:.2f}s")

    t_load = time.time()
    try:
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
    except Exception as exc:
        print(f"  [FAIL] loader error: {exc}")
        traceback.print_exc()
        log_attachment(
            AttachmentLogEntry(
                run_id=run_id,
                attachment_name=file_name,
                doc_type=doc_type,
                status="failed",
                error_message=f"loader: {exc}",
                file_path=str(path),
            )
        )
        return None
    dt_load = time.time() - t_load

    print(f"  loaded   : {lr.summary()}")
    print(f"  db time  : {dt_load:.2f}s")

    log_attachment(
        AttachmentLogEntry(
            run_id=run_id,
            attachment_name=file_name,
            doc_type=doc_type,
            status=STATUS_LOADED,
            file_path=str(path),
            rows_processed=lr.rows_processed,
            rows_inserted=lr.rows_inserted,
            rows_updated=lr.rows_updated,
            rows_skipped=lr.rows_skipped,
        )
    )
    return lr


def main() -> int:
    setup_logging()
    run_id = start_run()
    print(f"run_id: {run_id}")

    _header("Pre-load counts")
    pre = _pre_counts()
    for t, c in pre.items():
        print(f"  {t:25s}: {c}")

    # Build shared resolvers; prefetch once.
    _header("Priming resolvers")
    with get_conn() as conn:
        supplier_resolver = SupplierResolver(conn)
        po_resolver = POResolver(conn)
        supplier_resolver.prefetch()
        po_resolver.prefetch()
        print(
            f"  suppliers: codes={len(supplier_resolver._by_code)} "
            f"names={len(supplier_resolver._by_name)}"
        )
        print(
            f"  pos      : keys={len(po_resolver._by_key)} "
            f"distinct_numbers={len(po_resolver._latest)}"
        )

    # Run each file
    _header("Pipeline")
    results: Dict[str, LoadResult] = {}
    failed = 0
    for doc_type, file_name, parser_mod, loader_mod in PIPELINE:
        r = _run_one(
            doc_type,
            file_name,
            parser_mod,
            loader_mod,
            run_id=run_id,
            supplier_resolver=supplier_resolver,
            po_resolver=po_resolver,
        )
        if r is None:
            failed += 1
        else:
            results[doc_type] = r

    _header("Post-load counts")
    post = _pre_counts()
    for t in pre.keys():
        delta = post[t] - pre[t]
        arrow = "+" if delta >= 0 else ""
        print(f"  {t:25s}: {pre[t]:>10} -> {post[t]:>10}  ({arrow}{delta})")

    _header("Supplier resolver stats")
    print(f"  {supplier_resolver.stats}")

    total_processed = sum(r.rows_processed for r in results.values())
    total_inserted = sum(r.rows_inserted for r in results.values())
    total_updated = sum(r.rows_updated for r in results.values())
    total_skipped = sum(r.rows_skipped for r in results.values())

    status = RUN_STATUS_SUCCESS
    if failed > 0:
        status = RUN_STATUS_FAILED if len(results) == 0 else RUN_STATUS_PARTIAL

    finish_run(
        run_id,
        status,
        attachments_processed=len(PIPELINE),
        attachments_succeeded=len(results),
        attachments_failed=failed,
        attachments_skipped=0,
        error_message=None if failed == 0 else f"{failed} file(s) failed",
    )

    _header(f"PHASE 2 SMOKE TEST: {status.upper()}")
    print(
        f"files ok={len(results)}/{len(PIPELINE)}  "
        f"total_processed={total_processed}  "
        f"inserted={total_inserted}  updated={total_updated}  skipped={total_skipped}"
    )
    close_pool()
    return 0 if failed == 0 else (50 if len(results) > 0 else 60)


if __name__ == "__main__":
    sys.exit(main())
