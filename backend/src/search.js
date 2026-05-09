// Cross-entity search — feeds the ⌘K command palette.
//
//   GET /api/search?q=PT26&limit=5
//
// Returns top hits across invoices, purchase orders, suppliers, and
// validation rules. Each hit is normalized to:
//
//   { kind, id, label, sub, link }
//
// where `link` is the in-app path the palette should navigate to.

import { pool } from './db.js'

async function searchInvoices(q, limit) {
  const { rows } = await pool.query(`
    SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.total_amount,
           i.status, s.supplier_name
      FROM invoices i
      LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
     WHERE i.invoice_number ILIKE '%' || $1 || '%'
     ORDER BY i.invoice_date DESC NULLS LAST
     LIMIT $2
  `, [q, limit])
  return rows.map(r => ({
    kind: 'invoice',
    id: r.invoice_id,
    label: r.invoice_number,
    sub: [r.supplier_name, r.total_amount && '₹' + Number(r.total_amount).toLocaleString('en-IN')].filter(Boolean).join(' · '),
    meta: r.status,
    link: `/invoices/validate/${r.invoice_id}`
  }))
}

async function searchPurchaseOrders(q, limit) {
  const { rows } = await pool.query(`
    SELECT po.po_id, po.po_number, po.pfx, po.date, s.supplier_name, po.status
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
     WHERE po.po_number ILIKE '%' || $1 || '%'
        OR (COALESCE(po.pfx, '') || '/' || po.po_number) ILIKE '%' || $1 || '%'
     ORDER BY po.date DESC NULLS LAST
     LIMIT $2
  `, [q, limit])
  return rows.map(r => ({
    kind: 'po',
    id: r.po_id,
    label: [r.pfx, r.po_number].filter(Boolean).join('/'),
    sub: [r.supplier_name].filter(Boolean).join(' · '),
    meta: r.status,
    link: `/purchase-orders?q=${encodeURIComponent(r.po_number)}`
  }))
}

async function searchSuppliers(q, limit) {
  const { rows } = await pool.query(`
    SELECT supplier_id, supplier_name, gst_number
      FROM suppliers
     WHERE supplier_name ILIKE '%' || $1 || '%'
        OR gst_number ILIKE '%' || $1 || '%'
     ORDER BY supplier_name
     LIMIT $2
  `, [q, limit])
  return rows.map(r => ({
    kind: 'supplier',
    id: r.supplier_id,
    label: r.supplier_name,
    sub: r.gst_number,
    link: `/suppliers?q=${encodeURIComponent(r.supplier_name)}`
  }))
}

/**
 * GET /api/search?q=...&limit=5
 *
 * Fans out to invoices, POs, suppliers in parallel. Robust to any single
 * source erroring (returns the others).
 */
export async function getSearchRoute(req, res) {
  try {
    const q = (req.query.q || '').trim()
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 25)

    if (q.length < 2) {
      return res.json({ q, sections: [] })
    }

    const tasks = [
      searchInvoices(q, limit).catch(e => { console.warn('search invoices:', e.message); return [] }),
      searchPurchaseOrders(q, limit).catch(e => { console.warn('search POs:', e.message); return [] }),
      searchSuppliers(q, limit).catch(e => { console.warn('search suppliers:', e.message); return [] })
    ]
    const [invoices, pos, suppliers] = await Promise.all(tasks)

    const sections = [
      { label: 'Invoices',         items: invoices },
      { label: 'Purchase orders',  items: pos },
      { label: 'Suppliers',        items: suppliers }
    ].filter(s => s.items.length > 0)

    res.json({ q, sections })
  } catch (err) {
    console.error('Error in search:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
