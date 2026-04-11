"""Parser for the Purchase Order Excel file (PO.xls — xlsx content).

Row-per-line layout: each spreadsheet row represents one PO line. Header
fields (unit, po_number, date, amd_no, supplier code/name, terms) are
repeated on every row. The loader groups by (po_number, amd_no).

Column names observed on 2026-04-11 in docs/PO.xls:
    UNIT, REF_UNIT, PFX, PO_NUMBER, DATE, AMD_NO, SUPLR_ID, SUPPLIER_NAME,
    ITEM_ID, DESCRIPTION1, QTY, UNIT_COST, DISC%, TERMS, RAW_MATERIAL,
    PROCESS_DESCRIPTION, NORMS, PROCESS_COST
"""

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
    "unit":                 ["UNIT", "Unit"],
    "ref_unit":             ["REF_UNIT", "Ref Unit", "Ref. Unit"],
    "pfx":                  ["PFX", "Pfx", "Prefix", "PO Pfx"],
    "po_number":            ["PO_NUMBER", "PO NUMBER", "PO No", "PO No.", "PO Number"],
    "date":                 ["DATE", "PO DATE", "Order Date"],
    "amd_no":               ["AMD_NO", "AMD No", "Amd. No", "AMD NO"],
    "suplr_id":             ["SUPLR_ID", "Supplier Code", "Supplier", "SUPLR ID"],
    "supplier_name":        ["SUPPLIER_NAME", "Supplier Name", "SUPPLIER NAME"],
    "item_id":              ["ITEM_ID", "Item Id", "Item ID", "Item Code", "ITEM ID"],
    "description1":         ["DESCRIPTION1", "Description 1", "Item Desc", "Item Description"],
    "qty":                  ["QTY", "Quantity", "Order Qty"],
    "unit_cost":            ["UNIT_COST", "UNIT COST", "Unit Cost", "Rate", "Price"],
    "disc_pct":             ["DISC%", "DISC %", "Disc %", "Discount %"],
    "terms":                ["TERMS", "Terms", "Payment Terms"],
    "raw_material":         ["RAW_MATERIAL", "Raw Material"],
    "process_description":  ["PROCESS_DESCRIPTION", "Process Description"],
    "norms":                ["NORMS", "Norms"],
    "process_cost":         ["PROCESS_COST", "Process Cost"],
}

REQUIRED = ("po_number", "date")


def parse(source: PathOrBytes) -> List[Dict[str, Any]]:
    wb = load_workbook_flex(source)
    try:
        ws = select_sheet(wb)
        header_row, col_map = build_header_map(ws, ALIASES, required=REQUIRED)
        log.debug(
            "po parser: header_row=%d columns=%s", header_row, sorted(col_map.keys())
        )
        rows: List[Dict[str, Any]] = []
        for raw in iter_data_rows(ws, header_row, col_map):
            po_number = coerce_str(raw.get("po_number"))
            po_date = coerce_date(raw.get("date"))
            # Skip rows without the two mandatory identifiers
            if not po_number or po_date is None:
                continue
            rows.append(
                {
                    "unit":                coerce_str(raw.get("unit"), max_len=50),
                    "ref_unit":            coerce_str(raw.get("ref_unit"), max_len=50),
                    "pfx":                 coerce_str(raw.get("pfx"), max_len=50),
                    "po_number":           po_number[:50],
                    "date":                po_date,
                    "amd_no":              coerce_int(raw.get("amd_no")) or 0,
                    "suplr_id":            coerce_str(raw.get("suplr_id"), max_len=50),
                    "supplier_name":       coerce_str(raw.get("supplier_name"), max_len=255),
                    "item_id":             coerce_str(raw.get("item_id"), max_len=50),
                    "description1":        coerce_str(raw.get("description1")),
                    "qty":                 coerce_decimal(raw.get("qty")),
                    "unit_cost":           coerce_decimal(raw.get("unit_cost")),
                    "disc_pct":            coerce_decimal(raw.get("disc_pct")),
                    "terms":               coerce_str(raw.get("terms")),
                    "raw_material":        coerce_str(raw.get("raw_material")),
                    "process_description": coerce_str(raw.get("process_description")),
                    "norms":               coerce_str(raw.get("norms")),
                    "process_cost":        coerce_decimal(raw.get("process_cost")),
                }
            )
    finally:
        wb.close()
    return rows
