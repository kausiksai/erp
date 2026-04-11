"""Parser for DC.xls (Delivery Challans)."""

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
    "unit":             ["UNIT", "Unit"],
    "unit_description": ["UNIT DESCRIPTION", "Unit Description"],
    "item":             ["ITEM", "Item"],
    "rev":              ["REV", "REV.", "Rev", "Rev."],
    "item_description": ["ITEM DESCRIPTION", "Item Description"],
    "uom":              ["UOM"],
    "supplier":         ["SUPPLIER", "Supplier"],
    "supplier_name":    ["SUPPLIER NAME", "Supplier Name"],
    "dc_no":            ["DC NO", "DC NO.", "DC No", "DC No."],
    "dc_line":          ["DC LINE", "DC Line"],
    "dc_pfx":           ["DC PFX", "DC PFX.", "DC Pfx"],
    "ord_no":           ["ORDER NO", "ORDER NO.", "Order No"],
    "ord_type":         ["ORDER TYPE", "Order Type"],
    "source":           ["SOURCE", "Source"],
    "sf_code":          ["SF CODE", "SF Code"],
    "dc_qty":           ["TRANSACTION QTY", "TRANSACTION QTY.", "Transaction Qty"],
    "dc_date":          ["TRANSACTION DATE", "Transaction Date", "DC Date"],
    "grn_pfx":          ["GRN PFX", "GRN PFX.", "GRN Pfx", "GRN Pfx."],
    "grn_no":           ["GRN NO", "GRN NO.", "GRN No", "GRN No."],
    "open_order_pfx":   ["Open order pfx", "Open order pfx.", "OPEN ORDER PFX"],
    "open_order_no":    ["Open order no", "Open order no.", "OPEN ORDER NO"],
    "material_type":    ["Material type", "MATERIAL TYPE"],
    "line_no":          ["LINE NO", "LINE NO.", "Line No"],
    "temp_qty":         ["TEMP QTY", "TEMP. QTY.", "Temp Qty"],
    "received_qty":     ["RECEIVED QTY", "RECEIVED QTY.", "Received Qty"],
    "suplr_dc_no":      ["SUPLR DC NO", "SUPLR. DC NO.", "SUPLR DC NO."],
    "suplr_dc_date":    ["SUPLR DC DATE", "SUPLR. DC DATE", "SUPLR DC DATE."],
    "received_item":    ["RECEIVED ITEM"],
    "received_item_rev": ["RECEIVED ITEM REV", "RECEIVED ITEM REV."],
    "received_item_uom": ["RECEIVED ITEM UOM"],
}

REQUIRED = ("dc_no",)


def parse(source: PathOrBytes) -> List[Dict[str, Any]]:
    wb = load_workbook_flex(source)
    try:
        ws = select_sheet(wb)
        header_row, col_map = build_header_map(ws, ALIASES, required=REQUIRED)
        log.debug("dc parser: header_row=%d columns=%d", header_row, len(col_map))
        rows: List[Dict[str, Any]] = []
        for raw in iter_data_rows(ws, header_row, col_map):
            dc_no = coerce_str(raw.get("dc_no"), max_len=50)
            if not dc_no:
                continue
            rows.append(
                {
                    "unit":               coerce_str(raw.get("unit"), max_len=50),
                    "unit_description":   coerce_str(raw.get("unit_description"), max_len=255),
                    "item":               coerce_str(raw.get("item"), max_len=50),
                    "rev":                coerce_int(raw.get("rev")),
                    "description":        coerce_str(raw.get("item_description")),
                    "uom":                coerce_str(raw.get("uom"), max_len=50),
                    "supplier":           coerce_str(raw.get("supplier"), max_len=50),
                    "name":               coerce_str(raw.get("supplier_name"), max_len=255),
                    "dc_no":              dc_no,
                    "dc_line":            coerce_int(raw.get("dc_line")),
                    "dc_pfx":             coerce_str(raw.get("dc_pfx"), max_len=50),
                    "ord_no":             coerce_str(raw.get("ord_no"), max_len=50),
                    "ord_type":           coerce_str(raw.get("ord_type"), max_len=50),
                    "source":             coerce_str(raw.get("source"), max_len=100),
                    "sf_code":            coerce_str(raw.get("sf_code"), max_len=50),
                    "dc_qty":             coerce_decimal(raw.get("dc_qty")),
                    "dc_date":            coerce_date(raw.get("dc_date")),
                    "grn_pfx":            coerce_str(raw.get("grn_pfx"), max_len=50),
                    "grn_no":             coerce_str(raw.get("grn_no"), max_len=50),
                    "open_order_pfx":     coerce_str(raw.get("open_order_pfx"), max_len=50),
                    "open_order_no":      coerce_str(raw.get("open_order_no"), max_len=50),
                    "material_type":      coerce_str(raw.get("material_type"), max_len=100),
                    "line_no":            coerce_int(raw.get("line_no")),
                    "temp_qty":           coerce_decimal(raw.get("temp_qty")),
                    "received_qty":       coerce_decimal(raw.get("received_qty")),
                    "suplr_dc_no":        coerce_str(raw.get("suplr_dc_no"), max_len=100),
                    "suplr_dc_date":      coerce_date(raw.get("suplr_dc_date")),
                    "received_item":      coerce_str(raw.get("received_item"), max_len=100),
                    "received_item_rev":  coerce_str(raw.get("received_item_rev"), max_len=50),
                    "received_item_uom":  coerce_str(raw.get("received_item_uom"), max_len=50),
                }
            )
    finally:
        wb.close()
    return rows
