/**
 * Parse Excel (PO matched, GRN matched, Pending ASN) and insert into DB.
 * Uses first sheet; first row = headers. Column names matched case-insensitively and with common aliases.
 */
import XLSX from 'xlsx'
import { pool } from './db.js'

function normalizeKey (s) {
  if (s == null || typeof s !== 'string') return ''
  return String(s).trim().toLowerCase().replace(/\s+/g, '_')
}

/** Get value from row by trying several possible header names */
function get (row, ...keys) {
  const norm = (k) => normalizeKey(k)
  const keyList = keys.flatMap(k => (typeof k === 'string' ? [k] : []))
  for (const key of keyList) {
    for (const [header, value] of Object.entries(row)) {
      if (norm(header) === norm(key)) return value
    }
  }
  return undefined
}

function toNum (v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toDecimal (v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toStr (v, maxLen = 255) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : (maxLen ? s.slice(0, maxLen) : s)
}

/** Excel epoch (Jan 1 1900) to JS: 25569 days */
function excelSerialToDate (serial) {
  const utcDays = Math.floor(serial - 25569)
  const d = new Date(utcDays * 86400 * 1000)
  if (isNaN(d.getTime())) return null
  return d
}

/** Parse date from Excel serial, "DD-MMM-YY", "YYYY-MM-DD", etc. */
function parseDate (v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return v
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = excelSerialToDate(v)
    if (d) return d
  }
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function formatDateForPg (d) {
  if (!d || !(d instanceof Date)) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Parse workbook buffer and return array of row objects (first row = headers).
 */
function parseExcelToRows (buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const firstSheet = wb.SheetNames[0]
  if (!firstSheet) return []
  const sheet = wb.Sheets[firstSheet]
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
}

/**
 * Import PO matched Excel: group rows by (po_number, amd_no), insert purchase_orders then purchase_order_lines.
 * Expects columns like: UNIT, REF_UNIT, PFX, O_NUMBE/PO_NUMBER/PO Number, DATE, AMD_NO, SUPLR_ID, PPLIER_NA/SUPPLIER_NAME, TERMS,
 * ITEM_ID, ESCRIPTION/DESCRIPTION/DESCRIPTION1, QTY, UNIT_COST, DISC%/DISC_PCT, etc.
 */
export async function importPoExcel (buffer, client) {
  const rows = parseExcelToRows(buffer)
  if (rows.length === 0) return { purchaseOrdersInserted: 0, linesInserted: 0 }

  const poKey = (r) => {
    const num = toStr(get(r, 'O_NUMBE', 'PO_NUMBER', 'PO Number', 'po_number', 'PO_NO')) || ''
    const amd = toNum(get(r, 'AMD_NO', 'amd_no', 'Amendment No')) ?? 0
    return `${num}|${amd}`
  }

  const groups = new Map()
  for (const row of rows) {
    const key = poKey(row)
    if (!key || key === '|0') continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  let purchaseOrdersInserted = 0
  let linesInserted = 0

  for (const [, groupRows] of groups) {
    const first = groupRows[0]
    const poNumber = toStr(get(first, 'O_NUMBE', 'PO_NUMBER', 'PO Number', 'po_number', 'PO_NO'))
    if (!poNumber) continue

    const poDate = parseDate(get(first, 'DATE', 'date', 'PO Date', 'po_date'))
    if (!poDate) continue

    const amdNo = Math.max(0, Math.floor(toNum(get(first, 'AMD_NO', 'amd_no', 'Amendment No')) ?? 0))
    const unit = toStr(get(first, 'UNIT'), 50)
    const refUnit = toStr(get(first, 'REF_UNIT'), 50)
    const pfx = toStr(get(first, 'PFX'), 50)
    const suplrId = toStr(get(first, 'SUPLR_ID', 'suplr_id', 'Supplier ID'), 50)
    const terms = toStr(get(first, 'TERMS', 'terms'))

    let supplierId = null
    const supplierName = toStr(get(first, 'PPLIER_NA', 'SUPPLIER_NAME', 'Supplier Name', 'supplier_name'))
    if (supplierName) {
      const sup = await client.query(
        `SELECT supplier_id FROM suppliers WHERE LOWER(TRIM(supplier_name)) = LOWER(TRIM($1)) LIMIT 1`,
        [supplierName]
      )
      if (sup.rows[0]) supplierId = sup.rows[0].supplier_id
    }

    const poInsert = await client.query(
      `INSERT INTO purchase_orders (unit, ref_unit, pfx, po_number, date, amd_no, suplr_id, supplier_id, terms, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')
       ON CONFLICT (po_number, amd_no) DO UPDATE SET unit = EXCLUDED.unit, ref_unit = EXCLUDED.ref_unit, pfx = EXCLUDED.pfx, date = EXCLUDED.date, suplr_id = EXCLUDED.suplr_id, supplier_id = EXCLUDED.supplier_id, terms = EXCLUDED.terms
       RETURNING po_id`,
      [unit, refUnit, pfx, poNumber, formatDateForPg(poDate), amdNo, suplrId, supplierId, terms]
    )
    const poId = poInsert.rows[0]?.po_id
    if (!poId) continue
    purchaseOrdersInserted++

    await client.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [poId])

    let seq = 0
    for (const row of groupRows) {
      seq++
      const itemId = toStr(get(row, 'ITEM_ID', 'item_id', 'Item ID'), 50)
      const description1 = toStr(get(row, 'ESCRIPTION', 'DESCRIPTION', 'description1', 'Description'))
      const qty = toDecimal(get(row, 'QTY', 'qty', 'Quantity'))
      const unitCost = toDecimal(get(row, 'UNIT_COST', 'unit_cost', 'Unit Cost'))
      const discPct = toDecimal(get(row, 'DISC%', 'DISC_PCT', 'disc_pct', 'Discount %'))

      await client.query(
        `INSERT INTO purchase_order_lines (po_id, sequence_number, item_id, description1, qty, unit_cost, disc_pct)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [poId, seq, itemId, description1, qty, unitCost, discPct ?? 0]
      )
      linesInserted++
    }
  }

  return { purchaseOrdersInserted, linesInserted }
}

/**
 * Import GRN matched Excel. Resolve po_id from po_no/PO_NO/po_number. Map columns to grn table.
 */
export async function importGrnExcel (buffer, client) {
  const rows = parseExcelToRows(buffer)
  if (rows.length === 0) return { grnInserted: 0 }

  let grnInserted = 0
  for (const row of rows) {
    const poNo = toStr(get(row, 'PO_NO', 'PO_NUMBER', 'po_number', 'O_NUMBE', 'PO No'))
    if (!poNo) continue

    const poRow = await client.query(
      `SELECT po_id FROM purchase_orders WHERE TRIM(po_number) = TRIM($1) LIMIT 1`,
      [poNo]
    )
    const poId = poRow.rows[0]?.po_id ?? null
    if (!poId) continue

    const grnNo = toStr(get(row, 'GRN_NO', 'grn_no', 'GRN No'), 50)
    const grnDate = parseDate(get(row, 'GRN_DATE', 'grn_date', 'GRN Date'))
    const dcNo = toStr(get(row, 'DC_NO', 'dc_no', 'DC No'), 50)
    const dcDate = parseDate(get(row, 'DC_DATE', 'dc_date', 'DC Date'))
    const grnLine = toNum(get(row, 'GRN_LINE', 'grn_line'))
    const unit = toStr(get(row, 'UNIT', 'unit'), 50)
    const item = toStr(get(row, 'ITEM', 'item_id', 'ITEM_ID'), 50)
    const description1 = toStr(get(row, 'DESCRIPTION_1', 'description_1', 'ESCRIPTION', 'Description'))
    const uom = toStr(get(row, 'UOM', 'uom'), 50)
    const grnQty = toDecimal(get(row, 'GRN_QTY', 'grn_qty', 'Qty'))
    const acceptedQty = toDecimal(get(row, 'ACCEPTED_QTY', 'accepted_qty', 'Accepted Qty'))
    const unitCost = toDecimal(get(row, 'UNIT_COST', 'unit_cost'))
    const gateEntryNo = toStr(get(row, 'GATE_ENTRY_NO', 'gate_entry_no'), 50)
    const supplierDocNo = toStr(get(row, 'SUPPLIER_DOC_NO', 'supplier_doc_no'), 50)
    const supplierDocDate = parseDate(get(row, 'SUPPLIER_DOC_DATE', 'supplier_doc_date'))
    const supplier = toStr(get(row, 'SUPPLIER', 'supplier'), 50)
    const supplierName = toStr(get(row, 'SUPPLIER_NAME', 'supplier_name', 'PPLIER_NA'), 255)
    const poPfx = toStr(get(row, 'PO_PFX', 'po_pfx', 'PFX'), 50)
    const poLine = toNum(get(row, 'PO_LINE', 'po_line'))

    await client.query(
      `INSERT INTO grn (
        po_id, grn_no, grn_date, grn_line, dc_no, dc_date, unit, item, description_1, uom,
        grn_qty, accepted_qty, unit_cost, gate_entry_no, supplier_doc_no, supplier_doc_date, supplier, supplier_name, po_no, po_pfx, po_line
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        poId, grnNo, grnDate ? formatDateForPg(grnDate) : null, grnLine, dcNo, dcDate ? formatDateForPg(dcDate) : null,
        unit, item, description1, uom, grnQty, acceptedQty, unitCost,
        gateEntryNo, supplierDocNo, supplierDocDate ? formatDateForPg(supplierDocDate) : null,
        supplier, supplierName, poNo, poPfx, poLine
      ]
    )
    grnInserted++
  }
  return { grnInserted }
}

/**
 * Import Pending ASN Excel. Resolve po_id from po_number/PO_NO. Map columns to asn table.
 */
export async function importAsnExcel (buffer, client) {
  const rows = parseExcelToRows(buffer)
  if (rows.length === 0) return { asnInserted: 0 }

  let asnInserted = 0
  for (const row of rows) {
    const poNo = toStr(get(row, 'PO_NO', 'PO_NUMBER', 'po_number', 'O_NUMBE', 'PO No'))
    if (!poNo) continue

    const poRow = await client.query(
      `SELECT po_id FROM purchase_orders WHERE TRIM(po_number) = TRIM($1) LIMIT 1`,
      [poNo]
    )
    const poId = poRow.rows[0]?.po_id ?? null
    if (!poId) continue

    const asnNo = toStr(get(row, 'ASN_NO', 'asn_no', 'ASN No'), 50)
    const dcNo = toStr(get(row, 'DC_NO', 'dc_no', 'DC No'), 50)
    const dcDate = parseDate(get(row, 'DC_DATE', 'dc_date', 'DC Date'))
    const invNo = toStr(get(row, 'INV_NO', 'inv_no', 'Inv No'), 50)
    const invDate = parseDate(get(row, 'INV_DATE', 'inv_date', 'Inv Date'))
    const lrNo = toStr(get(row, 'LR_NO', 'lr_no', 'LR No'), 50)
    const lrDate = parseDate(get(row, 'LR_DATE', 'lr_date', 'LR Date'))
    const unit = toStr(get(row, 'UNIT', 'unit'), 50)
    const transporter = toStr(get(row, 'TRANSPORTER', 'transporter'), 50)
    const transporterName = toStr(get(row, 'TRANSPORTER_NAME', 'transporter_name', 'Transporter Name'), 255)
    const supplier = toStr(get(row, 'SUPPLIER', 'supplier'), 50)
    const supplierName = toStr(get(row, 'SUPPLIER_NAME', 'supplier_name', 'PPLIER_NA'), 255)
    const status = toStr(get(row, 'STATUS', 'status'), 50)

    await client.query(
      `INSERT INTO asn (
        po_id, asn_no, dc_no, dc_date, inv_no, inv_date, lr_no, lr_date, unit, transporter, transporter_name, supplier, supplier_name, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        poId, asnNo, dcNo, dcDate ? formatDateForPg(dcDate) : null, invNo, invDate ? formatDateForPg(invDate) : null,
        lrNo, lrDate ? formatDateForPg(lrDate) : null, unit, transporter, transporterName, supplier, supplierName, status
      ]
    )
    asnInserted++
  }
  return { asnInserted }
}
