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
  try {
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
  } catch (err) {
    console.warn('fetchErrorCodeCounts:', err.message)
    return {}
  }
}

/**
 * Recent unread system notifications (integration failures, threshold
 * breaches). Surfaced at the top of the queue.
 *
 * Defensive: returns [] if the notifications table doesn't exist yet
 * (Phase 2 migration not applied on this DB) — the rest of the queue
 * is still useful without it.
 */
async function fetchSystemNotifications(client, userId, limit = 3) {
  try {
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
  } catch (err) {
    if (err.code !== '42P01') console.warn('fetchSystemNotifications:', err.message)
    return []
  }
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
 * GET /api/insights/suggestions
 *
 * Returns 0–3 AI-style suggestion cards derived from current data.
 *
 * The cards are deterministic — same DB state always produces the same
 * suggestions. Each one combines a numeric finding with a human-readable
 * narrative the Workspace can render directly.
 */
export async function getInsightsSuggestionsRoute(_req, res) {
  const out = []
  try {
    // ---- 1. Single biggest stuck-invoice group (top blocker) ----
    try {
      const { rows } = await pool.query(`
        SELECT e->>'code' AS code, COUNT(DISTINCT i.invoice_id)::int AS n
          FROM invoices i,
               LATERAL jsonb_array_elements(
                 COALESCE(i.mismatches->'errors', '[]'::jsonb)
               ) e
         WHERE i.status IN ('waiting_for_validation', 'waiting_for_re_validation',
                            'debit_note_approval', 'exception_approval')
         GROUP BY e->>'code'
         ORDER BY n DESC
         LIMIT 1
      `)
      const top = rows[0]
      if (top && top.n >= 30) {
        const code  = String(top.code).split('_')[0]
        const label = code === 'E003' ? `Add ${top.n} SC* POs to clear top blocker`
                    : code === 'E022' ? `Approve ${top.n} debit notes in one batch`
                    : code === 'E070' ? `${top.n} GRN rows missing supplier doc no`
                    : code === 'E004' ? `${top.n} OCR invoices need supplier match`
                    : `Resolve ${top.n} stuck invoices in the ${code} bucket`
        const body  = code === 'E003'
          ? 'If source ERP exports subcontract POs, you unlock these invoices in one config change.'
          : code === 'E022'
          ? 'Supplier rate issue across many invoices. Auto-drafted debit notes ready for review.'
          : code === 'E070'
          ? 'Receiving needs to fill supplier_doc_no on the GRN rows. Single-team fix.'
          : code === 'E004'
          ? 'Engine has high-confidence guesses for many of these. A review session clears them.'
          : 'Targeting this category resolves the largest single bucket of stuck invoices.'
        out.push({ icon: 'pi-bolt', title: label, body, metadata: { code, count: top.n } })
      }
    } catch { /* non-fatal */ }

    // ---- 2. Supplier with the highest concentration of one error code ----
    try {
      const { rows } = await pool.query(`
        WITH per AS (
          SELECT s.supplier_name, e->>'code' AS code, COUNT(DISTINCT i.invoice_id)::int AS n
            FROM invoices i
            LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id,
            LATERAL jsonb_array_elements(
              COALESCE(i.mismatches->'errors', '[]'::jsonb)
            ) e
           WHERE i.status IN ('waiting_for_validation', 'waiting_for_re_validation',
                              'debit_note_approval', 'exception_approval')
             AND s.supplier_name IS NOT NULL
           GROUP BY s.supplier_name, e->>'code'
        )
        SELECT supplier_name, code, n
          FROM per
         WHERE n >= 5
         ORDER BY n DESC
         LIMIT 1
      `)
      const top = rows[0]
      if (top) {
        const code = String(top.code).split('_')[0]
        out.push({
          icon: 'pi-percentage',
          title: `${top.supplier_name} ${code === 'E022' ? 'rate' : 'data'} issue is systemic`,
          body:  `All ${top.n} invoices from this supplier hit ${code}. Recommend a master-rate audit.`,
          metadata: { supplier: top.supplier_name, code, count: top.n }
        })
      }
    } catch { /* non-fatal */ }

    // ---- 3. OCR accuracy trend ----
    try {
      const { rows } = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'validated' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0), 0)::numeric(5,3) AS rate
          FROM invoices
         WHERE source = 'ocr'
           AND invoice_date >= CURRENT_DATE - INTERVAL '7 days'
      `)
      const rate = Number(rows[0]?.rate || 0)
      // If OCR validation rate is below 90 % in the last week, flag it.
      if (rate > 0 && rate < 0.90) {
        const pct = Math.round(rate * 100)
        out.push({
          icon: 'pi-trending-up',
          title: `OCR validation rate at ${pct}% this week`,
          body:  'Some PDF templates may have changed format. Review OCR queue and re-extract failures.',
          metadata: { ocr_rate: rate }
        })
      }
    } catch { /* non-fatal */ }

    res.json({ items: out })
  } catch (err) {
    console.error('insights/suggestions:', err)
    res.json({ items: [] })   // never 500 — frontend renders empty state
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
