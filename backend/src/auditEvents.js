// Audit log — read endpoint + tiny `recordAudit` helper for the rest of
// the codebase to call when something noteworthy happens.
//
// Endpoint:
//   GET /api/audit?actor=&action=&entity=&since=&until=&limit=&offset=
//
// All query params optional. Returns rows ordered by ts DESC. Total count
// is returned for pagination.
//
// The endpoint reads from two tables and merges:
//   1. audit_events      — the canonical, fire-and-forget audit stream
//                          (populated by recordAudit() calls).
//   2. invoice_status_audit — DB trigger that captures every
//                          UPDATE OF status on invoices (db_user,
//                          app_name, client_addr). Rows are projected into
//                          audit_events' shape so the UI renders both
//                          streams in one table. See
//                          scripts/migration_invoice_status_audit.sql for
//                          schema + why it exists.
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
 *
 * Returns merged rows from `audit_events` and `invoice_status_audit`.
 * The status-audit rows are mapped onto the same shape:
 *   ts            ← changed_at
 *   actor_kind    = 'system' (trigger-driven)
 *   actor_label   = db_user
 *   action        = 'invoice_status_changed'
 *   entity_kind   = 'invoice'
 *   entity_id     = invoice_id
 *   entity_label  = invoice_number
 *   summary       = "<old> → <new>"
 *   meta          = { db_user, app_name, client_addr, source: 'trigger' }
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

    // ------------------------------------------------------------------
    // Stream 1: canonical audit_events
    // ------------------------------------------------------------------
    let canonicalRows = []
    let canonicalTotal = 0
    try {
      const totalQ = `SELECT COUNT(*)::int AS n FROM audit_events ${where}`
      const rowsQ = `
        SELECT audit_id, ts, actor_kind, actor_id, actor_label, action,
               entity_kind, entity_id, entity_label, summary, meta
          FROM audit_events
          ${where}
          ORDER BY ts DESC
          LIMIT ${lim} OFFSET ${off}
      `
      const [t, r] = await Promise.all([
        pool.query(totalQ, params),
        pool.query(rowsQ, params)
      ])
      canonicalTotal = t.rows[0]?.n || 0
      canonicalRows = r.rows
    } catch (err) {
      if (err.code !== '42P01') throw err
    }

    // ------------------------------------------------------------------
    // Stream 2: invoice_status_audit (trigger-populated) — projected into
    // the same shape and merged. Filters applied client-side here because
    // the projection means most filters need translation (e.g.
    // actor_kind='system' is the only valid value for trigger rows).
    // ------------------------------------------------------------------
    let triggerRows = []
    let triggerTotal = 0
    const shouldIncludeTrigger =
      (!entity_kind || entity_kind === 'invoice') &&
      (!actor_kind || actor_kind === 'system') &&
      (!action || action === 'invoice_status_changed')
    if (shouldIncludeTrigger) {
      try {
        const tConds = []
        const tParams = []
        let j = 1
        if (entity) { tConds.push(`(invoice_id::text = $${j} OR invoice_number ILIKE '%' || $${j} || '%')`); tParams.push(entity); j++ }
        if (since)  { tConds.push(`changed_at >= $${j++}`); tParams.push(since) }
        if (until)  { tConds.push(`changed_at <  $${j++}`); tParams.push(until) }
        if (q)      { tConds.push(`(invoice_number ILIKE '%' || $${j} || '%' OR old_status ILIKE '%' || $${j} || '%' OR new_status ILIKE '%' || $${j} || '%')`); tParams.push(q); j++ }
        if (actor)  { tConds.push(`db_user ILIKE '%' || $${j++} || '%'`); tParams.push(actor) }
        const tWhere = tConds.length ? 'WHERE ' + tConds.join(' AND ') : ''

        const tTotalQ = `SELECT COUNT(*)::int AS n FROM invoice_status_audit ${tWhere}`
        const tRowsQ = `
          SELECT audit_id, invoice_id, invoice_number, old_status, new_status,
                 changed_at, db_user, app_name, client_addr
            FROM invoice_status_audit
            ${tWhere}
            ORDER BY changed_at DESC
            LIMIT ${lim} OFFSET ${off}
        `
        const [tT, tR] = await Promise.all([
          pool.query(tTotalQ, tParams),
          pool.query(tRowsQ, tParams)
        ])
        triggerTotal = tT.rows[0]?.n || 0
        triggerRows = tR.rows.map((r) => ({
          // Disambiguate id-space — `S` prefix marks status-audit rows so
          // React keys never collide with audit_events.audit_id.
          audit_id: `S${r.audit_id}`,
          ts: r.changed_at,
          actor_kind: 'system',
          actor_id: null,
          actor_label: r.db_user || 'db',
          action: 'invoice_status_changed',
          entity_kind: 'invoice',
          entity_id: r.invoice_id != null ? String(r.invoice_id) : null,
          entity_label: r.invoice_number || null,
          summary: r.old_status && r.new_status
            ? `${r.old_status} → ${r.new_status}`
            : (r.new_status || r.old_status || null),
          meta: {
            source: 'trigger',
            db_user: r.db_user,
            app_name: r.app_name,
            client_addr: r.client_addr,
            old_status: r.old_status,
            new_status: r.new_status
          }
        }))
      } catch (err) {
        // 42P01 = relation does not exist; migration may not be applied yet.
        if (err.code !== '42P01') {
          console.warn('invoice_status_audit projection failed:', err.message)
        }
      }
    }

    // Merge + sort by ts desc, then re-page.
    const merged = [...canonicalRows, ...triggerRows]
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
      .slice(0, lim)

    res.json({
      items: merged,
      total: canonicalTotal + triggerTotal,
      limit: lim,
      offset: off
    })
  } catch (err) {
    console.error('Error fetching audit events:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
