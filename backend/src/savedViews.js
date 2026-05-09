// Saved views — per-user filter-combo presets on list pages.
//
// Endpoints (all scoped to req.user.userId):
//   GET    /api/saved-views?scope=invoices              list user's views for a scope
//   POST   /api/saved-views                             create one  { scope, name, filters, is_default? }
//   PATCH  /api/saved-views/:viewId                     rename / re-filter / set default
//   DELETE /api/saved-views/:viewId                     remove
//
// `filters` is an opaque JSONB blob owned by the frontend (e.g. invoices
// list might use { status: 'validated', supplier: 'plasmatek' }).

import { pool } from './db.js'

const VALID_SCOPES = new Set(['invoices', 'purchase_orders', 'receipts', 'reconciliation', 'payments'])

export async function listSavedViewsRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { scope } = req.query

    const conditions = ['user_id = $1']
    const params = [userId]
    if (scope) {
      if (!VALID_SCOPES.has(scope)) {
        return res.status(400).json({ error: 'bad_scope', message: `scope must be one of ${[...VALID_SCOPES].join(', ')}` })
      }
      conditions.push(`scope = $2`)
      params.push(scope)
    }

    const { rows } = await pool.query(`
      SELECT view_id, scope, name, filters, is_default, created_at, updated_at
        FROM saved_views
       WHERE ${conditions.join(' AND ')}
       ORDER BY scope, is_default DESC, name
    `, params).catch(err => {
      if (err.code === '42P01') return { rows: [] }   // table missing — empty result
      throw err
    })

    res.json({ items: rows })
  } catch (err) {
    console.error('Error listing saved views:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

export async function createSavedViewRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })

    const { scope, name, filters, is_default } = req.body || {}
    if (!scope || !VALID_SCOPES.has(scope)) {
      return res.status(400).json({ error: 'bad_scope', message: 'scope is required' })
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'bad_name', message: 'name is required' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Only one default per scope per user.
      if (is_default) {
        await client.query(
          'UPDATE saved_views SET is_default = FALSE WHERE user_id = $1 AND scope = $2',
          [userId, scope]
        )
      }
      const { rows } = await client.query(`
        INSERT INTO saved_views (user_id, scope, name, filters, is_default)
        VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, FALSE))
        RETURNING view_id, scope, name, filters, is_default, created_at, updated_at
      `, [userId, scope, name, JSON.stringify(filters || {}), is_default ?? false])
      await client.query('COMMIT')
      res.status(201).json(rows[0])
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err.code === '23505') {
        return res.status(409).json({ error: 'duplicate', message: 'A view with that name already exists for this scope.' })
      }
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('Error creating saved view:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

export async function patchSavedViewRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { viewId } = req.params
    const { name, filters, is_default } = req.body || {}

    // Pull current row & ensure ownership.
    const { rows: existing } = await pool.query(
      'SELECT user_id, scope FROM saved_views WHERE view_id = $1',
      [viewId]
    )
    if (!existing[0]) return res.status(404).json({ error: 'not_found' })
    if (existing[0].user_id !== userId) return res.status(403).json({ error: 'forbidden' })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (is_default) {
        await client.query(
          'UPDATE saved_views SET is_default = FALSE WHERE user_id = $1 AND scope = $2',
          [userId, existing[0].scope]
        )
      }
      const { rows } = await client.query(`
        UPDATE saved_views
           SET name       = COALESCE($1, name),
               filters    = COALESCE($2::jsonb, filters),
               is_default = COALESCE($3, is_default),
               updated_at = NOW()
         WHERE view_id = $4
         RETURNING view_id, scope, name, filters, is_default, created_at, updated_at
      `, [name ?? null, filters ? JSON.stringify(filters) : null, is_default ?? null, viewId])
      await client.query('COMMIT')
      res.json(rows[0])
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('Error patching saved view:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

export async function deleteSavedViewRoute(req, res) {
  try {
    const userId = req.user?.userId
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { viewId } = req.params

    const { rowCount } = await pool.query(
      'DELETE FROM saved_views WHERE view_id = $1 AND user_id = $2',
      [viewId, userId]
    )
    if (!rowCount) return res.status(404).json({ error: 'not_found' })
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting saved view:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
