"""Loader for the Bill Register (invoices).

Design
    * The Bill Register is a multi-invoice file. Each group is identified
      by (unit, supplier_id, invoice_number).
    * Dedup key on the DB side is the UNIQUE(supplier_id, invoice_number)
      constraint added in phase 2 migration. The loader treats
      ON CONFLICT as "invoice already exists; do not overwrite lines"
      because overwriting would wipe any validation state the previous run
      already captured.
    * New invoices land with status='waiting_for_validation', source=
      'email_automation', and `bill_register_run_id` set to the current
      automation run. Phase 3's validation sweep will pick them up.
    * Returns per-invoice new/skipped counts so the orchestrator can log
      them.
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple
from uuid import UUID

from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import Json, execute_values

from ._common import LoadResult, POResolver, SupplierResolver

log = logging.getLogger(__name__)

INVOICE_COLS = (
    "invoice_number",
    "invoice_date",
    "supplier_id",
    "po_id",
    "po_number",
    "total_amount",
    "tax_amount",
    "status",
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
    # Phase 2.2 additions
    "bill_type",
    "mode",
    "doc_entry_date",
    "grn_date",
    "po_pfx",
    "gst_type",
    "place_of_supply_desc",
    # Phase 3 — dual-source reconciliation
    "excel_snapshot",
    "excel_received_at",
    "reconciliation_status",
)

INVOICE_LINE_COLS = (
    "invoice_id",
    "po_id",
    "item_name",
    "item_code",
    "item_rev",
    "narration",
    "hsn_sac",
    "uom",
    "billed_qty",
    "rate",
    "line_total",
    "taxable_value",
    "assessable_value",
    "gross_amount",
    "net_amount",
    "cgst_rate",
    "cgst_amount",
    "sgst_rate",
    "sgst_amount",
    "igst_rate",
    "igst_amount",
    "cgst_rcm_amount",
    "sgst_rcm_amount",
    "igst_rcm_amount",
    "total_tax_amount",
    "sequence_number",
    # Phase 2.2 additions
    "item_class",
    "item_sub_class",
    "uom_description",
    "grn_tax_amount",
    "bill_amt_tc",
    "gross_amount_suplr",
    "net_amount_suplr",
    "domestic_amt",
    "import_amt",
    "cgst_9_amount",
    "cgst_2_5_amount",
    "sgst_9_amount",
    "sgst_2_5_amount",
    "igst_18_amount",
    "igst_5_amount",
)


def _invoice_total(lines: Sequence[Dict[str, Any]]) -> Tuple[Any, Any]:
    total = None
    tax = None
    for ln in lines:
        lt = ln.get("line_total") or ln.get("net_amount")
        if lt is not None:
            total = (total or 0) + lt
        tt = ln.get("total_tax_amount")
        if tt is not None:
            tax = (tax or 0) + tt
    return total, tax


# ----------------------------------------------------------------------------
# Dual-source reconciliation — excel_snapshot builder.
# ----------------------------------------------------------------------------
# Mirrors the shape produced by backend/src/reconcile.js `buildExcelSnapshot`
# so the Node comparator can treat both JSONB snapshots symmetrically. Kept
# in lock-step with the JS version; if you add a field there, add it here too.
# ----------------------------------------------------------------------------

_GSTIN_STRIP = re.compile(r"[^A-Z0-9]")


def _norm_id(v: Any) -> Optional[str]:
    if v is None or v == "":
        return None
    s = _GSTIN_STRIP.sub("", str(v).upper())
    return s or None


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v) if v == v else None  # NaN check
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(str(v).replace(",", "").replace("\u20b9", "").strip())
    except (ValueError, TypeError):
        return None


def _iso_date(v: Any) -> Optional[str]:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    return s[:10] if s else None


def _sum_lines(lines: Sequence[Dict[str, Any]], *keys: str) -> Optional[float]:
    total = 0.0
    found = False
    for ln in lines:
        for k in keys:
            v = _num(ln.get(k))
            if v is not None:
                total += v
                found = True
                break
    return round(total, 2) if found else None


def _build_excel_snapshot(
    header: Dict[str, Any], lines: Sequence[Dict[str, Any]]
) -> Dict[str, Any]:
    cgst = _sum_lines(lines, "cgst_amount") or 0.0
    sgst = _sum_lines(lines, "sgst_amount") or 0.0
    igst = _sum_lines(lines, "igst_amount") or 0.0
    tax_total = cgst + sgst + igst
    return {
        "invoice_number": header.get("bill_no") or header.get("invoice_number"),
        "invoice_date": _iso_date(header.get("bill_date") or header.get("invoice_date")),
        "supplier_gstin": _norm_id(header.get("gstin")),
        "supplier_name": header.get("supplier_name"),
        "po_number": header.get("po_no") or header.get("po_number"),
        "subtotal": _sum_lines(lines, "taxable_value", "assessable_value"),
        "cgst": round(cgst, 2) if cgst else None,
        "sgst": round(sgst, 2) if sgst else None,
        "igst": round(igst, 2) if igst else None,
        "tax_amount": round(tax_total, 2) if tax_total else None,
        "total_amount": _sum_lines(lines, "line_total", "net_amount"),
        "line_items": [
            {
                "sequence": i + 1,
                "item_name": ln.get("item_name"),
                "hsn_sac": ln.get("hsn_sac"),
                "quantity": _num(ln.get("billed_qty")),
                "uom": ln.get("uom"),
                "rate": _num(ln.get("rate")),
                "taxable_value": _num(ln.get("taxable_value") or ln.get("assessable_value")),
                "cgst_amount": _num(ln.get("cgst_amount")),
                "sgst_amount": _num(ln.get("sgst_amount")),
                "igst_amount": _num(ln.get("igst_amount")),
                "line_total": _num(ln.get("line_total") or ln.get("net_amount")),
            }
            for i, ln in enumerate(lines)
        ],
    }


def load(
    conn: PGConnection,
    invoices: Sequence[Dict[str, Any]],
    *,
    supplier_resolver: SupplierResolver,
    po_resolver: POResolver,
    run_id: UUID,
) -> LoadResult:
    t0 = time.time()
    result = LoadResult(doc_type="invoice", rows_processed=len(invoices))

    if not invoices:
        result.duration_seconds = time.time() - t0
        return result

    # -- Step 1: resolve supplier_id + po_id per invoice ----------------------
    resolved: List[Dict[str, Any]] = []
    skipped_no_supplier = 0
    for inv in invoices:
        h = inv["header"]
        supplier_id = supplier_resolver.resolve(h.get("supplier"), h.get("supplier_name"))
        if supplier_id is None:
            skipped_no_supplier += 1
            continue
        po_id = po_resolver.resolve(h.get("po_no"))
        resolved.append(
            {
                "header": h,
                "supplier_id": supplier_id,
                "po_id": po_id,
                "lines": inv["lines"],
            }
        )

    result.extras["skipped_no_supplier"] = skipped_no_supplier

    if not resolved:
        result.duration_seconds = time.time() - t0
        return result

    # -- Step 2: split into (new, ocr-first merge, already-complete) ---------
    # Dual-source world: a row may already exist because the portal uploaded
    # an OCR'd PDF before the Excel arrived. For those we must UPDATE the
    # existing row with excel_snapshot (and flip source to 'both') rather
    # than skip. Rows that already have excel_snapshot are genuinely done.
    keys = list({(r["supplier_id"], r["header"]["bill_no"]) for r in resolved})
    existing: Dict[Tuple[int, str], Dict[str, Any]] = {}
    with conn.cursor() as cur:
        chunk = 1000
        for i in range(0, len(keys), chunk):
            sub = keys[i : i + chunk]
            cur.execute(
                "SELECT invoice_id, supplier_id, invoice_number, excel_snapshot "
                "FROM invoices WHERE (supplier_id, invoice_number) IN %s",
                (tuple(sub),),
            )
            for inv_id, sid, num, excel_snap in cur.fetchall():
                existing[(sid, num)] = {
                    "invoice_id": inv_id,
                    "has_excel": excel_snap is not None,
                }

    new_invoices: List[Dict[str, Any]] = []
    merge_invoices: List[Dict[str, Any]] = []  # OCR-first rows: just add excel_snapshot
    for r in resolved:
        key = (r["supplier_id"], r["header"]["bill_no"])
        meta = existing.get(key)
        if meta is None:
            new_invoices.append(r)
        elif not meta["has_excel"]:
            r["_existing_invoice_id"] = meta["invoice_id"]
            merge_invoices.append(r)
        # else: already has excel_snapshot → genuinely skip

    already_present = sum(1 for r in resolved if existing.get(
        (r["supplier_id"], r["header"]["bill_no"])
    ) and existing[(r["supplier_id"], r["header"]["bill_no"])]["has_excel"])
    result.rows_skipped = already_present
    result.extras["already_present"] = already_present
    result.extras["merged_into_ocr_rows"] = len(merge_invoices)

    # -- Step 2a: merge path — update OCR-first rows with excel_snapshot ------
    if merge_invoices:
        with conn.cursor() as cur:
            for r in merge_invoices:
                snapshot = _build_excel_snapshot(r["header"], r["lines"])
                cur.execute(
                    """
                    UPDATE invoices
                       SET excel_snapshot        = %s,
                           excel_received_at     = NOW(),
                           source                = 'both',
                           reconciliation_status = 'pending_reconciliation',
                           bill_register_run_id  = %s,
                           updated_at            = NOW()
                     WHERE invoice_id = %s
                    """,
                    (Json(snapshot), str(run_id), r["_existing_invoice_id"]),
                )

    if not new_invoices:
        result.duration_seconds = time.time() - t0
        log.info(result.summary())
        return result

    # -- Step 3: insert new invoices (bulk) with RETURNING invoice_id ---------
    header_rows: List[Tuple[Any, ...]] = []
    for r in new_invoices:
        h = r["header"]
        total_amount, tax_amount = _invoice_total(r["lines"])
        excel_snapshot = _build_excel_snapshot(h, r["lines"])
        header_rows.append(
            (
                h["bill_no"],
                h["bill_date"],
                r["supplier_id"],
                r["po_id"],
                h.get("po_no"),
                total_amount,
                tax_amount,
                "waiting_for_validation",
                h.get("unit"),
                h.get("doc_pfx"),
                h.get("doc_no"),
                h.get("grn_pfx"),
                h.get("grn_no"),
                h.get("dc_no"),
                h.get("ss_pfx"),
                h.get("ss_no"),
                h.get("open_order_pfx"),
                h.get("open_order_no"),
                h.get("gstin"),
                h.get("rcm_flag") or False,
                h.get("place_of_supply"),
                h.get("gst_classification"),
                h.get("gst_supply_type"),
                h.get("non_gst_flag") or False,
                h.get("aic_type"),
                h.get("currency"),
                h.get("exchange_rate"),
                # source: 'excel' is the reconciliation vocabulary; legacy
                # 'email_automation' rows are migrated by migration_invoice_reconciliation.sql.
                "excel",
                str(run_id),
                # Phase 2.2 additions
                h.get("bill_type"),
                h.get("mode"),
                h.get("doc_entry_date"),
                h.get("grn_date"),
                h.get("po_pfx"),
                h.get("gst_type"),
                h.get("place_of_supply_desc"),
                # Phase 3 — dual-source reconciliation
                Json(excel_snapshot),
                datetime.utcnow(),
                "single_source",
            )
        )

    with conn.cursor() as cur:
        col_list = ", ".join(f'"{c}"' for c in INVOICE_COLS)
        sql = (
            f"INSERT INTO invoices ({col_list}) VALUES %s "
            "RETURNING invoice_id, supplier_id, invoice_number"
        )
        returned = execute_values(cur, sql, header_rows, page_size=500, fetch=True)
        id_map: Dict[Tuple[int, str], int] = {
            (row[1], row[2]): row[0] for row in returned
        }
        result.rows_inserted = len(returned)

        # -- Step 4: bulk insert invoice_lines --------------------------------
        line_values: List[Tuple[Any, ...]] = []
        for r in new_invoices:
            key = (r["supplier_id"], r["header"]["bill_no"])
            invoice_id = id_map.get(key)
            if invoice_id is None:
                # Should never happen; we just inserted it. Defensive skip.
                log.warning("invoice id missing after insert for %s", key)
                continue
            for seq, ln in enumerate(r["lines"], start=1):
                line_values.append(
                    (
                        invoice_id,
                        r["po_id"],
                        ln.get("item_name"),
                        ln.get("item_code"),
                        ln.get("item_rev"),
                        ln.get("narration"),
                        ln.get("hsn_sac"),
                        ln.get("uom"),
                        ln.get("billed_qty"),
                        ln.get("rate"),
                        ln.get("line_total"),
                        ln.get("taxable_value"),
                        ln.get("assessable_value"),
                        ln.get("gross_amount"),
                        ln.get("net_amount"),
                        ln.get("cgst_rate"),
                        ln.get("cgst_amount"),
                        ln.get("sgst_rate"),
                        ln.get("sgst_amount"),
                        ln.get("igst_rate"),
                        ln.get("igst_amount"),
                        ln.get("cgst_rcm_amount"),
                        ln.get("sgst_rcm_amount"),
                        ln.get("igst_rcm_amount"),
                        ln.get("total_tax_amount"),
                        seq,
                        # Phase 2.2 additions
                        ln.get("item_class"),
                        ln.get("item_sub_class"),
                        ln.get("uom_description"),
                        ln.get("grn_tax_amount"),
                        ln.get("bill_amt_tc"),
                        ln.get("gross_amount_suplr"),
                        ln.get("net_amount_suplr"),
                        ln.get("domestic_amt"),
                        ln.get("import_amt"),
                        ln.get("cgst_9_amount"),
                        ln.get("cgst_2_5_amount"),
                        ln.get("sgst_9_amount"),
                        ln.get("sgst_2_5_amount"),
                        ln.get("igst_18_amount"),
                        ln.get("igst_5_amount"),
                    )
                )
        if line_values:
            line_col_list = ", ".join(f'"{c}"' for c in INVOICE_LINE_COLS)
            execute_values(
                cur,
                f"INSERT INTO invoice_lines ({line_col_list}) VALUES %s",
                line_values,
                page_size=1000,
            )
        result.extras["lines_inserted"] = len(line_values)

    result.duration_seconds = time.time() - t0
    log.info(result.summary())
    return result
