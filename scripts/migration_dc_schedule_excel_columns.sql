-- Align delivery_challans + po_schedules with DC transaction & Schedule Excel layouts.
-- Run after schema / migration_open_po_dc_schedule.sql on existing databases.

-- Delivery Challan (DC transaction Excel columns)
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS revision VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS dc_line INTEGER;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS dc_pfx VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS source VARCHAR(100);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS grn_pfx VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS grn_no VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS open_order_pfx VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS open_order_no VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS material_type VARCHAR(100);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS line_no INTEGER;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS temp_qty DECIMAL(15, 3);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS received_qty DECIMAL(15, 3);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS suplr_dc_no VARCHAR(100);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS suplr_dc_date DATE;
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS received_item VARCHAR(100);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS received_item_rev VARCHAR(50);
ALTER TABLE delivery_challans ADD COLUMN IF NOT EXISTS received_item_uom VARCHAR(50);

-- Schedule Excel columns
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS supplier VARCHAR(50);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS item_rev VARCHAR(50);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS date_from DATE;
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS date_to DATE;
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS firm VARCHAR(255);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS tentative VARCHAR(255);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS closeshort VARCHAR(100);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS doc_pfx VARCHAR(50);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS doc_no VARCHAR(100);
ALTER TABLE po_schedules ADD COLUMN IF NOT EXISTS status VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_po_schedules_doc_no ON po_schedules (doc_no);
