"""Apply a `ValidationResult` to the database.

Writes the invoice status, optionally computes payment_due_date, marks PO
fulfilled on valid invoices, and stores the full result JSON in
`invoices.notes` (as a structured string) / audit log. The caller controls
the transaction; this function runs inside it.

Also persists every Finding into `invoices.validation_errors` (JSONB)
in the exact same shape the Node validator uses
(`{errors: [{code, message}], warnings: [{code, message}], computed_at}`),
so the Reconciliation page sees a consistent per-rule rollup regardless
of which engine validated the invoice.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from psycopg2.extensions import connection as PGConnection

from .engine import ValidationResult
from .tolerances import (
    PO_STATUS_FULFILLED,
    PO_STATUS_PARTIALLY_FULFILLED,
    STATUS_VALIDATED,
)

log = logging.getLogger(__name__)


def _parse_payment_terms_days(terms: Optional[str], default: int = 30) -> int:
    if not terms:
        return default
    match = re.search(r"(\d+)\s*DAY", str(terms).upper())
    if match:
        try:
            n = int(match.group(1))
            return n if n >= 0 else default
        except ValueError:
            return default
    return default


def _persist_validation_errors(cur, result: ValidationResult) -> None:
    """Write findings into `invoices.validation_errors` (JSONB).

    Same shape the Node engine produces — keeps the Reconciliation page's
    per-rule rollup consistent regardless of which engine validated the
    invoice.

    The column is auto-created on first write (idempotent ALTER TABLE) so
    fresh installs don't need a separate migration step.
    """
    try:
        cur.execute(
            "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS validation_errors JSONB"
        )
    except Exception as err:  # noqa: BLE001 — best-effort, never fatal
        log.warning("_persist_validation_errors: ADD COLUMN failed: %s", err)
        return

    payload = {
        "errors":   [{"code": f.code, "message": f.message} for f in (result.errors or [])],
        "warnings": [{"code": f.code, "message": f.message} for f in (result.warnings or [])],
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        cur.execute(
            "UPDATE invoices SET validation_errors = %s::jsonb WHERE invoice_id = %s",
            (json.dumps(payload), result.invoice_id),
        )
    except Exception as err:  # noqa: BLE001
        log.warning("_persist_validation_errors: UPDATE failed: %s", err)


def apply_validation_result(conn: PGConnection, result: ValidationResult) -> None:
    """Persist the validation outcome for one invoice."""
    with conn.cursor() as cur:
        # Always persist the per-rule findings, regardless of valid/invalid
        # outcome. Runs inside the same txn as the status update.
        _persist_validation_errors(cur, result)
        if result.valid:
            # Compute payment_due_date from PO terms + invoice date
            cur.execute(
                """
                SELECT i.invoice_date, po.terms
                FROM invoices i
                LEFT JOIN purchase_orders po ON po.po_id = i.po_id
                WHERE i.invoice_id = %s
                """,
                (result.invoice_id,),
            )
            row = cur.fetchone()
            inv_date, terms = (row[0], row[1]) if row else (None, None)
            due_days = _parse_payment_terms_days(terms)
            payment_due_date = (
                inv_date + timedelta(days=due_days) if inv_date else None
            )
            # Persist resolved po_id when validation succeeded.
            # The engine's load_invoice_context can resolve a PO via the
            # GRN/ASN fallback even when invoices.po_id is NULL. Without
            # writing it back, the frontend can't display the PO / GRN /
            # ASN / DC for the validated invoice (it queries by po_id),
            # and subsequent sweeper runs would re-run the fallback every
            # time. Set po_id only when it's currently NULL — never
            # overwrite an existing po_id since that may have been
            # manually corrected by a reviewer.
            cur.execute(
                """
                UPDATE invoices
                SET status = %s,
                    payment_due_date = %s,
                    po_id = COALESCE(po_id, %s),
                    updated_at = NOW()
                WHERE invoice_id = %s
                """,
                (result.target_status, payment_due_date, result.po_id, result.invoice_id),
            )

            # Mark PO based on cumulative invoiced qty vs PO total qty:
            #   cumulative >= PO total  → 'fulfilled'
            #   0 < cumulative < total  → 'partially_fulfilled'
            #   else                    → leave the existing status untouched
            #
            # Open POs are excluded — they always stay 'open' (handled below).
            # The previous behaviour marked every successful validation as
            # 'fulfilled' which caused status drift on multi-invoice POs and
            # spurious E006 firings on re-validation cycles.
            if result.po_id is not None and not result.is_open_po:
                cur.execute(
                    """
                    WITH po_total AS (
                        SELECT COALESCE(SUM(qty), 0)::numeric AS qty
                        FROM purchase_order_lines
                        WHERE po_id = %s
                    ),
                    invoiced AS (
                        SELECT COALESCE(SUM(il.billed_qty), 0)::numeric AS qty
                        FROM invoice_lines il
                        JOIN invoices i ON i.invoice_id = il.invoice_id
                        WHERE i.po_id = %s AND i.status = 'validated'
                    )
                    UPDATE purchase_orders po
                    SET status = CASE
                        WHEN (SELECT qty FROM po_total) > 0
                             AND (SELECT qty FROM invoiced) >= (SELECT qty FROM po_total) - 0.001
                            THEN %s
                        WHEN (SELECT qty FROM invoiced) > 0
                            THEN %s
                        ELSE po.status
                    END
                    WHERE po.po_id = %s
                    """,
                    (
                        result.po_id, result.po_id,
                        PO_STATUS_FULFILLED, PO_STATUS_PARTIALLY_FULFILLED,
                        result.po_id,
                    ),
                )
        else:
            # Non-valid outcomes: route to target status, clear payment_due_date
            cur.execute(
                """
                UPDATE invoices
                SET status = %s,
                    payment_due_date = NULL,
                    updated_at = NOW()
                WHERE invoice_id = %s
                """,
                (result.target_status, result.invoice_id),
            )
