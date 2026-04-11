"""Parser for schedule.xls (Supplier Schedule / PO Schedule)."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from ._common import (
    PathOrBytes,
    build_header_map,
    coerce_date,
    coerce_decimal,
    coerce_int,
    coerce_str,
    iter_data_rows,
    load_workbook_flex,
    select_sheet,
)

log = logging.getLogger(__name__)

ALIASES = {
    "line_no":       ["Line", "Line No", "Line No."],
    "unit":          ["Unit"],
    "supplier":      ["Supplier"],
    "supplier_name": ["Supplier Name"],
    "item":          ["Item"],
    "item_rev":      ["Rev", "Rev."],
    "item_desc":     ["Item Desc", "Item Desc."],
    "uom":           ["UOM"],
    "date_from":     ["From"],
    "date_to":       ["To"],
    "firm":          ["Firm"],
    "tentative":     ["Tentative"],
    "closeshort":    ["Closeshort", "Close Short"],
    "doc_pfx":       ["Doc Pfx", "Doc Pfx.", "Doc. Pfx.", "Doc. Pfx"],
    "doc_no":        ["Doc No", "Doc. No.", "Doc No."],
    "status":        ["Status"],
}

REQUIRED = ("doc_no",)


def parse(source: PathOrBytes) -> List[Dict[str, Any]]:
    wb = load_workbook_flex(source)
    try:
        ws = select_sheet(wb)
        header_row, col_map = build_header_map(ws, ALIASES, required=REQUIRED)
        log.debug("schedule parser: header_row=%d columns=%d", header_row, len(col_map))
        rows: List[Dict[str, Any]] = []
        for raw in iter_data_rows(ws, header_row, col_map):
            doc_no = coerce_str(raw.get("doc_no"), max_len=100)
            if not doc_no:
                continue

            # sched_qty semantics: loader/validator uses the 'Firm' column
            # as the scheduled quantity; Tentative and Closeshort are tracked
            # but not used for quantity totals.
            firm = coerce_decimal(raw.get("firm"))
            tentative = coerce_decimal(raw.get("tentative"))
            closeshort = coerce_decimal(raw.get("closeshort"))

            rows.append(
                {
                    "po_number":    None,  # no PO link in this file
                    "ord_pfx":      None,
                    "ord_no":       None,
                    "schedule_ref": None,
                    "ss_pfx":       None,
                    "ss_no":        None,
                    "line_no":      coerce_int(raw.get("line_no")),
                    "item_id":      coerce_str(raw.get("item"), max_len=100),
                    "description":  coerce_str(raw.get("item_desc")),
                    "sched_qty":    firm,
                    "sched_date":   coerce_date(raw.get("date_from")),
                    "promise_date": coerce_date(raw.get("date_to")),
                    "required_date": None,
                    "unit":         coerce_str(raw.get("unit"), max_len=50),
                    "uom":          coerce_str(raw.get("uom"), max_len=50),
                    "supplier":     coerce_str(raw.get("supplier"), max_len=50),
                    "supplier_name": coerce_str(raw.get("supplier_name"), max_len=255),
                    "item_rev":     coerce_str(raw.get("item_rev"), max_len=50),
                    "date_from":    coerce_date(raw.get("date_from")),
                    "date_to":      coerce_date(raw.get("date_to")),
                    "firm":         str(firm) if firm is not None else None,
                    "tentative":    str(tentative) if tentative is not None else None,
                    "closeshort":   str(closeshort) if closeshort is not None else None,
                    "doc_pfx":      coerce_str(raw.get("doc_pfx"), max_len=50),
                    "doc_no":       doc_no,
                    "status":       coerce_str(raw.get("status"), max_len=50),
                }
            )
    finally:
        wb.close()
    return rows
