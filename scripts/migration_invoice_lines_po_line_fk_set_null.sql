-- Migration: relax invoice_lines.po_line_id FK to ON DELETE SET NULL
--
-- Background: the daily PO loader (email_automation/loaders/po.py) refreshes
-- purchase_order_lines for each PO it loads. With the old NO ACTION FK from
-- invoice_lines.po_line_id, any OCR invoice line that had matched a PO line
-- (the upload handler's item-name lookup populates po_line_id) blocked the
-- PO refresh entirely. That made today's 6 AM run fail at phase 1 with:
--
--   ForeignKeyViolation: update or delete on table "purchase_order_lines"
--   violates foreign key constraint "invoice_lines_po_line_id_fkey" on
--   table "invoice_lines"
--   DETAIL: Key (po_line_id)=(117029) is still referenced from
--           table "invoice_lines".
--
-- and a downstream DC loader failure because the resolver cache held
-- phantom po_ids from the rolled-back PO transaction.
--
-- Semantics: an invoice_lines row's po_line_id is a soft pointer that the
-- engine re-resolves on every validation sweep (by item_id / description
-- match against the current PO). When the underlying PO line goes away in
-- a refresh, dropping the reference to NULL is exactly right — the line is
-- still a real invoice line, it just needs to be re-matched against the
-- new PO state. CASCADE would silently delete the invoice line, which is
-- catastrophically wrong. SET NULL is the correct semantic.
--
-- Idempotent — safe to re-run.

BEGIN;

ALTER TABLE invoice_lines
  DROP CONSTRAINT IF EXISTS invoice_lines_po_line_id_fkey;

ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_po_line_id_fkey
    FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines(po_line_id)
    ON DELETE SET NULL;

COMMIT;
