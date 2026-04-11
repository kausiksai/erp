"""Loader for Purchase Orders.

Strategy
    * Group parsed rows into {(po_number, amd_no): {header, lines}}.
    * Resolve supplier_id for every distinct supplier using SupplierResolver.
    * Bulk UPSERT headers into purchase_orders with ON CONFLICT DO UPDATE
      on (po_number, amd_no). Rows already present are updated in-place;
      rows not present in the incoming file are left alone (amendment
      history is preserved per product decision 2026-04-11).
    * For each upserted po_id, delete existing purchase_order_lines and
      bulk-insert the fresh lines from the file. This keeps the line set
      in sync with the source without orphaning old data.
    * Populates POResolver so downstream loaders can resolve po_id by
      po_number without another query.
"""

from __future__ import annotations

import logging
import time
from collections import OrderedDict
from typing import Any, Dict, List, Sequence, Tuple

from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import execute_values

from ._common import LoadResult, POResolver, SupplierResolver, bulk_insert

log = logging.getLogger(__name__)

PO_HEADER_COLS = (
    "unit",
    "ref_unit",
    "pfx",
    "po_number",
    "date",
    "amd_no",
    "suplr_id",
    "supplier_id",
    "terms",
    "status",
)

PO_LINE_COLS = (
    "po_id",
    "sequence_number",
    "item_id",
    "description1",
    "qty",
    "unit_cost",
    "disc_pct",
    "raw_material",
    "process_description",
    "norms",
    "process_cost",
)


def load(
    conn: PGConnection,
    rows: Sequence[Dict[str, Any]],
    *,
    supplier_resolver: SupplierResolver,
    po_resolver: POResolver,
) -> LoadResult:
    t0 = time.time()
    result = LoadResult(doc_type="po", rows_processed=len(rows))

    if not rows:
        result.duration_seconds = time.time() - t0
        return result

    # -- Step 1: group by (po_number, amd_no) ---------------------------------
    groups: "OrderedDict[Tuple[str, int], Dict[str, Any]]" = OrderedDict()
    for r in rows:
        po_number = r["po_number"]
        amd_no = int(r.get("amd_no") or 0)
        key = (po_number, amd_no)
        grp = groups.get(key)
        if grp is None:
            grp = {
                "header": {
                    "unit":          r.get("unit"),
                    "ref_unit":      r.get("ref_unit"),
                    "pfx":           r.get("pfx"),
                    "po_number":     po_number,
                    "date":          r.get("date"),
                    "amd_no":        amd_no,
                    "suplr_id":      r.get("suplr_id"),
                    "supplier_name": r.get("supplier_name"),
                    "terms":         r.get("terms"),
                },
                "lines": [],
            }
            groups[key] = grp
        grp["lines"].append(r)

    result.extras["headers"] = len(groups)
    result.extras["lines"] = sum(len(g["lines"]) for g in groups.values())

    # -- Step 2: resolve suppliers -------------------------------------------
    for grp in groups.values():
        h = grp["header"]
        h["supplier_id"] = supplier_resolver.resolve(h.get("suplr_id"), h.get("supplier_name"))

    # -- Step 3: upsert headers ----------------------------------------------
    header_values: List[Tuple[Any, ...]] = []
    for grp in groups.values():
        h = grp["header"]
        header_values.append(
            (
                h["unit"],
                h["ref_unit"],
                h["pfx"],
                h["po_number"],
                h["date"],
                h["amd_no"],
                h["suplr_id"],
                h["supplier_id"],
                h["terms"],
                "open",  # status default on upsert
            )
        )

    with conn.cursor() as cur:
        col_list = ", ".join(f'"{c}"' for c in PO_HEADER_COLS)
        sql = (
            f"INSERT INTO purchase_orders ({col_list}) VALUES %s "
            "ON CONFLICT (po_number, amd_no) DO UPDATE SET "
            "unit = EXCLUDED.unit, "
            "ref_unit = EXCLUDED.ref_unit, "
            "pfx = EXCLUDED.pfx, "
            "date = EXCLUDED.date, "
            "suplr_id = EXCLUDED.suplr_id, "
            "supplier_id = EXCLUDED.supplier_id, "
            "terms = EXCLUDED.terms "
            # do NOT overwrite status — preserve fulfilled/open state driven
            # by validation.
            "RETURNING po_id, po_number, amd_no, (xmax = 0) AS inserted"
        )
        returned = execute_values(cur, sql, header_values, page_size=500, fetch=True)
        po_id_by_key: Dict[Tuple[str, int], int] = {}
        inserted = 0
        updated = 0
        for row in returned:
            po_id, po_number, amd_no, was_inserted = row
            po_id_by_key[(po_number, int(amd_no))] = po_id
            po_resolver.record(po_number, int(amd_no), po_id)
            if was_inserted:
                inserted += 1
            else:
                updated += 1

        result.rows_inserted = inserted
        result.rows_updated = updated

        # -- Step 4: refresh purchase_order_lines for these POs --------------
        all_po_ids = list(po_id_by_key.values())
        if all_po_ids:
            cur.execute(
                "DELETE FROM purchase_order_lines WHERE po_id = ANY(%s)",
                (all_po_ids,),
            )

        line_values: List[Tuple[Any, ...]] = []
        for key, grp in groups.items():
            po_id = po_id_by_key[key]
            for seq, ln in enumerate(grp["lines"], start=1):
                # Clamp qty to non-negative to satisfy chk_po_lines_qty
                qty = ln.get("qty")
                if qty is not None and qty < 0:
                    qty = None
                line_values.append(
                    (
                        po_id,
                        seq,
                        ln.get("item_id"),
                        ln.get("description1"),
                        qty,
                        ln.get("unit_cost"),
                        ln.get("disc_pct") or 0,
                        ln.get("raw_material"),
                        ln.get("process_description"),
                        ln.get("norms"),
                        ln.get("process_cost"),
                    )
                )
        if line_values:
            bulk_insert(
                cur,
                "purchase_order_lines",
                PO_LINE_COLS,
                line_values,
                page_size=1000,
            )
        result.extras["lines_inserted"] = len(line_values)

    result.duration_seconds = time.time() - t0
    log.info(result.summary())
    return result
