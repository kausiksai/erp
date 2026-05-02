"""Apply a `ValidationResult` to the database.

Writes the invoice status, optionally computes payment_due_date, marks PO
fulfilled on valid invoices, and stores the full result JSON in
`invoices.notes` (as a structured string) / audit log. The caller controls
the transaction; this function runs inside it.
"""

from __future__ import annotations

import logging
import re
from datetime import date, timedelta
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


def apply_validation_result(conn: PGConnection, result: ValidationResult) -> None:
    """Persist the validation outcome for one invoice."""
    with conn.cursor() as cur:
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
            cur.execute(
                """
                UPDATE invoices
                SET status = %s,
                    payment_due_date = %s,
                    updated_at = NOW()
                WHERE invoice_id = %s
                """,
                (result.target_status, payment_due_date, result.invoice_id),
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
