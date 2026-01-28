-- ============================================
-- Billing System Database Schema
-- Complete database schema with all tables, menu items, and initial data
-- ============================================

-- ============================================
-- Users Table (for authentication and role-based access)
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  user_id            BIGSERIAL PRIMARY KEY,
  username            TEXT        NOT NULL UNIQUE,
  email               TEXT        NOT NULL UNIQUE,
  password_hash       TEXT        NOT NULL,
  role                TEXT        NOT NULL DEFAULT 'user',
  full_name           TEXT,
  is_active           BOOLEAN     DEFAULT TRUE,
  last_login          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- ============================================
-- Supporting Tables (create first)
-- ============================================

-- Suppliers Table
CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id           BIGSERIAL PRIMARY KEY,
  supplier_name         TEXT        NOT NULL,
  gst_number            TEXT,
  pan_number            TEXT,
  supplier_address      TEXT,
  city                  TEXT,
  state_code            TEXT,
  state_name            TEXT,
  pincode               TEXT,
  email                 TEXT,
  phone                 TEXT,
  mobile                TEXT,
  msme_number           TEXT,
  -- Bank Details
  bank_account_name     TEXT,
  bank_account_number   TEXT,
  bank_ifsc_code        TEXT,
  bank_name             TEXT,
  branch_name           TEXT,
  -- Additional Fields
  website               TEXT,
  contact_person        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_name)
);

CREATE INDEX IF NOT EXISTS idx_suppliers_gst ON suppliers (gst_number);
CREATE INDEX IF NOT EXISTS idx_suppliers_pan ON suppliers (pan_number);

-- Owners Table (Company/Owner Information)
CREATE TABLE IF NOT EXISTS owners (
  owner_id              BIGSERIAL PRIMARY KEY,
  owner_name            TEXT        NOT NULL,
  gst_number            TEXT,
  pan_number            TEXT,
  owner_address         TEXT,
  city                  TEXT,
  state_code            TEXT,
  state_name            TEXT,
  pincode               TEXT,
  email                 TEXT,
  phone                 TEXT,
  mobile                TEXT,
  msme_number           TEXT,
  cin_number            TEXT,        -- Company Identification Number
  -- Bank Details
  bank_account_name     TEXT,
  bank_account_number   TEXT,
  bank_ifsc_code        TEXT,
  bank_name             TEXT,
  branch_name           TEXT,
  -- Additional Fields
  website               TEXT,
  contact_person        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_name)
);

CREATE INDEX IF NOT EXISTS idx_owners_gst ON owners (gst_number);
CREATE INDEX IF NOT EXISTS idx_owners_pan ON owners (pan_number);
CREATE INDEX IF NOT EXISTS idx_owners_cin ON owners (cin_number);

-- ============================================
-- Purchase Order Tables
-- ============================================

-- Purchase Order Master Table
-- Contains basic PO information - financial details are in invoices
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id            BIGSERIAL PRIMARY KEY,
  po_number        TEXT        NOT NULL UNIQUE,
  po_date          DATE        NOT NULL,
  supplier_id      BIGINT      REFERENCES suppliers(supplier_id),
  bill_to          TEXT        NOT NULL,
  bill_to_address  TEXT,
  bill_to_gstin    TEXT,
  status           TEXT        DEFAULT 'pending',
  terms_and_conditions TEXT,
  payment_terms    TEXT,
  delivery_terms   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_number ON purchase_orders (po_number);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_date ON purchase_orders (po_date);

-- Purchase Order Lines Table
-- Contains basic item information from the purchase order
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  po_line_id       BIGSERIAL PRIMARY KEY,
  po_id            BIGINT      NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  item_name        TEXT        NOT NULL,
  item_description TEXT,
  hsn_sac          TEXT,
  uom              TEXT,        -- Unit of Measure (Kgs, Nos, etc.)
  quantity         DECIMAL(15, 3),
  sequence_number  INTEGER,     -- Line item sequence number
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_lines_po ON purchase_order_lines (po_id);

-- ============================================
-- Invoice Tables
-- ============================================

-- Invoice Master Table
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id      BIGSERIAL PRIMARY KEY,
  invoice_number  TEXT        NOT NULL,
  invoice_date    DATE,
  supplier_id     BIGINT      REFERENCES suppliers(supplier_id),
  po_id           BIGINT      REFERENCES purchase_orders(po_id),
  scanning_number  TEXT,
  po_number       TEXT,        -- Purchase Order Number extracted from invoice
  total_amount    DECIMAL(15, 2),
  tax_amount      DECIMAL(15, 2),
  status          TEXT        DEFAULT 'pending',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date ON invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices (po_id);

-- Invoice Line Table
-- Contains actual billing details with rates, taxes, and amounts
CREATE TABLE IF NOT EXISTS invoice_lines (
  invoice_line_id BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT      NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  po_id           BIGINT      REFERENCES purchase_orders(po_id),
  po_line_id      BIGINT      REFERENCES purchase_order_lines(po_line_id),
  item_name       TEXT,
  hsn_sac         TEXT,
  uom             TEXT,        -- Unit of Measure (Kgs, Nos, etc.)
  billed_qty      DECIMAL(15, 3),
  weight          DECIMAL(15, 3),  -- Weight in kg (if applicable)
  count           INTEGER,         -- Count/quantity (if applicable)
  rate            DECIMAL(15, 2),
  rate_per        TEXT,        -- Rate per unit (Kgs, Nos, etc.)
  line_total      DECIMAL(15, 2),
  taxable_value   DECIMAL(15, 2),
  cgst_rate       DECIMAL(5, 2),
  cgst_amount     DECIMAL(15, 2),
  sgst_rate       DECIMAL(5, 2),
  sgst_amount     DECIMAL(15, 2),
  total_tax_amount DECIMAL(15, 2),
  sequence_number INTEGER,    -- Line item sequence number
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_po ON invoice_lines (po_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_po_line ON invoice_lines (po_line_id);

-- Invoice attachments (for storing uploaded PDFs)
CREATE TABLE IF NOT EXISTS invoice_attachments (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT      REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  file_name       TEXT        NOT NULL,
  file_path       TEXT,
  file_data       BYTEA,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice ON invoice_attachments (invoice_id);

-- ============================================
-- Menu Items and Role-Based Access Control
-- ============================================

-- Menu Items Table
CREATE TABLE IF NOT EXISTS menu_items (
  menu_item_id       BIGSERIAL PRIMARY KEY,
  menu_id            TEXT        NOT NULL UNIQUE,
  title              TEXT        NOT NULL,
  description        TEXT,
  icon               TEXT        NOT NULL,
  path               TEXT        NOT NULL,
  color              TEXT        NOT NULL,
  category_id        TEXT        NOT NULL,
  category_title     TEXT        NOT NULL,
  category_description TEXT,
  display_order      INTEGER     DEFAULT 0,
  is_active          BOOLEAN     DEFAULT TRUE,
  is_coming_soon     BOOLEAN     DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items (category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_active ON menu_items (is_active);
CREATE INDEX IF NOT EXISTS idx_menu_items_display_order ON menu_items (display_order);

-- Role Menu Access Table
CREATE TABLE IF NOT EXISTS role_menu_access (
  access_id          BIGSERIAL PRIMARY KEY,
  role               TEXT        NOT NULL,
  menu_item_id       BIGINT      NOT NULL REFERENCES menu_items(menu_item_id) ON DELETE CASCADE,
  has_access         BOOLEAN     DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role, menu_item_id)
);

CREATE INDEX IF NOT EXISTS idx_role_menu_access_role ON role_menu_access (role);
CREATE INDEX IF NOT EXISTS idx_role_menu_access_menu ON role_menu_access (menu_item_id);
CREATE INDEX IF NOT EXISTS idx_role_menu_access_active ON role_menu_access (has_access);

-- ============================================
-- Insert Menu Items
-- ============================================

-- Status & Actions Category
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('incomplete-pos', 'Incomplete Purchase Orders', 'View POs missing invoices, ASN, or GRN and update missing details', 'pi pi-exclamation-triangle', '/purchase-orders/incomplete', '#dc2626', 'status-actions', 'Status & Actions', 'Track incomplete records and pending actions', 1, TRUE, FALSE)
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

-- Invoice Management Category
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('invoice-upload', 'Invoice Upload', 'Upload invoices and extract data automatically', 'pi pi-file-pdf', '/invoices/upload', '#059669', 'invoices', 'Invoice Management', 'Manage invoices, validation, and details', 1, TRUE, FALSE),
('invoice-details', 'Invoice Details', 'View and manage invoice details and validation', 'pi pi-file-edit', '/invoices/validate', '#2563eb', 'invoices', 'Invoice Management', 'Manage invoices, validation, and details', 2, TRUE, FALSE)
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

-- Purchase Orders Category
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('purchase-order', 'Purchase Order Details', 'View and manage purchase order details', 'pi pi-shopping-cart', '/purchase-orders/upload', '#7c3aed', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 1, TRUE, FALSE),
('grn-details', 'GRN Details', 'Goods Receipt Note management and tracking', 'pi pi-box', '/grn/details', '#ea580c', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 2, TRUE, TRUE),
('asn-details', 'ASN Details', 'Advanced Shipping Notice management', 'pi pi-truck', '/asn/details', '#0891b2', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 3, TRUE, TRUE)
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

-- Master Data Category
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('user-registration', 'User Registration', 'Register and manage system users', 'pi pi-users', '/users/registration', '#dc2626', 'master-data', 'Master Data', 'Manage users, suppliers, and system configuration', 1, TRUE, FALSE),
('owner-details', 'Owner Details', 'View and edit company owner details', 'pi pi-id-card', '/owners/details', '#9333ea', 'master-data', 'Master Data', 'Manage users, suppliers, and system configuration', 2, TRUE, FALSE),
('supplier-registration', 'Supplier Registration', 'Register and manage supplier information', 'pi pi-building', '/suppliers/registration', '#ca8a04', 'master-data', 'Master Data', 'Manage users, suppliers, and system configuration', 3, TRUE, TRUE)
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

-- Finance & Payments Category
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('finance-dashboard', 'Finance Dashboard', 'Comprehensive financial overview and analytics', 'pi pi-chart-line', '/finance/dashboard', '#16a34a', 'finance', 'Finance & Payments', 'Financial dashboard and payment management', 1, TRUE, TRUE),
('ready-for-payment', 'Ready for Payments', 'Manage invoices ready for payment processing', 'pi pi-money-bill', '/payments/ready', '#0284c7', 'finance', 'Finance & Payments', 'Financial dashboard and payment management', 2, TRUE, TRUE),
('payment-history', 'Payment History', 'View and track payment history and status', 'pi pi-history', '/payments/history', '#9333ea', 'finance', 'Finance & Payments', 'Financial dashboard and payment management', 3, TRUE, TRUE)
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

-- Reports & Analytics Category
INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('invoice-reports', 'Invoice Reports', 'Generate comprehensive invoice reports', 'pi pi-file', '/reports/invoices', '#be123c', 'reports', 'Reports & Analytics', 'Generate reports and view analytics', 1, TRUE, TRUE),
('financial-reports', 'Financial Reports', 'Generate financial statements and reports', 'pi pi-chart-bar', '/reports/financial', '#0d9488', 'reports', 'Reports & Analytics', 'Generate reports and view analytics', 2, TRUE, TRUE),
('supplier-reports', 'Supplier Reports', 'Analyze supplier performance and reports', 'pi pi-chart-pie', '/reports/suppliers', '#c2410c', 'reports', 'Reports & Analytics', 'Generate reports and view analytics', 3, TRUE, TRUE)
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
-- Grant Role-Based Access to Menu Items
-- ============================================

-- Grant Admin Access to ALL Menu Items
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'admin', menu_item_id, TRUE
FROM menu_items
WHERE is_active = TRUE
ON CONFLICT (role, menu_item_id) DO UPDATE SET 
  has_access = TRUE, 
  updated_at = NOW();

-- Grant Manager Access to Specific Menu Items
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'manager', menu_item_id, TRUE
FROM menu_items
WHERE menu_id IN (
  'incomplete-pos',
  'invoice-upload',
  'invoice-details',
  'purchase-order',
  'grn-details',
  'asn-details',
  'user-registration',
  'supplier-registration',
  'finance-dashboard',
  'ready-for-payment',
  'payment-history',
  'invoice-reports',
  'financial-reports',
  'supplier-reports'
)
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Grant User Access to Specific Menu Items
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'user', menu_item_id, TRUE
FROM menu_items
WHERE menu_id IN (
  'incomplete-pos',
  'invoice-upload',
  'invoice-details',
  'purchase-order',
  'grn-details',
  'asn-details',
  'supplier-registration'
)
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Grant Finance Role Access to Specific Menu Items
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'finance', menu_item_id, TRUE
FROM menu_items
WHERE menu_id IN (
  'invoice-details',
  'finance-dashboard',
  'ready-for-payment',
  'payment-history',
  'invoice-reports',
  'financial-reports'
)
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Grant Viewer Role Access to Specific Menu Items
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'viewer', menu_item_id, TRUE
FROM menu_items
WHERE menu_id IN (
  'invoice-details',
  'payment-history',
  'invoice-reports'
)
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- ============================================
-- Insert Admin User
-- ============================================
-- Password: Admin@123
-- Email: admin@srimukha.com

INSERT INTO users (
  username,
  email,
  password_hash,
  role,
  full_name,
  is_active
) VALUES (
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
  updated_at = NOW()
ON CONFLICT (email) DO UPDATE SET
  username = EXCLUDED.username,
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role,
  full_name = EXCLUDED.full_name,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- ============================================
-- Initial Data (Optional - Sample Data)
-- ============================================

-- Insert Supplier Data
-- BHANDARI METAL ENTERPRISES
INSERT INTO suppliers (
  supplier_name,
  gst_number,
  pan_number,
  supplier_address,
  city,
  state_code,
  state_name,
  pincode,
  email,
  phone,
  mobile,
  msme_number,
  bank_account_name,
  bank_account_number,
  bank_ifsc_code,
  bank_name,
  branch_name,
  contact_person,
  created_at,
  updated_at
)
VALUES (
  'BHANDARI METAL ENTERPRISES',
  '33AALPP7410Q1Z7',
  'AALPP7410Q',
  'No.107 & 108, Armenian Street',
  'Chennai',
  '33',
  'Tamil Nadu',
  '600001',
  'bhandarimetal@gmail.com',
  '044-25228317',
  '8667783180',
  'UDYAM-TN-02-0199275',
  'BHANDARI METAL ENTERPRISES',
  '50200006232357',
  'HDFC0000166',
  'HDFC Bank Ltd',
  'Second Line Beach Road',
  NULL,
  NOW(),
  NOW()
)
ON CONFLICT (supplier_name) 
DO UPDATE SET 
  gst_number = EXCLUDED.gst_number,
  pan_number = EXCLUDED.pan_number,
  supplier_address = EXCLUDED.supplier_address,
  city = EXCLUDED.city,
  state_code = EXCLUDED.state_code,
  state_name = EXCLUDED.state_name,
  pincode = EXCLUDED.pincode,
  email = EXCLUDED.email,
  phone = EXCLUDED.phone,
  mobile = EXCLUDED.mobile,
  msme_number = EXCLUDED.msme_number,
  bank_account_name = EXCLUDED.bank_account_name,
  bank_account_number = EXCLUDED.bank_account_number,
  bank_ifsc_code = EXCLUDED.bank_ifsc_code,
  bank_name = EXCLUDED.bank_name,
  branch_name = EXCLUDED.branch_name,
  updated_at = NOW();

-- Insert Owner Data
-- SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED
INSERT INTO owners (
  owner_name,
  gst_number,
  pan_number,
  owner_address,
  city,
  state_code,
  state_name,
  pincode,
  email,
  phone,
  mobile,
  cin_number,
  bank_account_name,
  bank_account_number,
  bank_ifsc_code,
  bank_name,
  branch_name,
  contact_person,
  created_at,
  updated_at
)
VALUES (
  'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED',
  '33ABNCS1862K1ZZ',
  'ABNCS1862K',
  'NO.63-A, 9TH STREET NORTH PHASE, AMBATTUR INDUSTRIAL ESTATE',
  'Chennai',
  '33',
  'Tamil Nadu',
  '600098',
  NULL,
  NULL,
  NULL,
  'U26517TN2024PTC169214',
  'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NOW(),
  NOW()
)
ON CONFLICT (owner_name) 
DO UPDATE SET 
  gst_number = EXCLUDED.gst_number,
  pan_number = EXCLUDED.pan_number,
  owner_address = EXCLUDED.owner_address,
  city = EXCLUDED.city,
  state_code = EXCLUDED.state_code,
  state_name = EXCLUDED.state_name,
  pincode = EXCLUDED.pincode,
  cin_number = EXCLUDED.cin_number,
  updated_at = NOW();

-- Insert Purchase Order Data (Sample)
-- PO Number: PO9250648/2025-26
INSERT INTO purchase_orders (
  po_number,
  po_date,
  supplier_id,
  bill_to,
  bill_to_address,
  bill_to_gstin,
  status,
  terms_and_conditions,
  payment_terms,
  delivery_terms,
  created_at,
  updated_at
)
VALUES (
  'PO9250648/2025-26',
  '2025-07-31',
  (SELECT supplier_id FROM suppliers WHERE supplier_name = 'BHANDARI METAL ENTERPRISES' LIMIT 1),
  'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED - U9',
  'NO.63-A, 9TH STREET NORTH PHASE, AMBATTUR INDUSTRIAL ESTATE, CHENNAI - 600098',
  '33ABNCS1862K1ZZ',
  'pending',
  '1. Our responsibility ceases after the goods leave our premises
2. Interest @ 18% p.a. will be charged in delay payment
3. No complaint will be accepted after 5 days of supply.
4. Any rejection, the shares of the materials should remain the same.',
  '30 Days',
  'FOB',
  NOW(),
  NOW()
)
ON CONFLICT (po_number) DO NOTHING;

-- Insert Purchase Order Line Items (Sample)
INSERT INTO purchase_order_lines (
  po_id,
  item_name,
  item_description,
  hsn_sac,
  uom,
  quantity,
  sequence_number,
  created_at,
  updated_at
)
VALUES (
  (SELECT po_id FROM purchase_orders WHERE po_number = 'PO9250648/2025-26' LIMIT 1),
  'Pipe 73064000 304 Gr 11/2" 10G - 15 Nos',
  'Pipe 73064000 304 Gr 11/2" 10G - 15 Nos',
  '73064000',
  'Kgs',
  240.700,
  1,
  NOW(),
  NOW()
)
ON CONFLICT DO NOTHING;
