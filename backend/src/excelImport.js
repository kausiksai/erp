/**
 * Parse Excel (.xlsx / .xls) and import PO, GRN, ASN, DC, Schedules, Open PO prefixes.
 * Uses SheetJS (xlsx); first sheet; first row = headers. Column names matched case-insensitively.
 * GRN, ASN, delivery_challans, po_schedules, open_po_prefixes: full replace (TRUNCATE) on each upload.
 * PO: upsert from file + delete POs that have no invoice/GRN/DC/schedule and are not in the file.
 */
import * as XLSX from 'xlsx'
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

/** Excel epoch (Jan 1 1900) to JS */
function excelSerialToDate (serial) {
  const utcDays = Math.floor(Number(serial) - 25569)
  const d = new Date(utcDays * 86400 * 1000)
  if (isNaN(d.getTime())) return null
  return d
}

/** Parse date from Excel serial, Date, "DD-MMM-YY", "YYYY-MM-DD", etc. */
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
 * Parse workbook buffer → array of row objects (first row = headers).
 * Skips completely empty rows.
 */
export async function parseExcelToRows (buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sn = wb.SheetNames[0]
  if (!sn) return []
  const sheet = wb.Sheets[sn]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  return rows
    .map((row) => {
      const obj = {}
      for (const [k, v] of Object.entries(row)) {
        if (k == null || String(k).trim() === '') continue
        const key = String(k).trim()
        let out = v
        if (v instanceof Date) out = v
        else if (out === null || out === undefined) out = ''
        obj[key] = out
      }
      return obj
    })
    .filter((r) => Object.values(r).some((v) => v !== '' && v != null))
}

/**
 * Import PO Excel: group by (po_number, amd_no). Overwrite mode:
 * - Removes POs that have no invoice, no GRN, no DC, no schedule row and are not listed in this file.
 * - Upserts each PO and replaces its lines.
 */
export async function importPoExcel (buffer, client) {
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) return { purchaseOrdersInserted: 0, linesInserted: 0, mode: 'overwrite' }

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

  const uniquePoNumbers = [...new Set(
    [...groups.values()].map((g) => toStr(get(g[0], 'O_NUMBE', 'PO_NUMBER', 'PO Number', 'po_number', 'PO_NO'))).filter(Boolean)
  )]

  if (uniquePoNumbers.length > 0) {
    await client.query(
      `DELETE FROM purchase_orders po
       WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.po_id)
         AND NOT EXISTS (SELECT 1 FROM grn g WHERE g.po_id = po.po_id)
         AND NOT EXISTS (
           SELECT 1 FROM delivery_challans dc
           WHERE dc.po_id = po.po_id
              OR (TRIM(COALESCE(dc.ord_no, '')) <> ''
                  AND LOWER(TRIM(dc.ord_no)) = LOWER(TRIM(po.po_number)))
              OR (TRIM(COALESCE(dc.open_order_no, '')) <> ''
                  AND LOWER(TRIM(dc.open_order_no)) = LOWER(TRIM(po.po_number)))
         )
         AND NOT EXISTS (
           SELECT 1 FROM po_schedules ps
           WHERE ps.po_id = po.po_id
              OR (COALESCE(TRIM(ps.po_number), '') <> ''
                  AND LOWER(TRIM(ps.po_number)) = LOWER(TRIM(po.po_number)))
              OR (COALESCE(TRIM(ps.doc_no), '') <> ''
                  AND LOWER(TRIM(ps.doc_no)) = LOWER(TRIM(po.po_number)))
         )
         AND po.po_number <> ALL($1::text[])`,
      [uniquePoNumbers]
    )
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

  return { purchaseOrdersInserted, linesInserted, mode: 'overwrite' }
}

const GRN_PO_HEADERS = [
  'PO_NO', 'PO_NUMBER', 'po_number', 'O_NUMBE', 'PO No', 'PO No.', 'PO Number', 'PO #',
  'Order No', 'Order Number', 'PO', 'P.O. No', 'P.O. Number', 'Purchase Order', 'PO Reference'
]

const GRN_HEADERS = {
  grnNo: ['GRN_NO', 'grn_no', 'GRN No', 'GRN No.', 'GRN Number', 'GRN'],
  grnDate: ['GRN_DATE', 'grn_date', 'GRN Date', 'GRN Date.', 'Date'],
  dcNo: ['DC_NO', 'dc_no', 'DC No', 'DC No.', 'DC Number', 'Challan No', 'Delivery Challan'],
  dcDate: ['DC_DATE', 'dc_date', 'DC Date', 'DC Date.', 'Challan Date'],
  grnQty: [
    'GRN_QTY', 'grn_qty', 'Qty', 'Quantity', 'GRN Qty', 'GRN Qty.', 'Received Qty', 'Receipt Qty',
    'Receipt Qty. (Toler.)'
  ]
}

/**
 * Import GRN Excel — full replace: TRUNCATE grn, then insert.
 */
export async function importGrnExcel (buffer, client) {
  await client.query('TRUNCATE grn RESTART IDENTITY CASCADE')
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { grnInserted: 0, rowsTotal: 0, rowsWithPoNo: 0, rowsWithMatchingPo: 0, hint: 'Excel has no data rows (or first sheet is empty). Ensure the first row contains column headers and following rows contain GRN data.', mode: 'overwrite' }
  }

  let grnInserted = 0
  let rowsWithPoNo = 0
  let rowsWithMatchingPo = 0

  for (const row of rows) {
    const poNo = toStr(get(row, ...GRN_PO_HEADERS))
    if (!poNo) continue
    rowsWithPoNo++

    const poRow = await client.query(
      `SELECT po_id FROM purchase_orders
       WHERE TRIM(po_number) = TRIM($1)
       ORDER BY COALESCE(amd_no, 0) DESC, po_id DESC
       LIMIT 1`,
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
      hint = 'No PO number column found. Use a header like "PO No", "PO Number", "PO_NO", or "PO Number" in the first row.'
    } else if (rowsWithMatchingPo === 0) {
      hint = 'PO numbers in the file do not match any Purchase Order in the system. Upload PO master first, then upload GRN.'
    } else {
      hint = 'No rows were inserted. Check that PO numbers match exactly (no extra spaces) and that required data is present.'
    }
  }

  return {
    grnInserted,
    rowsTotal: rows.length,
    rowsWithPoNo,
    rowsWithMatchingPo,
    mode: 'overwrite',
    ...(hint && { hint })
  }
}

/**
 * Import ASN Excel — full replace: TRUNCATE asn, then insert.
 */
export async function importAsnExcel (buffer, client) {
  await client.query('TRUNCATE asn RESTART IDENTITY CASCADE')
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { asnInserted: 0, rowsTotal: 0, hint: 'Excel has no data rows (or first sheet is empty).', mode: 'overwrite' }
  }

  let asnInserted = 0
  let rowsSkippedNoData = 0

  for (const row of rows) {
    const asnNo = toStr(
      get(row, 'ASN No.', 'ASN No', 'ASN_NO', 'asn_no', 'ASN Number', 'ASN', 'ANC No.', 'ANC No', 'ANC_NO'),
      50
    )
    const supplier = toStr(get(row, 'Supplier', 'SUPPLIER', 'supplier', 'Supplier Code', 'SUPPLIER CODE'), 50)
    const supplierName = toStr(
      get(row, 'Supplier Name', 'Supplier Name.', 'SUPPLIER_NAME', 'supplier_name', 'PPLIER_NA'),
      255
    )
    const dcNo = toStr(get(row, 'DC No.', 'DC No', 'DC_NO', 'dc_no', 'DC Number', 'Challan No'), 50)
    const dcDate = parseDate(get(row, 'DC Date', 'DC Date.', 'DC_DATE', 'dc_date', 'Challan Date'))
    const invNo = toStr(
      get(
        row,
        'Inv. No.',
        'Inv. No',
        'Inv No',
        'INV_NO',
        'inv_no',
        'Invoice No',
        'Invoice No.',
        'Invoice Number'
      ),
      50
    )
    const invDate = parseDate(
      get(row, 'Inv. Date', 'Inv. Date.', 'Inv Date', 'INV_DATE', 'inv_date', 'Invoice Date', 'Invoice Date.')
    )
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
      hint = 'No recognizable ASN columns found. Expected headers: ASN No. / ANC No., Supplier / Supplier Code, DC No., Inv. No. / Invoice No., etc.'
    } else {
      hint = 'No rows were inserted. Ensure at least one key column is present per row.'
    }
  }

  return {
    asnInserted,
    rowsTotal: rows.length,
    mode: 'overwrite',
    ...(hint && { hint })
  }
}

/** PO resolution: ORDER NO. (DC Excel) and legacy aliases */
const DC_ORDER_NO_HEADERS = [
  'ORDER NO.', 'ORDER NO', 'Order No', 'ORD_NO', 'ord_no', 'PO_NO', 'PO_NUMBER', 'po_number', 'O_NUMBE', 'PO No', 'PO Number', 'Order No', 'PO'
]

/**
 * Import Delivery Challan (DC) transaction Excel — matches client layout (UNIT, DC NO., ORDER NO., TRANSACTION QTY., …).
 * Full replace: TRUNCATE delivery_challans, then insert.
 */
export async function importDcExcel (buffer, client) {
  await client.query('TRUNCATE delivery_challans RESTART IDENTITY CASCADE')
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { dcInserted: 0, rowsTotal: 0, hint: 'No data rows in Excel.', mode: 'overwrite' }
  }

  let dcInserted = 0
  let rowsWithPo = 0

  for (const row of rows) {
    const ordNo = toStr(get(row, ...DC_ORDER_NO_HEADERS), 50)
    let poId = null
    let supplierId = null
    if (ordNo) {
      rowsWithPo++
      const poRow = await client.query(
        `SELECT po_id, supplier_id FROM purchase_orders
         WHERE TRIM(po_number) = TRIM($1)
         ORDER BY COALESCE(amd_no, 0) DESC, po_id DESC
         LIMIT 1`,
        [ordNo]
      )
      poId = poRow.rows[0]?.po_id ?? null
      supplierId = poRow.rows[0]?.supplier_id ?? null
    }

    const unit = toStr(get(row, 'UNIT', 'Unit', 'unit'), 50)
    const unitDescription = toStr(get(row, 'UNIT DESCRIPTION', 'Unit Description', 'UNIT DESCRIPTION.', 'unit_description'), 255)
    const item = toStr(get(row, 'ITEM', 'Item', 'item', 'ITEM_ID'), 50)
    const revision = toStr(get(row, 'REV.', 'REV', 'Rev.', 'Rev', 'rev'), 50)
    const revParsed = toNum(revision)
    const revSmallint =
      revParsed != null && Number.isFinite(revParsed) && Math.abs(revParsed) <= 32767 ? Math.round(revParsed) : null
    const description = toStr(get(row, 'ITEM DESCRIPTION', 'Item Description', 'ITEM DESCRIPTION.', 'Item Desc.', 'DESCRIPTION'), 4000)
    const uom = toStr(get(row, 'UOM', 'Uom', 'uom'), 50)
    const supplier = toStr(get(row, 'SUPPLIER', 'Supplier', 'supplier', 'Suplr'), 50)
    const name = toStr(get(row, 'SUPPLIER NAME', 'Supplier Name', 'SUPPLIER NAME.', 'NAME', 'name'), 255)
    const dcNo = toStr(get(row, 'DC NO.', 'DC NO', 'Dc No.', 'DC_NO', 'dc_no', 'Challan No'), 50)
    const dcLine = toNum(get(row, 'DC LINE', 'DC LINE.', 'Dc Line', 'dc_line'))
    const dcPfx = toStr(get(row, 'DC PFX.', 'DC PFX', 'Dc Pfx', 'dc_pfx'), 50)
    const ordType = toStr(get(row, 'ORDER TYPE', 'Order Type', 'ORDER TYPE.', 'ord_type'), 50)
    const source = toStr(get(row, 'SOURCE', 'Source', 'source'), 100)
    const sfCode = toStr(get(row, 'SF CODE', 'Sf Code', 'SF_CODE', 'sf_code'), 50)
    const dcQty = toDecimal(get(row, 'TRANSACTION QTY.', 'TRANSACTION QTY', 'Transaction Qty', 'TRANSACTION_QTY', 'DC_QTY', 'Qty'))
    const dcDate = parseDate(get(row, 'TRANSACTION DATE', 'Transaction Date', 'TRANSACTION DATE.', 'DC_DATE', 'DC Date'))
    const grnPfx = toStr(get(row, 'GRN PFX.', 'GRN PFX', 'Grn Pfx', 'grn_pfx'), 50)
    const grnNo = toStr(get(row, 'GRN NO.', 'GRN NO', 'Grn No', 'GRN_NO', 'grn_no'), 50)
    const openOrderPfx = toStr(get(row, 'Open order pfx.', 'Open order pfx', 'OPEN ORDER PFX', 'open_order_pfx'), 50)
    const openOrderNo = toStr(get(row, 'Open order no.', 'Open order no', 'OPEN ORDER NO', 'open_order_no'), 50)
    const materialType = toStr(get(row, 'Material type', 'MATERIAL TYPE', 'Material Type', 'material_type'), 100)
    const lineNo = toNum(get(row, 'LINE NO.', 'LINE NO', 'Line No', 'line_no'))
    const tempQty = toDecimal(get(row, 'TEMP. QTY.', 'TEMP. QTY', 'Temp Qty', 'temp_qty'))
    const receivedQty = toDecimal(get(row, 'RECEIVED QTY.', 'RECEIVED QTY', 'Received Qty', 'received_qty'))
    const suplrDcNo = toStr(get(row, 'SUPLR. DC NO.', 'SUPLR. DC NO', 'Suplr Dc No', 'suplr_dc_no'), 100)
    const suplrDcDate = parseDate(get(row, 'SUPLR. DC DATE', 'Suplr Dc Date', 'suplr_dc_date'))
    const receivedItem = toStr(get(row, 'RECEIVED ITEM', 'Received Item', 'received_item'), 100)
    const receivedItemRev = toStr(get(row, 'RECEIVED ITEM REV.', 'RECEIVED ITEM REV', 'Received Item Rev', 'received_item_rev'), 50)
    const receivedItemUom = toStr(get(row, 'RECEIVED ITEM UOM', 'Received Item Uom', 'received_item_uom'), 50)

    const ordNoCol = ordNo || toStr(get(row, 'ORDER NO.', 'ORDER NO', 'Order No'), 50)
    const ordPfx = toStr(get(row, 'ORD_PFX', 'ord_pfx'), 50)
    const docNo = toNum(get(row, 'DOC_NO', 'doc_no', 'Doc No'))

    const hasRow = dcNo || item || dcQty != null || description || ordNoCol || grnNo
    if (!hasRow) continue

    await client.query(
      `INSERT INTO delivery_challans (
        po_id, supplier_id, doc_no, dc_no, dc_date, supplier, name, item, rev, revision, uom, description, sf_code,
        dc_qty, consumed, in_process, balance, out_days, other_type, ord_type, ord_pfx, ord_no, mi_doc_no,
        ext_description, unit, unit_description, ref_unit, ref_unit_description,
        dc_line, dc_pfx, source, grn_pfx, grn_no, open_order_pfx, open_order_no, material_type, line_no,
        temp_qty, received_qty, suplr_dc_no, suplr_dc_date, received_item, received_item_rev, received_item_uom
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44
      )`,
      [
        poId, supplierId, docNo, dcNo, dcDate ? formatDateForPg(dcDate) : null, supplier, name, item, revSmallint, revision, uom, description, sfCode,
        dcQty, null, null, null, null, null, ordType, ordPfx, ordNoCol, null,
        null, unit, unitDescription, null, null,
        dcLine, dcPfx, source, grnPfx, grnNo, openOrderPfx, openOrderNo, materialType, lineNo,
        tempQty, receivedQty, suplrDcNo, suplrDcDate ? formatDateForPg(suplrDcDate) : null, receivedItem, receivedItemRev, receivedItemUom
      ]
    )
    dcInserted++
  }

  const hint = dcInserted === 0 && rows.length > 0
    ? (rowsWithPo === 0
      ? 'No ORDER NO. / PO column or no matching PO. Upload PO master first. Expected headers like UNIT, DC NO., ORDER NO., TRANSACTION QTY.'
      : 'No rows inserted. Check DC NO., ITEM, TRANSACTION QTY., or ORDER NO.')
    : null

  return { dcInserted, rowsTotal: rows.length, mode: 'overwrite', ...(hint && { hint }) }
}

/**
 * Import Schedule Excel — client layout: Line, Unit, Supplier, Item, From/To, Doc Pfx., Doc. No., Status, …
 * PO is resolved from Doc. No. (= purchase_orders.po_number) when present.
 * Full replace: TRUNCATE po_schedules, then insert.
 */
export async function importScheduleExcel (buffer, client) {
  await client.query('TRUNCATE po_schedules RESTART IDENTITY CASCADE')
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { schedulesInserted: 0, rowsTotal: 0, hint: 'No data rows in Excel.', mode: 'overwrite' }
  }

  let schedulesInserted = 0

  for (const row of rows) {
    const docNo = toStr(get(row, 'Doc. No.', 'Doc No.', 'DOC NO.', 'Doc No', 'DOC_NO', 'doc_no', 'Document No'), 100)
    // po_number / ord_no are VARCHAR(50) — match purchase_orders.po_number
    const poNoFull = docNo || toStr(get(row, ...DC_ORDER_NO_HEADERS), 50)
    const poNo = poNoFull ? poNoFull.slice(0, 50) : null
    let poId = null
    if (poNo) {
      const poRow = await client.query(
        `SELECT po_id FROM purchase_orders
         WHERE TRIM(po_number) = TRIM($1)
         ORDER BY COALESCE(amd_no, 0) DESC, po_id DESC
         LIMIT 1`,
        [poNo]
      )
      poId = poRow.rows[0]?.po_id ?? null
    }

    const lineNo = toNum(get(row, 'Line', 'LINE', 'line', 'LINE NO.', 'Line No'))
    const unit = toStr(get(row, 'Unit', 'UNIT', 'unit'), 50)
    const supplier = toStr(get(row, 'Supplier', 'SUPPLIER', 'supplier'), 50)
    const supplierName = toStr(get(row, 'Supplier Name', 'SUPPLIER NAME', 'supplier_name'), 255)
    const itemId = toStr(get(row, 'Item', 'ITEM', 'item', 'ITEM_ID'), 100)
    const itemRev = toStr(get(row, 'Rev.', 'REV.', 'Rev', 'REV', 'rev'), 50)
    const description = toStr(get(row, 'Item Desc.', 'Item Desc', 'ITEM DESC.', 'Item Description', 'DESCRIPTION'), 4000)
    const uom = toStr(get(row, 'UOM', 'Uom', 'uom'), 50)
    const dateFrom = parseDate(get(row, 'From', 'FROM', 'from'))
    const dateTo = parseDate(get(row, 'To', 'TO', 'to'))
    const firm = toStr(get(row, 'Firm', 'FIRM', 'firm'), 255)
    const tentative = toStr(get(row, 'Tentative', 'TENTATIVE', 'tentative'), 255)
    const closeshort = toStr(get(row, 'Closeshort', 'CLOSESHORT', 'closeshort', 'Close short'), 100)
    const docPfx = toStr(get(row, 'Doc Pfx.', 'Doc Pfx', 'DOC PFX', 'doc_pfx'), 50)
    const status = toStr(get(row, 'Status', 'STATUS', 'status'), 50)

    const ordPfx = toStr(get(row, 'ORD_PFX', 'ord_pfx'), 50)
    const ordNoRaw = toStr(get(row, 'ORD_NO', 'ORDER NO.', 'Order No'), 50) || (docNo ? docNo.slice(0, 50) : null)
    const ordNo = ordNoRaw
    const scheduleRef = toStr(get(row, 'SCHEDULE', 'schedule', 'schedule_ref'), 100)
    const ssPfx = toStr(get(row, 'SS_PFX', 'ss_pfx'), 50)
    const ssNo = toStr(get(row, 'SS_NO', 'ss_no'), 50)
    const schedQty = toDecimal(get(row, 'QTY', 'qty', 'SCHED_QTY', 'sched_qty', 'Quantity'))
    const schedDate = parseDate(get(row, 'SCHED_DATE', 'sched_date'))
    const promiseDate = parseDate(get(row, 'PROMISE_DATE', 'promise_date'))
    const requiredDate = parseDate(get(row, 'REQUIRED_DATE', 'required_date'))

    if (!docNo && !itemId && lineNo == null && !supplier && !unit) continue

    await client.query(
      `INSERT INTO po_schedules (
        po_id, po_number, ord_pfx, ord_no, schedule_ref, ss_pfx, ss_no, line_no, item_id, description,
        sched_qty, sched_date, promise_date, required_date, unit, uom,
        supplier, supplier_name, item_rev, date_from, date_to, firm, tentative, closeshort, doc_pfx, doc_no, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
      [
        poId, poNo, ordPfx, ordNo, scheduleRef, ssPfx, ssNo, lineNo, itemId, description,
        schedQty, schedDate ? formatDateForPg(schedDate) : null,
        promiseDate ? formatDateForPg(promiseDate) : null,
        requiredDate ? formatDateForPg(requiredDate) : null,
        unit, uom,
        supplier, supplierName, itemRev,
        dateFrom ? formatDateForPg(dateFrom) : null,
        dateTo ? formatDateForPg(dateTo) : null,
        firm, tentative, closeshort, docPfx, docNo, status
      ]
    )
    schedulesInserted++
  }

  const hint = schedulesInserted === 0 && rows.length > 0
    ? 'No schedule rows inserted. Expected: Line, Unit, Supplier, Item, Doc. No. (PO), From/To, Doc Pfx., Status, …'
    : null

  return { schedulesInserted, rowsTotal: rows.length, mode: 'overwrite', ...(hint && { hint }) }
}

/**
 * Import Open PO prefixes — full replace. Columns: PREFIX, prefix, Open_PO_Prefix, PFX_Prefix
 */
export async function importOpenPoPrefixesExcel (buffer, client) {
  await client.query('TRUNCATE open_po_prefixes RESTART IDENTITY CASCADE')
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { prefixesInserted: 0, rowsTotal: 0, hint: 'No data rows.', mode: 'overwrite' }
  }

  let prefixesInserted = 0
  const seen = new Set()

  for (const row of rows) {
    const prefix = toStr(get(row, 'PREFIX', 'prefix', 'Open_PO_Prefix', 'PFX_Prefix', 'PFX', 'Pfx'), 50)
    const description = toStr(get(row, 'DESCRIPTION', 'description', 'Description', 'Note'))
    if (!prefix) continue
    const key = prefix.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    await client.query(
      `INSERT INTO open_po_prefixes (prefix, description) VALUES ($1, $2)`,
      [prefix, description]
    )
    prefixesInserted++
  }

  return { prefixesInserted, rowsTotal: rows.length, mode: 'overwrite' }
}

/**
 * Import Suppliers — upsert by supplier_name (case-insensitive match).
 * Unlike the other importers, suppliers are master data shared across POs
 * and invoices, so we NEVER truncate. New rows are inserted, existing rows
 * are updated column-by-column (NULL values in the sheet do not overwrite
 * existing non-null values — that way a partial row doesn't wipe banking).
 *
 * Recognised columns (case-insensitive, any of these per field):
 *   supplier_name / Supplier Name / name
 *   suplr_id / supplier_id / code
 *   gst_number / gstin / GST
 *   pan_number / pan / PAN
 *   supplier_address / address
 *   city / City
 *   state_code / state code
 *   state_name / state / State
 *   pincode / pin / Pincode
 *   email / Email
 *   phone / Phone
 *   mobile / Mobile
 *   msme_number / msme / MSME
 *   bank_account_name / account holder / account name
 *   bank_account_number / account number / account no
 *   bank_ifsc_code / ifsc / IFSC
 *   bank_name / bank
 *   branch_name / branch
 *   website / Website
 *   contact_person / contact / Contact
 */
export async function importSuppliersExcel (buffer, client) {
  const rows = await parseExcelToRows(buffer)
  if (rows.length === 0) {
    return { inserted: 0, updated: 0, skipped: 0, rowsTotal: 0, hint: 'No data rows.', mode: 'upsert' }
  }

  let inserted = 0
  let updated = 0
  let skipped = 0
  const seenNames = new Set()

  for (const row of rows) {
    const supplier_name = toStr(get(row, 'supplier_name', 'Supplier Name', 'supplier', 'name'))
    if (!supplier_name) {
      skipped++
      continue
    }
    const dedupKey = supplier_name.toLowerCase()
    if (seenNames.has(dedupKey)) {
      skipped++
      continue
    }
    seenNames.add(dedupKey)

    const suplr_id            = toStr(get(row, 'suplr_id', 'supplier_id', 'code'), 100)
    const gst_number          = toStr(get(row, 'gst_number', 'gstin', 'GST', 'gst'), 50)
    const pan_number          = toStr(get(row, 'pan_number', 'pan', 'PAN'), 50)
    const supplier_address    = toStr(get(row, 'supplier_address', 'address'), 500)
    const city                = toStr(get(row, 'city'), 100)
    const state_code          = toStr(get(row, 'state_code', 'state code'), 20)
    const state_name          = toStr(get(row, 'state_name', 'state', 'State'), 100)
    const pincode             = toStr(get(row, 'pincode', 'pin'), 20)
    const email               = toStr(get(row, 'email'), 200)
    const phone               = toStr(get(row, 'phone'), 50)
    const mobile              = toStr(get(row, 'mobile'), 50)
    const msme_number         = toStr(get(row, 'msme_number', 'msme', 'MSME'), 50)
    const bank_account_name   = toStr(get(row, 'bank_account_name', 'account holder', 'account name'), 200)
    const bank_account_number = toStr(get(row, 'bank_account_number', 'account number', 'account no'), 50)
    const bank_ifsc_code      = toStr(get(row, 'bank_ifsc_code', 'ifsc', 'IFSC', 'ifsc code'), 20)
    const bank_name           = toStr(get(row, 'bank_name', 'bank'), 200)
    const branch_name         = toStr(get(row, 'branch_name', 'branch'), 200)
    const website             = toStr(get(row, 'website'), 200)
    const contact_person      = toStr(get(row, 'contact_person', 'contact', 'Contact'), 200)

    // COALESCE on every field so NULL sheet values don't wipe existing data.
    const result = await client.query(
      `INSERT INTO suppliers (
         supplier_name, suplr_id, gst_number, pan_number, supplier_address,
         city, state_code, state_name, pincode, email, phone, mobile, msme_number,
         bank_account_name, bank_account_number, bank_ifsc_code, bank_name, branch_name,
         website, contact_person
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (supplier_name) DO UPDATE SET
         suplr_id            = COALESCE(EXCLUDED.suplr_id,            suppliers.suplr_id),
         gst_number          = COALESCE(EXCLUDED.gst_number,          suppliers.gst_number),
         pan_number          = COALESCE(EXCLUDED.pan_number,          suppliers.pan_number),
         supplier_address    = COALESCE(EXCLUDED.supplier_address,    suppliers.supplier_address),
         city                = COALESCE(EXCLUDED.city,                suppliers.city),
         state_code          = COALESCE(EXCLUDED.state_code,          suppliers.state_code),
         state_name          = COALESCE(EXCLUDED.state_name,          suppliers.state_name),
         pincode             = COALESCE(EXCLUDED.pincode,             suppliers.pincode),
         email               = COALESCE(EXCLUDED.email,               suppliers.email),
         phone               = COALESCE(EXCLUDED.phone,               suppliers.phone),
         mobile              = COALESCE(EXCLUDED.mobile,              suppliers.mobile),
         msme_number         = COALESCE(EXCLUDED.msme_number,         suppliers.msme_number),
         bank_account_name   = COALESCE(EXCLUDED.bank_account_name,   suppliers.bank_account_name),
         bank_account_number = COALESCE(EXCLUDED.bank_account_number, suppliers.bank_account_number),
         bank_ifsc_code      = COALESCE(EXCLUDED.bank_ifsc_code,      suppliers.bank_ifsc_code),
         bank_name           = COALESCE(EXCLUDED.bank_name,           suppliers.bank_name),
         branch_name         = COALESCE(EXCLUDED.branch_name,         suppliers.branch_name),
         website             = COALESCE(EXCLUDED.website,             suppliers.website),
         contact_person      = COALESCE(EXCLUDED.contact_person,      suppliers.contact_person),
         updated_at          = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        supplier_name, suplr_id, gst_number, pan_number, supplier_address,
        city, state_code, state_name, pincode, email, phone, mobile, msme_number,
        bank_account_name, bank_account_number, bank_ifsc_code, bank_name, branch_name,
        website, contact_person
      ]
    )
    if (result.rows[0]?.inserted) inserted++
    else updated++
  }

  return { inserted, updated, skipped, rowsTotal: rows.length, mode: 'upsert' }
}
