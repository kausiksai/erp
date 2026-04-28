-- ============================================================================
-- Stage 3 — `unraised_invoices` (PO check)
-- ============================================================================
-- Surfaces POs where goods were received (GRN exists) but no invoice has
-- been raised yet — neither via email Excel nor via Drive PDF.
--
-- Populated nightly by `python -m ocr_automation.po_check`.
-- Idempotent and additive.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. unraised_invoices — current candidates awaiting an invoice
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unraised_invoices (
  po_id              BIGINT      PRIMARY KEY REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  po_number          TEXT        NOT NULL,
  supplier_id        BIGINT,
  supplier_name      TEXT,
  latest_grn_id      BIGINT,
  latest_grn_no      TEXT,
  latest_grn_date    DATE,
  days_since_grn     INT,
  expected_amount    NUMERIC(15,2),
  first_flagged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_id        UUID
);

CREATE INDEX IF NOT EXISTS idx_unraised_invoices_supplier
  ON unraised_invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_unraised_invoices_days
  ON unraised_invoices (days_since_grn DESC);
CREATE INDEX IF NOT EXISTS idx_unraised_invoices_first_flagged
  ON unraised_invoices (first_flagged_at);


-- ----------------------------------------------------------------------------
-- 2. Extend ocr_automation_log status check to allow 'po_check' rows
-- ----------------------------------------------------------------------------
ALTER TABLE ocr_automation_log
  DROP CONSTRAINT IF EXISTS ocr_automation_log_status_check;

ALTER TABLE ocr_automation_log
  ADD CONSTRAINT ocr_automation_log_status_check
  CHECK (status IN (
    'downloaded', 'extracted', 'saved',
    'reconciled', 'failed', 'skipped_duplicate',
    'po_check'
  ));


-- ----------------------------------------------------------------------------
-- 3. Convenience view — what the portal page will read
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_unraised_invoices AS
SELECT
  ui.po_id,
  ui.po_number,
  ui.supplier_id,
  COALESCE(ui.supplier_name, s.supplier_name) AS supplier_name,
  ui.latest_grn_no,
  ui.latest_grn_date,
  ui.days_since_grn,
  ui.expected_amount,
  ui.first_flagged_at,
  ui.last_seen_at,
  po.terms,
  po.status AS po_status
FROM unraised_invoices ui
LEFT JOIN suppliers s        ON s.supplier_id = ui.supplier_id
LEFT JOIN purchase_orders po ON po.po_id      = ui.po_id;

COMMIT;
