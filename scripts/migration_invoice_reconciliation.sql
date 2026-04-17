-- ============================================================================
-- Dual-Source Invoice Reconciliation — Schema Migration
--   Every invoice can now have two origin snapshots: the Excel Bill Register
--   row (pushed by email automation) and the Portal OCR extraction
--   (Landing AI). When both exist the system compares them, surfaces any
--   mismatches, and a reviewer approves the authoritative value which
--   feeds all downstream validations.
-- ============================================================================
-- Idempotent and re-runnable. Purely additive. Default-fills existing rows.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Source flag & raw snapshots
-- ----------------------------------------------------------------------------
-- source: where the most recent authoritative write came from.
--   'excel'        — only Excel Bill Register row exists
--   'ocr'          — only Portal OCR row exists
--   'both'         — both sources exist (reconciliation_status explains state)
--
-- The column already exists from migration_email_automation.sql where it
-- was originally used to tag ingestion origin ('portal' | 'email_automation').
-- We repurpose it for dual-source reconciliation here:
--   'email_automation' → 'excel'
--   'portal'           → 'ocr'
-- This keeps the vocabulary consistent with the snapshot JSONB fields below.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'excel';
ALTER TABLE invoices ALTER COLUMN source DROP NOT NULL;
UPDATE invoices SET source = 'excel' WHERE source = 'email_automation';
UPDATE invoices SET source = 'ocr'   WHERE source = 'portal';

-- Full per-source snapshots captured at ingest time. JSONB so line items,
-- tax breakdowns, supplier text, etc. survive without schema churn.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS excel_snapshot     JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS excel_received_at  TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ocr_snapshot       JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ocr_received_at    TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Reconciliation state
-- ----------------------------------------------------------------------------
-- reconciliation_status:
--   'single_source'         — only one source exists (no reconciliation due)
--   'auto_matched'          — both sources exist, every field within tolerance
--   'pending_reconciliation'— both sources exist, mismatches detected, awaits human review
--   'manually_approved'     — reviewer picked/edited authoritative values
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reconciliation_status TEXT DEFAULT 'single_source';

-- Ordered list of detected field diffs:
--   [{ field, excel_value, ocr_value, delta, tolerance, severity }, ...]
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS mismatches JSONB;

-- Audit who signed off and when.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(user_id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Back-fill remaining rows. Anything not already classified defaults to
-- 'excel' since the vast majority of historical data came through the Bill
-- Register pipeline.
-- ----------------------------------------------------------------------------
UPDATE invoices
   SET source = 'excel'
 WHERE source IS NULL
    OR source NOT IN ('excel', 'ocr', 'both');

UPDATE invoices
   SET reconciliation_status = 'single_source'
 WHERE reconciliation_status IS NULL;

-- ----------------------------------------------------------------------------
-- Constraints — validated separately to survive on populated tables.
-- Drop first so the migration re-runs cleanly after tweaks.
-- ----------------------------------------------------------------------------
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_source_chk;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_source_chk
  CHECK (source IN ('excel', 'ocr', 'both'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_reconciliation_status_chk;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_reconciliation_status_chk
  CHECK (reconciliation_status IN (
    'single_source',
    'auto_matched',
    'pending_reconciliation',
    'manually_approved'
  ));

-- ----------------------------------------------------------------------------
-- Indexes — the "Needs reconciliation" queue is the hot path.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_reconciliation_status
  ON invoices (reconciliation_status)
  WHERE reconciliation_status = 'pending_reconciliation';

CREATE INDEX IF NOT EXISTS idx_invoices_source ON invoices (source);

COMMIT;
