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
 * Get user's menu access
 * GET /api/users/:id/menu-access
 */
export async function getUserMenuAccessRoute(req, res) {
  try {
    const { id } = req.params
    
    // Get user role
    const userResult = await pool.query(
      'SELECT role FROM users WHERE user_id = $1',
      [id]
    )
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }
    
    const userRole = userResult.rows[0].role
    
    // Get all menu items with access status for this role
    const { rows } = await pool.query(`
      SELECT 
        mi.menu_item_id,
        mi.menu_id,
        mi.title,
        mi.path,
        mi.category_id,
        mi.category_title,
        COALESCE(rma.has_access, FALSE) as has_access
      FROM menu_items mi
      LEFT JOIN role_menu_access rma ON mi.menu_item_id = rma.menu_item_id 
        AND rma.role = $1
      WHERE mi.is_active = TRUE
      ORDER BY mi.category_id, mi.display_order, mi.title
    `, [userRole])
    
    res.json(rows)
  } catch (err) {
    console.error('Error fetching user menu access:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Update user's menu access (by updating role_menu_access)
 * PUT /api/users/:id/menu-access
 * Body: { menuItemIds: [1, 2, 3] } - array of menu_item_ids to grant access
 */
export async function updateUserMenuAccessRoute(req, res) {
  try {
    const { id } = req.params
    const { menuItemIds } = req.body
    
    // Get user role
    const userResult = await pool.query(
      'SELECT role FROM users WHERE user_id = $1',
      [id]
    )
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }
    
    const userRole = userResult.rows[0].role
    
    if (!Array.isArray(menuItemIds)) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'menuItemIds must be an array' 
      })
    }
    
    // Start transaction
    await pool.query('BEGIN')
    
    try {
      // Remove all existing access for this role
      await pool.query(
        'DELETE FROM role_menu_access WHERE role = $1',
        [userRole]
      )
      
      // Insert new access
      if (menuItemIds.length > 0) {
        const values = menuItemIds.map((menuItemId, index) => 
          `($${index * 2 + 1}, $${index * 2 + 2}, TRUE)`
        ).join(', ')
        
        const params = menuItemIds.flatMap(id => [userRole, id])
        
        await pool.query(`
          INSERT INTO role_menu_access (role, menu_item_id, has_access)
          VALUES ${values}
          ON CONFLICT (role, menu_item_id) DO UPDATE SET has_access = TRUE
        `, params)
      }
      
      await pool.query('COMMIT')
      
      res.json({ 
        message: 'Menu access updated successfully',
        role: userRole,
        menuItemIds 
      })
    } catch (err) {
      await pool.query('ROLLBACK')
      throw err
    }
  } catch (err) {
    console.error('Error updating user menu access:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
