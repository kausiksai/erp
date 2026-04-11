-- ============================================================================
-- Email Automation — Phase 2.2 Schema Migration
--   Add columns to invoices and invoice_lines so every column in the
--   Bill Register Excel is persisted.
-- ============================================================================
-- Idempotent and re-runnable. Purely additive. Nullable columns only.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- invoices — header-level fields that were parsed but not yet persisted
-- ----------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_type              TEXT;
    -- Bill Register "Type": 'Invoice' | 'Debit Note'
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mode                   TEXT;
    -- Bill Register "Mode" (Receipt etc.)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doc_entry_date         DATE;
    -- Bill Register "Date" — document entry date in the srimukha ERP
    -- (distinct from Bill Date / invoice_date).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS grn_date               DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_pfx                 TEXT;
    -- PO / SCO prefix (pair of po_number)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_type               TEXT;
    -- Registered / Unregistered
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS place_of_supply_desc   TEXT;
    -- State name corresponding to place_of_supply code

CREATE INDEX IF NOT EXISTS idx_invoices_po_pfx   ON invoices (po_pfx);
CREATE INDEX IF NOT EXISTS idx_invoices_bill_type ON invoices (bill_type);

-- ----------------------------------------------------------------------------
-- invoice_lines — line-level fields that were parsed but not yet persisted
-- ----------------------------------------------------------------------------
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS item_class         TEXT;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS item_sub_class     TEXT;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS uom_description    TEXT;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS grn_tax_amount     DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS bill_amt_tc        DECIMAL(15, 2);
    -- Bill Amt in transaction currency
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS gross_amount_suplr DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS net_amount_suplr   DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS domestic_amt       DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS import_amt         DECIMAL(15, 2);

-- GST slab breakdown (individual rate columns from Bill Register)
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS cgst_9_amount      DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS cgst_2_5_amount    DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS sgst_9_amount      DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS sgst_2_5_amount    DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS igst_18_amount     DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS igst_5_amount      DECIMAL(15, 2);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_item_class ON invoice_lines (item_class);

COMMIT;
