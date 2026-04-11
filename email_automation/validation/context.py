"""Loads the full validation context for a single invoice.

The `InvoiceContext` is a read-only snapshot of everything the engine needs
to make a decision. Loading it is one round-trip per table (no per-row
queries), and the engine operates purely on the in-memory context so that
check functions are easy to unit-test with fixture data.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Dict, List, Optional

from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import RealDictCursor

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes — read-only snapshots
# ---------------------------------------------------------------------------
@dataclass
class SupplierContext:
    supplier_id: int
    supplier_name: Optional[str] = None
    state_code: Optional[str] = None
    gst_number: Optional[str] = None


@dataclass
class POContext:
    po_id: int
    po_number: str
    amd_no: int
    pfx: Optional[str]
    date: Optional[date]
    supplier_id: Optional[int]
    terms: Optional[str]
    status: str
    is_open_po: bool
    lines: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class InvoiceContext:
    invoice_id: int
    invoice: Dict[str, Any]
    lines: List[Dict[str, Any]]
    supplier: Optional[SupplierContext]
    po: Optional[POContext]
    # Sums / counts fetched once so checks don't re-query
    grn_qty_total: Decimal
    grn_accepted_qty_total: Decimal
    asn_count: int
    asn_qty_total: Decimal
    dc_count: int
    dc_qty_total: Decimal
    schedule_count: int
    schedule_qty_total: Decimal
    # Cumulative invoice rollups across all invoices for this PO (this one excluded)
    other_invoices_total_amount: Decimal
    other_invoices_total_qty: Decimal
    # Pre-computed
    this_inv_qty: Decimal
    this_inv_amount: Decimal
    po_value_computed: Decimal  # Σ(qty × unit_cost × (1-disc_pct/100))


class ContextError(RuntimeError):
    """Raised when an invoice cannot be loaded for validation."""


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------
def _to_decimal(v: Any) -> Decimal:
    if v is None:
        return Decimal(0)
    if isinstance(v, Decimal):
        return v
    try:
        return Decimal(str(v))
    except (ArithmeticError, ValueError):
        return Decimal(0)


def _state_code_from_gstin(gstin: Optional[str]) -> Optional[str]:
    """Extract the 2-digit state code from a GSTIN (first two characters)."""
    if not gstin:
        return None
    gstin = gstin.strip()
    if len(gstin) >= 2 and gstin[:2].isdigit():
        return gstin[:2]
    return None


def load_invoice_context(conn: PGConnection, invoice_id: int) -> InvoiceContext:
    """Fetch everything needed to validate one invoice."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        # -- invoice header ---------------------------------------------------
        cur.execute(
            "SELECT * FROM invoices WHERE invoice_id = %s",
            (invoice_id,),
        )
        invoice = cur.fetchone()
        if invoice is None:
            raise ContextError(f"invoice {invoice_id} not found")

        # -- invoice lines ----------------------------------------------------
        cur.execute(
            """
            SELECT *
            FROM invoice_lines
            WHERE invoice_id = %s
            ORDER BY sequence_number NULLS LAST, invoice_line_id
            """,
            (invoice_id,),
        )
        inv_lines = cur.fetchall()

        this_inv_qty = sum(
            (_to_decimal(ln.get("billed_qty")) for ln in inv_lines),
            Decimal(0),
        )
        this_inv_amount = sum(
            (_to_decimal(ln.get("line_total")) for ln in inv_lines),
            Decimal(0),
        )

        # -- supplier ---------------------------------------------------------
        supplier: Optional[SupplierContext] = None
        if invoice.get("supplier_id") is not None:
            cur.execute(
                """
                SELECT supplier_id, supplier_name, state_code, gst_number
                FROM suppliers WHERE supplier_id = %s
                """,
                (invoice["supplier_id"],),
            )
            srow = cur.fetchone()
            if srow:
                state_code = srow.get("state_code") or _state_code_from_gstin(
                    srow.get("gst_number") or invoice.get("gstin")
                )
                supplier = SupplierContext(
                    supplier_id=srow["supplier_id"],
                    supplier_name=srow.get("supplier_name"),
                    state_code=state_code,
                    gst_number=srow.get("gst_number"),
                )

        # -- PO + lines (latest amendment if po_id is NULL) -------------------
        po: Optional[POContext] = None
        po_id = invoice.get("po_id")
        po_number = invoice.get("po_number")
        if po_id is None and po_number:
            cur.execute(
                """
                SELECT po_id FROM purchase_orders
                WHERE po_number = %s
                ORDER BY amd_no DESC
                LIMIT 1
                """,
                (po_number,),
            )
            row = cur.fetchone()
            if row:
                po_id = row["po_id"]

        po_value_computed = Decimal(0)
        if po_id is not None:
            cur.execute(
                "SELECT * FROM purchase_orders WHERE po_id = %s",
                (po_id,),
            )
            po_row = cur.fetchone()
            if po_row:
                cur.execute(
                    """
                    SELECT 1 FROM open_po_prefixes op
                    WHERE TRIM(op.prefix) <> ''
                      AND UPPER(%s) LIKE UPPER(TRIM(op.prefix)) || '%%'
                    LIMIT 1
                    """,
                    (po_row.get("pfx") or "",),
                )
                is_open_po = cur.fetchone() is not None

                cur.execute(
                    """
                    SELECT po_line_id, sequence_number, item_id, description1,
                           qty, unit_cost, disc_pct
                    FROM purchase_order_lines
                    WHERE po_id = %s
                    ORDER BY sequence_number, po_line_id
                    """,
                    (po_id,),
                )
                po_lines = cur.fetchall()

                for pl in po_lines:
                    qty = _to_decimal(pl.get("qty"))
                    uc = _to_decimal(pl.get("unit_cost"))
                    disc = _to_decimal(pl.get("disc_pct"))
                    effective = qty * uc * (Decimal(1) - disc / Decimal(100))
                    po_value_computed += effective

                po = POContext(
                    po_id=po_row["po_id"],
                    po_number=po_row["po_number"],
                    amd_no=int(po_row.get("amd_no") or 0),
                    pfx=po_row.get("pfx"),
                    date=po_row.get("date"),
                    supplier_id=po_row.get("supplier_id"),
                    terms=po_row.get("terms"),
                    status=po_row.get("status") or "open",
                    is_open_po=is_open_po,
                    lines=list(po_lines),
                )

        # -- GRN totals (by po_id; fall back to grn_no from invoice if no po) -
        grn_qty_total = Decimal(0)
        grn_accepted_qty_total = Decimal(0)
        if po is not None:
            cur.execute(
                """
                SELECT COALESCE(SUM(grn_qty), 0)::numeric       AS q,
                       COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)), 0)::numeric AS aq
                FROM grn WHERE po_id = %s
                """,
                (po.po_id,),
            )
            row = cur.fetchone()
            grn_qty_total = _to_decimal(row["q"])
            grn_accepted_qty_total = _to_decimal(row["aq"])
        elif invoice.get("grn_no"):
            cur.execute(
                """
                SELECT COALESCE(SUM(grn_qty), 0)::numeric       AS q,
                       COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)), 0)::numeric AS aq
                FROM grn WHERE grn_no = %s
                """,
                (invoice["grn_no"],),
            )
            row = cur.fetchone()
            grn_qty_total = _to_decimal(row["q"])
            grn_accepted_qty_total = _to_decimal(row["aq"])

        # -- ASN totals (linked via inv_no = invoice_number) ------------------
        asn_count = 0
        asn_qty_total = Decimal(0)
        if invoice.get("invoice_number"):
            cur.execute(
                """
                SELECT COUNT(*)::int AS c,
                       COALESCE(SUM(quantity), 0)::numeric AS q
                FROM asn
                WHERE TRIM(COALESCE(inv_no, '')) <> ''
                  AND LOWER(TRIM(inv_no)) = LOWER(TRIM(%s))
                """,
                (invoice["invoice_number"],),
            )
            row = cur.fetchone()
            asn_count = int(row["c"])
            asn_qty_total = _to_decimal(row["q"])

        # -- DC / Schedule totals (for Open PO requirement + qty match) -------
        dc_count = 0
        dc_qty_total = Decimal(0)
        schedule_count = 0
        schedule_qty_total = Decimal(0)
        if po is not None:
            cur.execute(
                """
                SELECT COUNT(*)::int AS c,
                       COALESCE(SUM(dc_qty), 0)::numeric AS q
                FROM delivery_challans
                WHERE po_id = %s
                   OR (TRIM(COALESCE(ord_no, '')) <> '' AND LOWER(TRIM(ord_no)) = LOWER(TRIM(%s)))
                   OR (TRIM(COALESCE(open_order_no, '')) <> '' AND LOWER(TRIM(open_order_no)) = LOWER(TRIM(%s)))
                """,
                (po.po_id, po.po_number, po.po_number),
            )
            row = cur.fetchone()
            dc_count = int(row["c"])
            dc_qty_total = _to_decimal(row["q"])

            cur.execute(
                """
                SELECT COUNT(*)::int AS c,
                       COALESCE(SUM(sched_qty), 0)::numeric AS q
                FROM po_schedules
                WHERE po_id = %s
                   OR (COALESCE(po_number, '') <> '' AND LOWER(TRIM(po_number)) = LOWER(TRIM(%s)))
                   OR (COALESCE(doc_no, '') <> '' AND LOWER(TRIM(doc_no)) = LOWER(TRIM(%s)))
                """,
                (po.po_id, po.po_number, po.po_number),
            )
            row = cur.fetchone()
            schedule_count = int(row["c"])
            schedule_qty_total = _to_decimal(row["q"])

        # -- Cumulative across other invoices for the same PO ----------------
        other_inv_total_amount = Decimal(0)
        other_inv_total_qty = Decimal(0)
        if po is not None:
            cur.execute(
                """
                SELECT COALESCE(SUM(i.total_amount), 0)::numeric AS amt,
                       COALESCE(SUM(
                           (SELECT COALESCE(SUM(il.billed_qty), 0)
                            FROM invoice_lines il WHERE il.invoice_id = i.invoice_id)
                       ), 0)::numeric AS qty
                FROM invoices i
                WHERE i.po_id = %s
                  AND i.invoice_id <> %s
                  AND i.status NOT IN ('rejected')
                """,
                (po.po_id, invoice_id),
            )
            row = cur.fetchone()
            other_inv_total_amount = _to_decimal(row["amt"])
            other_inv_total_qty = _to_decimal(row["qty"])

        return InvoiceContext(
            invoice_id=invoice_id,
            invoice=dict(invoice),
            lines=[dict(ln) for ln in inv_lines],
            supplier=supplier,
            po=po,
            grn_qty_total=grn_qty_total,
            grn_accepted_qty_total=grn_accepted_qty_total,
            asn_count=asn_count,
            asn_qty_total=asn_qty_total,
            dc_count=dc_count,
            dc_qty_total=dc_qty_total,
            schedule_count=schedule_count,
            schedule_qty_total=schedule_qty_total,
            other_invoices_total_amount=other_inv_total_amount,
            other_invoices_total_qty=other_inv_total_qty,
            this_inv_qty=this_inv_qty,
            this_inv_amount=this_inv_amount,
            po_value_computed=po_value_computed,
        )
