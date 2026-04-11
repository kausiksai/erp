-- ============================================================================
-- Email Automation — Phase 2 Schema Migration
-- ============================================================================
-- Purpose: adjust constraints and add lookup keys needed to load the Bill
--          Register and the five reference-data Excel files end-to-end.
--
-- Idempotent and re-runnable. Each change is guarded by IF NOT EXISTS or
-- checks catalog views so a second run is a no-op.
--
-- Safety notes
--   * `suppliers.suplr_id` is added to give us a deterministic supplier code
--     (e.g. 'V2375') that the incoming PO / GRN / ASN / DC / Schedule / Bill
--     Register files all use. The existing suppliers table only stored the
--     supplier_name; relying on name matching is unreliable.
--
--   * `invoices.invoice_number` currently has a global UNIQUE constraint.
--     The Bill Register contains 12 known bill-number collisions across
--     different (unit, supplier) pairs (see docs/Bill Register Mar-26.xlsx).
--     We relax the uniqueness to (supplier_id, invoice_number). The new
--     constraint is *more permissive* than the old one, so any existing
--     row that satisfied the old constraint trivially satisfies the new
--     one -- the migration cannot fail on existing data.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. suppliers.suplr_id — the canonical vendor code used in all source files
-- ----------------------------------------------------------------------------
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS suplr_id TEXT;

-- Partial unique index: NULL is allowed for suppliers created before we had
-- the code (they will get back-filled on first match by name), but once set
-- the code must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_suplr_id
  ON suppliers (suplr_id)
  WHERE suplr_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_name_lower
  ON suppliers (LOWER(TRIM(supplier_name)));

-- ----------------------------------------------------------------------------
-- 2. invoices.invoice_number — relax global UNIQUE to (supplier_id, number)
-- ----------------------------------------------------------------------------
-- Drop the old global unique constraint only if it exists by its current name.
DO $mig$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'invoices'::regclass
    AND contype = 'u'
    AND conname = 'invoices_invoice_number_key';
  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE invoices DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;
END
$mig$;

-- Add composite unique (NULLs allowed: suppliers without a supplier_id are
-- portal-origin and the old unique already blocked number collisions for
-- those, so no regression).
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'invoices'::regclass
      AND contype = 'u'
      AND conname = 'uq_invoices_supplier_number'
  ) THEN
    ALTER TABLE invoices
      ADD CONSTRAINT uq_invoices_supplier_number UNIQUE (supplier_id, invoice_number);
  END IF;
END
$mig$;

-- ----------------------------------------------------------------------------
-- 3. purchase_orders — help the validator find the latest amendment quickly
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_number_amd_desc
  ON purchase_orders (po_number, amd_no DESC);

-- ----------------------------------------------------------------------------
-- 4. Housekeeping index on invoices for (unit, supplier_id, invoice_number)
--    lookups the loader performs on every Bill Register row
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_unit_supplier_number
  ON invoices (unit, supplier_id, invoice_number);

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification (run manually)
-- ----------------------------------------------------------------------------
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'invoices'::regclass AND contype = 'u';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'suppliers' AND column_name = 'suplr_id';
