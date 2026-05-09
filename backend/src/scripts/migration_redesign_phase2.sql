-- Phase 2 redesign migration — additive only.
--
-- Adds three tables required by new screens that don't exist in the
-- current portal:
--
--   audit_events    — chronological log of every meaningful action
--   saved_views     — per-user saved filter combinations on list pages
--   notifications   — per-user toast / bell-feed notifications
--
-- All other existing tables are untouched. Safe to run multiple times.

BEGIN;

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------
-- Each meaningful action (validation runs, approvals, payment batches,
-- master edits, integration runs) inserts one row here. The Audit Log UI
-- queries this with filters on actor / action / entity / time.
--
-- Schema is intentionally generic: actor_kind tells the UI whether the
-- actor is a human user or the automation engine; entity_kind+entity_id
-- lets the UI link back to the relevant invoice / PO / supplier / rule.
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id      BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_kind    TEXT        NOT NULL CHECK (actor_kind IN ('user', 'automation', 'system')),
  actor_id      BIGINT,        -- user_id when actor_kind='user', NULL otherwise
  actor_label   TEXT,          -- denormalized 'Saikausik' / 'Validation engine' / 'Source ERP'
  action        TEXT        NOT NULL,  -- 'validated' | 'approved' | 'edited' | 'loaded' | 'failed' | ...
  entity_kind   TEXT,          -- 'invoice' | 'po' | 'grn' | 'supplier' | 'rule' | 'batch' | ...
  entity_id     TEXT,          -- string-typed — invoice_id, PO ref, GRN no, etc.
  entity_label  TEXT,          -- denormalized human label (invoice number, PO ref)
  summary       TEXT,          -- one-line human description
  meta          JSONB          -- structured details for drill-down
);

CREATE INDEX IF NOT EXISTS idx_audit_events_ts          ON audit_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor       ON audit_events (actor_kind, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity      ON audit_events (entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_action      ON audit_events (action);

COMMENT ON TABLE audit_events IS
  'Append-only audit trail. Read by /api/audit; written by validation engine, '
  'user-action handlers, and integration job runners.';


-- ---------------------------------------------------------------------------
-- saved_views
-- ---------------------------------------------------------------------------
-- Per-user named filter combos. The Invoices list (and later PO list, etc.)
-- shows these as chip filters above the table. `filters` is a JSONB blob
-- whose shape is owned by the frontend — backend just persists / returns it.
CREATE TABLE IF NOT EXISTS saved_views (
  view_id     BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  scope       TEXT        NOT NULL,   -- 'invoices' | 'purchase_orders' | 'receipts' | 'reconciliation'
  name        TEXT        NOT NULL,
  filters     JSONB       NOT NULL DEFAULT '{}',
  is_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, scope, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_views_user_scope ON saved_views (user_id, scope);

COMMENT ON TABLE saved_views IS
  'Per-user saved filter combinations on list pages. Frontend owns the '
  '`filters` JSONB shape; backend persists & returns it as-is.';


-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
-- Per-user feed for the topbar bell. Triggered server-side by integration
-- failures, queue thresholds, payment batches ready, etc.
--
-- Designed for the bell panel: filterable by read state, ordered by ts.
CREATE TABLE IF NOT EXISTS notifications (
  notification_id  BIGSERIAL PRIMARY KEY,
  user_id          BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  ts               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  variant          TEXT        NOT NULL CHECK (variant IN ('success', 'info', 'warn', 'danger')),
  title            TEXT        NOT NULL,
  body             TEXT,
  link             TEXT,        -- in-app deep link, e.g. '/invoices/validate?status=validated'
  read_at          TIMESTAMPTZ,
  meta             JSONB
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_ts
  ON notifications (user_id, ts DESC);

COMMENT ON TABLE notifications IS
  'Per-user bell-feed. Inserted by background jobs and action handlers; '
  'read by /api/notifications; marked read by the bell UI.';


COMMIT;
