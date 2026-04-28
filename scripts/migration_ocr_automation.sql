-- ============================================================================
-- OCR Automation — Audit + Idempotency Schema Migration
-- ============================================================================
-- Purpose:
--   * `drive_synced_files`     — idempotency: skip Drive files we already
--                                processed (or are processing).
--   * `ocr_automation_runs`    — one row per nightly run (mirrors
--                                email_automation_runs).
--   * `ocr_automation_log`     — one row per file-processing attempt.
--
-- Note: the invoice data itself goes into `invoices.ocr_snapshot` (JSONB)
--       via the existing /api/invoices flow — this migration adds NO columns
--       to invoices / invoice_lines.
--
-- Idempotent: safe to re-run. Purely additive.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. drive_synced_files — one row per Drive file ever seen
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drive_synced_files (
  file_id           TEXT        PRIMARY KEY,             -- Google Drive fileId
  file_name         TEXT        NOT NULL,
  mime_type         TEXT        NOT NULL,
  modified_time     TIMESTAMPTZ,                         -- Drive's modifiedTime
  sha256            TEXT,                                -- of downloaded bytes
  size_bytes        BIGINT,
  status            TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processed', 'failed', 'skipped')),
  invoice_id        BIGINT      REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  invoice_number    TEXT,
  run_id            UUID,                                -- last run that touched it
  error_message     TEXT,
  attempts          INT         NOT NULL DEFAULT 0,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_drive_synced_files_status
  ON drive_synced_files (status);
CREATE INDEX IF NOT EXISTS idx_drive_synced_files_run_id
  ON drive_synced_files (run_id);
CREATE INDEX IF NOT EXISTS idx_drive_synced_files_sha256
  ON drive_synced_files (sha256);


-- ----------------------------------------------------------------------------
-- 2. ocr_automation_runs — one row per pipeline execution
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_automation_runs (
  run_id                  UUID        PRIMARY KEY,
  started_at              TIMESTAMPTZ NOT NULL,
  finished_at             TIMESTAMPTZ,
  status                  TEXT        NOT NULL
                                      CHECK (status IN ('running', 'success', 'partial', 'failed')),
  host                    TEXT,
  drive_folder_id         TEXT,
  files_listed            INT         NOT NULL DEFAULT 0,
  files_processed         INT         NOT NULL DEFAULT 0,
  files_succeeded         INT         NOT NULL DEFAULT 0,
  files_failed            INT         NOT NULL DEFAULT 0,
  files_skipped           INT         NOT NULL DEFAULT 0,
  invoices_created        INT         NOT NULL DEFAULT 0,
  invoices_reconciled     INT         NOT NULL DEFAULT 0,
  error_message           TEXT
);

CREATE INDEX IF NOT EXISTS idx_ocr_automation_runs_started_at
  ON ocr_automation_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_automation_runs_status
  ON ocr_automation_runs (status);


-- ----------------------------------------------------------------------------
-- 3. ocr_automation_log — one row per file-processing attempt
-- ----------------------------------------------------------------------------
-- Status vocabulary:
--   downloaded            — successfully fetched from Drive
--   extracted             — OCR returned data
--   saved                 — invoice row written / updated
--   reconciled            — reconcileInvoice returned a status
--   failed                — any step raised; error_message populated
--   skipped_duplicate     — file_id already processed in a prior run
CREATE TABLE IF NOT EXISTS ocr_automation_log (
  log_id            BIGSERIAL   PRIMARY KEY,
  run_id            UUID        NOT NULL REFERENCES ocr_automation_runs(run_id),
  file_id           TEXT        NOT NULL,
  file_name         TEXT        NOT NULL,
  status            TEXT        NOT NULL
                              CHECK (status IN (
                                'downloaded', 'extracted', 'saved',
                                'reconciled', 'failed', 'skipped_duplicate'
                              )),
  invoice_id        BIGINT      REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  invoice_number    TEXT,
  reconciliation_status TEXT,
  duration_ms       INT,
  error_message     TEXT,
  details           JSONB,
  logged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ocr_automation_log_run_id
  ON ocr_automation_log (run_id);
CREATE INDEX IF NOT EXISTS idx_ocr_automation_log_file_id
  ON ocr_automation_log (file_id);
CREATE INDEX IF NOT EXISTS idx_ocr_automation_log_status
  ON ocr_automation_log (status);

COMMIT;
