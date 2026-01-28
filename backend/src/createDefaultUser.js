import 'dotenv/config'
import { pool } from './db.js'
import { hashPassword } from './auth.js'

async function createDefaultUser() {
  try {
    // Check if users table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      )
    `)

    if (!tableCheck.rows[0].exists) {
      console.error('Users table does not exist. Please run: npm run db:init')
      process.exit(1)
    }

    // Default admin user credentials
    const defaultUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin'
    const defaultEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com'
    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'
    const defaultRole = process.env.DEFAULT_ADMIN_ROLE || 'admin'
    const defaultFullName = process.env.DEFAULT_ADMIN_FULL_NAME || 'System Administrator'

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT user_id FROM users WHERE username = $1 OR email = $2',
      [defaultUsername, defaultEmail]
    )

    if (existingUser.rows.length > 0) {
      console.log(`User "${defaultUsername}" or email "${defaultEmail}" already exists. Skipping creation.`)
      process.exit(0)
    }

    // Hash password
    const passwordHash = await hashPassword(defaultPassword)

    // Create user
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, username, email, role`,
      [defaultUsername, defaultEmail, passwordHash, defaultFullName, defaultRole]
    )

    console.log('Default admin user created successfully!')
    console.log('Username:', rows[0].username)
    console.log('Email:', rows[0].email)
    console.log('Role:', rows[0].role)
    console.log('Password:', defaultPassword)
    console.log('\n⚠️  IMPORTANT: Change the default password after first login!')
    
    process.exit(0)
  } catch (err) {
    console.error('Failed to create default user:', err)
    process.exit(1)
  }
}

createDefaultUser()
