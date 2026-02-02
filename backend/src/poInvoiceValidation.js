/**
 * PO / Invoice / ASN / GRN Processing – Functional Requirements
 * PO lifecycle: open → (on validation) either partially_fulfilled or fulfilled
 * Invoice lifecycle: waiting_for_validation → validated | waiting_for_re_validation | debit_note_approval | exception_approval
 *   → validated → (approve payment) ready_for_payment → partially_paid | paid
 * 1. Standard validation (match) → invoice validated, PO fulfilled
 * 2. Shortfall → waiting_for_re_validation; proceed to debit note → debit_note_approval; after debit note approve → validated
 * 3. Exception (PO already fulfilled) → exception_approval; after approve → validated
 * 4. Validated invoices appear in Approve Payments; approve → ready_for_payment
 * 5. Payment: ready_for_payment → partially_paid → paid
 */

import { pool } from './db.js'

const PO_STATUS = { OPEN: 'open', FULFILLED: 'fulfilled', PARTIALLY_FULFILLED: 'partially_fulfilled' }

/**
 * Parse payment terms days from PO terms text (e.g. "60 DAYS FROM RECEIPT OF MATERIAL", "30 DAYS", "45 days").
 * @param {string | null} terms
 * @returns {number} days (default 30 if not parseable)
 */
function parsePaymentTermsDays(terms) {
  if (!terms || typeof terms !== 'string') return 30
  const normalized = terms.toUpperCase().trim()
  const match = normalized.match(/(\d+)\s*DAY/i)
  if (match) return Math.max(0, parseInt(match[1], 10)) || 30
  return 30
}

const INVOICE_STATUS = {
  WAITING_FOR_VALIDATION: 'waiting_for_validation',
  VALIDATED: 'validated',
  WAITING_FOR_RE_VALIDATION: 'waiting_for_re_validation',
  DEBIT_NOTE_APPROVAL: 'debit_note_approval',
  EXCEPTION_APPROVAL: 'exception_approval',
  READY_FOR_PAYMENT: 'ready_for_payment',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  REJECTED: 'rejected'
}

/**
 * Get cumulative quantities per PO (for header-level; line-level can be added later).
 * PO total = sum(purchase_order_lines.qty)
 * Invoice total = sum(invoice_lines.billed_qty) for that po_id
 * GRN total = sum(grn.grn_qty) or accepted_qty for that po_id
 * ASN table has no qty column; use GRN as receipt proxy or leave ASN as “exists” only.
 */
export async function getCumulativeQuantities(poId) {
  const [poTotal, invTotal, grnTotal] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(qty), 0)::numeric AS total FROM purchase_order_lines WHERE po_id = $1`,
      [poId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(il.billed_qty), 0)::numeric AS total
       FROM invoice_lines il
       JOIN invoices i ON i.invoice_id = il.invoice_id AND i.po_id = $1`,
      [poId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)), 0)::numeric AS total FROM grn WHERE po_id = $1`,
      [poId]
    )
  ])
  const poQty = parseFloat(poTotal.rows[0]?.total ?? 0)
  const invQty = parseFloat(invTotal.rows[0]?.total ?? 0)
  const grnQty = parseFloat(grnTotal.rows[0]?.total ?? 0)
  return { poQty, invQty, grnQty }
}

/**
 * Get PO status and terms for an invoice’s po_id. payment_terms_days is parsed from terms text.
 * @param {number} poId
 * @param {import('pg').PoolClient} [client] - use for transaction
 */
async function getPoForInvoice(poId, client) {
  if (!poId) return null
  const q = client ? client.query.bind(client) : pool.query.bind(pool)
  const { rows } = await q(
    `SELECT po_id, status, terms FROM purchase_orders WHERE po_id = $1`,
    [poId]
  )
  const row = rows[0]
  if (!row) return null
  return {
    po_id: row.po_id,
    status: row.status,
    payment_terms_days: parsePaymentTermsDays(row.terms)
  }
}

const TOL_QTY = 0.001
const TOL_AMOUNT = 0.01
const TOL_RATE_PCT = 0.01

/**
 * Full validation engine: header (supplier, PO link), line-level (qty, rate, line total), totals (Invoice vs PO vs GRN), ASN info.
 * Returns structured result for UI and for derive valid/isShortfall.
 */
export async function runFullValidation(invoiceId) {
  const errors = []
  const details = {
    header: { invoice: null, po: null, supplierMatch: null, errors: [], warnings: [] },
    lines: [],
    totals: { thisInvQty: 0, poQty: 0, grnQty: 0, thisInvAmount: 0, errors: [], warnings: [] },
    grn: { grnQty: 0, invLteGrn: null, errors: [] },
    asn: { asnCount: 0, warnings: [] }
  }

  const invRes = await pool.query(
    `SELECT invoice_id, invoice_number, invoice_date, supplier_id, po_id, total_amount, po_number
     FROM invoices WHERE invoice_id = $1`,
    [invoiceId]
  )
  if (!invRes.rows[0]) {
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, reason: 'Invoice not found', errors: ['Invoice not found'], warnings: [], details }
  }
  const invoice = invRes.rows[0]
  details.header.invoice = invoice
  const poId = invoice.po_id

  if (!poId) {
    errors.push('Invoice is not linked to a PO')
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, reason: errors[0], errors, warnings: [], details }
  }

  if (!invoice.invoice_number || String(invoice.invoice_number).trim() === '') {
    errors.push('Invoice number is missing')
  }
  if (!invoice.invoice_date) {
    details.header.warnings.push('Invoice date is missing')
  }

  const poRes = await pool.query(
    `SELECT po_id, po_number, supplier_id, status, terms FROM purchase_orders WHERE po_id = $1`,
    [poId]
  )
  if (!poRes.rows[0]) {
    errors.push('PO not found')
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, reason: errors[0], errors, warnings: [], details }
  }
  const po = poRes.rows[0]
  details.header.po = po

  if (po.status === PO_STATUS.FULFILLED) {
    return {
      valid: false,
      poAlreadyFulfilled: true,
      isShortfall: false,
      reason: 'PO already fulfilled; route to exception approval',
      errors: ['PO already fulfilled; route to exception approval'],
      warnings: [],
      details
    }
  }

  const supplierMatch = invoice.supplier_id != null && po.supplier_id != null && Number(invoice.supplier_id) === Number(po.supplier_id)
  details.header.supplierMatch = supplierMatch
  if (!supplierMatch) {
    errors.push('Invoice supplier does not match PO supplier')
  }
  if (invoice.po_number && po.po_number && String(invoice.po_number).trim() !== String(po.po_number).trim()) {
    details.header.warnings.push(`Invoice PO number (${invoice.po_number}) does not match PO (${po.po_number})`)
  }

  const [invLinesRes, poLinesRes, cumul, asnRes] = await Promise.all([
    pool.query(
      `SELECT invoice_line_id, po_line_id, sequence_number, billed_qty, weight, count, rate, line_total, item_name
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY sequence_number NULLS LAST, invoice_line_id`,
      [invoiceId]
    ),
    pool.query(
      `SELECT po_line_id, sequence_number, qty, unit_cost, item_id, description1 FROM purchase_order_lines WHERE po_id = $1 ORDER BY sequence_number`,
      [poId]
    ),
    getCumulativeQuantities(poId),
    pool.query(`SELECT COUNT(*) AS cnt FROM asn WHERE po_id = $1`, [poId])
  ])

  const invLines = invLinesRes.rows
  const poLines = poLinesRes.rows
  const { poQty, grnQty } = cumul
  details.totals.poQty = parseFloat(poQty)
  details.grn.grnQty = parseFloat(grnQty)
  details.asn.asnCount = parseInt(asnRes.rows[0]?.cnt ?? 0, 10)

  let thisInvQty = 0
  let thisInvAmount = 0
  const poLineByLineId = new Map(poLines.map(r => [r.po_line_id, r]))
  const poLineBySeq = new Map(poLines.map(r => [r.sequence_number, r]))

  for (let i = 0; i < invLines.length; i++) {
    const il = invLines[i]
    const invQty = il.billed_qty != null ? parseFloat(il.billed_qty) : (il.weight != null ? parseFloat(il.weight) : (il.count != null ? parseFloat(il.count) : null))
    const invRate = il.rate != null ? parseFloat(il.rate) : null
    const invTotal = il.line_total != null ? parseFloat(il.line_total) : null
    thisInvQty += invQty ?? 0
    thisInvAmount += invTotal ?? 0

    const poLine = (il.po_line_id && poLineByLineId.get(il.po_line_id)) || (il.sequence_number != null && poLineBySeq.get(il.sequence_number)) || poLines[i] || null
    const lineResult = {
      index: i + 1,
      invoiceLineId: il.invoice_line_id,
      poLineId: poLine?.po_line_id ?? null,
      itemName: il.item_name,
      invQty,
      poQty: poLine && poLine.qty != null ? parseFloat(poLine.qty) : null,
      invRate,
      poRate: poLine && poLine.unit_cost != null ? parseFloat(poLine.unit_cost) : null,
      invLineTotal: invTotal,
      quantityMatch: null,
      rateMatch: null,
      lineTotalMatch: null,
      errors: [],
      warnings: []
    }

    if (!poLine) {
      lineResult.errors.push('No matching PO line (by po_line_id or sequence)')
    } else {
      const qtyMatch = invQty != null && lineResult.poQty != null && Math.abs(invQty - lineResult.poQty) <= TOL_QTY
      lineResult.quantityMatch = qtyMatch
      if (!qtyMatch && invQty != null && lineResult.poQty != null) {
        if (invQty > lineResult.poQty + TOL_QTY) {
          lineResult.errors.push(`Line quantity (${invQty}) exceeds PO line qty (${lineResult.poQty})`)
        } else {
          lineResult.warnings.push(`Line quantity (${invQty}) differs from PO line qty (${lineResult.poQty})`)
        }
      }
      if (invRate != null && lineResult.poRate != null) {
        const rateMatch = Math.abs(invRate - lineResult.poRate) <= TOL_AMOUNT || (lineResult.poRate !== 0 && Math.abs((invRate - lineResult.poRate) / lineResult.poRate) <= TOL_RATE_PCT)
        lineResult.rateMatch = rateMatch
        if (!rateMatch) {
          lineResult.warnings.push(`Line rate (${invRate}) differs from PO unit cost (${lineResult.poRate})`)
        }
      }
      if (invTotal != null && invQty != null && invRate != null) {
        const expected = invQty * invRate
        lineResult.lineTotalMatch = Math.abs(invTotal - expected) <= TOL_AMOUNT
        if (!lineResult.lineTotalMatch) {
          lineResult.warnings.push(`Line total (${invTotal}) does not match qty × rate (${expected.toFixed(2)})`)
        }
      }
    }
    details.lines.push(lineResult)
  }

  details.totals.thisInvQty = thisInvQty
  details.totals.thisInvAmount = thisInvAmount

  const invMatchesPo = Math.abs(thisInvQty - poQty) <= TOL_QTY
  const invLteGrn = grnQty >= thisInvQty - TOL_QTY
  details.grn.invLteGrn = invLteGrn

  if (!invMatchesPo) {
    if (thisInvQty < poQty - TOL_QTY) {
      details.totals.errors.push(`Invoice total quantity (${thisInvQty}) is less than PO total (${poQty})`)
    } else if (thisInvQty > poQty + TOL_QTY) {
      details.totals.errors.push(`Invoice total quantity (${thisInvQty}) exceeds PO total (${poQty})`)
    } else {
      details.totals.errors.push(`Invoice quantity (${thisInvQty}) does not match PO total (${poQty})`)
    }
  }
  if (grnQty > 0 && !invLteGrn) {
    details.grn.errors.push(`GRN total (${grnQty}) is less than invoice quantity (${thisInvQty}). Pay only for what was received.`)
  }
  if (invoice.total_amount != null && Math.abs(thisInvAmount - parseFloat(invoice.total_amount)) > TOL_AMOUNT) {
    details.totals.warnings.push(`Sum of line totals (${thisInvAmount.toFixed(2)}) differs from invoice total amount (${invoice.total_amount})`)
  }
  if (details.asn.asnCount === 0 && invLines.length > 0) {
    details.asn.warnings.push('No ASN found for this PO (informational)')
  }

  const allLineErrors = details.lines.flatMap(l => l.errors)
  const totalErrors = [...details.totals.errors, ...details.grn.errors, ...allLineErrors]
  if (errors.length > 0) {
    totalErrors.unshift(...errors)
  }

  const warnings = [...details.header.warnings, ...details.totals.warnings, ...details.asn.warnings, ...details.lines.flatMap(l => l.warnings)]

  const isShortfall = totalErrors.some(e =>
    e.includes('quantity') || e.includes('PO total') || e.includes('GRN') || e.includes('exceeds') || e.includes('less than')
  ) || details.grn.errors.length > 0

  let validationFailureReason = null
  if (totalErrors.length > 0) {
    validationFailureReason = isShortfall
      ? (details.grn.errors[0] || details.totals.errors[0] || totalErrors[0])
      : totalErrors[0]
    if (isShortfall && validationFailureReason && !validationFailureReason.includes('Route to debit note')) {
      validationFailureReason += ' Route to debit note approval.'
    }
  }

  return {
    valid: totalErrors.length === 0,
    poAlreadyFulfilled: false,
    isShortfall: totalErrors.length > 0 && isShortfall,
    reason: validationFailureReason || (totalErrors.length ? totalErrors[0] : null),
    errors: totalErrors,
    warnings,
    details: {
      ...details,
      thisInvQty,
      poQty,
      grnQty
    }
  }
}

/**
 * Validate invoice against PO/GRN. Uses full validation engine; returns legacy shape for existing callers.
 */
export async function validateInvoiceAgainstPoGrn(invoiceId) {
  const full = await runFullValidation(invoiceId)

  if (full.poAlreadyFulfilled) {
    return { valid: false, poAlreadyFulfilled: true, reason: full.reason }
  }

  if (!full.valid) {
    return {
      valid: false,
      isShortfall: full.isShortfall,
      reason: full.reason,
      validationFailureReason: full.reason,
      thisInvQty: full.details.thisInvQty,
      poQty: full.details.poQty,
      grnQty: full.details.grnQty,
      errors: full.errors,
      warnings: full.warnings,
      details: full.details
    }
  }

  return { valid: true }
}

/**
 * Apply status updates after validation (standard flow).
 * Sets invoice to validated, payment_due_date, PO to fulfilled.
 */
export async function applyStandardValidation(client, invoiceId) {
  const inv = await client.query(
    `SELECT po_id, invoice_date FROM invoices WHERE invoice_id = $1`,
    [invoiceId]
  )
  if (!inv.rows[0]) throw new Error('Invoice not found')
  const { po_id, invoice_date } = inv.rows[0]
  const po = await getPoForInvoice(po_id, client)
  const termsDays = po?.payment_terms_days ?? 30
  let paymentDueDate = null
  if (invoice_date) {
    const d = new Date(invoice_date)
    d.setDate(d.getDate() + termsDays)
    paymentDueDate = d.toISOString().slice(0, 10)
  }
  await client.query(
    `UPDATE invoices SET status = $1, payment_due_date = $2, updated_at = NOW() WHERE invoice_id = $3`,
    [INVOICE_STATUS.VALIDATED, paymentDueDate, invoiceId]
  )
  await client.query(
    `UPDATE purchase_orders SET status = $1 WHERE po_id = $2`,
    [PO_STATUS.FULFILLED, po_id]
  )
  return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate, poStatus: PO_STATUS.FULFILLED }
}

/**
 * Proceed to payment despite mismatch (PO = Partially Fulfilled, invoice = validated).
 */
export async function proceedToPaymentFromMismatch(client, invoiceId) {
  const inv = await client.query(
    `SELECT po_id, invoice_date FROM invoices WHERE invoice_id = $1`,
    [invoiceId]
  )
  if (!inv.rows[0]) throw new Error('Invoice not found')
  const { po_id, invoice_date } = inv.rows[0]
  const po = await getPoForInvoice(po_id, client)
  const termsDays = po?.payment_terms_days ?? 30
  let paymentDueDate = null
  if (invoice_date) {
    const d = new Date(invoice_date)
    d.setDate(d.getDate() + termsDays)
    paymentDueDate = d.toISOString().slice(0, 10)
  }
  await client.query(
    `UPDATE invoices SET status = $1, payment_due_date = $2, updated_at = NOW() WHERE invoice_id = $3`,
    [INVOICE_STATUS.VALIDATED, paymentDueDate, invoiceId]
  )
  await client.query(
    `UPDATE purchase_orders SET status = $1 WHERE po_id = $2`,
    [PO_STATUS.PARTIALLY_FULFILLED, po_id]
  )
  return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate, poStatus: PO_STATUS.PARTIALLY_FULFILLED }
}

/**
 * Move invoice to debit_note_approval and ensure PO appears in incomplete list.
 */
export async function moveToDebitNoteApproval(client, invoiceId) {
  await client.query(
    `UPDATE invoices SET status = $1, updated_at = NOW() WHERE invoice_id = $2`,
    [INVOICE_STATUS.DEBIT_NOTE_APPROVAL, invoiceId]
  )
  return { invoiceStatus: INVOICE_STATUS.DEBIT_NOTE_APPROVAL }
}

/**
 * After debit note uploaded and approved: invoice = validated, payment amount = debit_note_value, PO = partially_fulfilled.
 */
export async function debitNoteApprove(client, invoiceId, debitNoteValue) {
  const inv = await client.query(`SELECT po_id, invoice_date FROM invoices WHERE invoice_id = $1`, [invoiceId])
  if (!inv.rows[0]) throw new Error('Invoice not found')
  const { po_id, invoice_date } = inv.rows[0]
  const po = await getPoForInvoice(po_id, client)
  const termsDays = po?.payment_terms_days ?? 30
  let paymentDueDate = null
  if (invoice_date) {
    const d = new Date(invoice_date)
    d.setDate(d.getDate() + termsDays)
    paymentDueDate = d.toISOString().slice(0, 10)
  }
  await client.query(
    `UPDATE invoices SET status = $1, payment_due_date = $2, debit_note_value = $3, updated_at = NOW() WHERE invoice_id = $4`,
    [INVOICE_STATUS.VALIDATED, paymentDueDate, debitNoteValue ?? null, invoiceId]
  )
  await client.query(
    `UPDATE purchase_orders SET status = $1 WHERE po_id = $2`,
    [PO_STATUS.PARTIALLY_FULFILLED, po_id]
  )
  return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate, debitNoteValue, poStatus: PO_STATUS.PARTIALLY_FULFILLED }
}

/**
 * Exception approval: invoice for already-fulfilled PO → after approval, validated.
 */
export async function exceptionApprove(client, invoiceId) {
  const inv = await client.query(`SELECT po_id, invoice_date FROM invoices WHERE invoice_id = $1`, [invoiceId])
  if (!inv.rows[0]) throw new Error('Invoice not found')
  const { po_id, invoice_date } = inv.rows[0]
  const po = await getPoForInvoice(po_id)
  const termsDays = po?.payment_terms_days ?? 30
  let paymentDueDate = null
  if (invoice_date) {
    const d = new Date(invoice_date)
    d.setDate(d.getDate() + termsDays)
    paymentDueDate = d.toISOString().slice(0, 10)
  }
  await client.query(
    `UPDATE invoices SET status = $1, payment_due_date = $2, updated_at = NOW() WHERE invoice_id = $3`,
    [INVOICE_STATUS.VALIDATED, paymentDueDate, invoiceId]
  )
  return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate }
}

/**
 * Force close PO: set status to fulfilled (for partially_fulfilled POs).
 */
export async function forceClosePo(client, poId) {
  const r = await client.query(
    `UPDATE purchase_orders SET status = $1 WHERE po_id = $2 AND status = $3 RETURNING po_id`,
    [PO_STATUS.FULFILLED, poId, PO_STATUS.PARTIALLY_FULFILLED]
  )
  if (r.rowCount === 0) throw new Error('PO not found or not in partially_fulfilled status')
  return { poStatus: PO_STATUS.FULFILLED }
}

/**
 * Run validation for an invoice and apply status updates (standard, shortfall, or exception).
 */
export async function validateAndUpdateInvoiceStatus(invoiceId) {
  const result = await validateInvoiceAgainstPoGrn(invoiceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (result.poAlreadyFulfilled) {
      await client.query(
        `UPDATE invoices SET status = $1, updated_at = NOW() WHERE invoice_id = $2`,
        [INVOICE_STATUS.EXCEPTION_APPROVAL, invoiceId]
      )
      await client.query('COMMIT')
      return { action: 'exception_approval', invoiceStatus: INVOICE_STATUS.EXCEPTION_APPROVAL }
    }
    if (result.isShortfall) {
      await client.query(
        `UPDATE invoices SET status = $1, updated_at = NOW() WHERE invoice_id = $2`,
        [INVOICE_STATUS.WAITING_FOR_RE_VALIDATION, invoiceId]
      )
      await client.query('COMMIT')
      return {
        action: 'shortfall',
        invoiceStatus: INVOICE_STATUS.WAITING_FOR_RE_VALIDATION,
        validationFailureReason: result.validationFailureReason || result.reason,
        thisInvQty: result.thisInvQty,
        poQty: result.poQty,
        grnQty: result.grnQty,
        errors: result.errors,
        warnings: result.warnings,
        details: result.details
      }
    }
    if (result.valid) {
      const applied = await applyStandardValidation(client, invoiceId)
      await client.query('COMMIT')
      return { action: 'validated', ...applied }
    }
    await client.query('ROLLBACK')
    return { action: 'none', reason: result.reason }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Check cumulative quantities for a PO and update PO status to fulfilled when cumulative matches.
 */
export async function updatePoStatusFromCumulative(poId) {
  const { poQty, invQty, grnQty } = await getCumulativeQuantities(poId)
  const tol = 0.001
  if (poQty <= 0) return null
  if (invQty >= poQty - tol && grnQty >= poQty - tol) {
    const client = await pool.connect()
    try {
      await client.query(
        `UPDATE purchase_orders SET status = $1 WHERE po_id = $2`,
        [PO_STATUS.FULFILLED, poId]
      )
      return { poStatus: PO_STATUS.FULFILLED }
    } finally {
      client.release()
    }
  }
  return null
}
