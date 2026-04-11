"""Loader for GRN (Goods Receipt Note).

Full-file refresh: TRUNCATE the table then bulk insert all parsed rows.
`grn` is not referenced by any FK, so TRUNCATE is safe inside a
transaction. Supplier and PO lookups are best-effort via the cached
resolvers; rows whose supplier or PO cannot be resolved are still loaded
with NULL FK columns.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Sequence, Tuple

from psycopg2.extensions import connection as PGConnection

from ._common import LoadResult, POResolver, SupplierResolver, bulk_insert

log = logging.getLogger(__name__)

GRN_COLS = (
    "po_id",
    "supplier_id",
    "unit",
    "unit_desc",
    "ref_unit",
    "territory",
    "ref_unit_desc",
    "dc_no",
    "dc_date",
    "gate_entry_no",
    "gunny_bags",
    "hdpe_bags",
    "gross_weight",
    "tare_weight",
    "nett_weight",
    "supplier_doc_no",
    "supplier_doc_date",
    "grn_pfx",
    "grn_no",
    "grn_line",
    "grn_date",
    "grn_year",
    "grn_period",
    "exchange_rate",
    "supplier",
    "supplier_name",
    "type",
    "pr_type",
    "type_1",
    "item",
    "rev",
    "description_1",
    "uom",
    "unit_cost",
    "grn_qty",
    "disc_amt",
    "tax_amount",
    "receipt_qty_toler",
    "accepted_qty",
    "rejected_qty",
    "return_qty",
    "rework_qty",
    "excess_qty",
    "excess_rtn_qty",
    "invoice_qty",
    "tax",
    "tax_desc",
    "warehouse",
    "warehouse_desc",
    "qc_pfx",
    "qc_no",
    "required_qty",
    "required_date",
    "promise_date",
    "buyer",
    "buyer_name",
    "type_2",
    "process_group",
    "process_desc",
    "class",
    "class_desc",
    "sub_class",
    "sub_class_desc",
    "group_desc",
    "sub_group_desc",
    "po_pfx",
    "po_no",
    "po_line",
    "po_schld",
    "ss_pfx",
    "ss_no",
    "ss_line",
    "open_order_pfx",
    "open_order_no",
    "amd_no",
    "assessable_value",
    "commodity_code",
    "bom_no",
    "prod_ord_no",
    "sf_code",
    "completed_process",
    "test_cert_req",
    "cert_ins",
    "description",
    "bom",
    "reference",
    "work_order_no",
    "task",
    "thickness",
    "length",
    "width",
    "qty_nos",
    "reference_1",
    "header_status",
    "line_status",
    "gst_type",
    "gstin_no",
)


def load(
    conn: PGConnection,
    rows: Sequence[Dict[str, Any]],
    *,
    supplier_resolver: SupplierResolver,
    po_resolver: POResolver,
) -> LoadResult:
    t0 = time.time()
    result = LoadResult(doc_type="grn", rows_processed=len(rows))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE grn RESTART IDENTITY")
        if not rows:
            result.duration_seconds = time.time() - t0
            return result

        values: List[Tuple[Any, ...]] = []
        for r in rows:
            supplier_id = supplier_resolver.resolve(r.get("supplier"), r.get("supplier_name"))
            po_id = po_resolver.resolve(r.get("po_no"), r.get("amd_no"))
            tup = (
                po_id,
                supplier_id,
                r.get("unit"),
                r.get("unit_desc"),
                r.get("ref_unit"),
                r.get("territory"),
                r.get("ref_unit_desc"),
                r.get("dc_no"),
                r.get("dc_date"),
                r.get("gate_entry_no"),
                r.get("gunny_bags"),
                r.get("hdpe_bags"),
                r.get("gross_weight"),
                r.get("tare_weight"),
                r.get("nett_weight"),
                r.get("supplier_doc_no"),
                r.get("supplier_doc_date"),
                r.get("grn_pfx"),
                r.get("grn_no"),
                r.get("grn_line"),
                r.get("grn_date"),
                r.get("grn_year"),
                r.get("grn_period"),
                r.get("exchange_rate"),
                r.get("supplier"),
                r.get("supplier_name"),
                r.get("type"),
                r.get("pr_type"),
                r.get("type_1"),
                r.get("item"),
                r.get("rev"),
                r.get("description_1"),
                r.get("uom"),
                r.get("unit_cost"),
                r.get("grn_qty"),
                r.get("disc_amt"),
                r.get("tax_amount"),
                r.get("receipt_qty_toler"),
                r.get("accepted_qty"),
                r.get("rejected_qty"),
                r.get("return_qty"),
                r.get("rework_qty"),
                r.get("excess_qty"),
                r.get("excess_rtn_qty"),
                r.get("invoice_qty"),
                r.get("tax"),
                r.get("tax_desc"),
                r.get("warehouse"),
                r.get("warehouse_desc"),
                r.get("qc_pfx"),
                r.get("qc_no"),
                r.get("required_qty"),
                r.get("required_date"),
                r.get("promise_date"),
                r.get("buyer"),
                r.get("buyer_name"),
                r.get("type_2"),
                r.get("process_group"),
                r.get("process_desc"),
                r.get("class"),
                r.get("class_desc"),
                r.get("sub_class"),
                r.get("sub_class_desc"),
                r.get("group_desc"),
                r.get("sub_group_desc"),
                r.get("po_pfx"),
                r.get("po_no"),
                r.get("po_line"),
                r.get("po_schld"),
                r.get("ss_pfx"),
                r.get("ss_no"),
                r.get("ss_line"),
                r.get("open_order_pfx"),
                r.get("open_order_no"),
                r.get("amd_no"),
                r.get("assessable_value"),
                r.get("commodity_code"),
                r.get("bom_no"),
                r.get("prod_ord_no"),
                r.get("sf_code"),
                r.get("completed_process"),
                r.get("test_cert_req"),
                r.get("cert_ins"),
                r.get("description"),
                r.get("bom"),
                r.get("reference"),
                r.get("work_order_no"),
                r.get("task"),
                r.get("thickness"),
                r.get("length"),
                r.get("width"),
                r.get("qty_nos"),
                r.get("reference_1"),
                r.get("header_status"),
                r.get("line_status"),
                r.get("gst_type"),
                r.get("gstin_no"),
            )
            values.append(tup)

        bulk_insert(cur, "grn", GRN_COLS, values, page_size=1000)
        result.rows_inserted = len(values)

    result.duration_seconds = time.time() - t0
    log.info(result.summary())
    return result
