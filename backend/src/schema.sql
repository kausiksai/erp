-- ============================================
-- Billing System Database Schema (Tables Only)
-- ============================================
-- Run schema.sql first, then data.sql for seed and test data.

-- ============================================
-- Users
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  user_id            BIGSERIAL PRIMARY KEY,
  username           TEXT        NOT NULL UNIQUE,
  email              TEXT        NOT NULL UNIQUE,
  password_hash      TEXT        NOT NULL,
  role               TEXT        NOT NULL DEFAULT 'user',
  full_name          TEXT,
  is_active          BOOLEAN     DEFAULT TRUE,
  last_login         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- ============================================
-- Suppliers
-- ============================================
CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id         BIGSERIAL PRIMARY KEY,
  supplier_name      TEXT        NOT NULL,
  gst_number         TEXT,
  pan_number         TEXT,
  supplier_address   TEXT,
  city               TEXT,
  state_code         TEXT,
  state_name         TEXT,
  pincode            TEXT,
  email              TEXT,
  phone              TEXT,
  mobile             TEXT,
  msme_number        TEXT,
  bank_account_name  TEXT,
  bank_account_number TEXT,
  bank_ifsc_code     TEXT,
  bank_name          TEXT,
  branch_name        TEXT,
  website            TEXT,
  contact_person     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_name)
);

CREATE INDEX IF NOT EXISTS idx_suppliers_gst ON suppliers (gst_number);
CREATE INDEX IF NOT EXISTS idx_suppliers_pan ON suppliers (pan_number);

-- ============================================
-- Owners
-- ============================================
CREATE TABLE IF NOT EXISTS owners (
  owner_id           BIGSERIAL PRIMARY KEY,
  owner_name         TEXT        NOT NULL,
  gst_number         TEXT,
  pan_number         TEXT,
  owner_address      TEXT,
  city               TEXT,
  state_code         TEXT,
  state_name         TEXT,
  pincode            TEXT,
  email              TEXT,
  phone              TEXT,
  mobile             TEXT,
  msme_number        TEXT,
  cin_number         TEXT,
  bank_account_name  TEXT,
  bank_account_number TEXT,
  bank_ifsc_code     TEXT,
  bank_name          TEXT,
  branch_name        TEXT,
  website            TEXT,
  contact_person     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_name)
);

CREATE INDEX IF NOT EXISTS idx_owners_gst ON owners (gst_number);
CREATE INDEX IF NOT EXISTS idx_owners_pan ON owners (pan_number);
CREATE INDEX IF NOT EXISTS idx_owners_cin ON owners (cin_number);

-- ============================================
-- Purchase Orders
-- ============================================
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id              BIGSERIAL PRIMARY KEY,
  unit               VARCHAR(50),
  ref_unit           VARCHAR(50),
  pfx                VARCHAR(50),
  po_number          VARCHAR(50) NOT NULL,
  date               DATE        NOT NULL,
  amd_no             SMALLINT    DEFAULT 0,
  suplr_id           VARCHAR(50),
  supplier_id        BIGINT      REFERENCES suppliers(supplier_id),
  terms              TEXT,
  status             TEXT        DEFAULT 'open',
  UNIQUE (po_number, amd_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_number ON purchase_orders (po_number);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_date ON purchase_orders (date);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_suplr_id ON purchase_orders (suplr_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders (status);

-- ============================================
-- Purchase Order Lines
-- ============================================
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  po_line_id         BIGSERIAL PRIMARY KEY,
  po_id              BIGINT      NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  sequence_number    INTEGER     NOT NULL DEFAULT 1,
  item_id            VARCHAR(50),
  description1       TEXT,
  qty                DECIMAL(15, 3),
  unit_cost          NUMERIC(18, 4),
  disc_pct           NUMERIC(5, 2) DEFAULT 0,
  raw_material       TEXT,
  process_description TEXT,
  norms              TEXT,
  process_cost       NUMERIC(18, 4),
  CONSTRAINT chk_po_lines_qty CHECK (qty IS NULL OR qty >= 0),
  CONSTRAINT chk_po_lines_sequence CHECK (sequence_number > 0)
);

CREATE INDEX IF NOT EXISTS idx_po_lines_po ON purchase_order_lines (po_id);
CREATE INDEX IF NOT EXISTS idx_po_lines_po_sequence ON purchase_order_lines (po_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_po_lines_item_id ON purchase_order_lines (item_id);

-- ============================================
-- Delivery Challans
-- ============================================
CREATE TABLE IF NOT EXISTS delivery_challans (
  id                 BIGSERIAL PRIMARY KEY,
  po_id              BIGINT      REFERENCES purchase_orders(po_id),
  supplier_id        BIGINT      REFERENCES suppliers(supplier_id),
  doc_no             BIGINT,
  dc_no              VARCHAR(50),
  dc_date            DATE,
  supplier           VARCHAR(50),
  name               VARCHAR(255),
  item               VARCHAR(50),
  rev                SMALLINT,
  uom                VARCHAR(50),
  description        TEXT,
  sf_code            VARCHAR(50),
  dc_qty             DECIMAL(15, 3),
  consumed           DECIMAL(15, 3),
  in_process         DECIMAL(15, 3),
  balance            DECIMAL(15, 3),
  out_days           INTEGER,
  other_type         TEXT,
  ord_type           VARCHAR(50),
  ord_pfx            VARCHAR(50),
  ord_no             VARCHAR(50),
  mi_doc_no          VARCHAR(50),
  ext_description    TEXT,
  unit               VARCHAR(50),
  unit_description   VARCHAR(255),
  ref_unit           VARCHAR(50),
  ref_unit_description VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_delivery_challans_dc_no ON delivery_challans (dc_no);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_po ON delivery_challans (po_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challans_supplier ON delivery_challans (supplier_id);

-- ============================================
-- GRN (Goods Receipt Note)
-- ============================================
CREATE TABLE IF NOT EXISTS grn (
  id                 BIGSERIAL PRIMARY KEY,
  po_id              BIGINT      REFERENCES purchase_orders(po_id),
  supplier_id        BIGINT      REFERENCES suppliers(supplier_id),
  unit               VARCHAR(50),
  unit_desc          VARCHAR(255),
  ref_unit           VARCHAR(50),
  territory          VARCHAR(50),
  ref_unit_desc      VARCHAR(255),
  dc_no              VARCHAR(50),
  dc_date            DATE,
  gate_entry_no      VARCHAR(50),
  gunny_bags         INTEGER,
  hdpe_bags          INTEGER,
  gross_weight       DECIMAL(15, 3),
  tare_weight        DECIMAL(15, 3),
  nett_weight        DECIMAL(15, 3),
  supplier_doc_no    VARCHAR(50),
  supplier_doc_date  DATE,
  grn_pfx            VARCHAR(50),
  grn_no             VARCHAR(50),
  grn_line           INTEGER,
  grn_date           DATE,
  grn_year           INTEGER,
  grn_period         INTEGER,
  exchange_rate      DECIMAL(15, 6),
  supplier           VARCHAR(50),
  supplier_name      VARCHAR(255),
  type               VARCHAR(50),
  pr_type            VARCHAR(50),
  type_1             VARCHAR(50),
  item               VARCHAR(50),
  rev                SMALLINT,
  description_1      TEXT,
  uom                VARCHAR(50),
  unit_cost          NUMERIC(18, 4),
  grn_qty            DECIMAL(15, 3),
  disc_amt           DECIMAL(15, 2),
  tax_amount         DECIMAL(15, 2),
  receipt_qty_toler  DECIMAL(15, 3),
  accepted_qty       DECIMAL(15, 3),
  rejected_qty       DECIMAL(15, 3),
  return_qty         DECIMAL(15, 3),
  rework_qty         DECIMAL(15, 3),
  excess_qty         DECIMAL(15, 3),
  excess_rtn_qty     DECIMAL(15, 3),
  invoice_qty        DECIMAL(15, 3),
  tax                VARCHAR(50),
  tax_desc           VARCHAR(255),
  warehouse          VARCHAR(50),
  warehouse_desc     VARCHAR(255),
  qc_pfx             VARCHAR(50),
  qc_no              VARCHAR(50),
  required_qty       DECIMAL(15, 3),
  required_date      DATE,
  promise_date       DATE,
  buyer              VARCHAR(50),
  buyer_name         VARCHAR(255),
  type_2             VARCHAR(50),
  process_group      VARCHAR(50),
  process_desc       TEXT,
  class              VARCHAR(50),
  class_desc         VARCHAR(255),
  sub_class          VARCHAR(50),
  sub_class_desc     VARCHAR(255),
  group_desc         VARCHAR(255),
  sub_group_desc     VARCHAR(255),
  po_pfx             VARCHAR(50),
  po_no              VARCHAR(50),
  po_line            INTEGER,
  po_schld           VARCHAR(50),
  ss_pfx             VARCHAR(50),
  ss_no              VARCHAR(50),
  ss_line            INTEGER,
  open_order_pfx     VARCHAR(50),
  open_order_no      VARCHAR(50),
  amd_no             SMALLINT,
  assessable_value   DECIMAL(18, 4),
  commodity_code     VARCHAR(50),
  bom_no             VARCHAR(50),
  prod_ord_no        VARCHAR(50),
  sf_code            VARCHAR(50),
  completed_process  VARCHAR(255),
  test_cert_req      VARCHAR(50),
  cert_ins           VARCHAR(50),
  description        TEXT,
  bom                VARCHAR(50),
  reference          VARCHAR(255),
  work_order_no      VARCHAR(50),
  task               VARCHAR(50),
  thickness          DECIMAL(15, 3),
  length             DECIMAL(15, 3),
  width              DECIMAL(15, 3),
  qty_nos            DECIMAL(15, 3),
  reference_1        VARCHAR(255),
  header_status      VARCHAR(50),
  line_status        VARCHAR(50),
  gst_type           VARCHAR(50),
  gstin_no           VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_grn_grn_no ON grn (grn_no);
CREATE INDEX IF NOT EXISTS idx_grn_dc_no ON grn (dc_no);
CREATE INDEX IF NOT EXISTS idx_grn_po_no ON grn (po_no);
CREATE INDEX IF NOT EXISTS idx_grn_po ON grn (po_id);
CREATE INDEX IF NOT EXISTS idx_grn_supplier ON grn (supplier_id);

-- ============================================
-- ASN (Advanced Shipping Notice)
-- ============================================
CREATE TABLE IF NOT EXISTS asn (
  id                 BIGSERIAL PRIMARY KEY,
  asn_no             VARCHAR(50),
  supplier           VARCHAR(50),
  supplier_name      VARCHAR(255),
  dc_no              VARCHAR(50),
  dc_date            DATE,
  inv_no             VARCHAR(50),
  inv_date           DATE,
  lr_no              VARCHAR(50),
  lr_date            DATE,
  unit               VARCHAR(50),
  transporter        VARCHAR(50),
  transporter_name   VARCHAR(255),
  doc_no_date        VARCHAR(100),
  status             VARCHAR(50)
);
-- PO number for ASN is derived via: asn.inv_no -> invoices.invoice_number -> invoices.po_id -> purchase_orders.po_number

CREATE INDEX IF NOT EXISTS idx_asn_asn_no ON asn (asn_no);
CREATE INDEX IF NOT EXISTS idx_asn_dc_no ON asn (dc_no);
CREATE INDEX IF NOT EXISTS idx_asn_inv_no ON asn (inv_no);

-- Migration for existing DBs that have asn.po_id / asn.supplier_id:
-- DROP INDEX IF EXISTS idx_asn_po; DROP INDEX IF EXISTS idx_asn_supplier;
-- ALTER TABLE asn DROP COLUMN IF EXISTS po_id, DROP COLUMN IF EXISTS supplier_id;
-- CREATE INDEX IF NOT EXISTS idx_asn_inv_no ON asn (inv_no);

-- ============================================
-- Invoices
-- ============================================
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id         BIGSERIAL PRIMARY KEY,
  invoice_number     TEXT        NOT NULL,
  invoice_date       DATE,
  supplier_id        BIGINT      REFERENCES suppliers(supplier_id),
  po_id              BIGINT      REFERENCES purchase_orders(po_id),
  scanning_number   TEXT,
  po_number          TEXT,
  total_amount       DECIMAL(15, 2),
  tax_amount         DECIMAL(15, 2),
  status             TEXT        DEFAULT 'waiting_for_validation',
  payment_due_date   DATE,
  debit_note_value   DECIMAL(15, 2),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date ON invoices (invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices (supplier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices (po_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po_number ON invoices (po_number);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

-- ============================================
-- Invoice Lines
-- ============================================
CREATE TABLE IF NOT EXISTS invoice_lines (
  invoice_line_id    BIGSERIAL PRIMARY KEY,
  invoice_id         BIGINT      NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  po_id              BIGINT      REFERENCES purchase_orders(po_id),
  po_line_id         BIGINT      REFERENCES purchase_order_lines(po_line_id),
  item_name          TEXT,
  hsn_sac            TEXT,
  uom                TEXT,
  billed_qty         DECIMAL(15, 3),
  weight             DECIMAL(15, 3),
  count              INTEGER,
  rate               DECIMAL(15, 2),
  rate_per           TEXT,
  line_total         DECIMAL(15, 2),
  taxable_value      DECIMAL(15, 2),
  cgst_rate          DECIMAL(5, 2),
  cgst_amount        DECIMAL(15, 2),
  sgst_rate          DECIMAL(5, 2),
  sgst_amount        DECIMAL(15, 2),
  total_tax_amount   DECIMAL(15, 2),
  sequence_number    INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_po ON invoice_lines (po_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_po_line ON invoice_lines (po_line_id);

-- ============================================
-- Invoice Attachments (main invoice PDF only)
-- ============================================
CREATE TABLE IF NOT EXISTS invoice_attachments (
  id                 BIGSERIAL PRIMARY KEY,
  invoice_id         BIGINT      REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  file_name          TEXT        NOT NULL,
  file_path          TEXT,
  file_data          BYTEA,
  attachment_type    TEXT        DEFAULT 'invoice',
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For existing DBs: add attachment_type if missing.
ALTER TABLE invoice_attachments ADD COLUMN IF NOT EXISTS attachment_type TEXT DEFAULT 'invoice';
-- Optional migration: move existing weight slips to invoice_weight_attachments before dropping column (run once if you had weight slips in invoice_attachments):
--   INSERT INTO invoice_weight_attachments (invoice_line_id, file_name, file_data, uploaded_at)
--   SELECT invoice_line_id, file_name, file_data, uploaded_at FROM invoice_attachments WHERE attachment_type = 'weight_slip' AND invoice_line_id IS NOT NULL ON CONFLICT (invoice_line_id) DO NOTHING;
--   DELETE FROM invoice_attachments WHERE attachment_type = 'weight_slip';
ALTER TABLE invoice_attachments DROP COLUMN IF EXISTS invoice_line_id;

CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice ON invoice_attachments (invoice_id);

-- ============================================
-- Invoice Weight Attachments (one weight slip per invoice line)
-- ============================================
CREATE TABLE IF NOT EXISTS invoice_weight_attachments (
  id                 BIGSERIAL PRIMARY KEY,
  invoice_line_id    BIGINT      NOT NULL REFERENCES invoice_lines(invoice_line_id) ON DELETE CASCADE,
  file_name          TEXT        NOT NULL,
  file_data          BYTEA,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_line_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_weight_attachments_line ON invoice_weight_attachments (invoice_line_id);

-- ============================================
-- Debit Notes (separate from invoice_attachments)
-- ============================================
CREATE TABLE IF NOT EXISTS debit_notes (
  debit_note_id      BIGSERIAL PRIMARY KEY,
  invoice_id         BIGINT      NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  file_name          TEXT        NOT NULL,
  file_path          TEXT,
  file_data          BYTEA,
  notes              TEXT,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debit_notes_invoice ON debit_notes (invoice_id);

-- ============================================
-- Debit Note Details (line items / details for a debit note)
-- ============================================
CREATE TABLE IF NOT EXISTS debit_note_details (
  debit_note_detail_id BIGSERIAL PRIMARY KEY,
  debit_note_id       BIGINT      NOT NULL REFERENCES debit_notes(debit_note_id) ON DELETE CASCADE,
  line_number        INTEGER,
  description        TEXT,
  quantity           DECIMAL(15, 3),
  unit_price         DECIMAL(15, 2),
  amount             DECIMAL(15, 2),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debit_note_details_debit_note ON debit_note_details (debit_note_id);

-- ============================================
-- Payment Approvals
-- ============================================
CREATE TABLE IF NOT EXISTS payment_approvals (
  id                 BIGSERIAL PRIMARY KEY,
  invoice_id         BIGINT      NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  po_id              BIGINT      REFERENCES purchase_orders(po_id),
  supplier_id        BIGINT      REFERENCES suppliers(supplier_id),
  status             TEXT        NOT NULL DEFAULT 'pending_approval',
  total_amount       DECIMAL(15, 2),
  debit_note_value   DECIMAL(15, 2),
  bank_account_name  TEXT,
  bank_account_number TEXT,
  bank_ifsc_code     TEXT,
  bank_name          TEXT,
  branch_name        TEXT,
  approved_by        BIGINT      REFERENCES users(user_id),
  approved_at        TIMESTAMPTZ,
  rejection_reason   TEXT,
  rejected_by        BIGINT      REFERENCES users(user_id),
  rejected_at        TIMESTAMPTZ,
  payment_done_by    BIGINT      REFERENCES users(user_id),
  payment_done_at    TIMESTAMPTZ,
  payment_type       TEXT,
  payment_reference  TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_approvals_invoice ON payment_approvals (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_approvals_po ON payment_approvals (po_id);
CREATE INDEX IF NOT EXISTS idx_payment_approvals_status ON payment_approvals (status);

-- ============================================
-- Payment Transactions (partial payments)
-- ============================================
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                   BIGSERIAL PRIMARY KEY,
  payment_approval_id  BIGINT      NOT NULL REFERENCES payment_approvals(id) ON DELETE CASCADE,
  amount               DECIMAL(15, 2) NOT NULL,
  paid_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_by              BIGINT      REFERENCES users(user_id),
  payment_type         TEXT,
  payment_reference    TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_approval ON payment_transactions (payment_approval_id);

-- ============================================
-- Menu Items
-- ============================================
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

-- ============================================
-- Role Menu Access
-- ============================================
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
-- Optional: migrate existing invoice statuses to new lifecycle (run if you have existing data)
-- ============================================
-- ALTER TABLE invoices ALTER COLUMN status SET DEFAULT 'waiting_for_validation';
-- UPDATE invoices SET status = 'waiting_for_validation' WHERE LOWER(TRIM(status)) = 'pending';
-- UPDATE invoices SET status = 'paid' WHERE LOWER(TRIM(status)) = 'completed';
