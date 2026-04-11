"""Parser for the Bill Register (invoices Excel).

Format notes (observed 2026-04-11 in docs/Bill Register Mar-26.xlsx)
    * 65 columns, each row is one invoice LINE.
    * Header fields (Unit, Supplier, Bill No., Bill Date, PO No., GRN No.)
      are repeated on every row.
    * Invoices are identified by (Unit, Supplier, Bill No.); one invoice
      can have up to 26 lines.
    * The `Type` column distinguishes 'Invoice' rows from 'Debit Note'
      rows; we only emit Invoice rows and count the skipped others.

Output shape
    parse() returns a list of grouped invoices:

        [
            {
                "header": {unit, supplier, supplier_name, bill_no, bill_date,
                           po_pfx, po_no, grn_pfx, grn_no, dc_no, gstin, ...},
                "lines":  [ {item_code, qty, rate, gross_amount, net_amount,
                             tax_amount, cgst_total, sgst_total, igst_total,
                             assessable_value, hsn_code, ...}, ... ],
            },
            ...
        ]

    The caller (invoice loader) is responsible for mapping supplier codes
    to supplier_id, looking up po_id, and inserting into `invoices` /
    `invoice_lines`.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from typing import Any, Dict, List, Tuple

from ._common import (
    PathOrBytes,
    ParseError,
    build_header_map,
    coerce_bool,
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
    "unit":             ["Unit"],
    "doc_pfx":          ["Doc. Pfx", "Doc Pfx", "Doc. Pfx."],
    "doc_no":           ["Doc. No", "Doc No", "Doc. No."],
    "date":             ["Date"],
    "type":             ["Type"],
    "mode":             ["Mode"],
    "supplier":         ["Supplier"],
    "supplier_name":    ["suplr. Name", "Supplier Name", "suplr Name", "suplr. Name."],
    "bill_no":          ["Bill No", "Bill No."],
    "bill_date":        ["Bill Date"],
    "grn_pfx":          ["GRN Pfx", "GRN Pfx."],
    "grn_no":           ["GRN No", "GRN No."],
    "grn_date":         ["GRN Date"],
    "po_pfx":           ["PO / SCO Pfx", "PO / SCO Pfx.", "PO SCO Pfx", "PO/SCO Pfx."],
    "po_no":            ["PO / SCO No", "PO / SCO No.", "PO SCO No"],
    "ss_pfx":           ["SS Pfx", "SS Pfx."],
    "ss_no":            ["SS No"],
    "open_order_pfx":   ["Open Order Pfx", "Open Order Pfx."],
    "open_order_no":    ["Open Order No", "Open Order No."],
    "dc_no":            ["DC No", "DC No."],
    "currency":         ["Curry", "Curry.", "Currency"],
    "exchange_rate":    ["Exchange Rate"],
    "item":             ["Item"],
    "qty":              ["Qty", "Qty."],
    "item_rev":         ["Item Rev", "Item Rev."],
    "item_desc":        ["Item Desc", "Item Desc."],
    "class":            ["Class"],
    "sub_class":        ["Sub Class"],
    "narration":        ["Narration"],
    "price":            ["Price"],
    "bill_amt_bc":      ["Bill Amt(BC)", "Bill Amt(BC).", "Bill Amt BC"],
    "bill_amt_tc":      ["Bill Amt(TC)", "Bill Amt(TC).", "Bill Amt TC"],
    "gross_suplr":      ["Gross Amt.(Suplr. Curry.)", "Gross Amt (Suplr Curry)", "Gross Amt Suplr"],
    "gross_base":       ["Gross Amt.(Base Curry.)", "Gross Amt (Base Curry)", "Gross Amt Base"],
    "net_suplr":        ["Net Amt.(Suplr. Curry.)", "Net Amt (Suplr Curry)", "Net Amt Suplr"],
    "net_base":         ["Net Amt.(Base Curry.)", "Net Amt (Base Curry)", "Net Amt Base"],
    "domestic_amt":     ["Domestic Amt", "Domestic Amt."],
    "import_amt":       ["Import Amt", "Import Amt."],
    "hsn_code":         ["HSN Code"],
    "gstin":            ["GSTIN"],
    "aic_type":         ["AIC Type"],
    "assbl_val":        ["Assbl.Val", "Assbl Val", "Assessable Value", "Assbl. Val"],
    "gst_type":         ["GST Type"],
    "gst_classification": ["GST Classification"],
    "rcm_flag":         ["RCM Flag"],
    "gst_supply_type":  ["GST Supply Type"],
    "non_gst_flag":     ["Non GST Flag"],
    "place_of_supply":  ["Place of Supply"],
    "description":      ["Description"],
    "uom":              ["UOM"],
    "uom_description":  ["UOM Description"],
    "grn_tax_amt":      ["GRN Tax Amt", "GRN Tax Amt."],
    "tax_amt":          ["Tax Amt", "Tax Amt."],
    "cgst_total":       ["CGST Total"],
    "sgst_total":       ["SGST Total"],
    "igst_total":       ["IGST Total"],
    "cgst_rcm_total":   ["CGSTRCM Total", "CGST RCM Total"],
    "sgst_rcm_total":   ["SGSTRCM Total", "SGST RCM Total"],
    "igst_rcm_total":   ["IGSTRCM Total", "IGST RCM Total"],
    # Individual slab columns — parsed so the loader can verify which rate
    # was applied when reconciling CGST/SGST/IGST per line.
    "sgst9":            ["SGST9"],
    "igst18":           ["IGST18"],
    "sgst2_5":          ["SGST2.5"],
    "igst5":            ["IGST5"],
    "cgst9":            ["CGST9"],
    "cgst2_5":          ["CGST2.5"],
}

REQUIRED = ("bill_no", "bill_date", "supplier")


def _infer_rate_pct(tax_amount, assbl_val) -> Any:
    """Given a CGST/SGST/IGST amount and the assessable value, return the
    apparent rate as a Decimal, or None. Used by the loader to fill
    cgst_rate / sgst_rate / igst_rate columns."""
    if tax_amount is None or assbl_val is None:
        return None
    if assbl_val == 0:
        return None
    try:
        return (tax_amount / assbl_val) * 100
    except (ArithmeticError, TypeError):
        return None


def parse(source: PathOrBytes) -> List[Dict[str, Any]]:
    wb = load_workbook_flex(source)
    try:
        ws = select_sheet(wb)
        header_row, col_map = build_header_map(ws, ALIASES, required=REQUIRED)
        log.debug(
            "invoice parser: header_row=%d columns=%d", header_row, len(col_map)
        )

        grouped: "OrderedDict[Tuple[Any, Any, Any], Dict[str, Any]]" = OrderedDict()
        skipped_non_invoice = 0
        skipped_incomplete = 0

        for raw in iter_data_rows(ws, header_row, col_map):
            row_type = coerce_str(raw.get("type"))
            if row_type is not None and row_type.lower() != "invoice":
                skipped_non_invoice += 1
                continue

            unit = coerce_str(raw.get("unit"), max_len=50)
            supplier = coerce_str(raw.get("supplier"), max_len=50)
            bill_no = coerce_str(raw.get("bill_no"))
            if not (unit and supplier and bill_no):
                skipped_incomplete += 1
                continue
            bill_date = coerce_date(raw.get("bill_date"))
            if bill_date is None:
                skipped_incomplete += 1
                continue

            key = (unit, supplier, bill_no)
            invoice = grouped.get(key)
            if invoice is None:
                invoice = {
                    "header": {
                        "unit":            unit,
                        "doc_pfx":         coerce_str(raw.get("doc_pfx"), max_len=50),
                        "doc_no":          coerce_str(raw.get("doc_no")),
                        "doc_entry_date":  coerce_date(raw.get("date")),
                        "bill_type":       row_type,
                        "mode":            coerce_str(raw.get("mode"), max_len=50),
                        "supplier":        supplier,
                        "supplier_name":   coerce_str(raw.get("supplier_name"), max_len=255),
                        "bill_no":         bill_no,
                        "bill_date":       bill_date,
                        "grn_pfx":         coerce_str(raw.get("grn_pfx"), max_len=50),
                        "grn_no":          coerce_str(raw.get("grn_no"), max_len=50),
                        "grn_date":        coerce_date(raw.get("grn_date")),
                        "dc_no":           coerce_str(raw.get("dc_no"), max_len=50),
                        "po_pfx":          coerce_str(raw.get("po_pfx"), max_len=50),
                        "po_no":           coerce_str(raw.get("po_no"), max_len=50),
                        "ss_pfx":          coerce_str(raw.get("ss_pfx"), max_len=50),
                        "ss_no":           coerce_str(raw.get("ss_no"), max_len=50),
                        "open_order_pfx":  coerce_str(raw.get("open_order_pfx"), max_len=50),
                        "open_order_no":   coerce_str(raw.get("open_order_no"), max_len=50),
                        "currency":        coerce_str(raw.get("currency"), max_len=10),
                        "exchange_rate":   coerce_decimal(raw.get("exchange_rate")),
                        "gstin":           coerce_str(raw.get("gstin"), max_len=20),
                        "aic_type":        coerce_str(raw.get("aic_type"), max_len=50),
                        "gst_type":        coerce_str(raw.get("gst_type"), max_len=50),
                        "gst_classification": coerce_str(raw.get("gst_classification"), max_len=50),
                        "rcm_flag":        coerce_bool(raw.get("rcm_flag")),
                        "gst_supply_type": coerce_str(raw.get("gst_supply_type"), max_len=50),
                        "non_gst_flag":    coerce_bool(raw.get("non_gst_flag")),
                        "place_of_supply": coerce_str(raw.get("place_of_supply"), max_len=50),
                        "place_of_supply_desc": coerce_str(raw.get("description")),
                    },
                    "lines": [],
                }
                grouped[key] = invoice

            assbl_val = coerce_decimal(raw.get("assbl_val"))
            cgst_total = coerce_decimal(raw.get("cgst_total"))
            sgst_total = coerce_decimal(raw.get("sgst_total"))
            igst_total = coerce_decimal(raw.get("igst_total"))

            line = {
                "item_code":          coerce_str(raw.get("item"), max_len=50),
                "item_rev":           coerce_str(raw.get("item_rev"), max_len=10),
                "item_name":          coerce_str(raw.get("item_desc")),
                "item_class":         coerce_str(raw.get("class"), max_len=50),
                "item_sub_class":     coerce_str(raw.get("sub_class"), max_len=50),
                "narration":          coerce_str(raw.get("narration")),
                "uom":                coerce_str(raw.get("uom"), max_len=50),
                "uom_description":    coerce_str(raw.get("uom_description"), max_len=255),
                "hsn_sac":            coerce_str(raw.get("hsn_code"), max_len=20),
                "billed_qty":         coerce_decimal(raw.get("qty")),
                "rate":               coerce_decimal(raw.get("price")),
                "gross_amount":       coerce_decimal(raw.get("gross_base")),
                "gross_amount_suplr": coerce_decimal(raw.get("gross_suplr")),
                "net_amount":         coerce_decimal(raw.get("net_base")),
                "net_amount_suplr":   coerce_decimal(raw.get("net_suplr")),
                "line_total":         coerce_decimal(raw.get("bill_amt_bc")),
                "bill_amt_tc":        coerce_decimal(raw.get("bill_amt_tc")),
                "domestic_amt":       coerce_decimal(raw.get("domestic_amt")),
                "import_amt":         coerce_decimal(raw.get("import_amt")),
                "assessable_value":   assbl_val,
                "taxable_value":      assbl_val,
                "grn_tax_amount":     coerce_decimal(raw.get("grn_tax_amt")),
                "cgst_amount":        cgst_total,
                "sgst_amount":        sgst_total,
                "igst_amount":        igst_total,
                "total_tax_amount":   coerce_decimal(raw.get("tax_amt")),
                "cgst_rcm_amount":    coerce_decimal(raw.get("cgst_rcm_total")),
                "sgst_rcm_amount":    coerce_decimal(raw.get("sgst_rcm_total")),
                "igst_rcm_amount":    coerce_decimal(raw.get("igst_rcm_total")),
                "cgst_rate":          _infer_rate_pct(cgst_total, assbl_val),
                "sgst_rate":          _infer_rate_pct(sgst_total, assbl_val),
                "igst_rate":          _infer_rate_pct(igst_total, assbl_val),
                # Individual GST slab breakdowns from the Bill Register
                "cgst_9_amount":      coerce_decimal(raw.get("cgst9")),
                "cgst_2_5_amount":    coerce_decimal(raw.get("cgst2_5")),
                "sgst_9_amount":      coerce_decimal(raw.get("sgst9")),
                "sgst_2_5_amount":    coerce_decimal(raw.get("sgst2_5")),
                "igst_18_amount":     coerce_decimal(raw.get("igst18")),
                "igst_5_amount":      coerce_decimal(raw.get("igst5")),
            }
            invoice["lines"].append(line)

        result = list(grouped.values())
        log.info(
            "invoice parser: invoices=%d lines=%d skipped_non_invoice=%d skipped_incomplete=%d",
            len(result),
            sum(len(inv["lines"]) for inv in result),
            skipped_non_invoice,
            skipped_incomplete,
        )
        return result
    finally:
        wb.close()
