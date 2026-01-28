import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { pool } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d'

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password) {
  const saltRounds = 10
  return await bcrypt.hash(password, saltRounds)
}

/**
 * Compare a password with a hash
 */
export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash)
}

/**
 * Generate a JWT token for a user
 */
export function generateToken(user) {
  return jwt.sign(
    {
      userId: user.user_id,
      username: user.username,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  )
}

/**
 * Verify a JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    return null
  }
}

/**
 * Authentication middleware - verifies JWT token
 */
export async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1] // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'unauthorized', message: 'No token provided' })
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return res.status(403).json({ error: 'forbidden', message: 'Invalid or expired token' })
    }

    // Optionally verify user still exists and is active
    const { rows } = await pool.query(
      'SELECT user_id, username, email, role, is_active FROM users WHERE user_id = $1',
      [decoded.userId]
    )

    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(403).json({ error: 'forbidden', message: 'User not found or inactive' })
    }

    req.user = rows[0]
    next()
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Role-based authorization middleware
 * Usage: authorize(['admin', 'manager'])
 */
export function authorize(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'unauthorized', message: 'Authentication required' })
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Insufficient permissions' })
    }

    next()
  }
}
