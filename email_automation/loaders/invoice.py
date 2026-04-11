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

import logging
import time
from typing import Any, Dict, List, Sequence, Tuple
from uuid import UUID

from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import execute_values

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

    # -- Step 2: filter invoices already present in DB ------------------------
    # Use (supplier_id, invoice_number) uniqueness added in phase 2 migration.
    keys = list({(r["supplier_id"], r["header"]["bill_no"]) for r in resolved})
    existing: set[Tuple[int, str]] = set()
    with conn.cursor() as cur:
        # Postgres does not accept a row-valued ANY array trivially; use a
        # temp-values approach with VALUES ... JOIN for efficiency.
        # For typical daily volume (<5k invoices) a simple IN works fine.
        # We chunk to keep SQL text reasonable.
        chunk = 1000
        for i in range(0, len(keys), chunk):
            sub = keys[i : i + chunk]
            cur.execute(
                "SELECT supplier_id, invoice_number FROM invoices "
                "WHERE (supplier_id, invoice_number) IN %s",
                (tuple(sub),),
            )
            for sid, num in cur.fetchall():
                existing.add((sid, num))

    new_invoices = [
        r
        for r in resolved
        if (r["supplier_id"], r["header"]["bill_no"]) not in existing
    ]
    result.rows_skipped = len(resolved) - len(new_invoices)
    result.extras["already_present"] = result.rows_skipped

    if not new_invoices:
        result.duration_seconds = time.time() - t0
        log.info(result.summary())
        return result

    # -- Step 3: insert new invoices (bulk) with RETURNING invoice_id ---------
    header_rows: List[Tuple[Any, ...]] = []
    for r in new_invoices:
        h = r["header"]
        total_amount, tax_amount = _invoice_total(r["lines"])
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
                "email_automation",
                str(run_id),
                # Phase 2.2 additions
                h.get("bill_type"),
                h.get("mode"),
                h.get("doc_entry_date"),
                h.get("grn_date"),
                h.get("po_pfx"),
                h.get("gst_type"),
                h.get("place_of_supply_desc"),
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
