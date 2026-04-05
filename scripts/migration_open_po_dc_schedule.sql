-- Run once on existing databases (after pulling schema changes).
-- Creates open_po_prefixes, po_schedules if missing. delivery_challans already exists in base schema.

CREATE TABLE IF NOT EXISTS open_po_prefixes (
  id                 BIGSERIAL PRIMARY KEY,
  prefix             VARCHAR(50) NOT NULL UNIQUE,
  description        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_open_po_prefixes_prefix ON open_po_prefixes (prefix);

CREATE TABLE IF NOT EXISTS po_schedules (
  id                 BIGSERIAL PRIMARY KEY,
  po_id              BIGINT      REFERENCES purchase_orders(po_id) ON DELETE SET NULL,
  po_number          VARCHAR(50),
  ord_pfx            VARCHAR(50),
  ord_no             VARCHAR(50),
  schedule_ref       VARCHAR(100),
  ss_pfx             VARCHAR(50),
  ss_no              VARCHAR(50),
  line_no            INTEGER,
  item_id            VARCHAR(100),
  description        TEXT,
  sched_qty          NUMERIC(18, 4),
  sched_date         DATE,
  promise_date       DATE,
  required_date      DATE,
  unit               VARCHAR(50),
  uom                VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_po_schedules_po_id ON po_schedules (po_id);
CREATE INDEX IF NOT EXISTS idx_po_schedules_po_number ON po_schedules (po_number);

-- Optional default prefix (Open PO detection)
INSERT INTO open_po_prefixes (prefix, description) VALUES ('OP', 'Default open PO pfx match (e.g. OP1, OP2)')
ON CONFLICT (prefix) DO NOTHING;
