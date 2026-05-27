// Receipts — unified read across GRN, ASN, Delivery Challans, and PO
// Schedules. Powers the new <Receipts> page that replaces four separate
// list pages with one tabbed view + cross-doc search.
//
// GET /api/receipts
//   ?type=grn|asn|dc|schedule   (defaults to all four — concatenated)
//   ?po=PO123
//   ?supplier_doc=INV-456       (matches invoice number on GRN/ASN)
//   ?supplier=plasmatek         (supplier id or name fragment)
//   ?q=                         (free-text search)
//   ?from=YYYY-MM-DD &to=YYYY-MM-DD
//   ?limit=&offset=
//
// All fields are normalized to a common shape so the frontend renders one
// table for any tab. The original row is included as `raw` for drill-down.
//
// 2026-05 update:
//   • ASN now joins via inv_no → invoices → purchase_orders to surface the
//     PO number (the schema comment promised this but the query didn't do it).
//   • Delivery Challan rows join purchase_orders for the same reason.
//   • GRN now surfaces rejected_qty, rework_qty, excess_qty for quality
//     visibility in the UI mini-bar.

import { pool } from './db.js'

const TYPES = ['grn', 'asn', 'dc', 'schedule']

function normalizeRow(row, kind) {
  switch (kind) {
    case 'grn':
      return {
        kind: 'grn',
        id: row.id,
        doc_no: [row.grn_pfx, row.grn_no].filter(Boolean).join('/'),
        doc_date: row.grn_date,
        po_number: row.po_no,
        supplier_id: row.supplier_id,
        supplier_doc_no: row.supplier_doc_no,
        supplier_doc_date: row.supplier_doc_date,
        item: row.item || row.description_1,
        qty: row.grn_qty != null ? Number(row.grn_qty) : null,
        accepted_qty: row.accepted_qty != null ? Number(row.accepted_qty) : null,
        rejected_qty: row.rejected_qty != null ? Number(row.rejected_qty) : null,
        rework_qty: row.rework_qty != null ? Number(row.rework_qty) : null,
        excess_qty: row.excess_qty != null ? Number(row.excess_qty) : null,
        warehouse: row.warehouse || null,
        gross_weight: row.gross_weight != null ? Number(row.gross_weight) : null,
        nett_weight: row.nett_weight != null ? Number(row.nett_weight) : null,
        uom: row.uom,
        status: row.header_status || (row.supplier_doc_no ? 'linked' : 'doc_no_missing'),
        raw: row
      }
    case 'asn':
      return {
        kind: 'asn',
        id: row.id,
        doc_no: row.asn_no,
        doc_date: row.dc_date,
        po_number: row.po_number || null,
        supplier_id: null,
        supplier_doc_no: row.inv_no,
        supplier_doc_date: row.inv_date,
        item: null,
        qty: null,
        accepted_qty: null,
        uom: null,
        status: row.status,
        transporter: row.transporter_name || row.transporter,
        lr_no: row.lr_no,
        raw: row
      }
    case 'dc':
      return {
        kind: 'dc',
        id: row.id,
        doc_no: row.dc_no,
        doc_date: row.dc_date,
        po_number: row.po_number || null,
        supplier_id: row.supplier_id,
        supplier_doc_no: row.suplr_dc_no,
        supplier_doc_date: row.suplr_dc_date,
        item: row.item,
        qty: row.dc_qty != null ? Number(row.dc_qty) : null,
        accepted_qty: null,
        consumed: row.consumed != null ? Number(row.consumed) : null,
        in_process: row.in_process != null ? Number(row.in_process) : null,
        balance: row.balance != null ? Number(row.balance) : null,
        uom: row.uom,
        status: row.status,
        raw: row
      }
    case 'schedule':
      return {
        kind: 'schedule',
        id: row.id,
        doc_no: row.schedule_ref || [row.ss_pfx, row.ss_no].filter(Boolean).join('/'),
        doc_date: row.sched_date,
        po_number: row.po_number,
        supplier_id: null,
        supplier_doc_no: null,
        supplier_doc_date: null,
        item: row.item_id,
        qty: row.sched_qty != null ? Number(row.sched_qty) : null,
        accepted_qty: null,
        uom: row.uom || row.unit,
        promise_date: row.promise_date,
        required_date: row.required_date,
        status: row.status,
        raw: row
      }
    default:
      return null
  }
}

async function fetchKind(kind, query) {
  const { po, supplier_doc, supplier, q, from, to, limit, offset } = query
  const params = []
  let i = 1
  const conds = []

  function addEq(col, val) {
    if (val !== undefined && val !== null && val !== '') { conds.push(`${col} = $${i++}`); params.push(val) }
  }
  function addLike(col, val) {
    if (val) { conds.push(`${col} ILIKE '%' || $${i++} || '%'`); params.push(val) }
  }
  function addRange(col, lo, hi) {
    if (lo) { conds.push(`${col} >= $${i++}`); params.push(lo) }
    if (hi) { conds.push(`${col} <  $${i++}`); params.push(hi) }
  }

  // Each kind builds its own SELECT body so we can JOIN where needed
  // (ASN → invoices → purchase_orders, DC → purchase_orders) without
  // dropping back to per-tab endpoints.
  let baseSql, dateCol, poCol, supDocCol, supplierIdCol, qFields

  switch (kind) {
    case 'grn':
      baseSql = `SELECT * FROM grn`
      dateCol = 'grn_date'
      poCol = 'po_no'
      supDocCol = 'supplier_doc_no'
      supplierIdCol = 'supplier_id'
      qFields = ['grn_pfx', 'grn_no', 'po_no', 'supplier_doc_no', 'item', 'description_1']
      break
    case 'asn':
      // PO number lives on purchase_orders.po_number, reachable through
      // invoices.invoice_number = asn.inv_no.
      baseSql = `
        SELECT a.*, po.po_number AS po_number
          FROM asn a
          LEFT JOIN invoices inv
            ON TRIM(COALESCE(a.inv_no,'')) <> ''
           AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
          LEFT JOIN purchase_orders po ON po.po_id = inv.po_id`
      dateCol = 'a.dc_date'
      poCol = 'po.po_number'
      supDocCol = 'a.inv_no'
      supplierIdCol = null
      qFields = ['a.asn_no', 'a.inv_no', 'a.transporter_name', 'a.lr_no', 'po.po_number']
      break
    case 'dc':
      baseSql = `
        SELECT dc.*, po.po_number AS po_number
          FROM delivery_challans dc
          LEFT JOIN purchase_orders po ON po.po_id = dc.po_id`
      dateCol = 'dc.dc_date'
      poCol = 'po.po_number'
      supDocCol = 'dc.suplr_dc_no'
      supplierIdCol = 'dc.supplier_id'
      qFields = ['dc.dc_no', 'dc.item', 'dc.description', 'dc.name', 'po.po_number']
      break
    case 'schedule':
      baseSql = `SELECT * FROM po_schedules`
      dateCol = 'sched_date'
      poCol = 'po_number'
      supDocCol = null
      supplierIdCol = null
      qFields = ['po_number', 'schedule_ref', 'item_id', 'description']
      break
    default:
      return []
  }

  if (poCol)         addEq(poCol, po)
  if (supDocCol)     addEq(supDocCol, supplier_doc)
  if (supplierIdCol) addEq(supplierIdCol, supplier)
  addRange(dateCol, from, to)
  if (q) {
    const placeholder = `$${i++}`
    params.push(q)
    conds.push('(' + qFields.map(f => `${f} ILIKE '%' || ${placeholder} || '%'`).join(' OR ') + ')')
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const lim = Math.min(parseInt(limit, 10) || 50, 500)
  const off = parseInt(offset, 10) || 0

  const sql = `
    ${baseSql}
    ${where}
    ORDER BY ${dateCol} DESC NULLS LAST
    LIMIT ${lim} OFFSET ${off}
  `
  try {
    const { rows } = await pool.query(sql, params)
    return rows.map(r => normalizeRow(r, kind))
  } catch (err) {
    console.warn(`receipts.fetchKind(${kind}) failed:`, err.message)
    return []
  }
}

/**
 * Real COUNT(*) per receipt-kind, ignoring pagination/filters.
 *   { grn: N, asn: N, dc: N, schedule: N }
 * Used by the KPI strip + tab chips on the Receipts page so they reflect
 * the table size, not the current page size.
 */
async function fetchTotals(kinds) {
  const tableFor = (k) => k === 'grn' ? 'grn'
    : k === 'asn' ? 'asn'
    : k === 'dc'  ? 'delivery_challans'
    : k === 'schedule' ? 'po_schedules'
    : null
  const out = {}
  await Promise.all(kinds.map(async (k) => {
    const table = tableFor(k)
    if (!table) { out[k] = 0; return }
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)
      out[k] = rows[0]?.n || 0
    } catch (err) {
      console.warn(`receipts.fetchTotals(${k}) failed:`, err.message)
      out[k] = 0
    }
  }))
  return out
}

export async function getReceiptsRoute(req, res) {
  try {
    const requested = (req.query.type || '').split(',').map(t => t.trim()).filter(Boolean)
    const kinds = requested.length > 0 ? requested.filter(t => TYPES.includes(t)) : TYPES

    // Always compute totals for ALL four kinds so the KPI strip is stable
    // regardless of which tab the user is on (the page only fetches one
    // tab's rows at a time but every tab's count needs to be live).
    const [results, totals] = await Promise.all([
      Promise.all(kinds.map(k => fetchKind(k, req.query))),
      fetchTotals(TYPES)
    ])
    const items = results.flat()

    res.json({
      items,
      // `by_kind` kept for back-compat — page-size on this response.
      by_kind: Object.fromEntries(kinds.map((k, idx) => [k, results[idx].length])),
      // `total_by_kind` = real COUNT(*) per table, the value the KPI strip
      // and tab chips should display.
      total_by_kind: totals
    })
  } catch (err) {
    console.error('Error fetching receipts:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
