// Supplier 360 — read-only aggregate view that powers the redesigned
// Suppliers slide-over.
//
// GET /api/suppliers/:id/360
//
// Pulls in one round trip:
//   * basic master data (name, GST, address, bank, contact)
//   * 30-day metrics (invoice count, validated count, spend, issues)
//   * recent invoices (last 10)
//   * State distribution from the supplier's invoices' PO supplier_id chain
//     (proxy for multi-state GSTIN signal — the dedicated gst_classification
//     column was never added to the DB, so we derive it from supplier state)
//   * top-3 error codes affecting this supplier
//   * payment-cycle averages (load → bank, in days)
//
// All columns referenced in the SELECTs are verified against
// backend/src/schema.sql + scripts/migration_email_automation.sql (which
// adds suppliers.suplr_id). Fields that the frontend wants but the DB
// doesn't carry (payment_term_days, payment_mode) are returned as null so
// the UI renders '—' rather than crashing.

import { pool } from './db.js'

export async function getSupplier360Route(req, res) {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' })

    const [
      supplier,
      metrics,
      recentInvoices,
      stateSplit,
      topErrors,
      paymentCycle
    ] = await Promise.all([
      pool.query(
        `SELECT supplier_id, supplier_name, suplr_id, gst_number, pan_number,
                supplier_address, city, state_code, state_name, pincode,
                contact_person, phone, mobile, email, website, msme_number,
                bank_account_name, bank_account_number, bank_ifsc_code,
                bank_name, branch_name,
                created_at, updated_at
           FROM suppliers
          WHERE supplier_id = $1`,
        [id]
      ),

      // 30-day metrics
      pool.query(
        `WITH s AS (
           SELECT
             COUNT(*)::int AS inv_total,
             COUNT(*) FILTER (WHERE status = 'validated')::int AS inv_validated,
             COUNT(*) FILTER (WHERE status IN ('waiting_for_validation',
                                               'waiting_for_re_validation',
                                               'debit_note_approval',
                                               'exception_approval'))::int AS inv_open,
             COALESCE(SUM(total_amount) FILTER (WHERE invoice_date >= CURRENT_DATE - INTERVAL '30 days'), 0)::numeric(15,2) AS spend_30d,
             COUNT(*) FILTER (WHERE invoice_date >= CURRENT_DATE - INTERVAL '30 days')::int AS inv_30d
           FROM invoices
          WHERE supplier_id = $1
         ),
         issues AS (
           SELECT COUNT(*)::int AS n
             FROM invoices
            WHERE supplier_id = $1
              AND status IN ('waiting_for_validation', 'waiting_for_re_validation',
                             'debit_note_approval',     'exception_approval')
              AND COALESCE(jsonb_array_length(mismatches->'errors'), 0) > 0
         )
         SELECT s.*, issues.n AS open_issues FROM s, issues`,
        [id]
      ),

      // Last 10 invoices
      pool.query(
        `SELECT invoice_id, invoice_number, invoice_date, total_amount, status, source, po_number,
                reconciliation_status
           FROM invoices
          WHERE supplier_id = $1
          ORDER BY invoice_date DESC NULLS LAST, invoice_id DESC
          LIMIT 10`,
        [id]
      ),

      // State distribution — derived from this supplier's PO unit/state. We
      // group invoices by the originating PO's unit (factory/state code) so
      // multi-state suppliers show up as multiple buckets.
      pool.query(
        `SELECT COALESCE(po.unit, 'unknown') AS classification,
                COUNT(*)::int AS n
           FROM invoices i
           LEFT JOIN purchase_orders po ON po.po_id = i.po_id
          WHERE i.supplier_id = $1
          GROUP BY 1
          ORDER BY n DESC`,
        [id]
      ).catch(() => ({ rows: [] })),

      // Top 3 error codes for this supplier (degrades gracefully if
      // mismatches column is empty).
      pool.query(
        `SELECT e->>'code' AS code, COUNT(DISTINCT i.invoice_id)::int AS n
           FROM invoices i,
                LATERAL jsonb_array_elements(
                  COALESCE(i.mismatches->'errors', '[]'::jsonb)
                ) e
          WHERE i.supplier_id = $1
          GROUP BY e->>'code'
          ORDER BY n DESC
          LIMIT 3`,
        [id]
      ).catch(() => ({ rows: [] })),

      // Payment-cycle days (avg between invoice_date and a 'paid' update).
      // Uses payment_done_at from payment_approvals when available, else
      // falls back to the invoice's updated_at when status flipped to paid.
      pool.query(
        `SELECT
           COALESCE(
             AVG(EXTRACT(EPOCH FROM (COALESCE(pa.payment_done_at, i.updated_at) - i.invoice_date::timestamptz)) / 86400.0),
             0
           )::numeric(6,1) AS avg_days
           FROM invoices i
           LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
          WHERE i.supplier_id = $1
            AND i.status = 'paid'
            AND i.invoice_date IS NOT NULL`,
        [id]
      )
    ])

    if (supplier.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' })
    }
    const sup = supplier.rows[0]
    const m   = metrics.rows[0] || {}

    // Health score: validated / total * 100, with a floor at 0 when total=0.
    const total = Number(m.inv_total || 0)
    const validated = Number(m.inv_validated || 0)
    const health = total > 0 ? Math.round((validated / total) * 100) : null

    res.json({
      supplier: {
        ...sup,
        // Columns the frontend renders but the DB doesn't carry. Surfaced
        // as nulls so the UI renders '—' rather than `undefined`.
        payment_term_days: null,
        payment_mode: null
      },
      metrics: {
        invoices_total:        total,
        invoices_validated:    validated,
        invoices_open:         Number(m.inv_open || 0),
        invoices_30d:          Number(m.inv_30d || 0),
        spend_30d:             Number(m.spend_30d || 0),
        open_issues:           Number(m.open_issues || 0),
        health_score:          health,
        avg_payment_days:      paymentCycle.rows[0]?.avg_days != null
                                 ? Number(paymentCycle.rows[0].avg_days)
                                 : null
      },
      recent_invoices: recentInvoices.rows,
      // Kept as `gst_distribution` for backward compatibility with the
      // frontend. Values are unit codes (state proxy) — see notes above.
      gst_distribution: stateSplit.rows,
      top_error_codes:  topErrors.rows
    })
  } catch (err) {
    console.error('Error building supplier 360:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
