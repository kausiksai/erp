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

/**
 * Extract the 2-digit state code from a GSTIN (first two characters).
 * Mirrors Python's _state_code_from_gstin in context.py.
 */
function stateCodeFromGstin(gstin) {
  if (!gstin) return ''
  const s = String(gstin).trim()
  if (s.length < 2) return ''
  const head = s.slice(0, 2)
  return /^\d{2}$/.test(head) ? head : ''
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
/**
 * Match an invoice line to its PO line. Resolution order **must** match
 * Python's `_resolve_po_line()` in email_automation/validation/checks.py:
 *   1. Explicit po_line_id (rare; never set by current loaders).
 *   2. Item-code / description match (best unused match scoring ≥ 80).
 *   3. Sequence-number match (positional fallback for unused lines).
 *   4. Positional fallback when line counts agree.
 *
 * Item match must win over sequence — Bill Register and PO XLS often list
 * the same items in different orders. Sequence-first matching pairs
 * line N of the invoice with line N of the PO regardless of item,
 * producing false E022/E021 mismatches on every reordered multi-line
 * invoice. (This bug was previously fixed on the Python side; JS had it
 * inverted.)
 */
function resolvePoLineForInvoiceLine(il, poLines, poLineByLineId, _poLineBySeq, usedPoLineIds, lineIndex, invLineCount) {
  // 1. Explicit po_line_id
  if (il.po_line_id) {
    const pl = poLineByLineId.get(il.po_line_id)
    if (pl) return pl
  }
  // 2. Item-text match — preferred over sequence to handle reordered invoices.
  const available = poLines.filter((p) => !usedPoLineIds.has(p.po_line_id))
  let best = null
  let bestScore = 0
  const MIN_ITEM_SCORE = 80
  for (const p of available) {
    const sc = itemMatchScore(il.item_name, p)
    if (sc > bestScore) {
      bestScore = sc
      best = p
    }
  }
  if (best && bestScore >= MIN_ITEM_SCORE) {
    return best
  }
  // 3. Sequence-number fallback (only on unused PO lines).
  if (il.sequence_number != null) {
    for (const p of poLines) {
      if (p.sequence_number === il.sequence_number && !usedPoLineIds.has(p.po_line_id)) {
        return p
      }
    }
  }
  // 4. Positional fallback only when line counts agree.
  if (lineIndex < poLines.length && invLineCount === poLines.length) {
    const cand = poLines[lineIndex]
    if (!usedPoLineIds.has(cand.po_line_id)) return cand
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
  // purchase_orders has no updated_at column in this DB (unlike invoices).
  // Touching it 500ms ago was the reason every Open-PO revalidate threw
  // "column updated_at of relation purchase_orders does not exist" and left
  // the invoice stuck on its old status.
  await client.query(
    `UPDATE purchase_orders SET status = $1 WHERE po_id = $2`,
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
    `SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.supplier_id, i.po_id,
            i.total_amount, i.po_number, i.open_order_pfx, i.open_order_no,
            i.grn_pfx, i.grn_no, i.ss_pfx, i.ss_no,
            i.place_of_supply, i.gstin AS invoice_gstin,
            s.state_code AS supplier_state_code,
            s.gst_number AS supplier_gst_number
       FROM invoices i
       LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
      WHERE i.invoice_id = $1`,
    [invoiceId]
  )
  if (!invRes.rows[0]) {
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, isOpenPo: false, reason: 'Invoice not found', errors: ['Invoice not found'], warnings: [], details }
  }
  const invoice = invRes.rows[0]
  details.header.invoice = invoice

  // 3-way PO resolution. Mirrors Python's load_invoice_context() in
  // email_automation/validation/context.py — resolves PO via:
  //   1. invoices.po_id (direct)
  //   2. po_number text → purchase_orders.po_number (latest amendment)
  //   3. GRN / ASN cross-reference (this invoice's grn_pfx+grn_no, this
  //      invoice's invoice_number on GRN.supplier_doc_no, or ASN.inv_no).
  //      Only resolves when the candidates collapse to a single PO under
  //      the same supplier.
  let poId = invoice.po_id
  if (poId == null && invoice.po_number) {
    const { rows } = await pool.query(
      `SELECT po_id FROM purchase_orders
        WHERE po_number = $1
        ORDER BY amd_no DESC
        LIMIT 1`,
      [invoice.po_number]
    )
    if (rows[0]) poId = rows[0].po_id
  }
  if (poId == null && invoice.supplier_id != null) {
    const { rows } = await pool.query(
      `WITH cand AS (
         SELECT g.po_id
           FROM grn g JOIN purchase_orders po ON po.po_id = g.po_id
          WHERE g.grn_pfx = $1 AND g.grn_no = $2
            AND g.supplier_id = $3
            AND po.supplier_id = $3
            AND g.po_id IS NOT NULL
         UNION
         SELECT g.po_id
           FROM grn g JOIN purchase_orders po ON po.po_id = g.po_id
          WHERE TRIM(g.supplier_doc_no) = $4
            AND g.supplier_id = $3
            AND po.supplier_id = $3
            AND g.po_id IS NOT NULL
         UNION
         SELECT po.po_id
           FROM asn a
           JOIN purchase_orders po
             ON TRIM(po.pfx) = TRIM(a.po_pfx)
            AND TRIM(po.po_number) = TRIM(a.po_no)
            AND po.supplier_id = $3
          WHERE TRIM(a.inv_no) = $4
       )
       SELECT po_id FROM cand GROUP BY po_id`,
      [
        invoice.grn_pfx || '',
        invoice.grn_no || '',
        invoice.supplier_id,
        String(invoice.invoice_number || '').trim()
      ]
    )
    // Only auto-resolve when the traversal collapses to a single PO —
    // multiple candidates means ambiguous, leave po_id NULL.
    if (rows.length === 1) poId = rows[0].po_id
  }

  // E004_NO_SUPPLIER — fires independent of PO resolution. Mirrors Python
  // check_reference_data() which emits E004 alongside E002/E003 when an
  // orphan invoice also has no resolvable supplier. Without this, every
  // no-PO invoice missing a supplier loses the E004 signal.
  if (invoice.supplier_id == null) {
    errors.push('Supplier not identified — invoice has no resolvable supplier link')
  }

  if (!poId) {
    // E002 vs E003 distinction — matches Python check_reference_data():
    //   • Has any text reference (po_number / open_order_no) → E003 (PO
    //     referenced but not loaded in master; usually upstream timing
    //     issue, may arrive in a later sync).
    //   • No reference at all → E002 (invoice never had a PO linked).
    const textRef = invoice.po_number || invoice.open_order_no
    if (textRef) {
      errors.push(`PO not found: invoice references '${textRef}' but it isn't in our master`)
    } else {
      errors.push('Invoice is not linked to any PO or Open Order')
    }
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, isOpenPo: false, reason: errors[0], errors, warnings: [], details }
  }

  if (!invoice.invoice_number || String(invoice.invoice_number).trim() === '') {
    errors.push('Invoice number is missing')
  }
  if (!invoice.invoice_date) {
    details.header.warnings.push('Invoice date is missing')
  }

  // E010_INVOICE_DATE_IN_FUTURE — sanity. A future-dated invoice shouldn't
  // be accepted for payment.
  if (invoice.invoice_date) {
    const invDate = new Date(invoice.invoice_date)
    invDate.setHours(0, 0, 0, 0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (invDate.getTime() > today.getTime()) {
      errors.push(`Invoice date ${invoice.invoice_date} is in the future`)
    }
  }

  const poRes = await pool.query(
    `SELECT po_id, po_number, supplier_id, status, terms, pfx, date AS po_date
       FROM purchase_orders WHERE po_id = $1`,
    [poId]
  )
  if (!poRes.rows[0]) {
    errors.push('PO not found')
    return { valid: false, poAlreadyFulfilled: false, isShortfall: false, isOpenPo: false, reason: errors[0], errors, warnings: [], details }
  }
  const po = poRes.rows[0]
  details.header.po = po

  // Open PO can be tagged at either the PO level (purchase_orders.pfx) OR
  // at the invoice level (invoices.open_order_pfx, populated from the
  // supplier's bill register). Some POs were created in legacy systems
  // with non-OP prefixes (e.g. STP1) but the supplier still raises invoices
  // against an Open Order series — so the invoice carries open_order_pfx
  // even though the PO header doesn't. Either match enables open-PO logic.
  const openPo =
    (await isOpenPoByPfx(po.pfx)) ||
    (await isOpenPoByPfx(invoice.open_order_pfx))

  // PO fulfilled check is now deferred until AFTER cumulative data is loaded
  // (see below). This way we can tell whether the PO is *genuinely* used up
  // by other invoices, vs. just marked fulfilled by this very invoice's
  // earlier validation cycle (status drift).
  const poStatusFulfilledBeforeCumulative = po.status === PO_STATUS.FULFILLED && !openPo

  // E005_SUPPLIER_MISMATCH — matches Python check_header(): only fires when
  // both sides have a supplier_id AND they differ. A null on either side
  // is not E005 — missing invoice supplier is E004 (already raised), and
  // a null po.supplier_id is a master-data gap we don't penalise the
  // invoice for.
  const supplierMatch = invoice.supplier_id != null && po.supplier_id != null && Number(invoice.supplier_id) === Number(po.supplier_id)
  details.header.supplierMatch = supplierMatch
  if (
    invoice.supplier_id != null &&
    po.supplier_id != null &&
    Number(invoice.supplier_id) !== Number(po.supplier_id)
  ) {
    errors.push('Invoice supplier does not match PO supplier')
  }
  if (invoice.po_number && po.po_number && String(invoice.po_number).trim() !== String(po.po_number).trim()) {
    details.header.warnings.push(`Invoice PO number (${invoice.po_number}) does not match PO (${po.po_number})`)
  }

  // E011_INVOICE_BEFORE_PO — invoice predates PO. Common for urgent buys
  // where goods are purchased first and the PO is raised afterward, so this
  // is a WARNING (recorded for visibility), not a blocker. The invoice still
  // validates on the strength of GRN / qty / price / GST checks.
  if (invoice.invoice_date && po.po_date) {
    const invDate = new Date(invoice.invoice_date)
    const poDate  = new Date(po.po_date)
    if (invDate.getTime() < poDate.getTime()) {
      details.header.warnings.push(
        `Invoice date ${String(invoice.invoice_date).slice(0, 10)} is earlier than ` +
        `PO date ${String(po.po_date).slice(0, 10)}`
      )
    }
  }

  const [invLinesRes, poLinesRes, cumul, asnRes, dcRes, schRes, dcSumRes, schSumRes, otherInvQtyRes, otherInvAmtRes, thisInvoiceGrnRes, thisInvoiceSchedRes] = await Promise.all([
    pool.query(
      `SELECT invoice_line_id, po_line_id, sequence_number, billed_qty, weight, count, rate, line_total, item_name,
              taxable_value, cgst_amount, sgst_amount, igst_amount,
              cgst_9_amount, cgst_2_5_amount, sgst_9_amount, sgst_2_5_amount,
              igst_18_amount, igst_5_amount, total_tax_amount
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY sequence_number NULLS LAST, invoice_line_id`,
      [invoiceId]
    ),
    pool.query(
      `SELECT po_line_id, sequence_number, qty, unit_cost, disc_pct, item_id, description1
         FROM purchase_order_lines WHERE po_id = $1 ORDER BY sequence_number`,
      [poId]
    ),
    getCumulativeQuantities(poId),
    // ASN scope MUST be (inv_no = this invoice_number) AND (supplier_id =
    // this invoice's supplier_id). The ASN export's inv_no field is just
    // the supplier's short invoice number (e.g. "10", "118", "127") and
    // collides across suppliers — one inv_no = "127" matches 18 ASN rows
    // across 15 unrelated suppliers. Without the supplier filter, E052/E073
    // over-fire ~4× (V3 dry-run: E052 146 vs Python 36; E073 211 vs 50).
    // ASN doesn't carry supplier_id, so we filter via supplier_name match
    // (mirrors Python context.py).
    pool.query(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(COALESCE(a.quantity, 0)), 0)::numeric AS qty_total
         FROM asn a
         JOIN suppliers s ON LOWER(TRIM(s.supplier_name)) = LOWER(TRIM(a.supplier_name))
        WHERE TRIM(COALESCE(a.inv_no, '')) <> ''
          AND LOWER(TRIM(a.inv_no)) = LOWER(TRIM($1))
          AND s.supplier_id = $2`,
      [String(invoice.invoice_number || '').trim(), invoice.supplier_id]
    ),
    // DC Excel: ORDER NO. → ord_no + po_id when PO exists; OPEN ORDER NO. → open_order_no. TRANSACTION QTY. → dc_qty (sum).
    // Include rows linked by po_id OR by order / open-order number when po_id was null at import (same idea as schedules).
    pool.query(
      `SELECT COUNT(*)::int AS c FROM delivery_challans
       WHERE po_id = $1
          OR (TRIM(COALESCE(ord_no, '')) <> '' AND LOWER(TRIM(ord_no)) = LOWER(TRIM($2)))
          OR (TRIM(COALESCE(open_order_no, '')) <> '' AND LOWER(TRIM(open_order_no)) = LOWER(TRIM($2)))`,
      [poId, po.po_number || '']
    ),
    // Schedule presence count — match by po_id, po_number/doc_no text, OR
    // by the invoice's own (ss_pfx, ss_no) reference. The supplier schedule
    // export has no PO FK, so legacy data only carries ss_pfx/ss_no on the
    // schedule row and on the invoice — matching via those is the only way
    // to know a schedule exists. Without this branch, E074 over-fires on
    // every legitimate scheduled shipment. Mirrors Python load_invoice_context.
    pool.query(
      `SELECT COUNT(*)::int AS c FROM po_schedules
       WHERE po_id = $1
          OR (COALESCE(po_number, '') <> '' AND LOWER(TRIM(po_number)) = LOWER(TRIM($2)))
          OR (COALESCE(doc_no, '') <> '' AND LOWER(TRIM(doc_no)) = LOWER(TRIM($2)))
          OR ($3 <> '' AND $4 <> ''
              AND LOWER(TRIM(COALESCE(ss_pfx, ''))) = LOWER($3)
              AND LOWER(TRIM(COALESCE(ss_no,  ''))) = LOWER($4))`,
      [
        poId,
        po.po_number || '',
        String(invoice.ss_pfx || '').trim(),
        String(invoice.ss_no || '').trim(),
      ]
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
    ),
    // Sum of billed_qty across OTHER invoices for the same PO — used to
    // tell apart "PO genuinely consumed by another invoice" from "PO is
    // marked fulfilled because this invoice's earlier validation drifted
    // the status". Also sums OTHER invoices' total_amount for the E061
    // cumulative-amount check.
    pool.query(
      `SELECT COALESCE(SUM(il.billed_qty), 0)::numeric AS qty
         FROM invoice_lines il
         JOIN invoices i2 ON i2.invoice_id = il.invoice_id
        WHERE i2.po_id = $1 AND i2.invoice_id <> $2`,
      [poId, invoiceId]
    ),
    // Sum of pre-tax (taxable_value) across OTHER invoices on this PO.
    // The previous version summed total_amount and applied a 0.85 heuristic
    // to back into pre-tax, which over-estimates spend when sibling invoices
    // have inflated total_amount with missing taxable_value (a real data
    // quality pattern in this DB — 15 of 47 E061 hits were false positives
    // for that reason, blocking ~10 invoices that should validate).
    // Reading taxable_value directly removes the heuristic.
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(il.taxable_value, 0)), 0)::numeric AS amt
         FROM invoices i2
         JOIN invoice_lines il ON il.invoice_id = i2.invoice_id
        WHERE i2.po_id = $1 AND i2.invoice_id <> $2`,
      [poId, invoiceId]
    ),
    // GRN qty scoped to THIS invoice (matched via supplier_doc_no).
    // Without this scoping, E071 compares this invoice's qty against the
    // cumulative GRN total for the whole open PO (often huge sum across
    // many invoices), producing spurious mismatches on every shipment.
    // Mirrors Python's `this_invoice_grn_accepted_qty_total` in context.py.
    pool.query(
      `SELECT COALESCE(SUM(grn_qty), 0)::numeric AS q,
              COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)), 0)::numeric AS aq
         FROM grn
        WHERE po_id = $1
          AND TRIM(COALESCE(supplier_doc_no, '')) <> ''
          AND LOWER(TRIM(supplier_doc_no)) = LOWER(TRIM($2))`,
      [poId, String(invoice.invoice_number || '')]
    ),
    // Schedule qty scoped to THIS invoice (matched via ss_pfx + ss_no).
    // Cumulative schedule_qty_total across the whole open PO is also
    // not comparable to a single invoice's qty (same bug class as E071).
    invoice.ss_pfx && invoice.ss_no
      ? pool.query(
          `SELECT COALESCE(SUM(sched_qty), 0)::numeric AS q
             FROM po_schedules
            WHERE LOWER(TRIM(COALESCE(ss_pfx, ''))) = LOWER($1)
              AND LOWER(TRIM(COALESCE(ss_no,  ''))) = LOWER($2)`,
          [String(invoice.ss_pfx || '').trim(), String(invoice.ss_no || '').trim()]
        )
      : Promise.resolve({ rows: [{ q: 0 }] })
  ])

  const invLines = invLinesRes.rows
  const poLines = poLinesRes.rows
  const { poQty, grnQty } = cumul
  details.totals.poQty = parseFloat(poQty)
  details.grn.grnQty = parseFloat(grnQty)
  // GRN scoped to THIS invoice (supplier_doc_no = invoice_number) — the same
  // value E071 checks and the Receipts tab shows. grnQty above is the
  // PO-cumulative total (every invoice's GRN on an open PO), which is
  // misleading in the per-invoice "What's different" panel. Surface both so
  // the UI can show the per-invoice figure.
  details.grn.thisInvoiceGrnQty = parseFloat(thisInvoiceGrnRes.rows[0]?.aq ?? 0)
  details.asn.asnCount = parseInt(asnRes.rows[0]?.cnt ?? 0, 10)
  details.asn.asnQty   = parseFloat(asnRes.rows[0]?.qty_total ?? 0)
  const otherInvQty = parseFloat(otherInvQtyRes.rows[0]?.qty ?? 0)
  const dcCount = parseInt(dcRes.rows[0]?.c ?? 0, 10)
  const scheduleCount = parseInt(schRes.rows[0]?.c ?? 0, 10)
  const sumDcQty = parseFloat(dcSumRes.rows[0]?.total ?? 0)
  const sumSchedQty = parseFloat(schSumRes.rows[0]?.total ?? 0)
  details.dcCount = dcCount
  details.scheduleCount = scheduleCount
  details.sumDcQty = sumDcQty
  details.sumSchedQty = sumSchedQty

  // Pre-compute this invoice's total billed_qty so we can evaluate the
  // refined "PO already fulfilled" check before the main validation loop.
  const thisInvQtyTotal = invLines.reduce(
    (acc, il) => acc + (il.billed_qty != null ? parseFloat(il.billed_qty) : 0),
    0
  )

  // Refined PO-fulfilled check: only block when this invoice's qty
  // ACTUALLY exceeds the PO's remaining capacity (po_qty − qty already
  // consumed by OTHER validated invoices). If there's room, the PO being
  // marked 'fulfilled' is just status drift caused by a previous run of
  // *this same* invoice's validation; allow it through.
  const poQtyNumeric = parseFloat(poQty)
  if (poStatusFulfilledBeforeCumulative) {
    const remainingCapacity = poQtyNumeric - otherInvQty
    if (thisInvQtyTotal > remainingCapacity + TOL_QTY) {
      return {
        valid: false,
        poAlreadyFulfilled: true,
        isShortfall: false,
        isOpenPo: false,
        reason:
          `PO already fulfilled and this invoice qty (${thisInvQtyTotal}) exceeds ` +
          `remaining capacity (${remainingCapacity}). Route to exception approval.`,
        errors: ['PO already fulfilled; route to exception approval'],
        warnings: [],
        details
      }
    }
  }

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
    } else {
      // Compute effective PO rate (after contracted discount). Mirrors
      // Python check_lines_and_resolution(): discount comes from
      // purchase_order_lines.disc_pct.
      const poDiscPct = poLine.disc_pct != null ? parseFloat(poLine.disc_pct) : 0
      const effectivePoRate = lineResult.poRate != null
        ? lineResult.poRate * (1 - poDiscPct / 100)
        : null

      if (openPo) {
        lineResult.quantityMatch = null
      } else {
        const qtyMatch = invQty != null && lineResult.poQty != null && Math.abs(invQty - lineResult.poQty) <= TOL_QTY
        lineResult.quantityMatch = qtyMatch
        if (!qtyMatch && invQty != null && lineResult.poQty != null) {
          if (invQty > lineResult.poQty + TOL_QTY) {
            // E021_LINE_QTY_OVER_PO
            lineResult.errors.push(`Line quantity (${invQty}) exceeds PO line qty (${lineResult.poQty})`)
          } else {
            // W020 — under PO qty is a warning, not blocking (matches Python)
            lineResult.warnings.push(`Line quantity (${invQty}) differs from PO line qty (${lineResult.poQty})`)
          }
        }
      }

      // E022_LINE_RATE_MISMATCH — invoice rate vs effective PO rate (with
      // discount applied). Suppliers commonly write the GROSS unit price in
      // the rate field and apply the contracted discount at the line-total
      // level (taxable_value). In that case rate looks like a mismatch even
      // though the discount IS applied — the per-unit effective price comes
      // from taxable_value/qty. Accept either form: the stated rate, or the
      // implied taxable_value/qty rate. ERROR for standard PO, WARNING for
      // Open PO (rate is advisory on blanket agreements). Matches Python.
      if (invRate != null && effectivePoRate != null && effectivePoRate > 0) {
        const invTaxable = il.taxable_value != null ? parseFloat(il.taxable_value) : null
        const invRateFromAmount = (invTaxable != null && invQty != null && invQty > 0)
          ? invTaxable / invQty
          : null
        const ok = (rate) => rate != null && (
          Math.abs(rate - effectivePoRate) <= TOL_AMOUNT ||
          Math.abs(rate - effectivePoRate) / effectivePoRate <= TOL_RATE_PCT
        )
        const rateOk = ok(invRate) || ok(invRateFromAmount)
        const driftAbs = Math.abs(invRate - effectivePoRate)
        const driftRel = driftAbs / effectivePoRate
        lineResult.rateMatch = rateOk
        if (!rateOk) {
          const msg =
            `Line ${i + 1} rate (${invRate}) differs from PO effective rate ` +
            `(${effectivePoRate.toFixed(4)}; unit_cost ${lineResult.poRate} with ${poDiscPct}% disc)`
          if (openPo) {
            lineResult.warnings.push(msg)
          } else {
            lineResult.errors.push(msg)
          }
        }
      }

      // E023_LINE_PRICE_MISMATCH — pre-tax assessable_value vs qty ×
      // effective_rate. Skipped for Open POs (price determined at receipt).
      // Mirrors Python check_lines_and_resolution() line-price block.
      const lineAssbl = il.taxable_value != null ? parseFloat(il.taxable_value) : 0
      if (!openPo && invQty != null && effectivePoRate != null && effectivePoRate > 0 && lineAssbl > 0) {
        const expectedAssbl = invQty * effectivePoRate
        const drift = Math.abs(lineAssbl - expectedAssbl)
        // Python allows 0.01 absolute OR 0.1% relative drift.
        if (drift > TOL_AMOUNT && drift > expectedAssbl * 0.001) {
          lineResult.lineTotalMatch = false
          lineResult.errors.push(
            `Line ${i + 1} assessable_value (${lineAssbl}) does not match ` +
            `qty (${invQty}) × PO effective rate (${effectivePoRate.toFixed(4)}) = ${expectedAssbl.toFixed(2)}`
          )
        } else {
          lineResult.lineTotalMatch = true
        }
      }
    }

    // GST self-consistency at the line level. Mirrors Python check_gst()
    // in email_automation/validation/checks.py.
    const cgstAmt = il.cgst_amount != null ? parseFloat(il.cgst_amount) : 0
    const sgstAmt = il.sgst_amount != null ? parseFloat(il.sgst_amount) : 0
    const igstAmt = il.igst_amount != null ? parseFloat(il.igst_amount) : 0

    // E030/E031/E032 — slab sum mismatch. Only run when slab columns are
    // populated (the bill-register Excel carries them; OCR-loaded rows
    // don't — for those we silently skip, which matches Python).
    const hasCgstSlabs = il.cgst_9_amount != null || il.cgst_2_5_amount != null
    const hasSgstSlabs = il.sgst_9_amount != null || il.sgst_2_5_amount != null
    const hasIgstSlabs = il.igst_18_amount != null || il.igst_5_amount != null
    const cgstSlabSum = (il.cgst_9_amount != null ? parseFloat(il.cgst_9_amount) : 0)
                      + (il.cgst_2_5_amount != null ? parseFloat(il.cgst_2_5_amount) : 0)
    const sgstSlabSum = (il.sgst_9_amount != null ? parseFloat(il.sgst_9_amount) : 0)
                      + (il.sgst_2_5_amount != null ? parseFloat(il.sgst_2_5_amount) : 0)
    const igstSlabSum = (il.igst_18_amount != null ? parseFloat(il.igst_18_amount) : 0)
                      + (il.igst_5_amount != null ? parseFloat(il.igst_5_amount) : 0)
    if (hasCgstSlabs && cgstAmt > 0 && Math.abs(cgstSlabSum - cgstAmt) > TOL_AMOUNT) {
      lineResult.errors.push(
        `Line ${i + 1}: CGST slab sum (${cgstSlabSum.toFixed(2)}) does not match cgst_amount (${cgstAmt})`
      )
    }
    if (hasSgstSlabs && sgstAmt > 0 && Math.abs(sgstSlabSum - sgstAmt) > TOL_AMOUNT) {
      lineResult.errors.push(
        `Line ${i + 1}: SGST slab sum (${sgstSlabSum.toFixed(2)}) does not match sgst_amount (${sgstAmt})`
      )
    }
    if (hasIgstSlabs && igstAmt > 0 && Math.abs(igstSlabSum - igstAmt) > TOL_AMOUNT) {
      lineResult.errors.push(
        `Line ${i + 1}: IGST slab sum (${igstSlabSum.toFixed(2)}) does not match igst_amount (${igstAmt})`
      )
    }

    // E033_CGST_SGST_NOT_EQUAL — Indian GST rule: when both CGST and SGST
    // are charged on a line, they must be equal.
    if (cgstAmt > 0 && sgstAmt > 0 && Math.abs(cgstAmt - sgstAmt) > TOL_AMOUNT) {
      lineResult.errors.push(
        `Line ${i + 1}: CGST (${cgstAmt}) and SGST (${sgstAmt}) must be equal under intra-state GST rules`
      )
    }

    // E034/E035 — intra-state vs inter-state mismatch. Compares the
    // invoice's place_of_supply against the supplier's state_code.
    //
    // Supplier state is derived from (mirrors Python load_invoice_context):
    //   1. The invoice's own GSTIN (first 2 digits) — the authoritative
    //      source for this particular transaction. Multi-state suppliers
    //      commonly bill from a different state than the one on the master
    //      record (e.g. PLASMATEK has Karnataka in master 29… but bills
    //      from TN 33…), so the master state would mis-fire E034/E035 on
    //      every invoice from that secondary registration.
    //   2. suppliers.state_code (master).
    //   3. suppliers.gst_number first 2 digits (final fallback).
    const pos = (invoice.place_of_supply || '').toString().trim()
    const supState = (
      stateCodeFromGstin(invoice.invoice_gstin) ||
      (invoice.supplier_state_code || '').toString().trim() ||
      stateCodeFromGstin(invoice.supplier_gst_number) ||
      ''
    )
    const intraState = pos !== '' && supState !== '' && pos === supState
    if (intraState && igstAmt > 0) {
      lineResult.errors.push(
        `Line ${i + 1}: place_of_supply (${pos}) equals supplier state (${supState}) → intra-state, ` +
        `but charged IGST ${igstAmt}. Supplier must re-issue with CGST + SGST.`
      )
    }
    if (!intraState && pos !== '' && supState !== '' && (cgstAmt > 0 || sgstAmt > 0)) {
      lineResult.errors.push(
        `Line ${i + 1}: place_of_supply (${pos}) differs from supplier state (${supState}) → inter-state, ` +
        `but charged CGST/SGST. Supplier must re-issue with IGST.`
      )
    }

    details.lines.push(lineResult)
  }

  details.totals.thisInvQty = thisInvQty
  details.totals.thisInvAmount = thisInvAmount

  const invMatchesPo = Math.abs(thisInvQty - poQty) <= TOL_QTY
  const invLteGrn = grnQty >= thisInvQty - TOL_QTY
  const invMatchesGrnQty = Math.abs(thisInvQty - grnQty) <= TOL_QTY
  details.grn.invLteGrn = openPo ? invMatchesGrnQty : invLteGrn

  const asnQty = details.asn.asnQty || 0

  if (!openPo) {
    if (!invMatchesPo) {
      if (thisInvQty < poQty - TOL_QTY) {
        // Partial billing is a normal workflow — one PO can be split
        // across multiple invoices (delivery in batches, partial
        // shipments). The invoice validates for what it bills; the PO
        // is correctly marked `partially_fulfilled` by
        // applyStandardValidation. Only emit a warning so finance can
        // still see the PO is under-billed cumulatively, but don't
        // block payment for legitimate partial deliveries.
        const cumulativeQtyForE041 = thisInvQty + otherInvQty
        if (cumulativeQtyForE041 < poQty - TOL_QTY) {
          details.totals.warnings.push(
            `Partial billing: invoice qty (${thisInvQty}) is less than PO total (${poQty}); ` +
            `cumulative across all invoices on this PO (${cumulativeQtyForE041}) still under PO total — PO will be marked partially_fulfilled.`
          )
        }
      } else if (thisInvQty > poQty + TOL_QTY) {
        // E040 — over-billing on a single invoice is a real error.
        details.totals.errors.push(`Invoice total quantity (${thisInvQty}) exceeds PO total (${poQty})`)
      }
      // The exact-match-with-rounding-noise case (within TOL_QTY) is
      // implicitly handled by `invMatchesPo` being true.
    }
    // Standard PO: GRN must exist (E051). The previous check only fired when
    // GRN existed but was short — it silently passed when GRN was missing
    // entirely, letting un-receipted invoices reach payment.
    if (grnQty <= TOL_QTY) {
      details.grn.errors.push(
        'Standard PO: GRN with quantity is required before this invoice can be validated for payment.'
      )
    } else if (!invLteGrn) {
      details.grn.errors.push(
        `GRN total (${grnQty}) is less than invoice quantity (${thisInvQty}). Pay only for what was received.`
      )
    }
    // Standard PO: ASN is optional, but when supplied its qty must match.
    if (details.asn.asnCount > 0 && asnQty > TOL_QTY && Math.abs(thisInvQty - asnQty) > TOL_QTY) {
      details.asn.errors = details.asn.errors || []
      details.asn.errors.push(
        `Standard PO: invoice quantity (${thisInvQty}) does not match ASN total (${asnQty}).`
      )
    }
  }
  if (invoice.total_amount != null && Math.abs(thisInvAmount - parseFloat(invoice.total_amount)) > TOL_AMOUNT) {
    details.totals.warnings.push(`Sum of line totals (${thisInvAmount.toFixed(2)}) differs from invoice total amount (${invoice.total_amount})`)
  }
  // Note: the previous "No ASN found for this PO (informational)" warning
  // for standard PO is intentionally removed — ASN is optional per finance
  // policy, and we no longer surface absence as a flag.

  // E042_HEADER_AMOUNT_OVER_PO + E060/E061 cumulative checks.
  //
  // Cumulative qty / amount across all invoices on this PO (this + others)
  // must not exceed PO limits. Open POs are exempted because they have no
  // fixed qty/value ceiling. Mirrors Python check_cumulative() in
  // email_automation/validation/checks.py.
  if (!openPo) {
    const otherInvAmt = parseFloat(otherInvAmtRes.rows[0]?.amt ?? 0)
    const thisInvPreTax = invLines.reduce(
      (acc, ln) => acc + (ln.taxable_value != null ? parseFloat(ln.taxable_value) : 0),
      0
    )
    const poValueComputed = poLines.reduce((sum, l) => {
      const q = l.qty != null ? parseFloat(l.qty) : 0
      const r = l.unit_cost != null ? parseFloat(l.unit_cost) : 0
      const d = l.disc_pct != null ? parseFloat(l.disc_pct) : 0
      return sum + q * r * (1 - d / 100)
    }, 0)

    // E042 — this invoice's pre-tax total alone exceeds the PO computed
    // value. Hard block; supplier needs to issue a corrected invoice.
    if (poValueComputed > 0 && thisInvPreTax > poValueComputed + TOL_AMOUNT) {
      details.totals.errors.push(
        `Invoice pre-tax total (${thisInvPreTax.toFixed(2)}) exceeds PO value (${poValueComputed.toFixed(2)})`
      )
    }

    const cumulativeQty = otherInvQty + thisInvQty
    if (poQty > 0 && cumulativeQty > poQty + TOL_QTY) {
      details.totals.errors.push(
        `Cumulative invoiced qty (${cumulativeQty.toFixed(2)}) exceeds PO qty (${poQty.toFixed(2)})`
      )
    }

    // Cumulative pre-tax check using real Σ(taxable_value) of sibling
    // invoices. The previous 0.85 heuristic on total_amount over-estimated
    // sibling spend whenever sibling invoices had inflated total_amount
    // with missing taxable_value, blocking 10+ invoices that legitimately
    // fit inside the PO budget.
    if (poValueComputed > 0) {
      const remainingBudget = poValueComputed - otherInvAmt
      if (remainingBudget > 0 && thisInvPreTax > remainingBudget + TOL_AMOUNT) {
        details.totals.errors.push(
          `Cumulative pre-tax invoiced amount exceeds PO value ` +
          `(this invoice pre-tax=${thisInvPreTax.toFixed(2)}, remaining budget=${remainingBudget.toFixed(2)})`
        )
      }
    }
  }

  if (openPo) {
    // Use the THIS-invoice-scoped GRN total. The cumulative grnQty above
    // spans every invoice ever drawn against this open PO — comparing it
    // to a single invoice's qty produces spurious mismatches (this was
    // the original E071 bug Python already fixed). Match supplier_doc_no
    // = invoice_number to scope.
    const thisInvGrnAcceptedQty = parseFloat(thisInvoiceGrnRes.rows[0]?.aq ?? 0)
    if (thisInvGrnAcceptedQty <= TOL_QTY) {
      errors.push('Open PO: GRN with quantity is required for this invoice.')   // E070
    } else if (Math.abs(thisInvQty - thisInvGrnAcceptedQty) > TOL_QTY) {
      details.grn.errors.push(                                                    // E071
        `Open PO: invoice quantity (${thisInvQty}) must match GRN total for this invoice (${thisInvGrnAcceptedQty}).`
      )
    }
    // Open PO: ASN is optional. Validate qty match only when ASN exists.
    if (details.asn.asnCount > 0 && asnQty > TOL_QTY && Math.abs(thisInvQty - asnQty) > TOL_QTY) {
      details.asn.errors = details.asn.errors || []
      details.asn.errors.push(                                                    // E073
        `Open PO: invoice quantity (${thisInvQty}) must match ASN total (${asnQty}).`
      )
    }
    if (dcCount === 0 && scheduleCount === 0) {
      errors.push('Open PO: at least one Delivery Challan or Schedule record must exist for this purchase order.')   // E074
    }
    // E075 — DC is a ceiling, not an exact match. One Open-PO order can be
    // drawn down by multiple invoices until the cumulative DC qty is met, so
    // an individual invoice only fails when it BILLS MORE than the DC total.
    // Being under is normal (more invoices will follow). Only GRN (E071) is
    // an exact match.
    if (dcCount > 0 && sumDcQty > TOL_QTY && thisInvQty > sumDcQty + TOL_QTY) {
      errors.push(                                                                // E075
        `Open PO: invoice quantity (${thisInvQty}) exceeds Delivery Challan total (${sumDcQty}).`
      )
    }
    // E076 — Schedule is also a ceiling, not an exact match (same multi-draw
    // reasoning as DC). Scope to THIS invoice's (ss_pfx, ss_no). Fails only
    // when the invoice qty exceeds the scheduled qty.
    const thisInvSchedQty = parseFloat(thisInvoiceSchedRes.rows[0]?.q ?? 0)
    if (scheduleCount > 0 && thisInvSchedQty > TOL_QTY && thisInvQty > thisInvSchedQty + TOL_QTY) {
      errors.push(
        `Open PO: invoice quantity (${thisInvQty}) exceeds Schedule total for this invoice (${thisInvSchedQty}).`
      )
    }
  }

  const allLineErrors = details.lines.flatMap(l => l.errors)
  // details.asn.errors holds E052 (Standard PO ASN qty mismatch) and E073
  // (Open PO ASN qty mismatch). Without this aggregation those rules fire
  // inside the engine but never surface to the caller, so the Reconciliation
  // page and dry-run script both see 0 — even though Python finds 36 / 50.
  const allAsnErrors = Array.isArray(details.asn.errors) ? details.asn.errors : []
  const totalErrors = [...details.totals.errors, ...details.grn.errors, ...allLineErrors, ...allAsnErrors]
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
      thisInvoiceGrnQty: full.details.grn?.thisInvoiceGrnQty,
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
    `SELECT po_id, invoice_date, open_order_pfx FROM invoices WHERE invoice_id = $1`,
    [invoiceId]
  )
  if (!inv.rows[0]) throw new Error('Invoice not found')
  const { po_id, invoice_date, open_order_pfx } = inv.rows[0]
  const pfxRow = await client.query(`SELECT pfx FROM purchase_orders WHERE po_id = $1`, [po_id])
  // Defend against direct callers — Open PO can be tagged at PO level OR at
  // invoice level (legacy POs with non-OP prefixes carry open_order_pfx
  // from the supplier's bill register).
  if (
    (await isOpenPoByPfx(pfxRow.rows[0]?.pfx, client)) ||
    (await isOpenPoByPfx(open_order_pfx, client))
  ) {
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
  // Mark the PO based on cumulative invoiced qty vs PO total qty.
  //   cumulative >= total  →  'fulfilled'
  //   0 < cumulative < total  →  'partially_fulfilled'
  //   cumulative == 0  →  leave existing status (this case shouldn't reach
  //                       here since we just validated an invoice, but the
  //                       guard prevents accidentally clobbering admin-set
  //                       statuses if data is missing).
  // The previous code unconditionally set 'fulfilled' which caused status
  // drift on multi-invoice POs and spurious E006 firings on re-validation.
  const { rows: statusRows } = await client.query(
    `WITH po_total AS (
       SELECT COALESCE(SUM(qty), 0)::numeric AS qty
       FROM purchase_order_lines WHERE po_id = $1
     ),
     invoiced AS (
       SELECT COALESCE(SUM(il.billed_qty), 0)::numeric AS qty
       FROM invoice_lines il
       JOIN invoices i ON i.invoice_id = il.invoice_id
       WHERE i.po_id = $1 AND i.status = $2
     )
     UPDATE purchase_orders po SET status = CASE
       WHEN (SELECT qty FROM po_total) > 0
            AND (SELECT qty FROM invoiced) >= (SELECT qty FROM po_total) - 0.001
         THEN $3
       WHEN (SELECT qty FROM invoiced) > 0
         THEN $4
       ELSE po.status
     END
     WHERE po.po_id = $1
     RETURNING status`,
    [po_id, INVOICE_STATUS.VALIDATED, PO_STATUS.FULFILLED, PO_STATUS.PARTIALLY_FULFILLED]
  )
  const newPoStatus = statusRows[0]?.status ?? PO_STATUS.OPEN
  return { invoiceStatus: INVOICE_STATUS.VALIDATED, paymentDueDate, poStatus: newPoStatus }
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
    `UPDATE purchase_orders SET status = $1 WHERE po_id = $2`,
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
 * Admin override approval — manually mark an invoice `validated` despite
 * unresolved validation errors. Used from the Needs Attention page when
 * the user has reviewed the blockers (rate/qty/supplier mismatches etc.)
 * and accepts them as legitimate. Sets payment_due_date from PO terms
 * exactly like a normal validation, so the invoice flows straight into
 * the approval queue.
 *
 * No engine call — we trust the human override. The validation_errors
 * JSONB is preserved as-is for audit, but `manual_override_at` /
 * `manual_override_by` columns (auto-created on first call) record who
 * unstuck the invoice.
 */
export async function adminOverrideApprove(client, invoiceId, actor) {
  const inv = await client.query(
    `SELECT po_id, invoice_date FROM invoices WHERE invoice_id = $1`,
    [invoiceId]
  )
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
  // Auto-create the override columns on first call so installs don't
  // need a separate migration step (same idiom as validation_errors).
  try {
    await client.query(`
      ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS manual_override_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS manual_override_by  TEXT,
        ADD COLUMN IF NOT EXISTS manual_override_note TEXT
    `)
  } catch (err) {
    // Non-fatal — column add may fail under stricter perms; the UPDATE
    // below will surface the real error if columns truly aren't there.
  }
  await client.query(
    `UPDATE invoices
        SET status = $1,
            payment_due_date = $2,
            manual_override_at = NOW(),
            manual_override_by = $3,
            manual_override_note = $4,
            updated_at = NOW()
      WHERE invoice_id = $5`,
    [
      INVOICE_STATUS.VALIDATED,
      paymentDueDate,
      actor?.label || null,
      actor?.note  || null,
      invoiceId,
    ]
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
/**
 * Map a plain-string validation error to a short rule code (E001…E076).
 *
 * The engine pushes free-text errors like `'Invoice supplier does not match
 * PO supplier'`, but the Reconciliation page aggregates by short rule
 * code — so we have to bridge the two here. Order matters: more specific
 * patterns first.
 */
function classifyErrorToCode(msg) {
  if (!msg) return null
  const s = String(msg).toLowerCase()
  // ---- Open-PO specific (must come before generic GRN/PO checks) ----
  // E070 must precede E071 because the E070 message ("GRN with quantity is
  // required") contains the word "quantity" and would otherwise be
  // misclassified as E071. Anchor E070 on the unique word "required".
  if (s.startsWith('open po') && s.includes('grn') && s.includes('required'))             return 'E070'
  if (s.startsWith('open po') && s.includes('grn') && s.includes('quantity'))             return 'E071'
  if (s.startsWith('open po') && s.includes('grn'))                                        return 'E070'
  if (s.startsWith('open po') && s.includes('asn'))                                        return 'E073'
  if (s.startsWith('open po') && s.includes('challan') && s.includes('schedule'))         return 'E074'
  if (s.startsWith('open po') && s.includes('challan'))                                   return 'E075'
  if (s.startsWith('open po') && s.includes('schedule'))                                  return 'E076'
  // ---- Cumulative (must come before generic header checks) ----
  if (s.includes('cumulative') && s.includes('qty'))                                      return 'E060'
  if (s.includes('cumulative') && (s.includes('amount') || s.includes('pre-tax')))        return 'E061'
  // ---- Header / reference ----
  if (s.includes('invoice number') && s.includes('missing'))                              return 'E001'
  // E003 takes precedence over E002: invoices referencing a PO that
  // doesn't exist in master use the "po not found" wording with a text
  // reference; truly-no-PO invoices use "not linked to any PO or Open Order".
  if (s.includes('po not found') || s.startsWith('po not found'))                         return 'E003'
  if (s.includes('not linked to any po') || s.includes('not linked to a po'))             return 'E002'
  if (s.includes('supplier not identified') || s.includes('no resolvable supplier'))      return 'E004'
  if (s.includes('supplier does not match'))                                              return 'E005'
  if (s.includes('po already fulfilled') || s.includes('po is fulfilled'))                return 'E006'
  // ---- Date ----
  if (s.includes('invoice date') && s.includes('future'))                                 return 'E010'
  if (s.includes('invoice date') && s.includes('earlier than') && s.includes('po date'))  return 'E011'
  // ---- Line ----
  if (s.includes('no matching po line'))                                                  return 'E020'
  if (s.includes('line') && s.includes('quantity') && s.includes('exceeds'))              return 'E021'
  // E023 must be checked BEFORE E022 because "assessable_value … qty × PO
  // effective rate" contains the word "rate" and would otherwise be
  // misclassified as E022.
  if (s.includes('assessable_value'))                                                     return 'E023'
  if (s.includes('line total') && s.includes('does not match'))                           return 'E023'
  if (s.includes('line') && s.includes('rate'))                                           return 'E022'
  // ---- GST ----
  if (s.includes('cgst slab sum'))                                                        return 'E030'
  if (s.includes('sgst slab sum'))                                                        return 'E031'
  if (s.includes('igst slab sum'))                                                        return 'E032'
  if (s.includes('cgst') && s.includes('sgst') && s.includes('must be equal'))            return 'E033'
  if (s.includes('intra-state') && s.includes('igst'))                                    return 'E034'
  if (s.includes('inter-state') && (s.includes('cgst') || s.includes('sgst')))            return 'E035'
  // ---- Header totals ----
  if (s.includes('invoice total quantity') && s.includes('exceeds'))                      return 'E040'
  if (s.includes('invoice total quantity') && (s.includes('less than') || s.includes('does not match'))) return 'E041'
  if (s.includes('invoice total') && s.includes('exceeds') && s.includes('po'))           return 'E042'
  if (s.includes('invoice pre-tax total') && s.includes('exceeds') && s.includes('po'))   return 'E042'
  if (s.includes('sum of line totals'))                                                   return 'E042'
  // ---- GRN ----
  if (s.includes('grn') && (s.includes('shortfall') || s.includes('less than')))          return 'E050'
  if (s.includes('grn') && s.includes('required'))                                        return 'E051'
  // E052: Standard PO ASN qty mismatch. Distinct from E073 (Open PO + ASN)
  // by the "standard po" prefix. Matches the message emitted in
  // runFullValidation's standard-PO branch.
  if (s.startsWith('standard po') && s.includes('asn') && s.includes('does not match'))   return 'E052'
  return null
}

/**
 * Persist a flattened `{errors, warnings}` payload into
 * `invoices.validation_errors` (JSONB) so the Reconciliation page can
 * aggregate by rule code without re-running the engine.
 *
 * The column is auto-created on first write — keeps deployments
 * migration-free for installs that haven't applied the optional
 * `migration_validation_errors_column.sql`.
 */
async function persistValidationResults(client, invoiceId, errors, warnings) {
  // Auto-create the column once per process. Idempotent.
  try {
    await client.query(
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS validation_errors JSONB`
    )
  } catch (err) {
    console.warn('persistValidationResults: ADD COLUMN failed (non-fatal):', err.message)
  }
  const payload = {
    errors: (errors || []).map((m) => ({ code: classifyErrorToCode(m) || 'EXXX', message: m })),
    warnings: (warnings || []).map((m) => ({ code: classifyErrorToCode(m) || 'EXXX', message: m })),
    computed_at: new Date().toISOString()
  }
  try {
    await client.query(
      `UPDATE invoices SET validation_errors = $1::jsonb WHERE invoice_id = $2`,
      [JSON.stringify(payload), invoiceId]
    )
  } catch (err) {
    console.warn('persistValidationResults: UPDATE failed (non-fatal):', err.message)
  }
}

export async function validateAndUpdateInvoiceStatus(invoiceId) {
  const result = await validateInvoiceAgainstPoGrn(invoiceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Persist whatever the engine produced so the Reconciliation page can
    // aggregate by rule code without re-running validation. Runs inside
    // the same txn as the status update so the two never drift.
    await persistValidationResults(client, invoiceId, result.errors, result.warnings)
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

    // Any other invalid outcome (errors present but not classified as
    // shortfall / fulfilled / open-PO failure) — e.g. E001/E002/E003/E004
    // /E010/E011/E022/E033/E034/E060 etc. — demote the invoice to
    // waiting_for_re_validation. Previously the function fell through with
    // `action: 'none'`, which left previously-validated invoices stuck on
    // the wrong status when a new rule caught them on re-run.
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      await client.query(
        `UPDATE invoices SET status = $1, payment_due_date = NULL, updated_at = NOW() WHERE invoice_id = $2`,
        [INVOICE_STATUS.WAITING_FOR_RE_VALIDATION, invoiceId]
      )
      await client.query('COMMIT')
      return {
        action: 'errors',
        invoiceStatus: INVOICE_STATUS.WAITING_FOR_RE_VALIDATION,
        reason: result.reason || result.errors[0],
        errors: result.errors,
        warnings: result.warnings
      }
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
