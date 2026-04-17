// User Management API endpoints
// Add these routes to your main index.js file

import { pool } from './db.js'
import { hashPassword } from './auth.js'

/**
 * Get all users (Admin/Manager only)
 * GET /api/users
 */
export async function getUsersRoute(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT 
        user_id,
        username,
        email,
        role,
        full_name,
        is_active,
        last_login,
        created_at,
        updated_at
      FROM users
      ORDER BY created_at DESC
    `)
    
    res.json(rows)
  } catch (err) {
    console.error('Error fetching users:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Get a single user by ID
 * GET /api/users/:id
 */
export async function getUserByIdRoute(req, res) {
  try {
    const { id } = req.params
    
    const { rows } = await pool.query(`
      SELECT 
        user_id,
        username,
        email,
        role,
        full_name,
        is_active,
        last_login,
        created_at,
        updated_at
      FROM users
      WHERE user_id = $1
    `, [id])
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }
    
    res.json(rows[0])
  } catch (err) {
    console.error('Error fetching user:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Create a new user (Admin only)
 * POST /api/users
 */
export async function createUserRoute(req, res) {
  try {
    const { username, email, password, fullName, role = 'user', isActive = true } = req.body
    
    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'Username, email, and password are required' 
      })
    }
    
    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'Password must be at least 6 characters' 
      })
    }
    
    // Validate role
    const validRoles = ['admin', 'manager', 'user', 'finance', 'viewer']
    if (!validRoles.includes(role)) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: `Invalid role. Must be one of: ${validRoles.join(', ')}` 
      })
    }
    
    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT user_id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    )
    
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ 
        error: 'conflict', 
        message: 'Username or email already exists' 
      })
    }
    
    // Hash password
    const passwordHash = await hashPassword(password)
    
    // Create user
    const { rows } = await pool.query(`
      INSERT INTO users (username, email, password_hash, full_name, role, is_active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING user_id, username, email, role, full_name, is_active, created_at
    `, [username, email, passwordHash, fullName || null, role, isActive])
    
    res.status(201).json(rows[0])
  } catch (err) {
    console.error('Error creating user:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Update a user (Admin only)
 * PUT /api/users/:id
 */
export async function updateUserRoute(req, res) {
  try {
    const { id } = req.params
    const { username, email, fullName, role, isActive, password } = req.body
    
    // Build update query dynamically
    const updates = []
    const values = []
    let paramIndex = 1
    
    if (username !== undefined) {
      updates.push(`username = $${paramIndex++}`)
      values.push(username)
    }
    
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`)
      values.push(email)
    }
    
    if (fullName !== undefined) {
      updates.push(`full_name = $${paramIndex++}`)
      values.push(fullName)
    }
    
    if (role !== undefined) {
      const validRoles = ['admin', 'manager', 'user', 'finance', 'viewer']
      if (!validRoles.includes(role)) {
        return res.status(400).json({ 
          error: 'validation_error', 
          message: `Invalid role. Must be one of: ${validRoles.join(', ')}` 
        })
      }
      updates.push(`role = $${paramIndex++}`)
      values.push(role)
    }
    
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`)
      values.push(isActive)
    }
    
    if (password !== undefined) {
      if (password.length < 6) {
        return res.status(400).json({ 
          error: 'validation_error', 
          message: 'Password must be at least 6 characters' 
        })
      }
      const passwordHash = await hashPassword(password)
      updates.push(`password_hash = $${paramIndex++}`)
      values.push(passwordHash)
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'No fields to update' 
      })
    }
    
    updates.push(`updated_at = NOW()`)
    values.push(id)
    
    // Check if username or email conflicts with other users
    if (username || email) {
      const conflictCheck = await pool.query(
        'SELECT user_id FROM users WHERE (username = $1 OR email = $2) AND user_id != $3',
        [username || '', email || '', id]
      )
      
      if (conflictCheck.rows.length > 0) {
        return res.status(409).json({ 
          error: 'conflict', 
          message: 'Username or email already exists' 
        })
      }
    }
    
    const { rows } = await pool.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE user_id = $${paramIndex}
      RETURNING user_id, username, email, role, full_name, is_active, updated_at
    `, values)
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }
    
    res.json(rows[0])
  } catch (err) {
    console.error('Error updating user:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Delete a user (Admin only)
 * DELETE /api/users/:id
 */
export async function deleteUserRoute(req, res) {
  try {
    const { id } = req.params
    
    // Prevent deleting yourself
    if (parseInt(id) === req.user.user_id) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'Cannot delete your own account' 
      })
    }
    
    const { rows } = await pool.query(
      'DELETE FROM users WHERE user_id = $1 RETURNING user_id, username',
      [id]
    )
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }
    
    res.json({ message: 'User deleted successfully', user: rows[0] })
  } catch (err) {
    console.error('Error deleting user:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Effective menu access for a specific user.
 *
 * A user can have explicit rows in `user_menu_access`. If any are present,
 * that is their full effective set. If none exist we fall back to the
 * role template in `role_menu_access`.
 *
 * GET /api/users/:id/menu-access
 * Returns every active menu_item with `has_access` resolved against the
 * effective set, plus a `source` flag ('user' | 'role') so the UI can
 * show whether overrides exist.
 */
export async function getUserMenuAccessRoute(req, res) {
  try {
    const { id } = req.params

    const userResult = await pool.query(
      'SELECT role FROM users WHERE user_id = $1',
      [id]
    )
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }
    const userRole = userResult.rows[0].role

    const overrideCountResult = await pool.query(
      'SELECT COUNT(*)::int AS n FROM user_menu_access WHERE user_id = $1',
      [id]
    )
    const source = overrideCountResult.rows[0].n > 0 ? 'user' : 'role'

    const { rows } = await pool.query(`
      SELECT
        mi.menu_item_id,
        mi.menu_id,
        mi.title,
        mi.path,
        mi.icon,
        mi.category_id,
        mi.category_title,
        mi.display_order,
        CASE
          WHEN $1::text = 'user' THEN COALESCE(uma.has_access, FALSE)
          ELSE COALESCE(rma.has_access, FALSE)
        END AS has_access
      FROM menu_items mi
      LEFT JOIN user_menu_access uma
             ON uma.menu_item_id = mi.menu_item_id AND uma.user_id = $2
      LEFT JOIN role_menu_access rma
             ON rma.menu_item_id = mi.menu_item_id AND rma.role    = $3
      WHERE mi.is_active = TRUE
      ORDER BY mi.category_id, mi.display_order, mi.title
    `, [source, id, userRole])

    res.json({ source, role: userRole, items: rows })
  } catch (err) {
    console.error('Error fetching user menu access:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Replace a user's explicit menu access with `menuItemIds`.
 * Sending an empty array removes all overrides and the user falls back to
 * their role template.
 *
 * PUT /api/users/:id/menu-access
 * Body: { menuItemIds: [1, 2, 3], useRoleDefault?: boolean }
 *   useRoleDefault=true clears all overrides (equivalent to menuItemIds=[]).
 */
export async function updateUserMenuAccessRoute(req, res) {
  const client = await pool.connect()
  try {
    const { id } = req.params
    const { menuItemIds, useRoleDefault } = req.body || {}

    const userResult = await client.query(
      'SELECT role FROM users WHERE user_id = $1',
      [id]
    )
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }

    if (!useRoleDefault && !Array.isArray(menuItemIds)) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'menuItemIds must be an array (or set useRoleDefault=true)'
      })
    }

    await client.query('BEGIN')

    // Wipe any previous per-user overrides for this user.
    await client.query('DELETE FROM user_menu_access WHERE user_id = $1', [id])

    let inserted = 0
    if (!useRoleDefault && menuItemIds.length > 0) {
      // Validate every menu_item_id is real + active, to avoid dangling rows.
      const { rows: validRows } = await client.query(
        `SELECT menu_item_id FROM menu_items
          WHERE is_active = TRUE AND menu_item_id = ANY($1::bigint[])`,
        [menuItemIds]
      )
      const validIds = validRows.map((r) => r.menu_item_id)
      if (validIds.length > 0) {
        const values = validIds.map((_, i) => `($1, $${i + 3}, TRUE, $2)`).join(', ')
        const params = [id, req.user?.user_id || null, ...validIds]
        await client.query(
          `INSERT INTO user_menu_access (user_id, menu_item_id, has_access, granted_by)
           VALUES ${values}
           ON CONFLICT (user_id, menu_item_id) DO UPDATE
             SET has_access = TRUE,
                 granted_by = EXCLUDED.granted_by,
                 updated_at = NOW()`,
          params
        )
        inserted = validIds.length
      }
    }

    await client.query('COMMIT')
    res.json({
      message: 'Menu access updated successfully',
      user_id: Number(id),
      source: useRoleDefault || inserted === 0 ? 'role' : 'user',
      menuItemIds: useRoleDefault ? [] : menuItemIds
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Error updating user menu access:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
}

/**
 * Return the authenticated user's effective allowed menu items.
 * Used by the sidebar to decide what to render.
 *
 * GET /api/auth/me/menu-access
 */
export async function getMyMenuAccessRoute(req, res) {
  try {
    const userId = req.user?.user_id
    const role = req.user?.role
    if (!userId) return res.status(401).json({ error: 'unauthenticated' })

    const overrideCount = await pool.query(
      'SELECT COUNT(*)::int AS n FROM user_menu_access WHERE user_id = $1',
      [userId]
    )
    const source = overrideCount.rows[0].n > 0 ? 'user' : 'role'

    const { rows } = await pool.query(`
      SELECT
        mi.menu_item_id,
        mi.menu_id,
        mi.title,
        mi.path,
        mi.icon,
        mi.category_id,
        mi.display_order
      FROM menu_items mi
      LEFT JOIN user_menu_access uma
             ON uma.menu_item_id = mi.menu_item_id AND uma.user_id = $2
      LEFT JOIN role_menu_access rma
             ON rma.menu_item_id = mi.menu_item_id AND rma.role    = $3
      WHERE mi.is_active = TRUE
        AND CASE WHEN $1::text = 'user' THEN COALESCE(uma.has_access, FALSE)
                 ELSE COALESCE(rma.has_access, FALSE) END = TRUE
      ORDER BY mi.category_id, mi.display_order, mi.title
    `, [source, userId, role])

    res.json({ source, role, items: rows })
  } catch (err) {
    console.error('Error fetching my menu access:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
