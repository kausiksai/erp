"""Loader for Delivery Challans.

TRUNCATE + bulk INSERT. Resolves supplier_id and po_id via cached resolvers.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Sequence, Tuple

from psycopg2.extensions import connection as PGConnection

from ._common import LoadResult, POResolver, SupplierResolver, bulk_insert

log = logging.getLogger(__name__)

DC_COLS = (
    "po_id",
    "supplier_id",
    "doc_no",
    "dc_no",
    "dc_date",
    "supplier",
    "name",
    "item",
    "rev",
    "uom",
    "description",
    "sf_code",
    "dc_qty",
    "consumed",
    "in_process",
    "balance",
    "out_days",
    "other_type",
    "ord_type",
    "ord_pfx",
    "ord_no",
    "mi_doc_no",
    "ext_description",
    "unit",
    "unit_description",
    "ref_unit",
    "ref_unit_description",
    "revision",
    "dc_line",
    "dc_pfx",
    "source",
    "grn_pfx",
    "grn_no",
    "open_order_pfx",
    "open_order_no",
    "material_type",
    "line_no",
    "temp_qty",
    "received_qty",
    "suplr_dc_no",
    "suplr_dc_date",
    "received_item",
    "received_item_rev",
    "received_item_uom",
)


def load(
    conn: PGConnection,
    rows: Sequence[Dict[str, Any]],
    *,
    supplier_resolver: SupplierResolver,
    po_resolver: POResolver,
) -> LoadResult:
    t0 = time.time()
    result = LoadResult(doc_type="dc", rows_processed=len(rows))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE delivery_challans RESTART IDENTITY")
        if not rows:
            result.duration_seconds = time.time() - t0
            return result

        values: List[Tuple[Any, ...]] = []
        for r in rows:
            supplier_id = supplier_resolver.resolve(r.get("supplier"), r.get("name"))
            po_id = po_resolver.resolve(r.get("ord_no"))
            values.append(
                (
                    po_id,
                    supplier_id,
                    None,  # doc_no (BIGINT in schema — not in file)
                    r.get("dc_no"),
                    r.get("dc_date"),
                    r.get("supplier"),
                    r.get("name"),
                    r.get("item"),
                    r.get("rev"),
                    r.get("uom"),
                    r.get("description"),
                    r.get("sf_code"),
                    r.get("dc_qty"),
                    None, None, None, None, None,  # consumed/in_process/balance/out_days/other_type
                    r.get("ord_type"),
                    None,  # ord_pfx
                    r.get("ord_no"),
                    None, None,  # mi_doc_no, ext_description
                    r.get("unit"),
                    r.get("unit_description"),
                    None, None, None,  # ref_unit, ref_unit_description, revision
                    r.get("dc_line"),
                    r.get("dc_pfx"),
                    r.get("source"),
                    r.get("grn_pfx"),
                    r.get("grn_no"),
                    r.get("open_order_pfx"),
                    r.get("open_order_no"),
                    r.get("material_type"),
                    r.get("line_no"),
                    r.get("temp_qty"),
                    r.get("received_qty"),
                    r.get("suplr_dc_no"),
                    r.get("suplr_dc_date"),
                    r.get("received_item"),
                    r.get("received_item_rev"),
                    r.get("received_item_uom"),
                )
            )
        bulk_insert(cur, "delivery_challans", DC_COLS, values, page_size=1000)
        result.rows_inserted = len(values)

    result.duration_seconds = time.time() - t0
    log.info(result.summary())
    return result
