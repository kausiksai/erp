"""Loader for PO Schedules (supplier schedules).

TRUNCATE + bulk INSERT into po_schedules. No PO/supplier resolution is
required because the source file does not link schedules back to POs by id
— validation resolves them by po_number / doc_no text.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Sequence, Tuple

from psycopg2.extensions import connection as PGConnection

from ._common import LoadResult, POResolver, SupplierResolver, bulk_insert

log = logging.getLogger(__name__)

SCHEDULE_COLS = (
    "po_id",
    "po_number",
    "ord_pfx",
    "ord_no",
    "schedule_ref",
    "ss_pfx",
    "ss_no",
    "line_no",
    "item_id",
    "description",
    "sched_qty",
    "sched_date",
    "promise_date",
    "required_date",
    "unit",
    "uom",
    "supplier",
    "supplier_name",
    "item_rev",
    "date_from",
    "date_to",
    "firm",
    "tentative",
    "closeshort",
    "doc_pfx",
    "doc_no",
    "status",
)


def load(
    conn: PGConnection,
    rows: Sequence[Dict[str, Any]],
    *,
    supplier_resolver: SupplierResolver,  # unused
    po_resolver: POResolver,  # unused
) -> LoadResult:
    t0 = time.time()
    result = LoadResult(doc_type="schedule", rows_processed=len(rows))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE TABLE po_schedules RESTART IDENTITY")
        if not rows:
            result.duration_seconds = time.time() - t0
            return result

        values: List[Tuple[Any, ...]] = []
        for r in rows:
            values.append(
                (
                    None,  # po_id (resolved at validation time)
                    r.get("po_number"),
                    r.get("ord_pfx"),
                    r.get("ord_no"),
                    r.get("schedule_ref"),
                    r.get("ss_pfx"),
                    r.get("ss_no"),
                    r.get("line_no"),
                    r.get("item_id"),
                    r.get("description"),
                    r.get("sched_qty"),
                    r.get("sched_date"),
                    r.get("promise_date"),
                    r.get("required_date"),
                    r.get("unit"),
                    r.get("uom"),
                    r.get("supplier"),
                    r.get("supplier_name"),
                    r.get("item_rev"),
                    r.get("date_from"),
                    r.get("date_to"),
                    r.get("firm"),
                    r.get("tentative"),
                    r.get("closeshort"),
                    r.get("doc_pfx"),
                    r.get("doc_no"),
                    r.get("status"),
                )
            )
        bulk_insert(cur, "po_schedules", SCHEDULE_COLS, values, page_size=1000)
        result.rows_inserted = len(values)

    result.duration_seconds = time.time() - t0
    log.info(result.summary())
    return result
