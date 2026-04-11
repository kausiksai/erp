"""Loader for ASN (Advanced Shipping Notice).

TRUNCATE + bulk INSERT. ASN has no FK linkage, so the table rebuilds cleanly
every run.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Sequence, Tuple

from psycopg2.extensions import connection as PGConnection

from ._common import LoadResult, POResolver, SupplierResolver, bulk_insert

log = logging.getLogger(__name__)

ASN_COLS = (
    "asn_no",
    "supplier",
    "supplier_name",
    "dc_no",
    "dc_date",
    "inv_no",
    "inv_date",
    "lr_no",
    "lr_date",
    "unit",
    "transporter",
    "transporter_name",
    "doc_no_date",
    "status",
    # Phase 2.1 additions: every ASN.xls column is now persisted.
    "item_code",
    "item_desc",
    "quantity",
    "po_pfx",
    "po_no",
    "schedule_pfx",
    "schedule_no",
    "grn_status",
)


def load(
    conn: PGConnection,
    rows: Sequence[Dict[str, Any]],
    *,
    supplier_resolver: SupplierResolver,  # not used but kept for uniform signature
    po_resolver: POResolver,
) -> LoadResult:
    t0 = time.time()
    result = LoadResult(doc_type="asn", rows_processed=len(rows))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE asn RESTART IDENTITY")
        if not rows:
            result.duration_seconds = time.time() - t0
            return result

        values: List[Tuple[Any, ...]] = []
        for r in rows:
            values.append(
                (
                    r.get("asn_no"),
                    r.get("supplier"),
                    r.get("supplier_name"),
                    r.get("dc_no"),
                    r.get("dc_date"),
                    r.get("inv_no"),
                    r.get("inv_date"),
                    r.get("lr_no"),
                    r.get("lr_date"),
                    r.get("unit"),
                    r.get("transporter"),
                    r.get("transporter_name"),
                    r.get("doc_no_date"),
                    r.get("status"),
                    # Phase 2.1 additions
                    r.get("item_code"),
                    r.get("item_desc"),
                    r.get("quantity"),
                    r.get("po_pfx"),
                    r.get("po_no"),
                    r.get("schedule_pfx"),
                    r.get("schedule_no"),
                    r.get("grn_status"),
                )
            )
        bulk_insert(cur, "asn", ASN_COLS, values, page_size=1000)
        result.rows_inserted = len(values)

    result.duration_seconds = time.time() - t0
    log.info(result.summary())
    return result
