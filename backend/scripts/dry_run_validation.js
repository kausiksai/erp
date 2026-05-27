// Dry-run validator — read-only simulation. For each invoice currently in
// a pending status, call runFullValidation() and tally the outcome.
// Nothing is written back; this only reports what would happen if the
// admin clicked "Re-run engine" right now.
//
// Run: node scripts/dry_run_validation.js
//   (must be run from erp/backend, with the same .env loaded that the
//   backend uses, since we re-use db.js)

import 'dotenv/config'
import { pool } from '../src/db.js'
import { runFullValidation, isOpenPoByPfx } from '../src/poInvoiceValidation.js'

// AWS RDS occasionally drops idle TCP connections mid-run. Without this
// handler pg-pool's 'error' event is unhandled and Node crashes 8 minutes
// in. The next runFullValidation will checkout a fresh client.
pool.on('error', (err) => {
  console.warn('  ! pool client error (idle TCP drop, ignoring):', err.message)
})

// Mirror Python's sweeper scope: every pending status PLUS already-validated
// invoices that haven't been approved for payment yet (since rules may
// have tightened since their last validation). Locked rows
// (ready_for_payment, paid, rejected, validated with a payment_approval)
// are excluded — human action has already cleared their gate.
const ELIGIBLE_STATUSES = [
  'waiting_for_validation',
  'waiting_for_re_validation',
  'exception_approval',
  'debit_note_approval',
  'validated'
]

async function main() {
  const startedAt = Date.now()
  const { rows } = await pool.query(
    `SELECT i.invoice_id FROM invoices i
      LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
      WHERE i.status = ANY($1::text[])
        AND (i.status <> 'validated' OR pa.id IS NULL)
      ORDER BY i.invoice_id ASC`,
    [ELIGIBLE_STATUSES]
  )
  console.log(`\nDry-running validator on ${rows.length} pending invoices…\n`)

  const tally = {
    would_validate: 0,
    would_exception_approval: 0,
    would_shortfall: 0,    // demoted to waiting_for_re_validation due to GRN/qty mismatch
    would_other_invalid: 0, // demoted due to non-shortfall errors (E001/E002/E003/etc.)
    error_count_by_code: new Map(),
    failed_to_run: 0
  }

  let i = 0
  for (const { invoice_id } of rows) {
    i++
    if (i % 200 === 0) {
      process.stdout.write(`  …${i}/${rows.length}\r`)
    }
    try {
      const r = await runFullValidation(invoice_id)
      if (r.valid) {
        tally.would_validate++
      } else if (r.poAlreadyFulfilled) {
        tally.would_exception_approval++
      } else if (r.isShortfall) {
        tally.would_shortfall++
      } else {
        tally.would_other_invalid++
      }
      // Always count error codes — even on "valid" invoices we may have
      // emitted warnings; here we only tally errors so the table mirrors
      // the validation_errors->'errors' set.
      const codes = new Set()
      for (const msg of r.errors || []) {
        const code = classify(msg)
        if (code) codes.add(code)
      }
      for (const code of codes) {
        tally.error_count_by_code.set(code, (tally.error_count_by_code.get(code) || 0) + 1)
      }
    } catch (err) {
      tally.failed_to_run++
      console.warn(`  ! invoice ${invoice_id} threw:`, err.message)
    }
  }

  // Suppress unused-import warning — keep isOpenPoByPfx in scope for ad-hoc
  // probes if you want to drill in to a specific invoice from this script.
  void isOpenPoByPfx

  const tookSec = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log(`\nDone in ${tookSec}s.\n`)
  console.log(`============= PROJECTED OUTCOMES =============`)
  console.log(`Would validate (status='validated'):           ${tally.would_validate}`)
  console.log(`Would move to exception_approval:              ${tally.would_exception_approval}`)
  console.log(`Would move to waiting_for_re_validation`)
  console.log(`  …via shortfall heuristic:                   ${tally.would_shortfall}`)
  console.log(`  …via other invalid (E001/E002/etc.):        ${tally.would_other_invalid}`)
  console.log(`Failed to evaluate (engine threw):             ${tally.failed_to_run}`)
  console.log(`-----`)
  console.log(`Total pending:                                 ${rows.length}`)

  console.log(`\n============= ERRORS BY CODE =============`)
  const sorted = [...tally.error_count_by_code.entries()].sort((a, b) => b[1] - a[1])
  for (const [code, n] of sorted) {
    console.log(`  ${code.padEnd(6)} ${String(n).padStart(5)}`)
  }

  await pool.end()
}

// Inline classifier — mirrors poInvoiceValidation.js classifyErrorToCode().
// Duplicated here so this script doesn't depend on internal exports.
function classify(msg) {
  if (!msg) return null
  const s = String(msg).toLowerCase()
  // E070 ("GRN with quantity is required") contains "quantity" — without
  // anchoring on "required" first it gets misclassified as E071. Order matters.
  if (s.startsWith('open po') && s.includes('grn') && s.includes('required'))            return 'E070'
  if (s.startsWith('open po') && s.includes('grn') && s.includes('quantity'))            return 'E071'
  if (s.startsWith('open po') && s.includes('grn'))                                       return 'E070'
  if (s.startsWith('open po') && s.includes('asn'))                                       return 'E073'
  if (s.startsWith('open po') && s.includes('challan') && s.includes('schedule'))         return 'E074'
  if (s.startsWith('open po') && s.includes('challan'))                                   return 'E075'
  if (s.startsWith('open po') && s.includes('schedule'))                                  return 'E076'
  if (s.includes('cumulative') && s.includes('qty'))                                      return 'E060'
  if (s.includes('cumulative') && (s.includes('amount') || s.includes('pre-tax')))        return 'E061'
  if (s.includes('invoice number') && s.includes('missing'))                              return 'E001'
  if (s.includes('po not found') || s.startsWith('po not found'))                         return 'E003'
  if (s.includes('not linked to any po') || s.includes('not linked to a po'))             return 'E002'
  if (s.includes('supplier not identified') || s.includes('no resolvable supplier'))      return 'E004'
  if (s.includes('supplier does not match'))                                              return 'E005'
  if (s.includes('po already fulfilled') || s.includes('po is fulfilled'))                return 'E006'
  if (s.includes('invoice date') && s.includes('future'))                                 return 'E010'
  if (s.includes('invoice date') && s.includes('earlier than') && s.includes('po date'))  return 'E011'
  if (s.includes('no matching po line'))                                                  return 'E020'
  if (s.includes('line') && s.includes('quantity') && s.includes('exceeds'))              return 'E021'
  if (s.includes('assessable_value'))                                                     return 'E023'
  if (s.includes('line total') && s.includes('does not match'))                           return 'E023'
  if (s.includes('line') && s.includes('rate'))                                           return 'E022'
  if (s.includes('cgst slab sum'))                                                        return 'E030'
  if (s.includes('sgst slab sum'))                                                        return 'E031'
  if (s.includes('igst slab sum'))                                                        return 'E032'
  if (s.includes('cgst') && s.includes('sgst') && s.includes('must be equal'))            return 'E033'
  if (s.includes('intra-state') && s.includes('igst'))                                    return 'E034'
  if (s.includes('inter-state') && (s.includes('cgst') || s.includes('sgst')))            return 'E035'
  if (s.includes('invoice total quantity') && s.includes('exceeds'))                      return 'E040'
  if (s.includes('invoice total quantity') && (s.includes('less than') || s.includes('does not match'))) return 'E041'
  if (s.includes('invoice total') && s.includes('exceeds') && s.includes('po'))           return 'E042'
  if (s.includes('invoice pre-tax total') && s.includes('exceeds') && s.includes('po'))   return 'E042'
  if (s.includes('sum of line totals'))                                                   return 'E042'
  if (s.includes('grn') && (s.includes('shortfall') || s.includes('less than')))          return 'E050'
  if (s.includes('grn') && s.includes('required'))                                        return 'E051'
  if (s.startsWith('standard po') && s.includes('asn') && s.includes('does not match'))   return 'E052'
  return 'EXXX'
}

main().catch((err) => {
  console.error('Dry-run failed:', err)
  process.exitCode = 1
})
