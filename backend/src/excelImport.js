/**
 * Parse Excel (PO matched, GRN matched, Pending ASN) and insert into DB.
 * Uses first sheet; first row = headers. Column names matched case-insensitively and with common aliases.
 */
import ExcelJS from 'exceljs'
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
 * Skips rows that are completely empty (all values blank).
 */
async function parseExcelToRows (buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []

  const headerRow = sheet.getRow(1)
  const values1 = headerRow.values || []
  const headers = []
  for (let i = 1; i < values1.length; i++) {
    const h = values1[i]
    const label = (h != null && String(h).trim() !== '') ? String(h).trim() : `Column${i}`
    headers.push(label)
  }
  if (headers.length === 0) return []

  const rows = []
  const maxRow = sheet.rowCount || 10000
  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r)
    const vals = row.values || []
    const obj = {}
    let hasAny = false
    for (let c = 0; c < headers.length; c++) {
      const v = vals[c + 1]
      const out = (v != null && v !== '') ? v : ''
      if (v != null && String(v).trim() !== '') hasAny = true
      obj[headers[c]] = out
    }
    if (hasAny) rows.push(obj)
  }
  return rows
}

/**
 * Import PO matched Excel: group rows by (po_number, amd_no), insert purchase_orders then purchase_order_lines.
 * Expects columns like: UNIT, REF_UNIT, PFX, O_NUMBE/PO_NUMBER/PO Number, DATE, AMD_NO, SUPLR_ID, PPLIER_NA/SUPPLIER_NAME, TERMS,
 * ITEM_ID, ESCRIPTION/DESCRIPTION/DESCRIPTION1, QTY, UNIT_COST, DISC%/DISC_PCT, etc.
 */
export async function importPoExcel (buffer, client) {
  const rows = await parseExcelToRows(buffer)
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

/** GRN Excel: all supported header names for PO number (case-insensitive, spaces → underscores) */
const GRN_PO_HEADERS = [
  'PO_NO', 'PO_NUMBER', 'po_number', 'O_NUMBE', 'PO No', 'PO No.', 'PO Number', 'PO #',
  'Order No', 'Order Number', 'PO', 'P.O. No', 'P.O. Number', 'Purchase Order', 'PO Reference'
]

/** GRN Excel: header names for other key columns */
const GRN_HEADERS = {
  grnNo: ['GRN_NO', 'grn_no', 'GRN No', 'GRN No.', 'GRN Number', 'GRN'],
  grnDate: ['GRN_DATE', 'grn_date', 'GRN Date', 'GRN Date.', 'Date'],
  dcNo: ['DC_NO', 'dc_no', 'DC No', 'DC No.', 'DC Number', 'Challan No', 'Delivery Challan'],
  dcDate: ['DC_DATE', 'dc_date', 'DC Date', 'DC Date.', 'Challan Date'],
  grnQty: ['GRN_QTY', 'grn_qty', 'Qty', 'Quantity', 'GRN Qty', 'Received Qty', 'Receipt Qty']
}

/**
 * Import GRN matched Excel. Resolve po_id from po_no/PO_NO/po_number. Map columns to grn table.
 * Returns grnInserted and, when 0, diagnostic info (rowsTotal, rowsWithPoNo, rowsWithMatchingPo) for a clearer message.
 */
export async function importGrnExcel (buffer, client) {
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { grnInserted: 0, rowsTotal: 0, rowsWithPoNo: 0, rowsWithMatchingPo: 0, hint: 'Excel has no data rows (or first sheet is empty). Ensure the first row contains column headers and following rows contain GRN data.' }
  }

  let grnInserted = 0
  let rowsWithPoNo = 0
  let rowsWithMatchingPo = 0

  for (const row of rows) {
    const poNo = toStr(get(row, ...GRN_PO_HEADERS))
    if (!poNo) continue
    rowsWithPoNo++

    const poRow = await client.query(
      `SELECT po_id FROM purchase_orders WHERE TRIM(po_number) = TRIM($1) LIMIT 1`,
      [poNo]
    )
    const poId = poRow.rows[0]?.po_id ?? null
    if (!poId) continue
    rowsWithMatchingPo++

    const grnNo = toStr(get(row, ...GRN_HEADERS.grnNo), 50)
    const grnDate = parseDate(get(row, ...GRN_HEADERS.grnDate))
    const dcNo = toStr(get(row, ...GRN_HEADERS.dcNo), 50)
    const dcDate = parseDate(get(row, 'DC_DATE', 'dc_date', 'DC Date', 'DC Date.', 'Challan Date'))
    const grnLine = toNum(get(row, 'GRN_LINE', 'grn_line', 'GRN Line', 'Line'))
    const unit = toStr(get(row, 'UNIT', 'unit'), 50)
    const item = toStr(get(row, 'ITEM', 'item_id', 'ITEM_ID', 'Item', 'Item Code'), 50)
    const description1 = toStr(get(row, 'DESCRIPTION_1', 'description_1', 'ESCRIPTION', 'Description', 'Item Description'), 255)
    const uom = toStr(get(row, 'UOM', 'uom'), 50)
    const grnQty = toDecimal(get(row, ...GRN_HEADERS.grnQty))
    const acceptedQty = toDecimal(get(row, 'ACCEPTED_QTY', 'accepted_qty', 'Accepted Qty', 'Accepted'))
    const unitCost = toDecimal(get(row, 'UNIT_COST', 'unit_cost', 'Unit Cost', 'Rate'))
    const gateEntryNo = toStr(get(row, 'GATE_ENTRY_NO', 'gate_entry_no', 'Gate Entry No'), 50)
    const supplierDocNo = toStr(get(row, 'SUPPLIER_DOC_NO', 'supplier_doc_no'), 50)
    const supplierDocDate = parseDate(get(row, 'SUPPLIER_DOC_DATE', 'supplier_doc_date'))
    const supplier = toStr(get(row, 'SUPPLIER', 'supplier'), 50)
    const supplierName = toStr(get(row, 'SUPPLIER_NAME', 'supplier_name', 'PPLIER_NA', 'Supplier Name'), 255)
    const poPfx = toStr(get(row, 'PO_PFX', 'po_pfx', 'PFX'), 50)
    const poLine = toNum(get(row, 'PO_LINE', 'po_line', 'PO Line'))

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

  let hint = null
  if (grnInserted === 0 && rows.length > 0) {
    if (rowsWithPoNo === 0) {
      hint = 'No PO number column found. Use a header like "PO No", "PO Number", "PO_NO", or "PO Number" in the first row. If your file has a title row (e.g. "GRN Details"), make the row with column names the first row of the sheet, or delete the title row. Column names are matched case-insensitively.'
    } else if (rowsWithMatchingPo === 0) {
      hint = 'PO numbers in the file do not match any Purchase Order in the system. Upload or create POs first (Purchase Order Upload), then upload GRN.'
    } else {
      hint = 'No rows were inserted. Check that PO numbers match exactly (no extra spaces) and that required data is present.'
    }
  }

  return {
    grnInserted,
    rowsTotal: rows.length,
    rowsWithPoNo,
    rowsWithMatchingPo,
    ...(hint && { hint })
  }
}

/**
 * Import ASN Excel. Expected columns (exact names, case-insensitive):
 * ASN No., Supplier, Supplier Name, DC No., DC Date, Inv. No., Inv. Date, LR No., LR Date,
 * Unit, Transporter, Transporter Name, Doc. No./Date, Status
 * PO number is not stored; it is derived at display time via asn.inv_no -> invoices -> purchase_orders.
 */
export async function importAsnExcel (buffer, client) {
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { asnInserted: 0, rowsTotal: 0, hint: 'Excel has no data rows (or first sheet is empty). Ensure the first row contains column headers: ASN No., Supplier, Supplier Name, DC No., DC Date, Inv. No., Inv. Date, LR No., LR Date, Unit, Transporter, Transporter Name, Doc. No./Date, Status.' }
  }

  let asnInserted = 0
  let rowsSkippedNoData = 0

  for (const row of rows) {
    const asnNo = toStr(get(row, 'ASN No.', 'ASN No', 'ASN_NO', 'asn_no', 'ASN Number', 'ASN'), 50)
    const supplier = toStr(get(row, 'Supplier', 'SUPPLIER', 'supplier'), 50)
    const supplierName = toStr(get(row, 'Supplier Name', 'Supplier Name.', 'SUPPLIER_NAME', 'supplier_name', 'PPLIER_NA'), 255)
    const dcNo = toStr(get(row, 'DC No.', 'DC No', 'DC_NO', 'dc_no', 'DC Number', 'Challan No'), 50)
    const dcDate = parseDate(get(row, 'DC Date', 'DC Date.', 'DC_DATE', 'dc_date', 'Challan Date'))
    const invNo = toStr(get(row, 'Inv. No.', 'Inv. No', 'Inv No', 'INV_NO', 'inv_no', 'Invoice No', 'Invoice Number'), 50)
    const invDate = parseDate(get(row, 'Inv. Date', 'Inv. Date.', 'Inv Date', 'INV_DATE', 'inv_date', 'Invoice Date'))
    const lrNo = toStr(get(row, 'LR No.', 'LR No', 'LR_NO', 'lr_no', 'LR Number', 'L.R. No'), 50)
    const lrDate = parseDate(get(row, 'LR Date', 'LR Date.', 'LR_DATE', 'lr_date'))
    const unit = toStr(get(row, 'Unit', 'UNIT', 'unit'), 50)
    const transporter = toStr(get(row, 'Transporter', 'TRANSPORTER', 'transporter'), 50)
    const transporterName = toStr(get(row, 'Transporter Name', 'Transporter Name.', 'TRANSPORTER_NAME', 'transporter_name'), 255)
    const docNoDate = toStr(get(row, 'Doc. No./Date', 'Doc. No. / Date', 'DOC_NO_DATE', 'doc_no_date'), 100)
    const status = toStr(get(row, 'Status', 'STATUS', 'status'), 50)

    const hasAnyData = asnNo || dcNo || invNo || lrNo || supplier || supplierName || transporter || transporterName
    if (!hasAnyData) {
      rowsSkippedNoData++
      continue
    }

    await client.query(
      `INSERT INTO asn (
        asn_no, supplier, supplier_name, dc_no, dc_date, inv_no, inv_date, lr_no, lr_date,
        unit, transporter, transporter_name, doc_no_date, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        asnNo, supplier, supplierName, dcNo, dcDate ? formatDateForPg(dcDate) : null, invNo, invDate ? formatDateForPg(invDate) : null,
        lrNo, lrDate ? formatDateForPg(lrDate) : null, unit, transporter, transporterName, docNoDate, status
      ]
    )
    asnInserted++
  }

  let hint = null
  if (asnInserted === 0 && rows.length > 0) {
    if (rowsSkippedNoData === rows.length) {
      hint = 'No recognizable ASN columns found. Expected first row headers: ASN No., Supplier, Supplier Name, DC No., DC Date, Inv. No., Inv. Date, LR No., LR Date, Unit, Transporter, Transporter Name, Doc. No./Date, Status. If your file has a title row, make the row with these column names the first row of the sheet. Matching is case-insensitive.'
    } else {
      hint = 'No rows were inserted. Ensure at least one of: ASN No., DC No., Inv. No., LR No., Transporter, or Supplier is present in each row.'
    }
  }

  return {
    asnInserted,
    rowsTotal: rows.length,
    ...(hint && { hint })
  }
}
