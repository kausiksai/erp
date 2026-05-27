// Supplier Management API – list, get by id, create, update, delete
// Admin (or admin/manager) can manage suppliers

import { pool } from './db.js'

const SUPPLIER_COLUMNS = `
  supplier_id,
  supplier_name,
  suplr_id,
  gst_number,
  pan_number,
  supplier_address,
  city,
  state_code,
  state_name,
  pincode,
  email,
  phone,
  mobile,
  msme_number,
  bank_account_name,
  bank_account_number,
  bank_ifsc_code,
  bank_name,
  branch_name,
  website,
  contact_person,
  created_at,
  updated_at
`

/**
 * GET /api/suppliers – paginated list (admin/manager)
 *
 * Query params:
 *   q        : free-text search across supplier_name / suplr_id / gst_number /
 *              city / state_name
 *   limit    : page size (default 100, max 1000)
 *   offset   : pagination offset (default 0)
 *
 * Backward-compatible: returns { items, total, limit, offset } when paginated
 * params are provided, and a plain array otherwise (legacy callers).
 */
export async function getSuppliersRoute(req, res) {
  try {
    const wantsPaginated =
      req.query.limit !== undefined || req.query.offset !== undefined || !!req.query.q

    const conds = []
    const params = []
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`)
      const p = `$${params.length}`
      conds.push(
        `(supplier_name ILIKE ${p} OR suplr_id ILIKE ${p} OR gst_number ILIKE ${p} OR city ILIKE ${p} OR state_name ILIKE ${p})`
      )
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000)
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)

    if (!wantsPaginated) {
      // Legacy callers expect an array — preserve that contract.
      const { rows } = await pool.query(
        `SELECT ${SUPPLIER_COLUMNS} FROM suppliers ORDER BY supplier_name ASC`
      )
      return res.json(rows)
    }

    const [list, count] = await Promise.all([
      pool.query(
        `SELECT ${SUPPLIER_COLUMNS}
           FROM suppliers
           ${where}
           ORDER BY supplier_name ASC
           LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM suppliers ${where}`,
        params
      )
    ])
    res.json({
      items: list.rows,
      total: count.rows[0]?.n || 0,
      limit,
      offset
    })
  } catch (err) {
    console.error('Error fetching suppliers:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * GET /api/suppliers/by-id/:id – get one supplier by id (for edit form)
 */
export async function getSupplierByIdRoute(req, res) {
  try {
    const { id } = req.params
    const { rows } = await pool.query(
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE supplier_id = $1`,
      [id]
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Supplier not found' })
    }
    res.json(rows[0])
  } catch (err) {
    console.error('Error fetching supplier by id:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * POST /api/suppliers – create supplier (admin/manager)
 */
export async function createSupplierRoute(req, res) {
  try {
    const {
      supplier_name,
      suplr_id,
      gst_number,
      pan_number,
      supplier_address,
      city,
      state_code,
      state_name,
      pincode,
      email,
      phone,
      mobile,
      msme_number,
      bank_account_name,
      bank_account_number,
      bank_ifsc_code,
      bank_name,
      branch_name,
      website,
      contact_person
    } = req.body

    if (!supplier_name || String(supplier_name).trim() === '') {
      return res.status(400).json({
        error: 'validation_error',
        message: 'Supplier name is required'
      })
    }

    const { rows } = await pool.query(
      `INSERT INTO suppliers (
        supplier_name,
        suplr_id,
        gst_number,
        pan_number,
        supplier_address,
        city,
        state_code,
        state_name,
        pincode,
        email,
        phone,
        mobile,
        msme_number,
        bank_account_name,
        bank_account_number,
        bank_ifsc_code,
        bank_name,
        branch_name,
        website,
        contact_person
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING ${SUPPLIER_COLUMNS}`,
      [
        String(supplier_name).trim(),
        suplr_id ? String(suplr_id).trim() : null,
        gst_number ?? null,
        pan_number ?? null,
        supplier_address ?? null,
        city ?? null,
        state_code ?? null,
        state_name ?? null,
        pincode ?? null,
        email ?? null,
        phone ?? null,
        mobile ?? null,
        msme_number ?? null,
        bank_account_name ?? null,
        bank_account_number ?? null,
        bank_ifsc_code ?? null,
        bank_name ?? null,
        branch_name ?? null,
        website ?? null,
        contact_person ?? null
      ]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'duplicate',
        message: 'A supplier with this name already exists'
      })
    }
    console.error('Error creating supplier:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * PUT /api/suppliers/:id – update supplier (admin/manager)
 */
export async function updateSupplierRoute(req, res) {
  try {
    const { id } = req.params
    const {
      supplier_name,
      suplr_id,
      gst_number,
      pan_number,
      supplier_address,
      city,
      state_code,
      state_name,
      pincode,
      email,
      phone,
      mobile,
      msme_number,
      bank_account_name,
      bank_account_number,
      bank_ifsc_code,
      bank_name,
      branch_name,
      website,
      contact_person
    } = req.body

    const updates = []
    const values = []
    let paramIndex = 1

    if (supplier_name !== undefined) {
      if (String(supplier_name).trim() === '') {
        return res.status(400).json({
          error: 'validation_error',
          message: 'Supplier name cannot be empty'
        })
      }
      updates.push(`supplier_name = $${paramIndex++}`)
      values.push(String(supplier_name).trim())
    }
    if (suplr_id !== undefined) {
      updates.push(`suplr_id = $${paramIndex++}`);
      values.push(suplr_id ? String(suplr_id).trim() : null)
    }
    if (gst_number !== undefined) { updates.push(`gst_number = $${paramIndex++}`); values.push(gst_number) }
    if (pan_number !== undefined) { updates.push(`pan_number = $${paramIndex++}`); values.push(pan_number) }
    if (supplier_address !== undefined) { updates.push(`supplier_address = $${paramIndex++}`); values.push(supplier_address) }
    if (city !== undefined) { updates.push(`city = $${paramIndex++}`); values.push(city) }
    if (state_code !== undefined) { updates.push(`state_code = $${paramIndex++}`); values.push(state_code) }
    if (state_name !== undefined) { updates.push(`state_name = $${paramIndex++}`); values.push(state_name) }
    if (pincode !== undefined) { updates.push(`pincode = $${paramIndex++}`); values.push(pincode) }
    if (email !== undefined) { updates.push(`email = $${paramIndex++}`); values.push(email) }
    if (phone !== undefined) { updates.push(`phone = $${paramIndex++}`); values.push(phone) }
    if (mobile !== undefined) { updates.push(`mobile = $${paramIndex++}`); values.push(mobile) }
    if (msme_number !== undefined) { updates.push(`msme_number = $${paramIndex++}`); values.push(msme_number) }
    if (bank_account_name !== undefined) { updates.push(`bank_account_name = $${paramIndex++}`); values.push(bank_account_name) }
    if (bank_account_number !== undefined) { updates.push(`bank_account_number = $${paramIndex++}`); values.push(bank_account_number) }
    if (bank_ifsc_code !== undefined) { updates.push(`bank_ifsc_code = $${paramIndex++}`); values.push(bank_ifsc_code) }
    if (bank_name !== undefined) { updates.push(`bank_name = $${paramIndex++}`); values.push(bank_name) }
    if (branch_name !== undefined) { updates.push(`branch_name = $${paramIndex++}`); values.push(branch_name) }
    if (website !== undefined) { updates.push(`website = $${paramIndex++}`); values.push(website) }
    if (contact_person !== undefined) { updates.push(`contact_person = $${paramIndex++}`); values.push(contact_person) }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'validation_error',
        message: 'No fields to update'
      })
    }

    updates.push('updated_at = NOW()')
    values.push(id)

    const { rows } = await pool.query(
      `UPDATE suppliers SET ${updates.join(', ')} WHERE supplier_id = $${paramIndex} RETURNING ${SUPPLIER_COLUMNS}`,
      values
    )
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Supplier not found' })
    }
    res.json(rows[0])
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'duplicate',
        message: 'A supplier with this name already exists'
      })
    }
    console.error('Error updating supplier:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * DELETE /api/suppliers/:id – delete supplier if not referenced (admin/manager)
 */
export async function deleteSupplierRoute(req, res) {
  try {
    const { id } = req.params

    const refs = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1) AS po_count,
        (SELECT COUNT(*) FROM invoices WHERE supplier_id = $1) AS invoice_count`,
      [id]
    )
    const { po_count, invoice_count } = refs.rows[0]
    const total = Number(po_count) + Number(invoice_count)
    if (total > 0) {
      return res.status(400).json({
        error: 'in_use',
        message: `Cannot delete supplier: linked to ${po_count} purchase order(s) and ${invoice_count} invoice(s). Remove or reassign those first.`
      })
    }

    const { rowCount } = await pool.query(
      'DELETE FROM suppliers WHERE supplier_id = $1',
      [id]
    )
    if (rowCount === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Supplier not found' })
    }
    res.status(204).send()
  } catch (err) {
    console.error('Error deleting supplier:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
