"""Validation engine — the single orchestrator that turns an invoice into
a ValidationResult.

The engine is a pure function of the `InvoiceContext`: it reads no side
effects and writes no state. The separation from `status_writer` lets us
validate in tests and dry-runs without touching the database.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from psycopg2.extensions import connection as PGConnection

from . import checks
from .checks import Finding
from .context import InvoiceContext, load_invoice_context
from .tolerances import (
    STATUS_EXCEPTION_APPROVAL,
    STATUS_VALIDATED,
    STATUS_WAITING_FOR_RE_VALIDATION,
    STATUS_WAITING_FOR_VALIDATION,
    SEVERITY_ERROR,
)

log = logging.getLogger(__name__)

# Error codes that classify a failure as a SHORTFALL (route to debit note).
# Anything else that's a hard error keeps the invoice in waiting_for_validation
# for human correction (e.g. supplier mismatch, data errors).
SHORTFALL_CODES = {
    "E021_LINE_QTY_OVER_PO",
    "E022_LINE_RATE_MISMATCH",
    "E023_LINE_PRICE_MISMATCH",
    "E040_HEADER_QTY_OVER_PO",
    "E041_HEADER_QTY_UNDER_PO",
    "E042_HEADER_AMOUNT_OVER_PO",
    "E050_GRN_LESS_THAN_INVOICE",
    "E060_CUMULATIVE_QTY_OVER_PO",
    "E061_CUMULATIVE_AMOUNT_OVER_PO",
    "E070_OPEN_PO_NO_GRN",
    "E071_OPEN_PO_GRN_QTY_MISMATCH",
    "E072_OPEN_PO_NO_ASN",
    "E073_OPEN_PO_ASN_QTY_MISMATCH",
    "E074_OPEN_PO_NO_DC_OR_SCHEDULE",
    "E075_OPEN_PO_DC_QTY_MISMATCH",
    "E076_OPEN_PO_SCHED_QTY_MISMATCH",
}

# Errors that mean reference data is still missing — retry next run, don't
# fail the invoice and don't route to debit note.
RETRY_CODES = {"E003_PO_NOT_FOUND"}


@dataclass
class ValidationResult:
    invoice_id: int
    po_id: Optional[int]
    valid: bool
    is_shortfall: bool
    is_open_po: bool
    po_already_fulfilled: bool
    missing_reference_data: bool
    target_status: str
    reason: Optional[str]
    errors: List[Finding] = field(default_factory=list)
    warnings: List[Finding] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)

    def summary(self) -> str:
        return (
            f"invoice={self.invoice_id} "
            f"valid={self.valid} shortfall={self.is_shortfall} "
            f"open_po={self.is_open_po} missing_ref={self.missing_reference_data} "
            f"target={self.target_status} "
            f"errors={len(self.errors)} warnings={len(self.warnings)}"
        )

    def to_jsonb(self) -> Dict[str, Any]:
        return {
            "valid": self.valid,
            "is_shortfall": self.is_shortfall,
            "is_open_po": self.is_open_po,
            "po_already_fulfilled": self.po_already_fulfilled,
            "missing_reference_data": self.missing_reference_data,
            "target_status": self.target_status,
            "reason": self.reason,
            "error_codes": [e.code for e in self.errors],
            "warning_codes": [w.code for w in self.warnings],
            "errors": [e.to_dict() for e in self.errors],
            "warnings": [w.to_dict() for w in self.warnings],
            "details": self.details,
        }


def _classify(findings: List[Finding], ctx: InvoiceContext) -> ValidationResult:
    errors = [f for f in findings if f.severity == SEVERITY_ERROR]
    warnings = [f for f in findings if f.severity != SEVERITY_ERROR]
    error_codes = {e.code for e in errors}

    po_already_fulfilled = "E006_PO_ALREADY_FULFILLED" in error_codes

    # Missing reference data — retry next run
    missing_ref = bool(error_codes & RETRY_CODES) and error_codes.issubset(
        RETRY_CODES | {"W001_NO_INVOICE_DATE"}
    )

    is_open_po = ctx.po.is_open_po if ctx.po is not None else False
    is_shortfall = bool(error_codes & SHORTFALL_CODES) and not po_already_fulfilled

    if not errors:
        target = STATUS_VALIDATED
    elif po_already_fulfilled:
        target = STATUS_EXCEPTION_APPROVAL
    elif missing_ref:
        target = STATUS_WAITING_FOR_VALIDATION
    elif is_shortfall:
        target = STATUS_WAITING_FOR_RE_VALIDATION
    else:
        # Data errors (supplier mismatch, missing fields, unresolved line, GST rule)
        target = STATUS_WAITING_FOR_VALIDATION

    reason = None
    if errors:
        priority_order = [
            "E050", "E060", "E061", "E040", "E041", "E021", "E023", "E022",
            "E070", "E071", "E072", "E073", "E074", "E075", "E076",
            "E006", "E005", "E020", "E030", "E031", "E032", "E033",
            "E034", "E035", "E002", "E003", "E004", "E010", "E011", "E001",
        ]
        for prefix in priority_order:
            for e in errors:
                if e.code.startswith(prefix):
                    reason = e.message
                    break
            if reason:
                break
        if reason is None:
            reason = errors[0].message

    details = {
        "po_id": ctx.po.po_id if ctx.po else None,
        "po_number": ctx.po.po_number if ctx.po else None,
        "is_open_po": is_open_po,
        "this_inv_qty": str(ctx.this_inv_qty),
        "this_inv_amount": str(ctx.this_inv_amount),
        "po_value_computed": str(ctx.po_value_computed),
        "grn_accepted_qty_total": str(ctx.grn_accepted_qty_total),
        "asn_count": ctx.asn_count,
        "dc_count": ctx.dc_count,
        "schedule_count": ctx.schedule_count,
        "other_invoices_total_amount": str(ctx.other_invoices_total_amount),
    }

    return ValidationResult(
        invoice_id=ctx.invoice_id,
        po_id=ctx.po.po_id if ctx.po else None,
        valid=not errors,
        is_shortfall=is_shortfall,
        is_open_po=is_open_po,
        po_already_fulfilled=po_already_fulfilled,
        missing_reference_data=missing_ref,
        target_status=target,
        reason=reason,
        errors=errors,
        warnings=warnings,
        details=details,
    )


def run_full_validation(conn: PGConnection, invoice_id: int) -> ValidationResult:
    """Run all checks for one invoice and return a ValidationResult."""
    ctx = load_invoice_context(conn, invoice_id)

    findings: List[Finding] = []
    findings.extend(checks.check_reference_data(ctx))
    findings.extend(checks.check_header(ctx))
    findings.extend(checks.check_dates(ctx))
    findings.extend(checks.check_lines_and_resolution(ctx))
    findings.extend(checks.check_gst(ctx))
    findings.extend(checks.check_uom(ctx))
    findings.extend(checks.check_totals(ctx))
    findings.extend(checks.check_grn_qty(ctx))
    findings.extend(checks.check_cumulative(ctx))
    findings.extend(checks.check_grn_double_use(ctx))
    findings.extend(checks.check_open_po_requirements(ctx))
    findings.extend(checks.check_asn_informational(ctx))

    result = _classify(findings, ctx)
    log.debug(result.summary())
    return result
