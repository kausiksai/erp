// Item price history — invoice-side complement to the existing
// /items/:itemCode/po-history endpoint.
//
//   GET /api/items/:itemCode/invoice-history?limit=20
//
// Returns the actual billed rate per invoice over time, by joining
// purchase_order_lines.item_id back through po_id to invoices.
// The new <Item Price History> page renders these as a per-invoice trend
// table and a multi-supplier line chart.
//
// Existing /items/:itemCode/po-history (PO-side rates) is unchanged.

import { pool } from './db.js'

export async function getInvoicePriceHistoryRoute(req, res) {
  try {
    const itemCode = (req.params.itemCode || '').trim()
    if (!itemCode) return res.status(400).json({ error: 'item_code_required' })
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200)

    // Pull invoice-line records that mention this item code. The actual
    // invoice line items are stored in invoice_line_items per the schema.
    // If that table doesn't exist (older deployments), fall back to
    // matching via PO lines + invoice headers.
    const sql = `
      WITH item_pos AS (
        SELECT DISTINCT po.po_id
          FROM purchase_order_lines pol
          JOIN purchase_orders po ON po.po_id = pol.po_id
         WHERE UPPER(TRIM(pol.item_id)) = UPPER(TRIM($1))
      )
      SELECT
        i.invoice_id,
        i.invoice_number,
        i.invoice_date,
        i.po_id,
        po.po_number,
        po.pfx        AS po_pfx,
        s.supplier_id,
        s.supplier_name,
        i.total_amount,
        i.status
        FROM invoices i
        JOIN item_pos ip ON ip.po_id = i.po_id
        LEFT JOIN purchase_orders po ON po.po_id = i.po_id
        LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
       ORDER BY i.invoice_date DESC NULLS LAST
       LIMIT $2
    `
    const { rows } = await pool.query(sql, [itemCode, limit])

    // PO-side rates for the matching POs so the UI can compute Δ-vs-PO.
    const poIds = [...new Set(rows.map(r => r.po_id).filter(Boolean))]
    const polRates = poIds.length === 0 ? {} : await pool.query(`
      SELECT po_id, unit_cost, disc_pct, qty
        FROM purchase_order_lines
       WHERE po_id = ANY($1::bigint[])
         AND UPPER(TRIM(item_id)) = UPPER(TRIM($2))
    `, [poIds, itemCode]).then(r => Object.fromEntries(
      r.rows.map(x => [x.po_id, {
        po_rate: Number(x.unit_cost) || 0,
        disc_pct: Number(x.disc_pct) || 0,
        po_qty: Number(x.qty) || 0,
        effective_rate: Number(x.unit_cost) * (1 - (Number(x.disc_pct) || 0) / 100)
      }])
    ))

    const enriched = rows.map(r => ({
      ...r,
      ...(polRates[r.po_id] || {})
    }))

    // Summary: simple per-supplier average and overall trend
    const bySupplier = {}
    for (const r of enriched) {
      const key = r.supplier_name || 'unknown'
      if (!bySupplier[key]) bySupplier[key] = { count: 0, sum: 0, latest: null, latest_date: null }
      const rate = r.effective_rate ?? r.po_rate ?? 0
      bySupplier[key].count += 1
      bySupplier[key].sum += rate
      if (!bySupplier[key].latest_date || (r.invoice_date && r.invoice_date > bySupplier[key].latest_date)) {
        bySupplier[key].latest_date = r.invoice_date
        bySupplier[key].latest = rate
      }
    }
    const supplierSummary = Object.entries(bySupplier).map(([name, v]) => ({
      supplier_name: name,
      avg_rate: v.count > 0 ? v.sum / v.count : 0,
      latest_rate: v.latest,
      latest_date: v.latest_date,
      count: v.count
    })).sort((a, b) => b.count - a.count)

    res.json({
      item_code: itemCode,
      count: enriched.length,
      rows: enriched,
      by_supplier: supplierSummary
    })
  } catch (err) {
    console.error('[items/:itemCode/invoice-history]', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
