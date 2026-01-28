// Script to create admin user with hashed password
// Run with: node create_admin_user.js

import bcrypt from 'bcrypt'
import { pool } from './src/db.js'

const DEFAULT_PASSWORD = 'Admin@123' // Change this to your desired password

async function createAdminUser() {
  try {
    // Hash the password
    const saltRounds = 10
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, saltRounds)
    
    // Insert the admin user
    const result = await pool.query(
      `INSERT INTO users (
        username,
        email,
        password_hash,
        role,
        full_name,
        is_active
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        username = EXCLUDED.username,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        full_name = EXCLUDED.full_name,
        is_active = EXCLUDED.is_active
      RETURNING user_id, username, email, role`,
      ['admin', 'admin@srimukha.com', passwordHash, 'admin', 'Administrator', true]
    )
    
    console.log('Admin user created successfully!')
    console.log('User details:', result.rows[0])
    console.log(`\nDefault password: ${DEFAULT_PASSWORD}`)
    console.log('Please change the password after first login!')
    
    process.exit(0)
  } catch (error) {
    console.error('Error creating admin user:', error)
    process.exit(1)
  }
}

createAdminUser()
