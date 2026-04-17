-- ============================================================================
-- Per-user menu access
--   Replaces the previous (buggy) behaviour where editing "one user's menu
--   access" actually rewrote the entire role's access rows, silently
--   affecting every user with that role.
--   role_menu_access stays as the default/template when a user has no
--   personal overrides.
-- ============================================================================
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- user_menu_access — explicit per-user overrides.
-- ----------------------------------------------------------------------------
-- Semantics: when a user has ANY row in this table, that is their full
-- effective menu set (missing items are denied). When they have no rows
-- at all, the sidebar falls back to role_menu_access for their role.
CREATE TABLE IF NOT EXISTS user_menu_access (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  menu_item_id   BIGINT      NOT NULL REFERENCES menu_items(menu_item_id) ON DELETE CASCADE,
  has_access     BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_by     BIGINT      REFERENCES users(user_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, menu_item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_menu_access_user ON user_menu_access (user_id);
CREATE INDEX IF NOT EXISTS idx_user_menu_access_menu ON user_menu_access (menu_item_id);

-- ----------------------------------------------------------------------------
-- Refresh menu_items to match the new portal's actual sidebar.
-- The old seed referenced routes that were renamed or removed during the
-- rewrite (e.g. /grn/details, /invoices/reconciliation wasn't present).
-- UPSERT on menu_id so existing rows are updated in place and role_menu_access
-- / user_menu_access foreign keys are preserved.
-- ----------------------------------------------------------------------------
INSERT INTO menu_items
  (menu_id, title, description, icon, path, color,
   category_id, category_title, category_description, display_order, is_active, is_coming_soon)
VALUES
  ('dashboard',              'Dashboard',             'Portal home',                               'pi-th-large',             '/',                           '#3b82f6', 'overview', 'Overview', NULL, 1,  TRUE, FALSE),
  ('analytics',              'Analytics',             'Charts and trends',                         'pi-chart-line',           '/analytics',                  '#6366f1', 'overview', 'Overview', NULL, 2,  TRUE, FALSE),
  ('reports',                'Reports',               'CSV exports for every entity',              'pi-chart-bar',            '/reports',                    '#8b5cf6', 'overview', 'Overview', NULL, 3,  TRUE, FALSE),
  ('invoices',               'Invoices',              'Invoice list + validate',                   'pi-file',                 '/invoices/validate',          '#059669', 'workflow', 'Workflow', NULL, 1,  TRUE, FALSE),
  ('invoice-upload',         'Upload invoice',        'Portal OCR upload wizard',                  'pi-upload',               '/invoices/upload',            '#10b981', 'workflow', 'Workflow', NULL, 2,  TRUE, FALSE),
  ('invoice-reconciliation', 'Needs reconciliation',  'Dual-source Excel vs OCR review queue',     'pi-sync',                 '/invoices/reconciliation',    '#f59e0b', 'workflow', 'Workflow', NULL, 3,  TRUE, FALSE),
  ('payments',               'Payments',              'Approve, ready, history',                   'pi-wallet',               '/payments/approve',           '#0ea5e9', 'workflow', 'Workflow', NULL, 4,  TRUE, FALSE),
  ('incomplete-pos',         'Incomplete POs',        'POs missing invoice / GRN / ASN',           'pi-exclamation-circle',   '/purchase-orders/incomplete', '#ef4444', 'workflow', 'Workflow', NULL, 5,  TRUE, FALSE),
  ('purchase-orders',        'Purchase orders',       'All POs',                                   'pi-shopping-cart',        '/purchase-orders',            '#7c3aed', 'documents','Documents',NULL, 1,  TRUE, FALSE),
  ('grn',                    'GRN',                   'Goods receipt notes',                       'pi-box',                  '/grn',                        '#14b8a6', 'documents','Documents',NULL, 2,  TRUE, FALSE),
  ('asn',                    'ASN',                   'Advance shipping notices',                  'pi-truck',                '/asn',                        '#84cc16', 'documents','Documents',NULL, 3,  TRUE, FALSE),
  ('delivery-challans',      'Delivery challans',     'DCs from email ingest + upload',            'pi-file-edit',            '/delivery-challans',          '#f97316', 'documents','Documents',NULL, 4,  TRUE, FALSE),
  ('po-schedules',           'Schedules',             'PO schedules',                              'pi-calendar',             '/po-schedules',               '#a855f7', 'documents','Documents',NULL, 5,  TRUE, FALSE),
  ('open-po-prefixes',       'Open PO prefixes',      'Which PO prefixes count as open',           'pi-tag',                  '/open-po-prefixes',           '#d946ef', 'documents','Documents',NULL, 6,  TRUE, FALSE),
  ('suppliers',              'Suppliers',             'Supplier master',                           'pi-users',                '/suppliers',                  '#475569', 'masters',  'Masters',  NULL, 1,  TRUE, FALSE),
  ('user-registration',      'Users',                 'Portal users + roles + menu access',        'pi-user',                 '/users/registration',         '#475569', 'masters',  'Masters',  NULL, 2,  TRUE, FALSE),
  ('owner-details',          'Owners',                'Organisation owners',                       'pi-id-card',              '/owners/details',             '#475569', 'masters',  'Masters',  NULL, 3,  TRUE, FALSE),
  ('profile',                'Profile',               'Edit profile + change password',            'pi-user-edit',            '/profile',                    '#64748b', 'system',   'System',   NULL, 1,  TRUE, FALSE)
ON CONFLICT (menu_id) DO UPDATE SET
  title                = EXCLUDED.title,
  description          = EXCLUDED.description,
  icon                 = EXCLUDED.icon,
  path                 = EXCLUDED.path,
  color                = EXCLUDED.color,
  category_id          = EXCLUDED.category_id,
  category_title       = EXCLUDED.category_title,
  category_description = EXCLUDED.category_description,
  display_order        = EXCLUDED.display_order,
  is_active            = EXCLUDED.is_active,
  is_coming_soon       = EXCLUDED.is_coming_soon,
  updated_at           = NOW();

-- Deactivate any stale legacy rows that aren't in the current portal.
UPDATE menu_items
   SET is_active = FALSE, updated_at = NOW()
 WHERE menu_id NOT IN (
   'dashboard','analytics','reports','invoices','invoice-upload',
   'invoice-reconciliation','payments','incomplete-pos','purchase-orders',
   'grn','asn','delivery-challans','po-schedules','open-po-prefixes',
   'suppliers','user-registration','owner-details','profile'
 );

-- ----------------------------------------------------------------------------
-- Default role templates. Admin sees everything; others get reasonable
-- defaults. Existing per-user overrides (user_menu_access) take precedence.
-- ----------------------------------------------------------------------------
-- Admin → all active items.
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'admin', mi.menu_item_id, TRUE
  FROM menu_items mi WHERE mi.is_active
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Manager → everything except user/owner management.
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'manager', mi.menu_item_id, TRUE
  FROM menu_items mi
 WHERE mi.is_active
   AND mi.menu_id NOT IN ('user-registration','owner-details')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Finance → overview + invoices + payments + reports + profile.
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'finance', mi.menu_item_id, TRUE
  FROM menu_items mi
 WHERE mi.is_active
   AND mi.menu_id IN (
     'dashboard','analytics','reports','invoices','invoice-upload',
     'invoice-reconciliation','payments','incomplete-pos','profile'
   )
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- User → overview + invoices + incomplete POs + payments history + profile.
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'user', mi.menu_item_id, TRUE
  FROM menu_items mi
 WHERE mi.is_active
   AND mi.menu_id IN (
     'dashboard','analytics','reports','invoices','invoice-upload',
     'incomplete-pos','payments','profile'
   )
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Viewer → overview + reports + profile (read-only).
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'viewer', mi.menu_item_id, TRUE
  FROM menu_items mi
 WHERE mi.is_active
   AND mi.menu_id IN ('dashboard','analytics','reports','invoices','profile')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

-- Revoke any role-level access pointing at items that no longer exist /
-- are inactive (keeps the JOIN in the effective-menu query clean).
UPDATE role_menu_access rma
   SET has_access = FALSE
  FROM menu_items mi
 WHERE rma.menu_item_id = mi.menu_item_id
   AND NOT mi.is_active;

COMMIT;
