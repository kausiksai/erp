// Deep audit of remaining line rate / price / discount mismatches.
// Looks for patterns beyond what the recent fixes already cover:
//   1. Tax-inclusive invoice rate (rate × qty ≈ taxable × (1 + GST%))
//   2. Per-piece vs per-package qty (dozen / box / pack multiples)
//   3. Consistent % drift across the line (e.g. all off by 18% → wrong tax handling)
//   4. PO disc_pct present but invoice billed gross (real error)
//   5. Invoice discount field present but engine doesn't read it
//   6. Multi-tier qty pricing (multiple PO lines for same item at different rates)
//   7. Negative-rate "discount" lines (some suppliers add a discount line)
//   8. Rate-vs-amount asymmetry (rate matches but qty × rate ≠ taxable, hinting at a separate per-line discount)
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

// invoice_lines column inventory — see if there's a discount field we miss
const ilCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='invoice_lines' ORDER BY ordinal_position`)
console.log('=== invoice_lines columns ===')
console.log(ilCols.rows.map(r=>r.column_name).join(', '))

const invsWith = async (code) => (await pool.query(`
  SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id
    FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
   WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1) = $1`, [code])).rows

const e022Invs = await invsWith('E022')
const e023Invs = await invsWith('E023')
console.log(`\nE022 invoices: ${e022Invs.length}, E023 invoices: ${e023Invs.length}`)
const e022Ids = new Set(e022Invs.map(v => v.invoice_id))
const e023Ids = new Set(e023Invs.map(v => v.invoice_id))
const both = [...e022Ids].filter(id => e023Ids.has(id))
const onlyE022 = [...e022Ids].filter(id => !e023Ids.has(id))
const onlyE023 = [...e023Ids].filter(id => !e022Ids.has(id))
console.log(`E022 only: ${onlyE022.length}, E023 only: ${onlyE023.length}, BOTH: ${both.length}`)

// Pattern detector: classify each E022 invoice
const buckets = { taxInclusive:0, qtyMultiple:0, gstDrift:0, billedGross:0, negativeOrZero:0, rateMatchesAmtMismatch:0, manyDecimals:0, multiTier:0, real:0 }
const examples = { taxInclusive:[], qtyMultiple:[], gstDrift:[], billedGross:[], multiTier:[], rateMatchesAmtMismatch:[] }

for (const v of e022Invs) {
  if (!v.po_id) { buckets.real++; continue }
  const lines = await pool.query(`
    SELECT il.invoice_line_id AS id, il.rate AS inv_rate, il.billed_qty AS inv_qty, il.taxable_value, il.cgst_amount, il.sgst_amount, il.igst_amount,
           pol.po_line_id, pol.unit_cost AS po_rate, COALESCE(pol.disc_pct,0) AS disc, pol.qty AS po_qty
      FROM invoice_lines il LEFT JOIN purchase_order_lines pol ON pol.po_line_id=il.po_line_id
     WHERE il.invoice_id=$1 AND il.rate IS NOT NULL`, [v.invoice_id])

  const polines = await pool.query(`
    SELECT po_line_id, unit_cost AS po_rate, COALESCE(disc_pct,0) AS disc, qty
      FROM purchase_order_lines WHERE po_id=$1`, [v.po_id])

  let classified = 'real'
  for (const ln of lines.rows) {
    const inv = Number(ln.inv_rate); if (!inv) continue
    const q = Number(ln.inv_qty), taxable = Number(ln.taxable_value)
    // Default best PO line (highest unit_cost match — for diagnostic only). Real eff calc uses joined po_line.
    const eff = ln.po_rate != null ? Number(ln.po_rate) * (1 - Number(ln.disc)/100) : null
    if (eff == null || eff <= 0) continue
    const driftPct = Math.abs(inv - eff) / eff
    const taxTotal = (Number(ln.cgst_amount)||0) + (Number(ln.sgst_amount)||0) + (Number(ln.igst_amount)||0)
    const taxRate = taxable > 0 ? taxTotal/taxable : 0  // 0.18 for 18% GST

    // 1. tax-inclusive: inv ≈ eff × (1 + taxRate)
    if (taxRate > 0.01 && Math.abs(inv - eff * (1 + taxRate)) / eff <= 0.02) {
      classified = 'taxInclusive'
      if (examples.taxInclusive.length<3) examples.taxInclusive.push({inv:v.invoice_number, inv_rate:inv, po_eff:eff.toFixed(2), gst:Math.round(taxRate*100)+'%', would_be_incl:(eff*(1+taxRate)).toFixed(2)})
      break
    }
    // 2. qty multiple: inv ≈ eff × k for k in {2,3,4,5,6,8,10,12,24}
    for (const k of [2,3,4,5,6,8,10,12,24]) {
      if (Math.abs(inv - eff*k)/eff <= 0.02) { classified='qtyMultiple'; if (examples.qtyMultiple.length<3) examples.qtyMultiple.push({inv:v.invoice_number, inv_rate:inv, po_eff:eff.toFixed(2), factor:k}); break }
      if (Math.abs(inv*k - eff)/eff <= 0.02) { classified='qtyMultiple'; if (examples.qtyMultiple.length<3) examples.qtyMultiple.push({inv:v.invoice_number, inv_rate:inv, po_eff:eff.toFixed(2), factor:'1/'+k}); break }
    }
    if (classified !== 'real') break

    // 3. rate matches gross PO unit_cost (supplier ignored contracted discount)
    if (ln.disc > 0 && Math.abs(inv - Number(ln.po_rate))/Number(ln.po_rate) <= 0.01) {
      classified = 'billedGross'
      if (examples.billedGross.length<3) examples.billedGross.push({inv:v.invoice_number, inv_rate:inv, po_unit_cost:Number(ln.po_rate), disc:Number(ln.disc)+'%'})
      break
    }

    // 4. rate matches eff but taxable doesn't (line has extra discount unrecorded)
    if (driftPct <= 0.01 && q > 0 && taxable > 0 && Math.abs(taxable - q*eff)/(q*eff) > 0.01) {
      classified = 'rateMatchesAmtMismatch'
      if (examples.rateMatchesAmtMismatch.length<3) examples.rateMatchesAmtMismatch.push({inv:v.invoice_number, inv_rate:inv, po_eff:eff.toFixed(2), q, taxable, expected:(q*eff).toFixed(2)})
      break
    }

    // 5. multi-tier: multiple PO lines have similar item match, different rates
    const sameItem = polines.rows.filter(p => Math.abs(Number(p.po_rate)*(1-Number(p.disc)/100) - inv)/inv <= 0.01)
    if (sameItem.length > 0 && (!ln.po_line_id || !sameItem.find(p => String(p.po_line_id)===String(ln.po_line_id)))) {
      classified = 'multiTier'
      if (examples.multiTier.length<3) examples.multiTier.push({inv:v.invoice_number, inv_rate:inv, picked_eff:eff.toFixed(2), tier_matches:sameItem.length})
      break
    }
  }
  buckets[classified] = (buckets[classified]||0) + 1
}

console.log('\n=== E022 pattern breakdown ===')
for (const [k,v] of Object.entries(buckets)) if (v>0) console.log(`  ${k.padEnd(28)} ${v}`)
console.log('\n--- examples ---')
for (const [k, arr] of Object.entries(examples)) if (arr.length) {
  console.log(k+':')
  for (const e of arr) console.log('  ', JSON.stringify(e))
}

await pool.end()
