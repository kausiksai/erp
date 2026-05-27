// How many waiting_for_re_validation invoices have E061 as their ONLY
// blocking error? Those would all validate if we fixed E061.
// Also: replace the 0.85 heuristic with the actual Σ(taxable_value)
// of other invoices on the PO and see how many E061 hits remain.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

// 1) Distribution: how many waiting invoices have just one error?
const { rows: errorCounts } = await pool.query(`
  WITH per_inv AS (
    SELECT i.invoice_id,
           COUNT(*) AS err_n,
           jsonb_agg(DISTINCT split_part(e->>'code','_',1)) AS codes
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
     GROUP BY i.invoice_id
  )
  SELECT err_n, COUNT(*)::int AS invoices
    FROM per_inv
   GROUP BY err_n
   ORDER BY err_n
`)
console.log('Stuck invoices by # of distinct error codes:')
for (const r of errorCounts) console.log(`  ${r.err_n} error(s)  → ${r.invoices} invoices`)

// 2) Invoices whose ONLY error is E061
const { rows: e061only } = await pool.query(`
  WITH per_inv AS (
    SELECT i.invoice_id,
           array_agg(DISTINCT split_part(e->>'code','_',1) ORDER BY split_part(e->>'code','_',1)) AS codes
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
     GROUP BY i.invoice_id
  )
  SELECT COUNT(*)::int AS n
    FROM per_inv
   WHERE codes = ARRAY['E061']
`)
console.log(`\nInvoices whose ONLY blocking error is E061: ${e061only[0].n}`)

// 3) Re-evaluate E061 using ACTUAL Σ(taxable_value) of other invoices
const { rows: e061inv } = await pool.query(`
  SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id
    FROM invoices i,
         LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
   WHERE i.status = 'waiting_for_re_validation'
     AND split_part(e->>'code','_',1) = 'E061'
`)
console.log(`\nRe-checking all ${e061inv.length} E061 hits with actual pre-tax sum (no heuristic):`)

let truePositives = 0
let falsePositives = 0
const examples = []

for (const inv of e061inv) {
  const [{ rows: thisPretaxRows }, { rows: otherPretaxRows }, { rows: poValRows }] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(taxable_value, 0)), 0)::numeric AS p
         FROM invoice_lines WHERE invoice_id = $1`,
      [inv.invoice_id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(COALESCE(il.taxable_value, 0)), 0)::numeric AS p
         FROM invoices i2
         JOIN invoice_lines il ON il.invoice_id = i2.invoice_id
        WHERE i2.po_id = $1 AND i2.invoice_id <> $2`,
      [inv.po_id, inv.invoice_id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(qty * unit_cost * (1 - COALESCE(disc_pct,0)/100.0)), 0)::numeric AS v
         FROM purchase_order_lines WHERE po_id = $1`,
      [inv.po_id]
    ),
  ])
  const thisPretax = Number(thisPretaxRows[0]?.p) || 0
  const otherPretax = Number(otherPretaxRows[0]?.p) || 0
  const poVal = Number(poValRows[0]?.v) || 0
  const remaining = poVal - otherPretax
  const wouldFire = remaining > 0 && thisPretax > remaining + 0.01
  if (wouldFire) {
    truePositives += 1
  } else {
    falsePositives += 1
    if (examples.length < 8) {
      examples.push({
        invoice_id: inv.invoice_id,
        invoice_number: inv.invoice_number,
        thisPretax: thisPretax.toFixed(2),
        otherPretax: otherPretax.toFixed(2),
        poVal: poVal.toFixed(2),
        remaining: remaining.toFixed(2),
      })
    }
  }
}

console.log(`  would still fire (real over-budget): ${truePositives}`)
console.log(`  would clear (heuristic false pos)  : ${falsePositives}`)
if (examples.length > 0) {
  console.log('\nExamples that would clear:')
  for (const e of examples) {
    console.log(`  ${e.invoice_number} (id ${e.invoice_id}): this=${e.thisPretax}, other=${e.otherPretax}, po=${e.poVal}, remaining=${e.remaining}`)
  }
}

await pool.end()
