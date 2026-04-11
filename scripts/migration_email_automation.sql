-- ============================================================================
-- Email Automation — Schema Migration
-- ============================================================================
-- Purpose:  Add columns required to load the srimukha Bill Register and the
--           five reference-data Excel files end-to-end, and create audit tables
--           for the automated email pipeline.
--
-- Idempotent: safe to re-run. All changes are additive (ADD COLUMN IF NOT
--           EXISTS / CREATE TABLE IF NOT EXISTS). No destructive operations.
--
-- Scope:    This migration is executed by the email_automation package during
--           Phase 1 smoke test against production RDS. It does NOT drop any
--           existing columns or indexes, and does NOT relax any unique
--           constraints. Schema changes affecting existing portal flows will
--           be done in a later, explicit migration after review.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. invoices — add Bill Register header fields
-- ----------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS unit                TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doc_pfx             TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doc_no              TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS grn_pfx             TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS grn_no              TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS dc_no               TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ss_pfx              TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ss_no               TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS open_order_pfx      TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS open_order_no       TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gstin               TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rcm_flag            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS place_of_supply     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_classification  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gst_supply_type     TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS non_gst_flag        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS aic_type            TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency            TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS exchange_rate       NUMERIC(18, 6);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source              TEXT NOT NULL DEFAULT 'portal';
    -- source: 'portal' | 'email_automation'
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_register_run_id UUID;
    -- UUID of the email_automation run that created/updated this invoice row

CREATE INDEX IF NOT EXISTS idx_invoices_unit          ON invoices (unit);
CREATE INDEX IF NOT EXISTS idx_invoices_grn_no        ON invoices (grn_no);
CREATE INDEX IF NOT EXISTS idx_invoices_doc_no        ON invoices (doc_no);
CREATE INDEX IF NOT EXISTS idx_invoices_source        ON invoices (source);

-- ----------------------------------------------------------------------------
-- 2. invoice_lines — add richer tax / direct reference columns
-- ----------------------------------------------------------------------------
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS igst_rate        DECIMAL(5, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS igst_amount      DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS cgst_rcm_amount  DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS sgst_rcm_amount  DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS igst_rcm_amount  DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS gross_amount     DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS net_amount       DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS assessable_value DECIMAL(15, 2);
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS item_code        TEXT;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS item_rev         TEXT;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS narration        TEXT;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS grn_id           BIGINT;
    -- Direct link to a grn row for GRN double-use prevention during validation.
    -- FK omitted because grn is truncate-reloaded daily; integrity is enforced
    -- at load time by the loader.

CREATE INDEX IF NOT EXISTS idx_invoice_lines_item_code ON invoice_lines (item_code);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_grn_id    ON invoice_lines (grn_id);

-- ----------------------------------------------------------------------------
-- 3. email_automation_runs — one row per automation run
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_automation_runs (
  run_id                  UUID        PRIMARY KEY,
  started_at              TIMESTAMPTZ NOT NULL,
  finished_at             TIMESTAMPTZ,
  status                  TEXT        NOT NULL,
      -- running | success | partial | failed
  emails_fetched          INTEGER     NOT NULL DEFAULT 0,
  attachments_processed   INTEGER     NOT NULL DEFAULT 0,
  attachments_succeeded   INTEGER     NOT NULL DEFAULT 0,
  attachments_failed      INTEGER     NOT NULL DEFAULT 0,
  attachments_skipped     INTEGER     NOT NULL DEFAULT 0,
  revalidated_invoices    INTEGER     NOT NULL DEFAULT 0,
  error_message           TEXT,
  host                    TEXT,
  CONSTRAINT chk_runs_status CHECK (status IN ('running','success','partial','failed'))
);

CREATE INDEX IF NOT EXISTS idx_email_automation_runs_status  ON email_automation_runs (status);
CREATE INDEX IF NOT EXISTS idx_email_automation_runs_started ON email_automation_runs (started_at DESC);

-- ----------------------------------------------------------------------------
-- 4. email_automation_log — one row per attachment processing attempt
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_automation_log (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              UUID        NOT NULL REFERENCES email_automation_runs(run_id) ON DELETE CASCADE,
  message_id          TEXT,
  email_uid           BIGINT,
  sender              TEXT,
  subject             TEXT,
  received_at         TIMESTAMPTZ,
  attachment_name     TEXT,
  attachment_sha256   TEXT,
  doc_type            TEXT,
      -- po | grn | asn | dc | schedule | invoice | unknown
  status              TEXT        NOT NULL,
      -- downloaded | parsed | loaded | validated | failed
      -- | skipped_duplicate | skipped_unclassified
  invoice_id          BIGINT      REFERENCES invoices(invoice_id)       ON DELETE SET NULL,
  po_id               BIGINT      REFERENCES purchase_orders(po_id)     ON DELETE SET NULL,
  validation_result   JSONB,
  error_message       TEXT,
  file_path           TEXT,
  rows_processed      INTEGER,
  rows_inserted       INTEGER,
  rows_updated        INTEGER,
  rows_skipped        INTEGER,
  processed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_log_doc_type CHECK (
    doc_type IS NULL OR doc_type IN ('po','grn','asn','dc','schedule','invoice','unknown')
  ),
  CONSTRAINT chk_log_status CHECK (
    status IN (
      'downloaded','parsed','loaded','validated','failed',
      'skipped_duplicate','skipped_unclassified'
    )
  )
);

-- Dedup key: same attachment from the same email is never processed twice.
-- NULLs are allowed (runs that fail before hashing), so the constraint is
-- partial to keep the NOT-NULL pair unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attachment_dedup
  ON email_automation_log (message_id, attachment_sha256)
  WHERE message_id IS NOT NULL AND attachment_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_automation_log_run       ON email_automation_log (run_id);
CREATE INDEX IF NOT EXISTS idx_email_automation_log_status    ON email_automation_log (status);
CREATE INDEX IF NOT EXISTS idx_email_automation_log_doc_type  ON email_automation_log (doc_type);
CREATE INDEX IF NOT EXISTS idx_email_automation_log_processed ON email_automation_log (processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_automation_log_sha       ON email_automation_log (attachment_sha256);
CREATE INDEX IF NOT EXISTS idx_email_automation_log_invoice   ON email_automation_log (invoice_id);

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification queries (run manually after migration)
-- ----------------------------------------------------------------------------
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'invoices' AND column_name IN
--   ('unit','doc_pfx','doc_no','grn_pfx','grn_no','dc_no','gstin','source');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'invoice_lines' AND column_name LIKE '%igst%';
-- SELECT to_regclass('public.email_automation_runs');
-- SELECT to_regclass('public.email_automation_log');
