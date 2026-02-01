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

/**
 * Validate invoice against PO/GRN (quantity; optional rate/tax later).
 * Returns: { valid: boolean, reason?: string, poAlreadyFulfilled?: boolean, isShortfall?: boolean }
 */
export async function validateInvoiceAgainstPoGrn(invoiceId) {
  const inv = await pool.query(
    `SELECT invoice_id, po_id, status, invoice_date FROM invoices WHERE invoice_id = $1`,
    [invoiceId]
  )
  if (!inv.rows[0]) return { valid: false, reason: 'Invoice not found' }
  const invoice = inv.rows[0]
  const poId = invoice.po_id
  if (!poId) return { valid: false, reason: 'Invoice not linked to a PO' }

  const po = await getPoForInvoice(poId)
  if (!po) return { valid: false, reason: 'PO not found' }

  // 5. Invoices received after PO Fulfillment → Exception Approval
  if (po.status === PO_STATUS.FULFILLED) {
    return { valid: false, poAlreadyFulfilled: true, reason: 'PO already fulfilled; route to exception approval' }
  }

  const { poQty, invQty, grnQty } = await getCumulativeQuantities(poId)
  // For this invoice only, sum billed_qty (we could compare full cumulative later)
  const thisInv = await pool.query(
    `SELECT COALESCE(SUM(billed_qty), 0)::numeric AS total FROM invoice_lines WHERE invoice_id = $1`,
    [invoiceId]
  )
  const thisInvQty = parseFloat(thisInv.rows[0]?.total ?? 0)

  // Allow small tolerance for decimal comparison
  const tol = 0.001
  const invMatchesPo = Math.abs(thisInvQty - poQty) <= tol
  const invLteGrn = grnQty >= thisInvQty - tol

  // 2. Partial / Shortfall: invoice or GRN qty < PO qty – return specific reason and quantities for UI
  if (!invMatchesPo || thisInvQty < poQty - tol || (grnQty > 0 && !invLteGrn)) {
    let validationFailureReason = 'Quantity shortfall or mismatch; route to debit note approval.'
    if (!invMatchesPo && thisInvQty < poQty - tol) {
      validationFailureReason = `Invoice total quantity (${thisInvQty}) is less than PO total (${poQty}). Route to debit note approval.`
    } else if (!invMatchesPo && thisInvQty > poQty + tol) {
      validationFailureReason = `Invoice total quantity (${thisInvQty}) exceeds PO total (${poQty}). Route to debit note approval.`
    } else if (!invMatchesPo) {
      validationFailureReason = `Invoice quantity (${thisInvQty}) does not match PO total (${poQty}). Route to debit note approval.`
    } else if (grnQty > 0 && !invLteGrn) {
      validationFailureReason = `GRN total quantity (${grnQty}) is less than invoice quantity (${thisInvQty}). Pay only for what was received; route to debit note approval.`
    }
    return {
      valid: false,
      isShortfall: true,
      reason: validationFailureReason,
      thisInvQty,
      poQty,
      grnQty,
      validationFailureReason
    }
  }

  // 1. Standard validation: quantities match
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
        grnQty: result.grnQty
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
