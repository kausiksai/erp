/**
 * Dual-source invoice reconciliation.
 *
 * Every invoice can originate from two places:
 *   1. Excel Bill Register — pushed by the Python email_automation pipeline.
 *   2. Portal OCR — Landing AI extraction from the uploaded PDF.
 *
 * When both sources exist we compare them field-by-field with tolerance
 * rules, store the diff on `invoices.mismatches`, and set
 * `reconciliation_status` so the portal can route the row to either the
 * "needs reconciliation" queue (manual review) or let validation continue.
 *
 * The authoritative values that downstream validations (sweeper, payment
 * flow, etc.) read are always the *normal columns* on `invoices` /
 * `invoice_lines`. Reconciliation rewrites those columns when the reviewer
 * approves a source, or leaves the existing values alone if both sides agree.
 */

// Per-field tolerance rules. Numeric fields tolerate the larger of
// ABS_TOL_RUPEES (₹1) or PCT_TOL (0.5%). Strings must match case-insensitive
// after stripping non-alphanumeric characters (so "33AAACP7551L1Z5" matches
// "33 AAACP 7551 L1Z5").
const ABS_TOL_RUPEES = 1
const PCT_TOL = 0.005

const NUMERIC_FIELDS = [
  'total_amount',
  'tax_amount',
  'subtotal',
  'cgst',
  'sgst',
  'igst'
]

const STRING_FIELDS = [
  'invoice_number',
  'invoice_date',
  'supplier_gstin',
  'po_number'
]

// ---------------------------------------------------------------------------
//   Snapshot builders
// ---------------------------------------------------------------------------

/**
 * Build the canonical JSONB snapshot we persist for the Excel source.
 * Shape intentionally mirrors the OCR snapshot so the comparator treats
 * them symmetrically.
 */
export function buildExcelSnapshot(header, lines) {
  const taxSum = sumTaxes(lines)
  return {
    invoice_number: header.bill_no ?? header.invoice_number ?? null,
    invoice_date: iso(header.bill_date ?? header.invoice_date),
    supplier_gstin: normId(header.gstin ?? header.supplier_gstin),
    supplier_name: header.supplier_name ?? null,
    po_number: header.po_no ?? header.po_number ?? null,
    subtotal: sumLines(lines, 'taxable_value') ?? sumLines(lines, 'assessable_value'),
    cgst: taxSum.cgst,
    sgst: taxSum.sgst,
    igst: taxSum.igst,
    tax_amount: taxSum.total,
    total_amount: sumLines(lines, 'line_total') ?? sumLines(lines, 'net_amount'),
    line_items: (lines || []).map((ln, i) => ({
      sequence: i + 1,
      item_name: ln.item_name ?? null,
      hsn_sac: ln.hsn_sac ?? null,
      quantity: num(ln.billed_qty),
      uom: ln.uom ?? null,
      rate: num(ln.rate),
      taxable_value: num(ln.taxable_value ?? ln.assessable_value),
      cgst_amount: num(ln.cgst_amount),
      sgst_amount: num(ln.sgst_amount),
      igst_amount: num(ln.igst_amount),
      line_total: num(ln.line_total ?? ln.net_amount)
    }))
  }
}

/**
 * Build the canonical JSONB snapshot for the OCR source. Accepts the
 * canonical camelCase shape that Landing AI mapping produces.
 */
export function buildOcrSnapshot(invoice) {
  return {
    invoice_number: invoice.invoiceNumber ?? null,
    invoice_date: invoice.invoiceDate ?? null,
    supplier_gstin: normId(invoice.supplierGstin),
    supplier_name: invoice.supplierName ?? null,
    po_number: invoice.poNumber ?? null,
    subtotal: num(invoice.subtotal),
    cgst: num(invoice.cgst),
    sgst: num(invoice.sgst),
    igst: num(invoice.igst),
    tax_amount: num(invoice.taxAmount),
    total_amount: num(invoice.totalAmount),
    line_items: (invoice.items || []).map((it, i) => ({
      sequence: i + 1,
      item_name: it.itemName ?? null,
      hsn_sac: it.hsnSac ?? null,
      quantity: num(it.quantity),
      uom: it.uom ?? null,
      rate: num(it.unitPrice ?? it.rate),
      taxable_value: num(it.taxableValue),
      cgst_amount: num(it.cgstAmount),
      sgst_amount: num(it.sgstAmount),
      igst_amount: num(it.igstAmount),
      line_total: num(it.lineTotal)
    }))
  }
}

// ---------------------------------------------------------------------------
//   Comparator
// ---------------------------------------------------------------------------

/**
 * Compare two snapshots and produce:
 *   mismatches[]         — array of per-field diffs
 *   status               — 'auto_matched' | 'pending_reconciliation'
 *   all_match            — boolean shortcut
 *   line_count_mismatch  — true when line arrays differ in length
 */
export function compareSnapshots(excel, ocr) {
  const mismatches = []
  if (!excel || !ocr) {
    // Only one side present — not a mismatch, single_source handles it.
    return { mismatches: [], status: 'single_source', all_match: true }
  }

  for (const field of STRING_FIELDS) {
    const a = normStr(excel[field])
    const b = normStr(ocr[field])
    if (a == null && b == null) continue
    if (!stringEq(a, b)) {
      mismatches.push({
        field,
        excel_value: excel[field] ?? null,
        ocr_value: ocr[field] ?? null,
        severity: field === 'invoice_number' || field === 'supplier_gstin' ? 'high' : 'medium'
      })
    }
  }

  for (const field of NUMERIC_FIELDS) {
    const a = num(excel[field])
    const b = num(ocr[field])
    if (a == null && b == null) continue
    if (!numEq(a, b)) {
      mismatches.push({
        field,
        excel_value: a,
        ocr_value: b,
        delta: a != null && b != null ? Number((a - b).toFixed(2)) : null,
        tolerance: `±₹${ABS_TOL_RUPEES} or ±${(PCT_TOL * 100).toFixed(1)}%`,
        severity: field === 'total_amount' ? 'high' : 'medium'
      })
    }
  }

  const excelLines = excel.line_items ?? []
  const ocrLines = ocr.line_items ?? []
  if (excelLines.length !== ocrLines.length) {
    mismatches.push({
      field: 'line_items.count',
      excel_value: excelLines.length,
      ocr_value: ocrLines.length,
      severity: 'high'
    })
  }

  const status = mismatches.length === 0 ? 'auto_matched' : 'pending_reconciliation'
  return {
    mismatches,
    status,
    all_match: mismatches.length === 0,
    line_count_mismatch: excelLines.length !== ocrLines.length
  }
}

// ---------------------------------------------------------------------------
//   Orchestration — run from Node (Excel path is triggered from Python after
//   insert via a separate reconcile() API call; Node owns the comparator).
// ---------------------------------------------------------------------------

/**
 * Compare whatever snapshots exist on the row and persist the result.
 *   - 0 snapshots → status stays 'single_source' (shouldn't be called).
 *   - 1 snapshot  → 'single_source'.
 *   - 2 snapshots → compare and set auto_matched / pending_reconciliation.
 *
 * Returns the final { reconciliation_status, mismatches }.
 */
export async function reconcileInvoice(client, invoiceId) {
  const { rows } = await client.query(
    `SELECT source, excel_snapshot, ocr_snapshot
       FROM invoices
      WHERE invoice_id = $1
      FOR UPDATE`,
    [invoiceId]
  )
  if (rows.length === 0) return null
  const row = rows[0]

  const hasExcel = !!row.excel_snapshot
  const hasOcr = !!row.ocr_snapshot

  let status = 'single_source'
  let mismatches = null
  let source = row.source || 'excel'

  if (hasExcel && hasOcr) {
    source = 'both'
    const cmp = compareSnapshots(row.excel_snapshot, row.ocr_snapshot)
    status = cmp.status
    mismatches = cmp.mismatches
  } else if (hasExcel) {
    source = 'excel'
  } else if (hasOcr) {
    source = 'ocr'
  }

  await client.query(
    `UPDATE invoices
        SET source = $1,
            reconciliation_status = $2,
            mismatches = $3,
            updated_at = NOW()
      WHERE invoice_id = $4`,
    [source, status, mismatches ? JSON.stringify(mismatches) : null, invoiceId]
  )

  return { reconciliation_status: status, mismatches, source }
}

/**
 * Apply a reviewer's decision. `approvals` is keyed by field name, value is
 * one of:
 *   'excel' → keep the excel_snapshot value
 *   'ocr'   → keep the ocr_snapshot value
 *   { manual: <value> }   → override with an arbitrary value
 *
 * Any field not in `approvals` is left untouched. After applying the
 * updates the row transitions to reconciliation_status='manually_approved'.
 */
export async function applyReconciliationDecision(client, invoiceId, approvals, userId) {
  const { rows } = await client.query(
    `SELECT invoice_id, excel_snapshot, ocr_snapshot
       FROM invoices
      WHERE invoice_id = $1
      FOR UPDATE`,
    [invoiceId]
  )
  if (rows.length === 0) return null
  const row = rows[0]
  const excel = row.excel_snapshot || {}
  const ocr = row.ocr_snapshot || {}

  const dbFieldMap = {
    invoice_number: 'invoice_number',
    invoice_date: 'invoice_date',
    total_amount: 'total_amount',
    tax_amount: 'tax_amount',
    po_number: 'po_number'
  }

  const sets = []
  const vals = []
  let idx = 1
  for (const [field, choice] of Object.entries(approvals || {})) {
    const dbCol = dbFieldMap[field]
    if (!dbCol) continue
    let value
    if (choice === 'excel') value = excel[field] ?? null
    else if (choice === 'ocr') value = ocr[field] ?? null
    else if (choice && typeof choice === 'object' && 'manual' in choice) value = choice.manual
    else continue
    sets.push(`${dbCol} = $${idx++}`)
    vals.push(value)
  }

  sets.push(`reconciliation_status = 'manually_approved'`)
  sets.push(`reviewed_by = $${idx++}`)
  vals.push(userId || null)
  sets.push(`reviewed_at = NOW()`)
  sets.push(`updated_at = NOW()`)

  vals.push(invoiceId)
  await client.query(
    `UPDATE invoices SET ${sets.join(', ')} WHERE invoice_id = $${idx}`,
    vals
  )
  return { reconciliation_status: 'manually_approved' }
}

// ---------------------------------------------------------------------------
//   helpers
// ---------------------------------------------------------------------------

function num(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

function normId(v) {
  if (v == null) return null
  const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s || null
}

function normStr(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function stringEq(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return String(a).replace(/[^A-Za-z0-9]/g, '').toLowerCase() ===
         String(b).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

function numEq(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  const diff = Math.abs(a - b)
  if (diff <= ABS_TOL_RUPEES) return true
  const base = Math.max(Math.abs(a), Math.abs(b))
  return base > 0 && diff / base <= PCT_TOL
}

function iso(d) {
  if (!d) return null
  if (typeof d === 'string') return d.length >= 10 ? d.slice(0, 10) : d
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return null
}

function sumLines(lines, key) {
  if (!Array.isArray(lines) || lines.length === 0) return null
  let total = 0
  let any = false
  for (const ln of lines) {
    const v = num(ln[key])
    if (v != null) {
      total += v
      any = true
    }
  }
  return any ? Number(total.toFixed(2)) : null
}

function sumTaxes(lines) {
  const cgst = sumLines(lines, 'cgst_amount') || 0
  const sgst = sumLines(lines, 'sgst_amount') || 0
  const igst = sumLines(lines, 'igst_amount') || 0
  return {
    cgst: cgst || null,
    sgst: sgst || null,
    igst: igst || null,
    total: cgst + sgst + igst || null
  }
}
