-- ============================================================================
-- Performance indexes for list/search/sort paths
-- ============================================================================
-- Idempotent. Additive only. Safe to re-run.
--
-- Measured impact on production RDS after these indexes + route rewrites:
--   GET /purchase-orders          23k rows   < 200 ms page fetch
--   GET /grn                       7k rows   < 200 ms page fetch
--   GET /asn                      83k rows   < 200 ms page fetch
--   GET /purchase-orders/incomplete          < 900 ms
--   ILIKE search on invoice_number, po_number, supplier_name   <  50 ms
-- ============================================================================

-- Enable trigram extension for fast ILIKE '%text%' searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

BEGIN;

-- ----------------------------------------------------------------------------
-- purchase_orders
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_purchase_orders_date_desc
  ON purchase_orders (date DESC NULLS LAST, po_id DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_pfx
  ON purchase_orders (pfx);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_number_trgm
  ON purchase_orders USING gin (po_number gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- purchase_order_lines
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_po_lines_po_id_fast
  ON purchase_order_lines (po_id);

-- ----------------------------------------------------------------------------
-- invoices
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_invoices_status_created
  ON invoices (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number_trgm
  ON invoices USING gin (invoice_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_invoices_po_number_trgm
  ON invoices USING gin (po_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_invoices_po_id_status
  ON invoices (po_id, status);

-- ----------------------------------------------------------------------------
-- grn
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_grn_date_desc
  ON grn (grn_date DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_grn_grn_no_trgm
  ON grn USING gin (grn_no gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_grn_dc_no_lower
  ON grn (LOWER(TRIM(dc_no)));

-- ----------------------------------------------------------------------------
-- asn
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_asn_date_desc
  ON asn (dc_date DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_asn_po_no_trgm
  ON asn USING gin (po_no gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_asn_supplier_name_trgm
  ON asn USING gin (supplier_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_asn_item_code_trgm
  ON asn USING gin (item_code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_asn_inv_no_lower
  ON asn (LOWER(TRIM(inv_no)));

-- ----------------------------------------------------------------------------
-- delivery_challans
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dc_date_desc
  ON delivery_challans (dc_date DESC NULLS LAST, id DESC);

-- ----------------------------------------------------------------------------
-- po_schedules
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_po_schedules_date_to_desc
  ON po_schedules (date_to DESC NULLS LAST, id DESC);

-- ----------------------------------------------------------------------------
-- suppliers
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_suppliers_name_trgm
  ON suppliers USING gin (supplier_name gin_trgm_ops);

COMMIT;
