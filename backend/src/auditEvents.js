// Audit log — read endpoint + tiny `recordAudit` helper for the rest of
// the codebase to call when something noteworthy happens.
//
// Endpoint:
//   GET /api/audit?actor=&action=&entity=&since=&until=&limit=&offset=
//
// All query params optional. Returns rows ordered by ts DESC. Total count
// is returned for pagination.
//
// Helper:
//   recordAudit({ actorKind, actorId, actorLabel, action, entityKind,
//                 entityId, entityLabel, summary, meta })
//
// Both are no-ops if the audit_events table doesn't exist (migration
// unapplied) — the caller never sees an error.

import { pool } from './db.js'

/**
 * Insert one row into audit_events. Designed to be fire-and-forget — never
 * throws into the caller, never blocks the user-facing request.
 *
 * The validation engine, payment-approval handler, supplier edit, etc.
 * should each call this when they finish a meaningful action.
 */
export async function recordAudit(event) {
  try {
    await pool.query(`
      INSERT INTO audit_events
        (actor_kind, actor_id, actor_label, action,
         entity_kind, entity_id, entity_label, summary, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      event.actorKind || 'system',
      event.actorId   || null,
      event.actorLabel || null,
      event.action,
      event.entityKind  || null,
      event.entityId    ? String(event.entityId) : null,
      event.entityLabel || null,
      event.summary || null,
      event.meta ? JSON.stringify(event.meta) : null
    ])
  } catch (err) {
    // Never let audit failures cascade — log and swallow.
    console.warn('recordAudit failed (non-fatal):', err.message)
  }
}

/**
 * GET /api/audit
 */
export async function getAuditEventsRoute(req, res) {
  try {
    const {
      actor, actor_kind, action, entity, entity_kind,
      since, until, limit, offset, q
    } = req.query

    const conditions = []
    const params = []
    let i = 1

    if (actor_kind) { conditions.push(`actor_kind = $${i++}`); params.push(actor_kind) }
    if (actor)      { conditions.push(`(actor_id::text = $${i} OR actor_label ILIKE '%' || $${i} || '%')`); params.push(actor); i++ }
    if (action)     { conditions.push(`action = $${i++}`);     params.push(action) }
    if (entity_kind){ conditions.push(`entity_kind = $${i++}`); params.push(entity_kind) }
    if (entity)     { conditions.push(`(entity_id = $${i} OR entity_label ILIKE '%' || $${i} || '%')`); params.push(entity); i++ }
    if (since)      { conditions.push(`ts >= $${i++}`); params.push(since) }
    if (until)      { conditions.push(`ts < $${i++}`);  params.push(until) }
    if (q)          { conditions.push(`(summary ILIKE '%' || $${i} || '%' OR entity_label ILIKE '%' || $${i} || '%' OR action ILIKE '%' || $${i} || '%')`); params.push(q); i++ }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    const lim = Math.min(parseInt(limit, 10) || 50, 500)
    const off = parseInt(offset, 10) || 0

    const totalQ = `SELECT COUNT(*)::int AS n FROM audit_events ${where}`
    const rowsQ = `
      SELECT audit_id, ts, actor_kind, actor_id, actor_label, action,
             entity_kind, entity_id, entity_label, summary, meta
        FROM audit_events
        ${where}
        ORDER BY ts DESC
        LIMIT ${lim} OFFSET ${off}
    `

    let total = 0
    let items = []
    try {
      const [t, r] = await Promise.all([
        pool.query(totalQ, params),
        pool.query(rowsQ, params)
      ])
      total = t.rows[0]?.n || 0
      items = r.rows
    } catch (err) {
      // Table missing → empty result, not 500.
      if (err.code !== '42P01') throw err
    }
    res.json({ items, total, limit: lim, offset: off })
  } catch (err) {
    console.error('Error fetching audit events:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
