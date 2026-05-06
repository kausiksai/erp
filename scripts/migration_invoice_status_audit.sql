-- Migration: audit trail for invoices.status changes
--
-- Why: on 2026-05-06 we noticed the validated count had dropped from 111
-- (yesterday's docx) to 101 (today) without any obvious cause — no row
-- deletions in this case, but 10 invoices had been demoted from
-- 'validated' to a pending state by some path other than the validation
-- engine (which never demotes validated rows). With no audit trail there
-- was no way to attribute the change.
--
-- This trigger captures every status transition (UPDATE only — INSERTs
-- with an initial status are not interesting) along with:
--   • timestamp
--   • old → new status
--   • DB user that ran the UPDATE
--   • application_name from the session (set by app drivers; identifies
--     whether it's the validation sweeper, the Node backend, psql, etc.)
--   • client IP address (helps distinguish VM vs Mac vs portal)
--
-- Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS invoice_status_audit (
  audit_id        BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT      NOT NULL,
  invoice_number  TEXT,
  old_status      TEXT,
  new_status      TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  db_user         TEXT        NOT NULL DEFAULT current_user,
  app_name        TEXT,
  client_addr     INET
);

CREATE INDEX IF NOT EXISTS invoice_status_audit_invoice_id_idx
  ON invoice_status_audit (invoice_id);
CREATE INDEX IF NOT EXISTS invoice_status_audit_changed_at_idx
  ON invoice_status_audit (changed_at DESC);

CREATE OR REPLACE FUNCTION trg_invoice_status_audit() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO invoice_status_audit (
      invoice_id, invoice_number, old_status, new_status,
      db_user, app_name, client_addr
    ) VALUES (
      NEW.invoice_id, NEW.invoice_number, OLD.status, NEW.status,
      current_user,
      current_setting('application_name', true),
      inet_client_addr()
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_status_audit ON invoices;
CREATE TRIGGER invoices_status_audit
  AFTER UPDATE OF status ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION trg_invoice_status_audit();

COMMIT;
