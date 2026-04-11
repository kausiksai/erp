"""Numeric tolerances and enum-like constants for the validation engine.

Values mirror the Node engine (TOL_QTY, TOL_AMOUNT, TOL_RATE_PCT) but are
collected here so changing any of them is a single-line edit.
"""

from __future__ import annotations

from decimal import Decimal

# --- Numeric tolerances -----------------------------------------------------
TOL_QTY = Decimal("0.001")              # qty comparisons
TOL_AMOUNT = Decimal("0.01")            # monetary comparisons
TOL_RATE_PCT = Decimal("0.01")          # 1% relative rate drift

# --- Status / severity constants --------------------------------------------
SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

# --- Invoice lifecycle ------------------------------------------------------
STATUS_WAITING_FOR_VALIDATION = "waiting_for_validation"
STATUS_WAITING_FOR_RE_VALIDATION = "waiting_for_re_validation"
STATUS_VALIDATED = "validated"
STATUS_DEBIT_NOTE_APPROVAL = "debit_note_approval"
STATUS_EXCEPTION_APPROVAL = "exception_approval"
STATUS_READY_FOR_PAYMENT = "ready_for_payment"
STATUS_PARTIALLY_PAID = "partially_paid"
STATUS_PAID = "paid"
STATUS_REJECTED = "rejected"

HUMAN_TOUCHED_STATUSES = {
    STATUS_VALIDATED,
    STATUS_DEBIT_NOTE_APPROVAL,
    STATUS_EXCEPTION_APPROVAL,
    STATUS_READY_FOR_PAYMENT,
    STATUS_PARTIALLY_PAID,
    STATUS_PAID,
    STATUS_REJECTED,
}

REVALIDATABLE_STATUSES = {
    STATUS_WAITING_FOR_VALIDATION,
    STATUS_WAITING_FOR_RE_VALIDATION,
}

# --- PO lifecycle -----------------------------------------------------------
PO_STATUS_OPEN = "open"
PO_STATUS_PARTIALLY_FULFILLED = "partially_fulfilled"
PO_STATUS_FULFILLED = "fulfilled"

# --- Finding categories (for report grouping) ------------------------------
CAT_HEADER = "header"
CAT_LINE = "line"
CAT_TOTALS = "totals"
CAT_GST = "gst"
CAT_PRICE = "price"
CAT_CUMULATIVE = "cumulative"
CAT_OPEN_PO = "open_po"
CAT_REFERENCE = "reference"
CAT_DATE = "date"
CAT_UOM = "uom"
CAT_GRN = "grn"
