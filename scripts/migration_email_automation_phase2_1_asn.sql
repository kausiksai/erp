-- ============================================================================
-- Email Automation — Phase 2.1 Schema Migration
--   Add columns to asn so every column in ASN.xls is persisted.
-- ============================================================================
-- Idempotent and re-runnable. Purely additive.
-- ============================================================================

BEGIN;

ALTER TABLE asn ADD COLUMN IF NOT EXISTS item_code     VARCHAR(50);
ALTER TABLE asn ADD COLUMN IF NOT EXISTS item_desc     TEXT;
ALTER TABLE asn ADD COLUMN IF NOT EXISTS quantity      DECIMAL(15, 3);
ALTER TABLE asn ADD COLUMN IF NOT EXISTS po_pfx        VARCHAR(50);
ALTER TABLE asn ADD COLUMN IF NOT EXISTS po_no         VARCHAR(50);
ALTER TABLE asn ADD COLUMN IF NOT EXISTS schedule_pfx  VARCHAR(50);
ALTER TABLE asn ADD COLUMN IF NOT EXISTS schedule_no   VARCHAR(50);
ALTER TABLE asn ADD COLUMN IF NOT EXISTS grn_status    VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_asn_po_no     ON asn (po_no);
CREATE INDEX IF NOT EXISTS idx_asn_item_code ON asn (item_code);

COMMIT;
