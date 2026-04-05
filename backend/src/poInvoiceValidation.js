/**
 * PO / Invoice / ASN / GRN Processing – Functional Requirements
 * PO lifecycle: open → (on validation) either partially_fulfilled or fulfilled. Open PO: like standard PO but **no PO-line / PO-total quantity checks**; **requires** GRN + ASN + (DC or Schedule); **invoice qty must match** GRN total and DC/Schedule totals (when qty present); PO stays **open**; never auto-fulfilled on cumulative qty match. **Partial Open PO invoices** (fewer lines than the PO): each invoice line is matched to at most one PO line via po_line_id, sequence_number, or **item/description text** — not by row index against the whole PO; unmatched Open PO lines are warnings, not quantity failures for other PO lines.
 * DC/Schedule vs Excel: DC rows tie to PO by po_id and/or ORDER NO. (ord_no) and/or Open order no. (open_order_no) matching PO number; summed qty is dc_qty (= TRANSACTION QTY.). Schedule rows tie by po_id and/or po_number and/or Doc. No. (doc_no); sched_qty only when import finds QTY / SCHED_QTY / Quantity (many schedule sheets have no qty column).
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

function normItemText(s) {
  if (s == null) return ''
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * How well invoice line item_name matches a PO line (item_id, description1). 0 = no usable match.
 */
function itemMatchScore(invItemName, pol) {
  const inv = normItemText(invItemName)
  if (!inv) return 0
  const id = normItemText(pol.item_id)
  const desc = normItemText(pol.description1)
  if (id) {
    if (inv === id) return 300
    if (inv.includes(id) || id.includes(inv)) return 250
  }
  if (desc) {
    if (inv === desc) return 200
    if (inv.includes(desc) || desc.includes(inv)) return 190
    const invParts = inv.split(/[\s,/-]+/).filter((t) => t.length >= 2)
    for (const t of invParts) {
      if (t.length >= 3 && desc.includes(t)) return 130
    }
    const descParts = desc.split(/[\s,/-]+/).filter((t) => t.length >= 3)
    for (const t of descParts) {
      if (inv.includes(t)) return 120
    }
  }
  return 0
}

/**
 * Pick PO line for one invoice line: explicit ids → best unused item/description match →
 * index fallback only if invoice line count equals PO line count (full parallel upload).
 */
function resolvePoLineForInvoiceLine(il, poLines, poLineByLineId, poLineBySeq, usedPoLineIds, lineIndex, invLineCount) {
  if (il.po_line_id) {
    const pl = poLineByLineId.get(il.po_line_id)
    if (pl) return pl
  }
  if (il.sequence_number != null) {
    const pl = poLineBySeq.get(il.sequence_number)
    if (pl) return pl
  }
  const available = poLines.filter((p) => !usedPoLineIds.has(p.po_line_id))
  let best = null
  let bestScore = 0
  for (const p of available) {
    const sc = itemMatchScore(il.item_name, p)
    if (sc > bestScore) {
      bestScore = sc
      best = p
    }
  }
  const MIN_ITEM_SCORE = 80
  if (best && bestScore >= MIN_ITEM_SCORE) {
    return best
  }
  if (lineIndex < poLines.length && invLineCount === poLines.length) {
    return poLines[lineIndex]
  }
  return null
}

/**
 * If PO is Open PO (pfx matches open_po_prefixes), set status to open and return true.
 * Call after any flow that might otherwise set partially_fulfilled / fulfilled.
 */
export async function enforceOpenPoStaysOpen (client, poId) {
  const { rows } = await client.query(`SELECT pfx FROM purchase_orders WHERE po_id = $1`, [poId])
  if (!rows[0]) return false
  if (!(await isOpenPoByPfx(rows[0].pfx, client))) return false
  await client.query(
    `UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE po_id = $2`,
    [PO_STATUS.OPEN, poId]
  )
  return true
}

/**
 * True when PO.pfx matches any row in open_po_prefixes (prefix is leading part, case-insensitive).
 * @param {string|null|undefined} pfx
 * @param {{ query: Function }} [executor] pool or pg client
 */
export async function isOpenPoByPfx (pfx, executor = pool) {
  const p = pfx != null && String(pfx).trim() !== '' ? String(pfx).trim() : ''
  if (!p) return false
  const q = executor.query.bind(executor)
  const { rows } = await q(
    `SELECT 1 FROM open_po_prefixes op
     WHERE TRIM(op.prefix) <> ''
       AND UPPER($1) LIKE UPPER(TRIM(op.prefix)) || '%'
     LIMIT 1`,
    [p]
  )
  return rows.length > 0
}

/**
 * Full validation engine: header (supplier, PO link), line-level (qty, rate, line total), totals (Invoice vs PO vs GRN), ASN info.
 * Open PO: no line/PO-total qty vs PO; requires GRN (with qty), ASN, DC or Schedule; invoice total qty must align with GRN total and with summed DC qty / Schedule qty when those sums exist.
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
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, isOpenPo: false, reason: 'Invoice not found', errors: ['Invoice not found'], warnings: [], details }
  }
  const invoice = invRes.rows[0]
  details.header.invoice = invoice
  const poId = invoice.po_id

  if (!poId) {
    errors.push('Invoice is not linked to a PO')
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, isOpenPo: false, reason: errors[0], errors, warnings: [], details }
  }

  if (!invoice.invoice_number || String(invoice.invoice_number).trim() === '') {
    errors.push('Invoice number is missing')
  }
  if (!invoice.invoice_date) {
    details.header.warnings.push('Invoice date is missing')
  }

  const poRes = await pool.query(
    `SELECT po_id, po_number, supplier_id, status, terms, pfx FROM purchase_orders WHERE po_id = $1`,
    [poId]
  )
  if (!poRes.rows[0]) {
    errors.push('PO not found')
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, isOpenPo: false, reason: errors[0], errors, warnings: [], details }
  }
  const po = poRes.rows[0]
  details.header.po = po

  const openPo = await isOpenPoByPfx(po.pfx)

  if (po.status === PO_STATUS.FULFILLED && !openPo) {
    return {
      valid: false,
      poAlreadyFulfilled: true,
      isShortfall: false,
      isOpenPo: false,
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

  const [invLinesRes, poLinesRes, cumul, asnRes, dcRes, schRes, dcSumRes, schSumRes] = await Promise.all([
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
    pool.query(`SELECT COUNT(*) AS cnt FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) WHERE inv.po_id = $1`, [poId]),
    // DC Excel: ORDER NO. → ord_no + po_id when PO exists; OPEN ORDER NO. → open_order_no. TRANSACTION QTY. → dc_qty (sum).
    // Include rows linked by po_id OR by order / open-order number when po_id was null at import (same idea as schedules).
    pool.query(
      `SELECT COUNT(*)::int AS c FROM delivery_challans
       WHERE po_id = $1
          OR (TRIM(COALESCE(ord_no, '')) <> '' AND LOWER(TRIM(ord_no)) = LOWER(TRIM($2)))
          OR (TRIM(COALESCE(open_order_no, '')) <> '' AND LOWER(TRIM(open_order_no)) = LOWER(TRIM($2)))`,
      [poId, po.po_number || '']
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM po_schedules
       WHERE po_id = $1
          OR (COALESCE(po_number, '') <> '' AND LOWER(TRIM(po_number)) = LOWER(TRIM($2)))
          OR (COALESCE(doc_no, '') <> '' AND LOWER(TRIM(doc_no)) = LOWER(TRIM($2)))`,
      [poId, po.po_number || '']
    ),
    pool.query(
      `SELECT COALESCE(SUM(dc_qty), 0)::numeric AS total FROM delivery_challans
       WHERE po_id = $1
          OR (TRIM(COALESCE(ord_no, '')) <> '' AND LOWER(TRIM(ord_no)) = LOWER(TRIM($2)))
          OR (TRIM(COALESCE(open_order_no, '')) <> '' AND LOWER(TRIM(open_order_no)) = LOWER(TRIM($2)))`,
      [poId, po.po_number || '']
    ),
    pool.query(
      `SELECT COALESCE(SUM(sched_qty), 0)::numeric AS total FROM po_schedules
       WHERE po_id = $1
          OR (COALESCE(po_number, '') <> '' AND LOWER(TRIM(po_number)) = LOWER(TRIM($2)))
          OR (COALESCE(doc_no, '') <> '' AND LOWER(TRIM(doc_no)) = LOWER(TRIM($2)))`,
      [poId, po.po_number || '']
    )
  ])

  const invLines = invLinesRes.rows
  const poLines = poLinesRes.rows
  const { poQty, grnQty } = cumul
  details.totals.poQty = parseFloat(poQty)
  details.grn.grnQty = parseFloat(grnQty)
  details.asn.asnCount = parseInt(asnRes.rows[0]?.cnt ?? 0, 10)
  const dcCount = parseInt(dcRes.rows[0]?.c ?? 0, 10)
  const scheduleCount = parseInt(schRes.rows[0]?.c ?? 0, 10)
  const sumDcQty = parseFloat(dcSumRes.rows[0]?.total ?? 0)
  const sumSchedQty = parseFloat(schSumRes.rows[0]?.total ?? 0)
  details.dcCount = dcCount
  details.scheduleCount = scheduleCount
  details.sumDcQty = sumDcQty
  details.sumSchedQty = sumSchedQty

  let thisInvQty = 0
  let thisInvAmount = 0
  const poLineByLineId = new Map(poLines.map(r => [r.po_line_id, r]))
  const poLineBySeq = new Map(poLines.map(r => [r.sequence_number, r]))
  const usedPoLineIds = new Set()

  for (let i = 0; i < invLines.length; i++) {
    const il = invLines[i]
    const invQty = il.billed_qty != null ? parseFloat(il.billed_qty) : (il.weight != null ? parseFloat(il.weight) : (il.count != null ? parseFloat(il.count) : null))
    const invRate = il.rate != null ? parseFloat(il.rate) : null
    const invTotal = il.line_total != null ? parseFloat(il.line_total) : null
    thisInvQty += invQty ?? 0
    thisInvAmount += invTotal ?? 0

    const poLine = resolvePoLineForInvoiceLine(
      il,
      poLines,
      poLineByLineId,
      poLineBySeq,
      usedPoLineIds,
      i,
      invLines.length
    )
    if (poLine) usedPoLineIds.add(poLine.po_line_id)
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
      if (openPo) {
        lineResult.warnings.push(
          'Open PO: no PO line matched this invoice line (use po_line_id / sequence on the line, or item text similar to PO item_id or description). Totals still use GRN/DC vs this invoice only.'
        )
      } else {
        lineResult.errors.push('No matching PO line (by po_line_id, sequence, item text, or same line count as PO)')
      }
    } else if (openPo) {
      lineResult.quantityMatch = null
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
  const invMatchesGrnQty = Math.abs(thisInvQty - grnQty) <= TOL_QTY
  details.grn.invLteGrn = openPo ? invMatchesGrnQty : invLteGrn

  if (!openPo) {
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
  }
  if (invoice.total_amount != null && Math.abs(thisInvAmount - parseFloat(invoice.total_amount)) > TOL_AMOUNT) {
    details.totals.warnings.push(`Sum of line totals (${thisInvAmount.toFixed(2)}) differs from invoice total amount (${invoice.total_amount})`)
  }
  if (!openPo && details.asn.asnCount === 0 && invLines.length > 0) {
    details.asn.warnings.push('No ASN found for this PO (informational)')
  }

  if (openPo) {
    if (grnQty <= TOL_QTY) {
      errors.push('Open PO: GRN with quantity is required for this purchase order.')
    } else if (!invMatchesGrnQty) {
      details.grn.errors.push(
        `Open PO: invoice quantity (${thisInvQty}) must match GRN total (${grnQty}).`
      )
    }
    if (details.asn.asnCount === 0 && invLines.length > 0) {
      errors.push('Open PO: ASN linked to this PO/invoice is required.')
    }
    if (dcCount === 0 && scheduleCount === 0) {
      errors.push('Open PO: at least one Delivery Challan or Schedule record must exist for this purchase order.')
    }
    if (dcCount > 0 && sumDcQty > TOL_QTY && Math.abs(thisInvQty - sumDcQty) > TOL_QTY) {
      errors.push(
        `Open PO: invoice quantity (${thisInvQty}) must match Delivery Challan total (${sumDcQty}).`
      )
    }
    if (scheduleCount > 0 && sumSchedQty > TOL_QTY && Math.abs(thisInvQty - sumSchedQty) > TOL_QTY) {
      errors.push(
        `Open PO: invoice quantity (${thisInvQty}) must match Schedule total (${sumSchedQty}).`
      )
    }
  }

  const allLineErrors = details.lines.flatMap(l => l.errors)
  const totalErrors = [...details.totals.errors, ...details.grn.errors, ...allLineErrors]
  if (errors.length > 0) {
    totalErrors.unshift(...errors)
  }

  const warnings = [...details.header.warnings, ...details.totals.warnings, ...details.asn.warnings, ...details.lines.flatMap(l => l.warnings)]

  const isShortfall =
    details.grn.errors.length > 0 ||
    (!openPo &&
      totalErrors.some(
        e =>
          (e.includes('quantity') || e.includes('PO total') || e.includes('GRN') || e.includes('exceeds') || e.includes('less than')) &&
          !String(e).startsWith('Open PO:')
      )) ||
    (openPo &&
      totalErrors.some(
        e =>
          String(e).startsWith('Open PO:') &&
          (e.includes('quantity') ||
            e.includes('match') ||
            e.includes('ASN') ||
            e.includes('GRN') ||
            e.includes('Challan') ||
            e.includes('Schedule'))
      ))

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
    isOpenPo: openPo,
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
    return { valid: false, poAlreadyFulfilled: true, isOpenPo: false, reason: full.reason }
  }

  if (!full.valid) {
    return {
      valid: false,
      isShortfall: full.isShortfall,
      isOpenPo: full.isOpenPo ?? false,
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

  return { valid: true, isOpenPo: full.isOpenPo ?? false }
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
  const pfxRow = await client.query(`SELECT pfx FROM purchase_orders WHERE po_id = $1`, [po_id])
  if (await isOpenPoByPfx(pfxRow.rows[0]?.pfx, client)) {
    throw new Error('Open PO (prefix match) must not use standard validation — use applyOpenPoValidation')
  }
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
 * Open PO: validate invoice for payment; PO always stays **open** (never auto-fulfilled), even when
 * cumulative invoice qty matches PO qty — use updatePoStatusFromCumulative only for non–Open POs.
 */
export async function applyOpenPoValidation (client, invoiceId) {
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
    `UPDATE purchase_orders SET status = $1, updated_at = NOW() WHERE po_id = $2`,
    [PO_STATUS.OPEN, po_id]
  )
  return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate, poStatus: PO_STATUS.OPEN, openPo: true }
}

/**
 * Proceed to payment despite mismatch (PO = Partially Fulfilled, invoice = validated).
 * Open PO: PO status stays **open** (never partially_fulfilled).
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
  if (await enforceOpenPoStaysOpen(client, po_id)) {
    return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate, poStatus: PO_STATUS.OPEN, openPo: true }
  }
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
 * Open PO: PO status stays **open**.
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
  if (await enforceOpenPoStaysOpen(client, po_id)) {
    return {
      invoiceStatus: INVOICE_STATUS.VALIDATED,
      paymentDueDate,
      debitNoteValue,
      poStatus: PO_STATUS.OPEN,
      openPo: true
    }
  }
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
 * Open PO cannot be force-closed; status must remain open.
 */
export async function forceClosePo(client, poId) {
  const poRow = await client.query(`SELECT pfx FROM purchase_orders WHERE po_id = $1`, [poId])
  if (!poRow.rows[0]) throw new Error('PO not found')
  if (await isOpenPoByPfx(poRow.rows[0].pfx, client)) {
    throw new Error('Open PO (prefix match) cannot be force-closed; status must remain open')
  }
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
      const applied = result.isOpenPo
        ? await applyOpenPoValidation(client, invoiceId)
        : await applyStandardValidation(client, invoiceId)
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
 * Open POs (pfx matches open_po_prefixes) are never auto-fulfilled here — they stay open for further invoices.
 */
export async function updatePoStatusFromCumulative(poId) {
  const poRow = await pool.query(`SELECT pfx FROM purchase_orders WHERE po_id = $1`, [poId])
  if (!poRow.rows[0]) return null
  if (await isOpenPoByPfx(poRow.rows[0].pfx)) return null

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
