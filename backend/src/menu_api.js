// API endpoints for menu items and role-based access
// Add this to your main index.js file

import { pool } from './db.js'

/**
 * Get menu items for a specific role
 * GET /api/menu-items?role=admin
 */
router.get('/menu-items', async (req, res) => {
  try {
    const { role } = req.query

    if (!role) {
      return res.status(400).json({ error: 'role_required', message: 'Role parameter is required' })
    }

    // Get all active menu items with access for the role
    const query = `
      SELECT 
        mi.menu_item_id,
        mi.menu_id,
        mi.title,
        mi.description,
        mi.icon,
        mi.path,
        mi.color,
        mi.category_id,
        mi.category_title,
        mi.category_description,
        mi.display_order,
        mi.is_coming_soon,
        COALESCE(rma.has_access, FALSE) as has_access
      FROM menu_items mi
      LEFT JOIN role_menu_access rma ON mi.menu_item_id = rma.menu_item_id 
        AND rma.role = $1 
        AND rma.has_access = TRUE
      WHERE mi.is_active = TRUE
        AND (rma.has_access = TRUE OR rma.has_access IS NULL)
      ORDER BY mi.category_id, mi.display_order, mi.title
    `

    const result = await pool.query(query, [role])
    
    // Group by category
    const categories = {}
    result.rows.forEach(item => {
      if (item.has_access) {
        if (!categories[item.category_id]) {
          categories[item.category_id] = {
            id: item.category_id,
            title: item.category_title,
            description: item.category_description,
            items: []
          }
        }
        categories[item.category_id].items.push({
          id: item.menu_id,
          title: item.title,
          description: item.description,
          icon: item.icon,
          path: item.path,
          color: item.color,
          comingSoon: item.is_coming_soon
        })
      }
    })

    // Convert to array and filter out empty categories
    const menuCategories = Object.values(categories).filter(cat => cat.items.length > 0)

    res.json(menuCategories)
  } catch (err) {
    console.error('Error fetching menu items:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

/**
 * Get all menu items (admin only)
 * GET /api/menu-items/all
 */
router.get('/menu-items/all', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        menu_item_id,
        menu_id,
        title,
        description,
        icon,
        path,
        color,
        category_id,
        category_title,
        category_description,
        display_order,
        is_active,
        is_coming_soon,
        created_at,
        updated_at
      FROM menu_items
      ORDER BY category_id, display_order, title
    `)
    
    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching all menu items:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

/**
 * Get role access for a menu item
 * GET /api/menu-items/:menuId/roles
 */
router.get('/menu-items/:menuId/roles', async (req, res) => {
  try {
    const { menuId } = req.params

    const result = await pool.query(`
      SELECT 
        rma.role,
        rma.has_access,
        rma.created_at,
        rma.updated_at
      FROM role_menu_access rma
      JOIN menu_items mi ON mi.menu_item_id = rma.menu_item_id
      WHERE mi.menu_id = $1
      ORDER BY rma.role
    `, [menuId])
    
    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching menu item roles:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

/**
 * Update role access for a menu item
 * PUT /api/menu-items/:menuId/roles
 * Body: { role: 'admin', has_access: true }
 */
router.put('/menu-items/:menuId/roles', async (req, res) => {
  try {
    const { menuId } = req.params
    const { role, has_access } = req.body

    if (!role || typeof has_access !== 'boolean') {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'Role and has_access (boolean) are required' 
      })
    }

    // Get menu_item_id from menu_id
    const menuItemResult = await pool.query(
      'SELECT menu_item_id FROM menu_items WHERE menu_id = $1',
      [menuId]
    )

    if (menuItemResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Menu item not found' })
    }

    const menuItemId = menuItemResult.rows[0].menu_item_id

    // Insert or update role access
    const result = await pool.query(`
      INSERT INTO role_menu_access (role, menu_item_id, has_access)
      VALUES ($1, $2, $3)
      ON CONFLICT (role, menu_item_id) 
      DO UPDATE SET 
        has_access = EXCLUDED.has_access,
        updated_at = NOW()
      RETURNING *
    `, [role, menuItemId, has_access])

    res.json(result.rows[0])
  } catch (err) {
    console.error('Error updating menu item role access:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

/**
 * Create a new menu item
 * POST /api/menu-items
 */
router.post('/menu-items', async (req, res) => {
  try {
    const {
      menu_id,
      title,
      description,
      icon,
      path,
      color,
      category_id,
      category_title,
      category_description,
      display_order,
      is_active,
      is_coming_soon
    } = req.body

    if (!menu_id || !title || !icon || !path || !color || !category_id || !category_title) {
      return res.status(400).json({ 
        error: 'invalid_request', 
        message: 'Required fields: menu_id, title, icon, path, color, category_id, category_title' 
      })
    }

    const result = await pool.query(`
      INSERT INTO menu_items (
        menu_id, title, description, icon, path, color,
        category_id, category_title, category_description,
        display_order, is_active, is_coming_soon
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      menu_id, title, description || null, icon, path, color,
      category_id, category_title, category_description || null,
      display_order || 0, is_active !== undefined ? is_active : true,
      is_coming_soon !== undefined ? is_coming_soon : false
    ])

    res.status(201).json(result.rows[0])
  } catch (err) {
    if (err.code === '23505') { // Unique violation
      return res.status(409).json({ error: 'duplicate', message: 'Menu item with this ID already exists' })
    }
    console.error('Error creating menu item:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

/**
 * Update a menu item
 * PUT /api/menu-items/:menuId
 */
router.put('/menu-items/:menuId', async (req, res) => {
  try {
    const { menuId } = req.params
    const updateFields = req.body

    const allowedFields = [
      'title', 'description', 'icon', 'path', 'color',
      'category_id', 'category_title', 'category_description',
      'display_order', 'is_active', 'is_coming_soon'
    ]

    const updates = []
    const values = []
    let paramIndex = 1

    for (const field of allowedFields) {
      if (updateFields[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`)
        values.push(updateFields[field])
        paramIndex++
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'invalid_request', message: 'No valid fields to update' })
    }

    updates.push(`updated_at = NOW()`)
    values.push(menuId)

    const result = await pool.query(`
      UPDATE menu_items
      SET ${updates.join(', ')}
      WHERE menu_id = $${paramIndex}
      RETURNING *
    `, values)

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Menu item not found' })
    }

    res.json(result.rows[0])
  } catch (err) {
    console.error('Error updating menu item:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

/**
 * Delete a menu item (and cascade delete role access)
 * DELETE /api/menu-items/:menuId
 */
router.delete('/menu-items/:menuId', async (req, res) => {
  try {
    const { menuId } = req.params

    const result = await pool.query(`
      DELETE FROM menu_items
      WHERE menu_id = $1
      RETURNING menu_item_id
    `, [menuId])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Menu item not found' })
    }

    res.json({ message: 'Menu item deleted successfully' })
  } catch (err) {
    console.error('Error deleting menu item:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})
