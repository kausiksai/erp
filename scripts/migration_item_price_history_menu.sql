-- ============================================================================
-- Item price history — new menu entry + role grants
-- ============================================================================
-- Adds the "Item price history" page to the portal sidebar under the
-- "Documents" category and grants visibility to the roles that already
-- see other documents pages (admin, manager, finance, user).
--
-- Idempotent: re-running is safe.
-- ============================================================================

BEGIN;

INSERT INTO menu_items (
  menu_id, title, description, icon, path, color,
  category_id, category_title, display_order, is_active, is_coming_soon
)
VALUES (
  'item-price-history',
  'Item price history',
  'Compare item unit cost across the last 3 distinct POs',
  'pi-history',
  '/items/price-history',
  '#0ea5e9',
  'documents',
  'Documents',
  9,
  TRUE,
  FALSE
)
ON CONFLICT (menu_id) DO UPDATE SET
  title          = EXCLUDED.title,
  description    = EXCLUDED.description,
  icon           = EXCLUDED.icon,
  path           = EXCLUDED.path,
  color          = EXCLUDED.color,
  category_id    = EXCLUDED.category_id,
  category_title = EXCLUDED.category_title,
  is_active      = EXCLUDED.is_active,
  updated_at     = NOW();

-- Grant access to common roles. Adjust as needed.
INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT r.role, m.menu_item_id, TRUE
FROM (VALUES ('admin'), ('manager'), ('finance'), ('user')) AS r(role)
CROSS JOIN (
  SELECT menu_item_id FROM menu_items WHERE menu_id = 'item-price-history'
) m
ON CONFLICT (role, menu_item_id) DO UPDATE SET
  has_access = EXCLUDED.has_access,
  updated_at = NOW();

COMMIT;
