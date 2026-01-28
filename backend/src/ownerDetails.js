// Owner Details API endpoints
// Admin can view and edit owner details, but cannot add new owners

import { pool } from './db.js'

/**
 * Get owner details (Admin only)
 * GET /api/owners
 * Returns the first owner record (assuming single owner/company)
 */
export async function getOwnerDetailsRoute(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT 
        owner_id,
        owner_name,
        gst_number,
        pan_number,
        owner_address,
        city,
        state_code,
        state_name,
        pincode,
        email,
        phone,
        mobile,
        msme_number,
        cin_number,
        bank_account_name,
        bank_account_number,
        bank_ifsc_code,
        bank_name,
        branch_name,
        website,
        contact_person,
        created_at,
        updated_at
      FROM owners
      ORDER BY owner_id ASC
      LIMIT 1
    `)
    
    if (rows.length === 0) {
      // Return empty structure if no owner exists
      return res.json({
        owner_id: null,
        owner_name: '',
        gst_number: '',
        pan_number: '',
        owner_address: '',
        city: '',
        state_code: '',
        state_name: '',
        pincode: '',
        email: '',
        phone: '',
        mobile: '',
        msme_number: '',
        cin_number: '',
        bank_account_name: '',
        bank_account_number: '',
        bank_ifsc_code: '',
        bank_name: '',
        branch_name: '',
        website: '',
        contact_person: ''
      })
    }
    
    res.json(rows[0])
  } catch (err) {
    console.error('Error fetching owner details:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * Update owner details (Admin only)
 * PUT /api/owners/:id
 * Only allows updating existing owner, not creating new ones
 */
export async function updateOwnerDetailsRoute(req, res) {
  try {
    const { id } = req.params
    const {
      owner_name,
      gst_number,
      pan_number,
      owner_address,
      city,
      state_code,
      state_name,
      pincode,
      email,
      phone,
      mobile,
      msme_number,
      cin_number,
      bank_account_name,
      bank_account_number,
      bank_ifsc_code,
      bank_name,
      branch_name,
      website,
      contact_person
    } = req.body
    
    // Check if owner exists
    const existingOwner = await pool.query(
      'SELECT owner_id FROM owners WHERE owner_id = $1',
      [id]
    )
    
    if (existingOwner.rows.length === 0) {
      // Check if any owner exists (to prevent creating multiple owners)
      const anyOwner = await pool.query('SELECT owner_id FROM owners LIMIT 1')
      
      if (anyOwner.rows.length > 0) {
        return res.status(404).json({ 
          error: 'not_found', 
          message: 'Owner details not found.' 
        })
      }
      
      // If no owner exists and ID is provided, it means we're trying to create
      // But we don't allow creating new owners - only editing existing one
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'Cannot create new owner. Owner details must be created through database setup.' 
      })
    }
    
    // Build update query dynamically
    const updates = []
    const values = []
    let paramIndex = 1
    
    if (owner_name !== undefined) {
      updates.push(`owner_name = $${paramIndex++}`)
      values.push(owner_name)
    }
    if (gst_number !== undefined) {
      updates.push(`gst_number = $${paramIndex++}`)
      values.push(gst_number)
    }
    if (pan_number !== undefined) {
      updates.push(`pan_number = $${paramIndex++}`)
      values.push(pan_number)
    }
    if (owner_address !== undefined) {
      updates.push(`owner_address = $${paramIndex++}`)
      values.push(owner_address)
    }
    if (city !== undefined) {
      updates.push(`city = $${paramIndex++}`)
      values.push(city)
    }
    if (state_code !== undefined) {
      updates.push(`state_code = $${paramIndex++}`)
      values.push(state_code)
    }
    if (state_name !== undefined) {
      updates.push(`state_name = $${paramIndex++}`)
      values.push(state_name)
    }
    if (pincode !== undefined) {
      updates.push(`pincode = $${paramIndex++}`)
      values.push(pincode)
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`)
      values.push(email)
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`)
      values.push(phone)
    }
    if (mobile !== undefined) {
      updates.push(`mobile = $${paramIndex++}`)
      values.push(mobile)
    }
    if (msme_number !== undefined) {
      updates.push(`msme_number = $${paramIndex++}`)
      values.push(msme_number)
    }
    if (cin_number !== undefined) {
      updates.push(`cin_number = $${paramIndex++}`)
      values.push(cin_number)
    }
    if (bank_account_name !== undefined) {
      updates.push(`bank_account_name = $${paramIndex++}`)
      values.push(bank_account_name)
    }
    if (bank_account_number !== undefined) {
      updates.push(`bank_account_number = $${paramIndex++}`)
      values.push(bank_account_number)
    }
    if (bank_ifsc_code !== undefined) {
      updates.push(`bank_ifsc_code = $${paramIndex++}`)
      values.push(bank_ifsc_code)
    }
    if (bank_name !== undefined) {
      updates.push(`bank_name = $${paramIndex++}`)
      values.push(bank_name)
    }
    if (branch_name !== undefined) {
      updates.push(`branch_name = $${paramIndex++}`)
      values.push(branch_name)
    }
    if (website !== undefined) {
      updates.push(`website = $${paramIndex++}`)
      values.push(website)
    }
    if (contact_person !== undefined) {
      updates.push(`contact_person = $${paramIndex++}`)
      values.push(contact_person)
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ 
        error: 'validation_error', 
        message: 'No fields to update' 
      })
    }
    
    updates.push(`updated_at = NOW()`)
    values.push(id)
    
    const { rows } = await pool.query(`
      UPDATE owners
      SET ${updates.join(', ')}
      WHERE owner_id = $${paramIndex}
      RETURNING 
        owner_id,
        owner_name,
        gst_number,
        pan_number,
        owner_address,
        city,
        state_code,
        state_name,
        pincode,
        email,
        phone,
        mobile,
        msme_number,
        cin_number,
        bank_account_name,
        bank_account_number,
        bank_ifsc_code,
        bank_name,
        branch_name,
        website,
        contact_person,
        updated_at
    `, values)
    
    res.json(rows[0])
  } catch (err) {
    console.error('Error updating owner details:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
