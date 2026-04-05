-- PostgreSQL: Delete all data and reset auto-increment (sequences)
-- Run in a transaction so you can ROLLBACK if needed.

BEGIN;

-- Disable triggers temporarily (optional, TRUNCATE CASCADE usually suffices)
-- Truncate in dependency order: child tables first, then parents.
-- RESTART IDENTITY resets the sequence (auto-increment) for each table.
-- CASCADE truncates any other tables that reference these (if you want only these tables, omit CASCADE and rely on order).

TRUNCATE TABLE
  invoice_lines,
  invoice_attachments,
  invoice_weight_attachments,
  debit_note_details,
  purchase_order_lines,
  payment_transactions,
  payment_approvals,
  po_schedules,
  delivery_challans,
  grn,
  asn,
  invoices,
  debit_notes,
  open_po_prefixes,
  purchase_orders
RESTART IDENTITY;
-- Add CASCADE only if you also want to truncate other tables that reference these.

COMMIT;
