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
        po_number: null,                  // derived via asn.inv_no→invoices→po
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
        po_number: null,
        supplier_id: row.supplier_id,
        supplier_doc_no: null,
        supplier_doc_date: null,
        item: row.item,
        qty: row.dc_qty != null ? Number(row.dc_qty) : null,
        accepted_qty: null,
        consumed: row.consumed != null ? Number(row.consumed) : null,
        balance: row.balance != null ? Number(row.balance) : null,
        uom: row.uom,
        status: null,
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
        status: null,
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

  let table, dateCol, poCol, supDocCol, supplierIdCol, qFields
  switch (kind) {
    case 'grn':
      table = 'grn'; dateCol = 'grn_date'; poCol = 'po_no'; supDocCol = 'supplier_doc_no'; supplierIdCol = 'supplier_id'
      qFields = ['grn_pfx', 'grn_no', 'po_no', 'supplier_doc_no', 'item', 'description_1']
      break
    case 'asn':
      table = 'asn'; dateCol = 'dc_date'; poCol = null; supDocCol = 'inv_no'; supplierIdCol = null
      qFields = ['asn_no', 'inv_no', 'transporter_name', 'lr_no']
      break
    case 'dc':
      table = 'delivery_challans'; dateCol = 'dc_date'; poCol = null; supDocCol = null; supplierIdCol = 'supplier_id'
      qFields = ['dc_no', 'item', 'description', 'name']
      break
    case 'schedule':
      table = 'po_schedules'; dateCol = 'sched_date'; poCol = 'po_number'; supDocCol = null; supplierIdCol = null
      qFields = ['po_number', 'schedule_ref', 'item_id', 'description']
      break
    default:
      return []
  }

  if (poCol)        addEq(poCol, po)
  if (supDocCol)    addEq(supDocCol, supplier_doc)
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
    SELECT * FROM ${table}
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

export async function getReceiptsRoute(req, res) {
  try {
    const requested = (req.query.type || '').split(',').map(t => t.trim()).filter(Boolean)
    const kinds = requested.length > 0 ? requested.filter(t => TYPES.includes(t)) : TYPES

    const results = await Promise.all(kinds.map(k => fetchKind(k, req.query)))
    const items = results.flat()

    res.json({ items, by_kind: Object.fromEntries(kinds.map((k, idx) => [k, results[idx].length])) })
  } catch (err) {
    console.error('Error fetching receipts:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
