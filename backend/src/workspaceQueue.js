// Workspace action queue — feeds the new <Workspace> page.
//
// Returns a prioritized list of "things waiting on you right now": single
// invoices that need an approval, error-code groups with bulk actions,
// recent system notifications, and an upbeat reminder of what's already
// validated and ready for payment.
//
// Each item includes:
//   id        stable string (used by the UI as React key)
//   priority  0 = critical, 1 = action, 2 = info
//   variant   chip color: 'danger' | 'warn' | 'info' | 'success'
//   icon      PrimeIcons class name
//   title     headline
//   body      one-line description
//   chip      optional badge text (error code, count, etc.)
//   actions   buttons the UI should render — each has a label and either
//             a `link` (in-app navigation) or an `action` (server-side
//             trigger we'll wire later)
//
// Read by GET /api/workspace/queue. No writes.

import { pool } from './db.js'

/**
 * Counts of invoices grouped by their current `status`. We use these for
 * both the "ready for payment" positive item and the "rejected" warning.
 */
async function fetchStatusCounts(client) {
  const { rows } = await client.query(`
    SELECT status, COUNT(*)::int AS n
      FROM invoices
     GROUP BY status
  `)
  return Object.fromEntries(rows.map(r => [r.status, r.n]))
}

/**
 * Counts of invoices grouped by the most recent validation error code
 * stored in `mismatches.errors[].code`. We don't hit the validation engine
 * on every queue request — instead we read the cached result that the
 * engine writes back during its run.
 *
 * Falls back gracefully if `mismatches` isn't populated (returns {}).
 */
async function fetchErrorCodeCounts(client) {
  const { rows } = await client.query(`
    SELECT code, COUNT(*)::int AS n
      FROM (
        SELECT DISTINCT i.invoice_id, e->>'code' AS code
          FROM invoices i,
               LATERAL jsonb_array_elements(
                 COALESCE(i.mismatches->'errors', '[]'::jsonb)
               ) AS e
         WHERE i.status IN (
           'waiting_for_validation',
           'waiting_for_re_validation',
           'debit_note_approval',
           'exception_approval'
         )
      ) x
     GROUP BY code
     ORDER BY n DESC
  `)
  return Object.fromEntries(rows.map(r => [r.code, r.n]))
}

/**
 * Recent unread system notifications (integration failures, threshold
 * breaches). Surfaced at the top of the queue.
 */
async function fetchSystemNotifications(client, userId, limit = 3) {
  const { rows } = await client.query(`
    SELECT notification_id, ts, variant, title, body, link
      FROM notifications
     WHERE user_id = $1
       AND read_at IS NULL
       AND variant IN ('danger', 'warn')
     ORDER BY ts DESC
     LIMIT $2
  `, [userId, limit])
  return rows
}

/**
 * Build the queue. Items returned in priority order — UI just renders top
 * to bottom.
 */
async function buildQueue(userId) {
  const client = await pool.connect()
  try {
    const [statusCounts, errorCounts, sysNotifs] = await Promise.all([
      fetchStatusCounts(client),
      fetchErrorCodeCounts(client),
      fetchSystemNotifications(client, userId)
    ])

    const items = []

    // ---- Critical system events ----
    for (const n of sysNotifs) {
      items.push({
        id: `notif:${n.notification_id}`,
        priority: 0,
        variant: n.variant,
        icon: n.variant === 'danger' ? 'pi-server' : 'pi-exclamation-triangle',
        title: n.title,
        body: n.body || '',
        actions: n.link ? [{ label: 'Open', link: n.link }] : []
      })
    }

    // ---- AI-suggested debit notes (E022 line rate mismatch) ----
    if (errorCounts.E022) {
      items.push({
        id: 'group:E022',
        priority: 1,
        variant: 'danger',
        icon: 'pi-rupee',
        chip: `${errorCounts.E022} invoices`,
        title: `${errorCounts.E022} debit notes ready to approve`,
        body: 'Suppliers billed at gross PO rate — auto-drafted debit notes for the discount difference.',
        actions: [
          { label: 'Review',     link: '/invoices/reconciliation?code=E022' },
          { label: 'Approve all', action: 'approve_debit_notes_E022', kind: 'success' }
        ]
      })
    }

    // ---- Receiving-team groups ----
    if (errorCounts.E070) {
      items.push({
        id: 'group:E070',
        priority: 1,
        variant: 'warn',
        icon: 'pi-inbox',
        chip: `${errorCounts.E070} invoices`,
        title: `${errorCounts.E070} invoices waiting on GRN entry`,
        body: 'No GRN row carries the invoice number. Receiving needs to fill supplier_doc_no.',
        actions: [
          { label: 'Email receiving', action: 'email_receiving', kind: 'info' },
          { label: 'Open queue',      link: '/invoices/reconciliation?code=E070' }
        ]
      })
    }

    // ---- OCR extraction failures ----
    const ocrMiss = (errorCounts.E002 || 0) + (errorCounts.E004 || 0)
    if (ocrMiss > 0) {
      items.push({
        id: 'group:OCR',
        priority: 1,
        variant: 'info',
        icon: 'pi-image',
        chip: `${ocrMiss} invoices`,
        title: `${ocrMiss} OCR invoices need supplier or PO match`,
        body: 'Engine has high-confidence guesses for many — review and accept.',
        actions: [{ label: 'Open queue', link: '/invoices/reconciliation?code=E004' }]
      })
    }

    // ---- Subcontract POs missing (E003) ----
    if (errorCounts.E003) {
      items.push({
        id: 'group:E003',
        priority: 1,
        variant: 'danger',
        icon: 'pi-exclamation-triangle',
        chip: `${errorCounts.E003} invoices`,
        title: `Source ERP missing ${errorCounts.E003} POs`,
        body: 'Subcontract POs (SC*-prefixed) aren\'t in the daily export. Largest blocker.',
        actions: [{ label: 'Escalate', action: 'email_source_erp', kind: 'danger' }]
      })
    }

    // ---- Validated and ready for payment (positive item) ----
    const validated = statusCounts.validated || 0
    if (validated > 0) {
      items.push({
        id: 'status:validated',
        priority: 2,
        variant: 'success',
        icon: 'pi-check-circle',
        chip: 'Validated',
        title: `${validated} invoices ready for payment approval`,
        body: 'Engine signed off. Bulk-approve into the next payment batch.',
        actions: [{ label: 'Approve all →', link: '/payments/approve', kind: 'primary' }]
      })
    }

    return items
  } finally {
    client.release()
  }
}

/**
 * GET /api/insights/validation-trend?days=14
 *
 * Returns daily counts of invoices currently in `validated` status,
 * bucketed by their last update date. Used by the Workspace trend chart.
 *
 * This isn't a perfect "validations per day" stream because status changes
 * can be overwritten — but it tracks the cumulative pipeline well enough
 * for the visual.
 */
export async function getValidationTrendRoute(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90)
    const { rows } = await pool.query(`
      WITH series AS (
        SELECT generate_series(
          (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
          CURRENT_DATE,
          INTERVAL '1 day'
        )::date AS d
      ),
      buckets AS (
        SELECT DATE_TRUNC('day', updated_at)::date AS d, COUNT(*)::int AS n
          FROM invoices
         WHERE status = 'validated'
           AND updated_at >= CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day'
         GROUP BY 1
      )
      SELECT to_char(s.d, 'YYYY-MM-DD') AS date,
             COALESCE(b.n, 0)            AS count
        FROM series s
        LEFT JOIN buckets b ON b.d = s.d
        ORDER BY s.d
    `, [days])
    res.json({ days, points: rows })
  } catch (err) {
    console.error('Error building validation trend:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * GET /api/workspace/queue
 *
 * Returns the action queue for the authenticated user. The user comes
 * from authenticateToken middleware, which sets req.user.user_id.
 */
export async function getWorkspaceQueueRoute(req, res) {
  try {
    const userId = req.user?.user_id
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    const items = await buildQueue(userId)
    res.json({ items })
  } catch (err) {
    console.error('Error building workspace queue:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
