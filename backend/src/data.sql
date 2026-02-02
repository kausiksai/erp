-- ============================================
-- Billing System - Seed and Test Data
-- ============================================
-- Run manually in your DB client after schema.sql.
-- Order: users -> suppliers -> owners -> menu_items -> role_menu_access
-- -> purchase_orders -> purchase_order_lines -> asn -> grn -> invoices -> invoice_lines -> payment_approvals

-- ============================================
-- 1. Users (admin: Admin@123)
-- ============================================
INSERT INTO users (username, email, password_hash, role, full_name, is_active)
VALUES (
  'admin',
  'admin@srimukha.com',
  '$2b$10$TdamRulPA6bDLMRkMBn3fO40QN9HByBCXs8GGXzWGhdYwyal9rwBW',
  'admin',
  'Administrator',
  TRUE
)
ON CONFLICT (username) DO UPDATE SET
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role,
  full_name = EXCLUDED.full_name,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- ============================================
-- 2. Suppliers (4 suppliers for test POs)
-- ============================================
INSERT INTO suppliers (supplier_name, gst_number, pan_number, supplier_address, city, state_code, state_name, pincode, email, phone, mobile, msme_number, bank_account_name, bank_account_number, bank_ifsc_code, bank_name, branch_name, website, contact_person, created_at, updated_at)
VALUES
  ('YOGA TOOLS', '33AAACY1234A1Z5', 'AAACY1234A', 'Plot No. 45, Industrial Estate, Guindy', 'Chennai', '33', 'Tamil Nadu', '600032', 'accounts@yogatools.in', '044-22561234', '9840012345', 'UDYAM-TN-33-0012345', 'YOGA TOOLS', '12345678901234', 'HDFC0001234', 'HDFC Bank Ltd', 'Guindy Branch', 'https://www.yogatools.in', 'Mr. Ramesh Kumar', NOW(), NOW()),
  ('QUALITY METALLURGICAL LAB', '33AABCQ5678B1Z5', 'AABCQ5678B', 'No. 12, Second Main Road, Ambattur Industrial Estate', 'Chennai', '33', 'Tamil Nadu', '600058', 'info@qualitymetallab.com', '044-26251234', '9876543210', 'UDYAM-TN-33-0056789', 'QUALITY METALLURGICAL LAB', '98765432109876', 'ICIC0001234', 'ICICI Bank Ltd', 'Ambattur Branch', 'https://www.qualitymetallab.com', 'Mr. Suresh Patel', NOW(), NOW()),
  ('PLASMATEK PVD SYSTEMS', '29AABCP9012C1Z5', 'AABCP9012C', 'Survey No. 78, Peenya Industrial Area, Phase 2', 'Bengaluru', '29', 'Karnataka', '560058', 'sales@plasmatek.com', '080-28391234', '8765432109', 'UDYAM-KA-29-0090123', 'PLASMATEK PVD SYSTEMS PVT LTD', '45678901234567', 'SBIN0001234', 'State Bank of India', 'Peenya Branch', 'https://www.plasmatek.com', 'Mr. Rajesh Nair', NOW(), NOW()),
  ('A.T.S. TOOLS & ENGINEERING', '33AABCT3456D1Z5', 'AABCT3456D', 'No. 56, GST Road, Chromepet', 'Chennai', '33', 'Tamil Nadu', '600044', 'contact@atstools.co.in', '044-22451234', '7654321098', 'UDYAM-TN-33-0034567', 'A.T.S. TOOLS & ENGINEERING', '56789012345678', 'HDFC0005678', 'HDFC Bank Ltd', 'Chromepet Branch', 'https://www.atstools.co.in', 'Mr. Arun Sharma', NOW(), NOW())
ON CONFLICT (supplier_name) DO UPDATE SET
  gst_number = EXCLUDED.gst_number,
  pan_number = EXCLUDED.pan_number,
  bank_account_name = EXCLUDED.bank_account_name,
  bank_account_number = EXCLUDED.bank_account_number,
  bank_ifsc_code = EXCLUDED.bank_ifsc_code,
  bank_name = EXCLUDED.bank_name,
  branch_name = EXCLUDED.branch_name,
  updated_at = NOW();

-- ============================================
-- 3. Owners
-- ============================================
INSERT INTO owners (owner_name, gst_number, pan_number, owner_address, city, state_code, state_name, pincode, cin_number, created_at, updated_at)
VALUES (
  'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED',
  '33ABNCS1862K1ZZ',
  'ABNCS1862K',
  'NO.63-A, 9TH STREET NORTH PHASE, AMBATTUR INDUSTRIAL ESTATE',
  'Chennai',
  '33',
  'Tamil Nadu',
  '600098',
  'U26517TN2024PTC169214',
  NOW(),
  NOW()
)
ON CONFLICT (owner_name) DO UPDATE SET
  gst_number = EXCLUDED.gst_number,
  pan_number = EXCLUDED.pan_number,
  updated_at = NOW();

-- ============================================
-- 4. Menu Items (all categories)
-- ============================================
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('incomplete-pos', 'Incomplete Purchase Orders', 'View POs missing invoices, ASN, or GRN and update missing details', 'pi pi-exclamation-triangle', '/purchase-orders/incomplete', '#dc2626', 'status-actions', 'Status & Actions', 'Track incomplete records and pending actions', 1, TRUE, FALSE),
('invoice-upload', 'Invoice Upload', 'Upload invoices and extract data automatically', 'pi pi-file-pdf', '/invoices/upload', '#059669', 'invoices', 'Invoice Management', 'Manage invoices, validation, and details', 1, TRUE, FALSE),
('invoice-details', 'Invoice Details', 'View and manage invoice details and validation', 'pi pi-file-edit', '/invoices/validate', '#2563eb', 'invoices', 'Invoice Management', 'Manage invoices, validation, and details', 2, TRUE, FALSE),
('purchase-order', 'Purchase Order Details', 'View and manage purchase order details', 'pi pi-shopping-cart', '/purchase-orders/upload', '#7c3aed', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 1, TRUE, FALSE),
('grn-details', 'GRN Details', 'Goods Receipt Note management and tracking', 'pi pi-box', '/grn/details', '#ea580c', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 2, TRUE, FALSE),
('asn-details', 'ASN Details', 'Advanced Shipping Notice management', 'pi pi-truck', '/asn/details', '#0891b2', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 3, TRUE, FALSE),
('user-registration', 'User Registration', 'Register and manage system users', 'pi pi-users', '/users/registration', '#dc2626', 'master-data', 'Master Data', 'Manage users, suppliers, and system configuration', 1, TRUE, FALSE),
('owner-details', 'Owner Details', 'View and edit company owner details', 'pi pi-id-card', '/owners/details', '#9333ea', 'master-data', 'Master Data', 'Manage users, suppliers, and system configuration', 2, TRUE, FALSE),
('supplier-registration', 'Supplier Registration', 'Register and manage supplier information', 'pi pi-building', '/suppliers/registration', '#ca8a04', 'master-data', 'Master Data', 'Manage users, suppliers, and system configuration', 3, TRUE, FALSE),
('approve-payments', 'Approve Payments', 'Review and approve payments (PO, supplier, invoice, GRN, ASN, banking)', 'pi pi-check-square', '/payments/approve', '#0d9488', 'finance', 'Finance & Payments', 'Payment approval and history', 1, TRUE, FALSE),
('ready-for-payment', 'Ready for Payments', 'Manage approved payments and mark as done', 'pi pi-money-bill', '/payments/ready', '#0284c7', 'finance', 'Finance & Payments', 'Payment approval and history', 2, TRUE, FALSE),
('payment-history', 'Payment History', 'View and track payment history and status', 'pi pi-history', '/payments/history', '#9333ea', 'finance', 'Finance & Payments', 'Payment approval and history', 3, TRUE, FALSE),
('invoice-reports', 'Invoice Reports', 'Generate comprehensive invoice reports', 'pi pi-file', '/reports/invoices', '#be123c', 'reports', 'Reports & Analytics', 'Generate reports and view analytics', 2, TRUE, FALSE),
('financial-reports', 'Financial Reports', 'Generate financial statements and reports', 'pi pi-chart-bar', '/reports/financial', '#0d9488', 'reports', 'Reports & Analytics', 'Generate reports and view analytics', 3, TRUE, FALSE),
('supplier-reports', 'Supplier Reports', 'Analyze supplier performance and reports', 'pi pi-chart-pie', '/reports/suppliers', '#c2410c', 'reports', 'Reports & Analytics', 'Generate reports and view analytics', 4, TRUE, FALSE)
ON CONFLICT (menu_id) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  path = EXCLUDED.path,
  color = EXCLUDED.color,
  category_id = EXCLUDED.category_id,
  category_title = EXCLUDED.category_title,
  category_description = EXCLUDED.category_description,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  is_coming_soon = EXCLUDED.is_coming_soon,
  updated_at = NOW();

-- ============================================
-- 5. Role Menu Access
-- ============================================
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'admin', menu_item_id, TRUE FROM menu_items WHERE is_active = TRUE
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'manager', menu_item_id, TRUE FROM menu_items
WHERE menu_id IN ('incomplete-pos','invoice-upload','invoice-details','purchase-order','grn-details','asn-details','user-registration','supplier-registration','approve-payments','ready-for-payment','payment-history','invoice-reports','financial-reports','supplier-reports')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'user', menu_item_id, TRUE FROM menu_items
WHERE menu_id IN ('incomplete-pos','invoice-upload','invoice-details','purchase-order','grn-details','asn-details','supplier-registration')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'finance', menu_item_id, TRUE FROM menu_items
WHERE menu_id IN ('invoice-details','approve-payments','ready-for-payment','payment-history','invoice-reports','financial-reports')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'viewer', menu_item_id, TRUE FROM menu_items
WHERE menu_id IN ('invoice-details','payment-history','invoice-reports')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- ============================================
-- 6. Purchase Orders (21 POs – all status OPEN)
-- Data is set so that when you click Validate on Invoice Details you can test:
--   Partially fulfilled: PO-PF-* (missing docs or GRN < invoice)
--   Debit note:         PO-DN-* (GRN 6 < invoice 10) -> after Validate -> debit_note_approval
--   Full match:         PO-FULL-*, PO-EXC-*, PO-RFP-*, PO-APR-*, PO-DONE-* (GRN 10 = invoice 10) -> after Validate -> ready_for_payment
--   Exception:          Fulfill one PO then add a second invoice for same PO and Validate -> exception_approval
-- ============================================
INSERT INTO purchase_orders (unit, ref_unit, pfx, po_number, date, amd_no, suplr_id, supplier_id, terms, status)
SELECT 'U1', 'U1', 'MTS1', n, '2025-01-01'::date + (row_number() OVER ())::integer * 3, 0, 'V1', (SELECT supplier_id FROM suppliers WHERE supplier_name = 'YOGA TOOLS' LIMIT 1), '30 DAYS FROM RECEIPT OF MATERIAL', 'open'
FROM (VALUES
  ('PO-PF-01'),('PO-PF-02'),('PO-PF-03'),
  ('PO-DN-01'),('PO-DN-02'),('PO-DN-03'),
  ('PO-FULL-01'),('PO-FULL-02'),('PO-FULL-03'),
  ('PO-EXC-01'),('PO-EXC-02'),('PO-EXC-03'),
  ('PO-RFP-01'),('PO-RFP-02'),('PO-RFP-03'),
  ('PO-APR-01'),('PO-APR-02'),('PO-APR-03'),
  ('PO-DONE-01'),('PO-DONE-02'),('PO-DONE-03')
) AS t(n)
ON CONFLICT (po_number, amd_no) DO UPDATE SET status = 'open', supplier_id = EXCLUDED.supplier_id, terms = EXCLUDED.terms;

-- 7. Purchase Order Lines (1 line per PO, qty 10, unit_cost 100)
INSERT INTO purchase_order_lines (po_id, sequence_number, item_id, description1, qty, unit_cost, disc_pct)
SELECT po.po_id, 1, 'ITEM-01', 'Test item for ' || po.po_number, 10, 100.0000, 0
FROM purchase_orders po
WHERE po.po_number LIKE 'PO-%';

-- ============================================
-- 8. ASN
-- PO-PF-01: no ASN (missing). All others have ASN.
-- ============================================
INSERT INTO asn (po_id, supplier_id, asn_no, supplier, supplier_name, dc_no, dc_date, inv_no, inv_date, lr_no, lr_date, unit, transporter, transporter_name, doc_no_date, status)
SELECT po.po_id, po.supplier_id, 'ASN-'||po.po_number, 'V1', s.supplier_name, 'DC-'||po.po_number, po.date + 2, '', po.date + 2, 'LR-'||po.po_number, po.date + 3, 'U1', 'Transporter A', 'Transporter A', to_char(po.date + 2, 'DD-Mon-YYYY'), 'received'
FROM purchase_orders po
LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
WHERE po.po_number LIKE 'PO-%' AND po.po_number != 'PO-PF-01';

-- ============================================
-- 9. GRN (quantities set so Validate gives each scenario)
-- PO-PF-01, PO-PF-02: no GRN (missing).
-- PO-PF-03: GRN 5 (partial) -> invoice 10 > GRN 5 -> debit note after Validate.
-- PO-DN-*: GRN 6, invoice 10 -> debit_note_approval after Validate.
-- All others: GRN 10, invoice 10 -> ready_for_payment after Validate.
-- ============================================
INSERT INTO grn (po_id, supplier_id, unit, dc_no, dc_date, grn_pfx, grn_no, grn_line, grn_date, po_no, supplier_name, supplier, item, description_1, uom, grn_qty, accepted_qty, unit_cost, header_status, line_status)
SELECT po.po_id, po.supplier_id, 'U1', 'DC-'||po.po_number, po.date + 2, 'GRN', 'GRN-'||po.po_number, 1, po.date + 5, po.po_number, s.supplier_name, 'V1', 'ITEM-01', 'Goods for '||po.po_number, 'Nos',
  CASE WHEN po.po_number LIKE 'PO-DN-%' THEN 6 WHEN po.po_number = 'PO-PF-03' THEN 5 ELSE 10 END,
  CASE WHEN po.po_number LIKE 'PO-DN-%' THEN 6 WHEN po.po_number = 'PO-PF-03' THEN 5 ELSE 10 END,
  100, 'received', 'received'
FROM purchase_orders po
LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
WHERE po.po_number LIKE 'PO-%'
  AND po.po_number NOT IN ('PO-PF-01','PO-PF-02');

-- ============================================
-- 10. Invoices (all POs that have at least one doc; status = waiting_for_validation – Validate will change it)
-- PO-PF-01: no invoice (missing). PO-PF-02, PO-PF-03 and all others have invoice.
-- ============================================
INSERT INTO invoices (invoice_number, invoice_date, supplier_id, po_id, scanning_number, po_number, total_amount, tax_amount, status, payment_due_date, notes)
SELECT 'INV-'||po.po_number, po.date + 5, po.supplier_id, po.po_id, 'SCN-'||po.po_number, po.po_number,
  1000.00, 180.00,
  'waiting_for_validation',
  po.date + 35,
  'Test invoice ' || po.po_number
FROM purchase_orders po
WHERE po.po_number LIKE 'PO-%' AND po.po_number != 'PO-PF-01'
ON CONFLICT (invoice_number) DO UPDATE SET
  status = 'waiting_for_validation',
  total_amount = EXCLUDED.total_amount,
  tax_amount = EXCLUDED.tax_amount,
  payment_due_date = EXCLUDED.payment_due_date,
  debit_note_value = NULL;

-- ============================================
-- 11. Invoice Lines (billed_qty = 10 for all; validation compares to PO total 10 and GRN)
-- ============================================
INSERT INTO invoice_lines (invoice_id, po_id, po_line_id, item_name, hsn_sac, uom, billed_qty, rate, rate_per, line_total, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount, total_tax_amount, sequence_number)
SELECT i.invoice_id, pol.po_id, pol.po_line_id, pol.description1, '8466', 'Nos', pol.qty, pol.unit_cost, 'Nos',
  (pol.qty * pol.unit_cost)::DECIMAL(15,2), (pol.qty * pol.unit_cost)::DECIMAL(15,2),
  9, (pol.qty * pol.unit_cost * 0.09)::DECIMAL(15,2), 9, (pol.qty * pol.unit_cost * 0.09)::DECIMAL(15,2), (pol.qty * pol.unit_cost * 0.18)::DECIMAL(15,2), pol.sequence_number
FROM invoices i
JOIN purchase_orders po ON po.po_number = i.po_number AND (po.amd_no = 0 OR po.amd_no IS NULL)
JOIN purchase_order_lines pol ON pol.po_id = po.po_id
WHERE i.po_number LIKE 'PO-%'
  AND NOT EXISTS (SELECT 1 FROM invoice_lines il WHERE il.invoice_id = i.invoice_id AND il.po_line_id = pol.po_line_id);

-- No payment_approvals in seed – create via Approve Payments / Ready for Payments after validation.
