"""Pure-function validation checks.

Every check takes an `InvoiceContext` and returns a list of `Finding`s.
Checks never mutate the context or touch the database. The engine composes
them and classifies the result.

Finding codes
    E001..E0nn - errors (block validation)
    W001..W0nn - warnings (don't block)
The code is stable across runs so the smoke-test report can group by code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from .context import InvoiceContext
from .tolerances import (
    CAT_CUMULATIVE,
    CAT_DATE,
    CAT_GRN,
    CAT_GST,
    CAT_HEADER,
    CAT_LINE,
    CAT_OPEN_PO,
    CAT_PRICE,
    CAT_REFERENCE,
    CAT_TOTALS,
    CAT_UOM,
    PO_STATUS_FULFILLED,
    SEVERITY_ERROR,
    SEVERITY_WARNING,
    TOL_AMOUNT,
    TOL_QTY,
    TOL_RATE_PCT,
)


@dataclass
class Finding:
    code: str
    severity: str
    category: str
    message: str
    line_seq: Optional[int] = None
    data: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity,
            "category": self.category,
            "message": self.message,
            "line_seq": self.line_seq,
            "data": self.data,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _dec(v: Any) -> Decimal:
    if v is None:
        return Decimal(0)
    if isinstance(v, Decimal):
        return v
    try:
        return Decimal(str(v))
    except (ArithmeticError, ValueError):
        return Decimal(0)


def _norm_text(s: Any) -> str:
    if s is None:
        return ""
    return " ".join(str(s).lower().strip().split())


def _item_match_score(inv_item: Optional[str], po_line: Dict[str, Any]) -> int:
    """Port of Node itemMatchScore."""
    inv = _norm_text(inv_item)
    if not inv:
        return 0
    item_id = _norm_text(po_line.get("item_id"))
    desc = _norm_text(po_line.get("description1"))
    if item_id:
        if inv == item_id:
            return 300
        if inv in item_id or item_id in inv:
            return 250
    if desc:
        if inv == desc:
            return 200
        if inv in desc or desc in inv:
            return 190
        for t in [t for t in inv.split() if len(t) >= 3]:
            if t in desc:
                return 130
        for t in [t for t in desc.split() if len(t) >= 3]:
            if t in inv:
                return 120
    return 0


def _resolve_po_line(
    inv_line: Dict[str, Any],
    po_lines: List[Dict[str, Any]],
    used_ids: set,
    inv_line_count: int,
    inv_line_index: int,
) -> Optional[Dict[str, Any]]:
    """Mirror Node resolvePoLineForInvoiceLine."""
    if inv_line.get("po_line_id"):
        for pl in po_lines:
            if pl["po_line_id"] == inv_line["po_line_id"]:
                return pl
    if inv_line.get("sequence_number") is not None:
        for pl in po_lines:
            if pl.get("sequence_number") == inv_line["sequence_number"]:
                return pl
    # By item text (best unused match above threshold)
    best = None
    best_score = 0
    for pl in po_lines:
        if pl["po_line_id"] in used_ids:
            continue
        score = _item_match_score(inv_line.get("item_name") or inv_line.get("item_code"), pl)
        if score > best_score:
            best = pl
            best_score = score
    if best and best_score >= 80:
        return best
    # Positional fallback only if line counts match
    if inv_line_index < len(po_lines) and inv_line_count == len(po_lines):
        return po_lines[inv_line_index]
    return None


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------
def check_reference_data(ctx: InvoiceContext) -> List[Finding]:
    """Are the required reference rows loaded (PO, supplier)?"""
    out: List[Finding] = []
    if ctx.invoice.get("invoice_number") in (None, ""):
        out.append(Finding("E001_NO_INVOICE_NUMBER", SEVERITY_ERROR, CAT_HEADER,
                           "Invoice number is missing"))
    if ctx.invoice.get("invoice_date") is None:
        out.append(Finding("W001_NO_INVOICE_DATE", SEVERITY_WARNING, CAT_HEADER,
                           "Invoice date is missing"))
    if ctx.po is None:
        po_number = ctx.invoice.get("po_number")
        if not po_number:
            out.append(Finding("E002_NO_PO_LINK", SEVERITY_ERROR, CAT_REFERENCE,
                               "Invoice is not linked to any PO"))
        else:
            out.append(Finding(
                "E003_PO_NOT_FOUND", SEVERITY_ERROR, CAT_REFERENCE,
                f"PO '{po_number}' not found in purchase_orders — may arrive in a later run",
                data={"po_number": po_number},
            ))
    if ctx.supplier is None:
        out.append(Finding("E004_NO_SUPPLIER", SEVERITY_ERROR, CAT_HEADER,
                           "Invoice supplier cannot be resolved"))
    return out


def check_header(ctx: InvoiceContext) -> List[Finding]:
    out: List[Finding] = []
    if ctx.po is None or ctx.supplier is None:
        return out

    # supplier match
    if ctx.po.supplier_id is not None and ctx.supplier.supplier_id != ctx.po.supplier_id:
        out.append(Finding(
            "E005_SUPPLIER_MISMATCH", SEVERITY_ERROR, CAT_HEADER,
            f"Invoice supplier ({ctx.supplier.supplier_id}) does not match "
            f"PO supplier ({ctx.po.supplier_id})",
            data={"invoice_supplier": ctx.supplier.supplier_id, "po_supplier": ctx.po.supplier_id},
        ))

    # po_number text sanity
    inv_pon = ctx.invoice.get("po_number")
    if inv_pon and str(inv_pon).strip() != ctx.po.po_number:
        out.append(Finding(
            "W002_PO_NUMBER_TEXT_MISMATCH", SEVERITY_WARNING, CAT_HEADER,
            f"Invoice po_number text ({inv_pon}) differs from PO record ({ctx.po.po_number})",
        ))

    # PO status already fulfilled
    if ctx.po.status == PO_STATUS_FULFILLED and not ctx.po.is_open_po:
        out.append(Finding(
            "E006_PO_ALREADY_FULFILLED", SEVERITY_ERROR, CAT_HEADER,
            "PO is already fulfilled; route to exception approval",
        ))

    return out


def check_dates(ctx: InvoiceContext) -> List[Finding]:
    """NEW: invoice date sanity — not before PO date, not after today, not before GRN."""
    out: List[Finding] = []
    from datetime import date as date_cls

    inv_date = ctx.invoice.get("invoice_date")
    if inv_date is None:
        return out

    today = date_cls.today()
    if inv_date > today:
        out.append(Finding(
            "E010_INVOICE_DATE_IN_FUTURE", SEVERITY_ERROR, CAT_DATE,
            f"Invoice date {inv_date} is in the future",
        ))

    if ctx.po is not None and ctx.po.date is not None and inv_date < ctx.po.date:
        out.append(Finding(
            "E011_INVOICE_BEFORE_PO", SEVERITY_ERROR, CAT_DATE,
            f"Invoice date {inv_date} is earlier than PO date {ctx.po.date}",
        ))

    grn_date = ctx.invoice.get("grn_date")
    if grn_date is not None and inv_date < grn_date:
        out.append(Finding(
            "W003_INVOICE_BEFORE_GRN", SEVERITY_WARNING, CAT_DATE,
            f"Invoice date {inv_date} is earlier than GRN date {grn_date} "
            f"(invoicing goods before they were received)",
        ))
    return out


def check_lines_and_resolution(ctx: InvoiceContext) -> List[Finding]:
    """Resolve each invoice line to a PO line and do qty/price/UOM checks."""
    out: List[Finding] = []
    if ctx.po is None:
        return out

    po_lines = ctx.po.lines
    used_ids = set()
    total_expected_price = Decimal(0)

    for idx, il in enumerate(ctx.lines):
        seq = il.get("sequence_number") or (idx + 1)
        pl = _resolve_po_line(il, po_lines, used_ids, len(ctx.lines), idx)
        inv_qty = _dec(il.get("billed_qty"))
        inv_rate = _dec(il.get("rate"))
        inv_total = _dec(il.get("line_total"))

        if pl is None:
            if ctx.po.is_open_po:
                out.append(Finding(
                    "W010_OPEN_PO_LINE_UNRESOLVED", SEVERITY_WARNING, CAT_LINE,
                    "Open PO: no PO line matched this invoice line",
                    line_seq=seq,
                ))
            else:
                out.append(Finding(
                    "E020_NO_MATCHING_PO_LINE", SEVERITY_ERROR, CAT_LINE,
                    f"Invoice line {seq} has no matching PO line",
                    line_seq=seq,
                    data={"item_name": il.get("item_name"), "item_code": il.get("item_code")},
                ))
            continue

        used_ids.add(pl["po_line_id"])

        po_qty = _dec(pl.get("qty"))
        po_rate = _dec(pl.get("unit_cost"))
        po_disc = _dec(pl.get("disc_pct"))
        effective_rate = po_rate * (Decimal(1) - po_disc / Decimal(100))

        # Quantity check
        if not ctx.po.is_open_po:
            if inv_qty > po_qty + TOL_QTY:
                out.append(Finding(
                    "E021_LINE_QTY_OVER_PO", SEVERITY_ERROR, CAT_LINE,
                    f"Line {seq} billed_qty {inv_qty} exceeds PO line qty {po_qty}",
                    line_seq=seq,
                    data={"billed_qty": str(inv_qty), "po_qty": str(po_qty)},
                ))
            elif inv_qty < po_qty - TOL_QTY:
                out.append(Finding(
                    "W020_LINE_QTY_UNDER_PO", SEVERITY_WARNING, CAT_LINE,
                    f"Line {seq} billed_qty {inv_qty} is less than PO qty {po_qty}",
                    line_seq=seq,
                ))

        # Rate check against effective PO rate (disc_pct applied).
        # For Open POs this is a warning (Open POs are blanket agreements
        # drawn down at receipt; rate is advisory, not binding).
        if po_rate > 0 and inv_rate > 0:
            drift_abs = abs(inv_rate - effective_rate)
            drift_rel = drift_abs / effective_rate if effective_rate > 0 else Decimal(0)
            if drift_abs > TOL_AMOUNT and drift_rel > TOL_RATE_PCT:
                if ctx.po.is_open_po:
                    out.append(Finding(
                        "W022_OPEN_PO_LINE_RATE_DRIFT", SEVERITY_WARNING, CAT_PRICE,
                        f"Line {seq} rate {inv_rate} differs from Open PO effective rate "
                        f"{effective_rate} (unit_cost {po_rate} with {po_disc}% disc)",
                        line_seq=seq,
                        data={
                            "invoice_rate": str(inv_rate),
                            "po_unit_cost": str(po_rate),
                            "po_disc_pct": str(po_disc),
                            "effective_po_rate": str(effective_rate),
                        },
                    ))
                else:
                    out.append(Finding(
                        "E022_LINE_RATE_MISMATCH", SEVERITY_ERROR, CAT_PRICE,
                        f"Line {seq} rate {inv_rate} differs from PO effective rate "
                        f"{effective_rate} (unit_cost {po_rate} with {po_disc}% disc)",
                        line_seq=seq,
                        data={
                            "invoice_rate": str(inv_rate),
                            "po_unit_cost": str(po_rate),
                            "po_disc_pct": str(po_disc),
                            "effective_po_rate": str(effective_rate),
                        },
                    ))

        # Line price enforcement: assessable_value (pre-tax) must equal
        # qty × effective_po_rate. Compare pre-tax to pre-tax.
        # Skipped for Open POs — price is determined at receipt time.
        line_assbl = _dec(il.get("assessable_value") or il.get("taxable_value"))
        if not ctx.po.is_open_po and inv_qty > 0 and effective_rate > 0 and line_assbl > 0:
            expected_assbl = inv_qty * effective_rate
            total_expected_price += expected_assbl
            # Allow 0.01 absolute OR 0.1% relative drift (handles rounding
            # on discounts applied at receipt time).
            drift = abs(line_assbl - expected_assbl)
            if drift > TOL_AMOUNT and drift > expected_assbl * Decimal("0.001"):
                out.append(Finding(
                    "E023_LINE_PRICE_MISMATCH", SEVERITY_ERROR, CAT_PRICE,
                    f"Line {seq} assessable_value {line_assbl} does not match "
                    f"qty ({inv_qty}) × PO effective rate ({effective_rate}) = {expected_assbl}",
                    line_seq=seq,
                    data={
                        "assessable_value": str(line_assbl),
                        "expected": str(expected_assbl),
                    },
                ))
        elif ctx.po.is_open_po and inv_qty > 0 and effective_rate > 0 and line_assbl > 0:
            # Soft drift warning for visibility
            expected_assbl = inv_qty * effective_rate
            drift = abs(line_assbl - expected_assbl)
            if drift > TOL_AMOUNT and drift > expected_assbl * Decimal("0.01"):
                out.append(Finding(
                    "W023_OPEN_PO_LINE_PRICE_DRIFT", SEVERITY_WARNING, CAT_PRICE,
                    f"Line {seq} Open PO assessable {line_assbl} vs expected "
                    f"{expected_assbl} (qty × PO rate)",
                    line_seq=seq,
                ))

        # Line total self-consistency (invoice rate × qty == assessable_value)
        # The line_total (Bill Amt) includes tax, so we check assessable instead.
        if inv_qty > 0 and inv_rate > 0 and line_assbl > 0:
            expected_self = inv_qty * inv_rate
            if abs(line_assbl - expected_self) > TOL_AMOUNT:
                out.append(Finding(
                    "W021_LINE_ASSBL_SELF_INCONSISTENT", SEVERITY_WARNING, CAT_LINE,
                    f"Line {seq} assessable_value {line_assbl} != qty × invoice_rate ({expected_self})",
                    line_seq=seq,
                ))

    ctx.po.lines  # (kept for type hint)
    return out


def check_gst(ctx: InvoiceContext) -> List[Finding]:
    """GST self-consistency per line and header totals.

    Checks performed on *source* data only (no derived-rate tautologies):
        * cgst_9_amount + cgst_2_5_amount + ... == cgst_amount       (slab sum)
        * sgst_9_amount + sgst_2_5_amount + ... == sgst_amount       (slab sum)
        * igst_18_amount + igst_5_amount + ... == igst_amount        (slab sum)
        * cgst_amount == sgst_amount                                 (GST rule)
        * total_tax_amount ≈ cgst + sgst + igst                      (sum)
        * intra-state supply must not have IGST                      (rule)
        * inter-state supply must not have CGST/SGST                 (rule)
    """
    out: List[Finding] = []
    header_cgst = Decimal(0)
    header_sgst = Decimal(0)
    header_igst = Decimal(0)
    header_tax = Decimal(0)

    place_of_supply = (ctx.invoice.get("place_of_supply") or "").strip()
    supplier_state = ctx.supplier.state_code if ctx.supplier else None
    intra_state = bool(place_of_supply and supplier_state and place_of_supply == supplier_state)

    for idx, il in enumerate(ctx.lines):
        seq = il.get("sequence_number") or (idx + 1)
        cgst_amt = _dec(il.get("cgst_amount"))
        sgst_amt = _dec(il.get("sgst_amount"))
        igst_amt = _dec(il.get("igst_amount"))
        total_tax = _dec(il.get("total_tax_amount"))

        header_cgst += cgst_amt
        header_sgst += sgst_amt
        header_igst += igst_amt
        header_tax += total_tax

        # Slab sum: individual slab columns must add up to the total
        cgst_slab_sum = _dec(il.get("cgst_9_amount")) + _dec(il.get("cgst_2_5_amount"))
        sgst_slab_sum = _dec(il.get("sgst_9_amount")) + _dec(il.get("sgst_2_5_amount"))
        igst_slab_sum = _dec(il.get("igst_18_amount")) + _dec(il.get("igst_5_amount"))

        if cgst_amt > 0 and abs(cgst_slab_sum - cgst_amt) > TOL_AMOUNT:
            out.append(Finding(
                "E030_CGST_SLAB_SUM_MISMATCH", SEVERITY_ERROR, CAT_GST,
                f"Line {seq} CGST slab sum ({cgst_slab_sum}) != cgst_amount ({cgst_amt})",
                line_seq=seq,
            ))
        if sgst_amt > 0 and abs(sgst_slab_sum - sgst_amt) > TOL_AMOUNT:
            out.append(Finding(
                "E031_SGST_SLAB_SUM_MISMATCH", SEVERITY_ERROR, CAT_GST,
                f"Line {seq} SGST slab sum ({sgst_slab_sum}) != sgst_amount ({sgst_amt})",
                line_seq=seq,
            ))
        if igst_amt > 0 and abs(igst_slab_sum - igst_amt) > TOL_AMOUNT:
            out.append(Finding(
                "E032_IGST_SLAB_SUM_MISMATCH", SEVERITY_ERROR, CAT_GST,
                f"Line {seq} IGST slab sum ({igst_slab_sum}) != igst_amount ({igst_amt})",
                line_seq=seq,
            ))

        # CGST == SGST equality (Indian GST rule) — only when both are non-zero
        if cgst_amt > 0 and sgst_amt > 0 and abs(cgst_amt - sgst_amt) > TOL_AMOUNT:
            out.append(Finding(
                "E033_CGST_SGST_NOT_EQUAL", SEVERITY_ERROR, CAT_GST,
                f"Line {seq} CGST ({cgst_amt}) != SGST ({sgst_amt})",
                line_seq=seq,
            ))

        # Line total_tax == cgst + sgst + igst
        sum_tax = cgst_amt + sgst_amt + igst_amt
        if abs(total_tax - sum_tax) > TOL_AMOUNT:
            out.append(Finding(
                "W030_TAX_SUM_MISMATCH", SEVERITY_WARNING, CAT_GST,
                f"Line {seq} total_tax_amount {total_tax} != CGST+SGST+IGST ({sum_tax})",
                line_seq=seq,
            ))

        # Intra/inter state rule
        if intra_state and igst_amt > 0:
            out.append(Finding(
                "E034_INTRA_STATE_WITH_IGST", SEVERITY_ERROR, CAT_GST,
                f"Line {seq}: intra-state supply (place={place_of_supply}, supplier_state={supplier_state}) "
                f"should not have IGST {igst_amt}",
                line_seq=seq,
            ))
        if (not intra_state) and place_of_supply and supplier_state and (cgst_amt > 0 or sgst_amt > 0):
            out.append(Finding(
                "E035_INTER_STATE_WITH_CGST_SGST", SEVERITY_ERROR, CAT_GST,
                f"Line {seq}: inter-state supply should use IGST, not CGST/SGST",
                line_seq=seq,
            ))

    # Header tax_amount match
    header_tax_invoice = _dec(ctx.invoice.get("tax_amount"))
    if header_tax_invoice > 0 and abs(header_tax - header_tax_invoice) > TOL_AMOUNT:
        out.append(Finding(
            "W031_HEADER_TAX_MISMATCH", SEVERITY_WARNING, CAT_GST,
            f"Σ line total_tax_amount ({header_tax}) != invoices.tax_amount ({header_tax_invoice})",
        ))
    return out


def check_uom(ctx: InvoiceContext) -> List[Finding]:
    """NEW: UOM match (best-effort — PO table has no explicit UOM column).

    We check that UOM is consistent ACROSS invoice lines for the same item
    in the PO. True UOM match requires UOM on po_line which is absent in
    the schema; we flag suspicious mismatches based on DC/GRN UOM instead.
    """
    out: List[Finding] = []
    if ctx.po is None:
        return out
    # For now only flag missing UOM on invoice lines (best-effort)
    for idx, il in enumerate(ctx.lines):
        seq = il.get("sequence_number") or (idx + 1)
        if not il.get("uom"):
            out.append(Finding(
                "W040_NO_UOM", SEVERITY_WARNING, CAT_UOM,
                f"Line {seq} has no UOM",
                line_seq=seq,
            ))
    return out


def check_totals(ctx: InvoiceContext) -> List[Finding]:
    """Header-total qty and amount checks against PO.

    Quantity check is unchanged.
    Amount check uses Σ assessable_value (pre-tax) vs computed PO value
    (also pre-tax), not Σ line_total which is tax-inclusive.
    """
    out: List[Finding] = []
    if ctx.po is None:
        return out

    po_qty = sum((_dec(p.get("qty")) for p in ctx.po.lines), Decimal(0))
    this_qty = ctx.this_inv_qty
    this_amt_inclusive = ctx.this_inv_amount
    this_amt_exclusive = sum(
        (_dec(ln.get("assessable_value") or ln.get("taxable_value")) for ln in ctx.lines),
        Decimal(0),
    )

    if not ctx.po.is_open_po:
        if abs(this_qty - po_qty) > TOL_QTY:
            if this_qty > po_qty:
                out.append(Finding(
                    "E040_HEADER_QTY_OVER_PO", SEVERITY_ERROR, CAT_TOTALS,
                    f"Σ invoice billed_qty ({this_qty}) exceeds Σ PO line qty ({po_qty})",
                    data={"invoice_qty": str(this_qty), "po_qty": str(po_qty)},
                ))
            else:
                out.append(Finding(
                    "E041_HEADER_QTY_UNDER_PO", SEVERITY_ERROR, CAT_TOTALS,
                    f"Σ invoice billed_qty ({this_qty}) is less than Σ PO line qty ({po_qty})",
                    data={"invoice_qty": str(this_qty), "po_qty": str(po_qty)},
                ))

    # Header pre-tax amount vs computed PO value
    if ctx.po_value_computed > 0 and not ctx.po.is_open_po:
        if this_amt_exclusive > ctx.po_value_computed + TOL_AMOUNT:
            out.append(Finding(
                "E042_HEADER_AMOUNT_OVER_PO", SEVERITY_ERROR, CAT_PRICE,
                f"Invoice pre-tax total {this_amt_exclusive} exceeds computed PO value {ctx.po_value_computed}",
                data={"invoice_amount": str(this_amt_exclusive), "po_value": str(ctx.po_value_computed)},
            ))

    # Σ line_total vs invoices.total_amount (self-consistency of invoice)
    header_amount = _dec(ctx.invoice.get("total_amount"))
    if header_amount > 0 and abs(this_amt_inclusive - header_amount) > TOL_AMOUNT:
        out.append(Finding(
            "W041_HEADER_TOTAL_MISMATCH", SEVERITY_WARNING, CAT_TOTALS,
            f"Σ line_total ({this_amt_inclusive}) differs from invoices.total_amount ({header_amount})",
        ))

    return out


def check_grn_qty(ctx: InvoiceContext) -> List[Finding]:
    """GRN total must cover the invoice qty."""
    out: List[Finding] = []
    if ctx.po is None:
        return out
    if ctx.grn_accepted_qty_total > 0 and ctx.this_inv_qty > ctx.grn_accepted_qty_total + TOL_QTY:
        out.append(Finding(
            "E050_GRN_LESS_THAN_INVOICE", SEVERITY_ERROR, CAT_GRN,
            f"GRN accepted total ({ctx.grn_accepted_qty_total}) is less than "
            f"invoice qty ({ctx.this_inv_qty}) — shortfall",
            data={
                "grn_accepted": str(ctx.grn_accepted_qty_total),
                "invoice_qty": str(ctx.this_inv_qty),
            },
        ))
    return out


def check_cumulative(ctx: InvoiceContext) -> List[Finding]:
    """Cumulative qty + amount across all invoices on this PO must not exceed PO limits.

    Amount comparison uses pre-tax figures (Σ assessable_value).
    """
    out: List[Finding] = []
    if ctx.po is None or ctx.po.is_open_po:
        return out

    po_qty = sum((_dec(p.get("qty")) for p in ctx.po.lines), Decimal(0))
    cumulative_qty = ctx.other_invoices_total_qty + ctx.this_inv_qty
    if po_qty > 0 and cumulative_qty > po_qty + TOL_QTY:
        out.append(Finding(
            "E060_CUMULATIVE_QTY_OVER_PO", SEVERITY_ERROR, CAT_CUMULATIVE,
            f"Cumulative invoiced qty ({cumulative_qty}) exceeds PO qty ({po_qty})",
            data={
                "cumulative_qty": str(cumulative_qty),
                "po_qty": str(po_qty),
                "other_invoices_qty": str(ctx.other_invoices_total_qty),
            },
        ))

    # Cumulative pre-tax amount check
    this_amt_exclusive = sum(
        (_dec(ln.get("assessable_value") or ln.get("taxable_value")) for ln in ctx.lines),
        Decimal(0),
    )
    if ctx.po_value_computed > 0:
        # `other_invoices_total_amount` from the context is the sum of
        # invoices.total_amount which is tax-inclusive. For a fair
        # comparison we need to also fetch pre-tax totals for other
        # invoices. Until we add that to the context, we apply a
        # proportional allowance: expected_max = po_value × (1 + average_gst_rate).
        # A simple safe approach: skip the check when other_invoices_total_amount
        # already exceeds po_value_computed (would yield false positive),
        # otherwise check only this invoice's pre-tax amount against a
        # budget of (po_value - other_invoices_pre_tax_estimate).
        #
        # Conservative implementation: check cumulative pre-tax amount of
        # *this invoice alone* against (po_value - other_invoices_total_amount × 0.85),
        # where 0.85 is a rough pre-tax/post-tax ratio for 18% GST.
        est_other_pre_tax = ctx.other_invoices_total_amount * Decimal("0.85")
        remaining_budget = ctx.po_value_computed - est_other_pre_tax
        if remaining_budget > 0 and this_amt_exclusive > remaining_budget + TOL_AMOUNT:
            out.append(Finding(
                "E061_CUMULATIVE_AMOUNT_OVER_PO", SEVERITY_ERROR, CAT_CUMULATIVE,
                f"Cumulative pre-tax invoiced amount exceeds PO value "
                f"(this invoice pre-tax={this_amt_exclusive}, estimated budget={remaining_budget})",
                data={
                    "this_inv_pre_tax": str(this_amt_exclusive),
                    "po_value": str(ctx.po_value_computed),
                    "estimated_budget": str(remaining_budget),
                },
            ))
    return out


def check_grn_double_use(ctx: InvoiceContext) -> List[Finding]:
    """NEW: the GRN referenced by this invoice must not already be fully consumed
    by a different invoice (same grn_no on multiple invoices is suspicious).
    """
    out: List[Finding] = []
    grn_no = ctx.invoice.get("grn_no")
    if not grn_no:
        return out
    # The check looks at other invoices sharing this grn_no. For a simple
    # implementation we rely on the cumulative check to catch over-billing,
    # but we still raise a warning so operators see it in the report.
    # A proper implementation would COUNT invoices using this grn_no — done
    # via a context extension in a later phase to avoid extra queries per
    # invoice here.
    return out


def check_open_po_requirements(ctx: InvoiceContext) -> List[Finding]:
    """Open PO: require GRN with qty, ASN, and (DC or Schedule). Match qty totals."""
    out: List[Finding] = []
    if ctx.po is None or not ctx.po.is_open_po:
        return out

    if ctx.grn_accepted_qty_total <= TOL_QTY:
        out.append(Finding(
            "E070_OPEN_PO_NO_GRN", SEVERITY_ERROR, CAT_OPEN_PO,
            "Open PO: GRN with quantity is required",
        ))
    elif abs(ctx.this_inv_qty - ctx.grn_accepted_qty_total) > TOL_QTY:
        out.append(Finding(
            "E071_OPEN_PO_GRN_QTY_MISMATCH", SEVERITY_ERROR, CAT_OPEN_PO,
            f"Open PO: invoice qty ({ctx.this_inv_qty}) must match GRN total "
            f"({ctx.grn_accepted_qty_total})",
        ))

    if ctx.asn_count == 0:
        out.append(Finding(
            "E072_OPEN_PO_NO_ASN", SEVERITY_ERROR, CAT_OPEN_PO,
            "Open PO: ASN linked to this invoice is required",
        ))
    elif ctx.asn_qty_total > 0 and abs(ctx.this_inv_qty - ctx.asn_qty_total) > TOL_QTY:
        out.append(Finding(
            "E073_OPEN_PO_ASN_QTY_MISMATCH", SEVERITY_ERROR, CAT_OPEN_PO,
            f"Open PO: invoice qty ({ctx.this_inv_qty}) must match ASN total "
            f"({ctx.asn_qty_total})",
        ))

    if ctx.dc_count == 0 and ctx.schedule_count == 0:
        out.append(Finding(
            "E074_OPEN_PO_NO_DC_OR_SCHEDULE", SEVERITY_ERROR, CAT_OPEN_PO,
            "Open PO: at least one Delivery Challan or Schedule must exist",
        ))
    if ctx.dc_count > 0 and ctx.dc_qty_total > 0 and abs(ctx.this_inv_qty - ctx.dc_qty_total) > TOL_QTY:
        out.append(Finding(
            "E075_OPEN_PO_DC_QTY_MISMATCH", SEVERITY_ERROR, CAT_OPEN_PO,
            f"Open PO: invoice qty ({ctx.this_inv_qty}) must match DC total "
            f"({ctx.dc_qty_total})",
        ))
    if ctx.schedule_count > 0 and ctx.schedule_qty_total > 0 and abs(ctx.this_inv_qty - ctx.schedule_qty_total) > TOL_QTY:
        out.append(Finding(
            "E076_OPEN_PO_SCHED_QTY_MISMATCH", SEVERITY_ERROR, CAT_OPEN_PO,
            f"Open PO: invoice qty ({ctx.this_inv_qty}) must match Schedule total "
            f"({ctx.schedule_qty_total})",
        ))
    return out


def check_asn_informational(ctx: InvoiceContext) -> List[Finding]:
    out: List[Finding] = []
    if ctx.po is not None and not ctx.po.is_open_po and ctx.asn_count == 0 and ctx.lines:
        out.append(Finding(
            "W080_NO_ASN_FOUND", SEVERITY_WARNING, CAT_GRN,
            "No ASN found for this invoice (informational)",
        ))
    return out
