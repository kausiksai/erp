-- Add DC, PO Schedules, and Open PO Prefixes to the home menu (existing DBs that predate data.sql updates).
-- Safe to run multiple times (ON CONFLICT updates).

INSERT INTO menu_items (menu_id, title, description, icon, path, color, category_id, category_title, category_description, display_order, is_active, is_coming_soon) VALUES
('dc-details', 'Delivery Challan (DC)', 'Upload and view delivery challan transactions (full replace)', 'pi pi-file-export', '/delivery-challans/details', '#0f766e', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 4, TRUE, FALSE),
('po-schedules', 'PO Schedules', 'Upload and view purchase order schedules (full replace)', 'pi pi-calendar', '/po-schedules/details', '#7c2d12', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 5, TRUE, FALSE),
('open-po-prefixes', 'Open PO Prefixes', 'Define PFX prefixes that mark a PO as Open PO (Excel upload, full replace)', 'pi pi-bookmark', '/open-po-prefixes', '#4338ca', 'purchase-orders', 'Purchase Orders', 'Purchase order and related document management', 6, TRUE, FALSE)
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

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'admin', menu_item_id, TRUE FROM menu_items WHERE is_active = TRUE
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'manager', menu_item_id, TRUE FROM menu_items
WHERE menu_id IN ('incomplete-pos','invoice-upload','invoice-details','purchase-order','grn-details','asn-details','dc-details','po-schedules','open-po-prefixes','user-registration','supplier-registration','approve-payments','ready-for-payment','payment-history','invoice-reports','financial-reports','supplier-reports')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();

INSERT INTO role_menu_access (role, menu_item_id, has_access)
SELECT 'user', menu_item_id, TRUE FROM menu_items
WHERE menu_id IN ('incomplete-pos','invoice-upload','invoice-details','purchase-order','grn-details','asn-details','dc-details','po-schedules','supplier-registration')
ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE, updated_at = NOW();
