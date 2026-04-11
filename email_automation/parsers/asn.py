"""Parser for ASN.xls (Advanced Shipping Notice)."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from ._common import (
    PathOrBytes,
    build_header_map,
    coerce_date,
    coerce_decimal,
    coerce_str,
    iter_data_rows,
    load_workbook_flex,
    select_sheet,
)

log = logging.getLogger(__name__)

ALIASES = {
    "unit":           ["Unit"],
    "asn_no":         ["ANC No", "ANC No.", "ASN No", "ASN No."],
    "supplier":       ["Supplier Code", "Supplier"],
    "supplier_name":  ["Supplier Name"],
    "inv_no":         ["Invoice No", "Invoice No.", "Inv No"],
    "inv_date":       ["Invoice Date", "Inv Date"],
    "dc_no":          ["DC No", "DC No."],
    "dc_date":        ["DC Date"],
    "item_code":      ["Item Code"],
    "item_desc":      ["Item Desc", "Item Desc.", "Item Description"],
    "quantity":       ["Quantity", "Qty"],
    "po_pfx":         ["PO PFX", "PO PFX.", "PO Pfx", "PO Pfx."],
    "po_no":          ["PO No", "PO No."],
    "schedule_pfx":   ["Schedule PFX", "Schedule Pfx"],
    "schedule_no":    ["Schedule No", "Schedule No."],
    "status":         ["Status"],
    "grn_status":     ["GRN Status"],
}

REQUIRED = ("asn_no",)


def parse(source: PathOrBytes) -> List[Dict[str, Any]]:
    wb = load_workbook_flex(source)
    try:
        ws = select_sheet(wb)
        header_row, col_map = build_header_map(ws, ALIASES, required=REQUIRED)
        log.debug("asn parser: header_row=%d columns=%d", header_row, len(col_map))

        # asn table columns we populate. Note that asn has no FK to invoices —
        # the schema comment says the join is inv_no -> invoices.invoice_number.
        rows: List[Dict[str, Any]] = []
        for raw in iter_data_rows(ws, header_row, col_map):
            asn_no = coerce_str(raw.get("asn_no"), max_len=50)
            if not asn_no:
                continue
            # Compose doc_no_date from dc + date if present (preserves the
            # existing asn.doc_no_date column semantics)
            inv_no = coerce_str(raw.get("inv_no"), max_len=50)
            inv_date = coerce_date(raw.get("inv_date"))
            rows.append(
                {
                    "asn_no":           asn_no,
                    "supplier":         coerce_str(raw.get("supplier"), max_len=50),
                    "supplier_name":    coerce_str(raw.get("supplier_name"), max_len=255),
                    "dc_no":            coerce_str(raw.get("dc_no"), max_len=50),
                    "dc_date":          coerce_date(raw.get("dc_date")),
                    "inv_no":           inv_no,
                    "inv_date":         inv_date,
                    "lr_no":            None,
                    "lr_date":          None,
                    "unit":             coerce_str(raw.get("unit"), max_len=50),
                    "transporter":      None,
                    "transporter_name": None,
                    "doc_no_date":      None,
                    "status":           coerce_str(raw.get("status"), max_len=50),
                    # --- not in asn table but kept for audit / potential future columns ---
                    "item_code":        coerce_str(raw.get("item_code"), max_len=50),
                    "item_desc":        coerce_str(raw.get("item_desc")),
                    "quantity":         coerce_decimal(raw.get("quantity")),
                    "po_pfx":           coerce_str(raw.get("po_pfx"), max_len=50),
                    "po_no":            coerce_str(raw.get("po_no"), max_len=50),
                    "schedule_pfx":     coerce_str(raw.get("schedule_pfx"), max_len=50),
                    "schedule_no":      coerce_str(raw.get("schedule_no"), max_len=50),
                    "grn_status":       coerce_str(raw.get("grn_status"), max_len=50),
                }
            )
    finally:
        wb.close()
    return rows
