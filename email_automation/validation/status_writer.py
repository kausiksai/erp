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

            # Mark PO as fulfilled unless it's an Open PO (those stay 'open').
            # NB: purchase_orders has no updated_at column (checked schema).
            if result.po_id is not None and not result.is_open_po:
                cur.execute(
                    """
                    UPDATE purchase_orders
                    SET status = %s
                    WHERE po_id = %s AND status <> %s
                    """,
                    (PO_STATUS_FULFILLED, result.po_id, PO_STATUS_FULFILLED),
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
