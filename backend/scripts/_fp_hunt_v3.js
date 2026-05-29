// Round-3 deep dive. Read-only.
//   A. Duplicate invoices (same number+supplier reused) inflating cumulative
//   B. E003 "PO not found" near-matches (case/padding/prefix differences)
//   C. E022 wrong-PO-line resolution (invoice rate matches a DIFFERENT line on
//      the same PO than the resolver picked)
//   D. E040 / E060 caused by NULL billed_qty on some siblings
//   E. E034 place_of_supply formatting issues
//   F. E033 CGST/SGST equal-within-rounding edge cases
//   G. W002 escalation: PO-number-text mismatch — is the resolved PO actually wrong?
import 'dotenv/config'
import { pool } from '../src/db.js'
pool.on('error', () => {})

const TOL_AMOUNT = 0.01
const TOL_RATE_PCT = 0.01

// helper
const invsWith = async (code) => (await pool.query(`
  SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id, i.supplier_id, i.po_number,
                  i.gstin AS invoice_gstin, i.place_of_supply
    FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
   WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1) = $1`, [code])).rows

/* A. duplicate invoices ---- */
console.log('\n=== A. DUPLICATE INVOICES (same number + supplier_id) ===')
{
  const r = await pool.query(`
    SELECT invoice_number, supplier_id, COUNT(*)::int AS n,
           array_agg(invoice_id ORDER BY invoice_id) AS ids,
           array_agg(DISTINCT status) AS statuses
      FROM invoices
     WHERE invoice_number IS NOT NULL AND supplier_id IS NOT NULL
     GROUP BY invoice_number, supplier_id
    HAVING COUNT(*) > 1
     ORDER BY n DESC LIMIT 10`)
  console.log(`  groups with duplicates: ${r.rows.length}`)
  for (const g of r.rows.slice(0,8)) console.log(`  inv "${g.invoice_number}" × supplier ${g.supplier_id} → ${g.n} rows (ids ${g.ids.join(',')}; statuses ${g.statuses.join(',')})`)
}

/* B. E003 near-matches ---- */
console.log('\n=== B. E003 — PO referenced but slight format mismatch in master ===')
{
  const invs = await invsWith('E003')
  let found = 0
  for (const v of invs.slice(0, 200)) {
    const ref = String(v.po_number||'').trim()
    if (!ref) continue
    const r = await pool.query(`
      SELECT po_id, po_number FROM purchase_orders
       WHERE po_number = $1
          OR UPPER(po_number) = UPPER($1)
          OR REPLACE(po_number,' ','') = REPLACE($1,' ','')
          OR REGEXP_REPLACE(po_number,'^0+','') = REGEXP_REPLACE($1,'^0+','')
          OR po_number LIKE '%'||$1||'%'
          OR $1 LIKE '%'||po_number||'%'
       LIMIT 3`, [ref])
    if (r.rows.length > 0) {
      found++
      if (found <= 6) console.log(`  near-match inv ${v.invoice_number} stated "${ref}" → master has ${JSON.stringify(r.rows)}`)
    }
  }
  console.log(`  total E003 sampled: ${Math.min(200, invs.length)}, near-matches found: ${found}`)
}

/* C. E022 wrong-PO-line resolution ---- */
console.log('\n=== C. E022 — does another PO line on the SAME PO match the invoice rate? ===')
{
  const invs = await invsWith('E022')
  let resolverMissed = 0
  for (const v of invs) {
    if (!v.po_id) continue
    const lines = await pool.query(`
      SELECT il.invoice_line_id, il.rate AS inv_rate, il.billed_qty AS inv_qty, il.taxable_value, il.po_line_id AS picked
        FROM invoice_lines il WHERE il.invoice_id=$1 AND il.rate IS NOT NULL`, [v.invoice_id])
    const polines = await pool.query(`
      SELECT po_line_id, unit_cost AS po_rate, COALESCE(disc_pct,0) AS disc
        FROM purchase_order_lines WHERE po_id=$1`, [v.po_id])
    let mismatch = false
    for (const ln of lines.rows) {
      const inv = Number(ln.inv_rate)
      const invFromAmt = (Number(ln.taxable_value)||0)/(Number(ln.inv_qty)||1)
      // Find a PO line where neither inv nor invFromAmt matches → real error
      // But check: does any DIFFERENT PO line on this PO have effective rate matching inv or invFromAmt?
      const otherMatch = polines.rows.find(p => {
        if (String(p.po_line_id) === String(ln.picked)) return false
        const eff = Number(p.po_rate)*(1-Number(p.disc)/100)
        return (Math.abs(inv-eff) <= TOL_AMOUNT || Math.abs(inv-eff)/eff <= TOL_RATE_PCT) ||
               (Math.abs(invFromAmt-eff) <= TOL_AMOUNT || Math.abs(invFromAmt-eff)/eff <= TOL_RATE_PCT)
      })
      if (otherMatch) { mismatch = true; break }
    }
    if (mismatch) resolverMissed++
  }
  console.log(`  E022 invoices total: ${invs.length}, where a DIFFERENT PO line on the same PO matches the invoice rate: ${resolverMissed}`)
}

/* D. E040 / E060 with NULL billed_qty on some lines ---- */
console.log('\n=== D. NULL billed_qty on lines (qty falls back to weight/count) ===')
{
  const r = await pool.query(`
    SELECT i.invoice_id, i.invoice_number, COUNT(il.invoice_line_id)::int AS lines,
           COUNT(*) FILTER (WHERE il.billed_qty IS NULL)::int AS null_qty,
           COUNT(*) FILTER (WHERE il.weight IS NOT NULL)::int AS has_weight
      FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.invoice_id
     WHERE i.status='waiting_for_re_validation'
     GROUP BY i.invoice_id, i.invoice_number
    HAVING COUNT(*) FILTER (WHERE il.billed_qty IS NULL) > 0
     LIMIT 8`)
  console.log(`  invoices with at least one null billed_qty: ${r.rows.length} (engine falls back to weight/count)`)
  for (const v of r.rows.slice(0,5)) console.log(`  inv ${v.invoice_number}: ${v.null_qty}/${v.lines} lines have null billed_qty (${v.has_weight} with weight)`)
}

/* E. E034 — place_of_supply formatting ---- */
console.log('\n=== E. E034 — place_of_supply formatting (text vs 2-digit code) ===')
{
  const invs = await invsWith('E034')
  let weird = 0
  for (const v of invs) {
    const pos = String(v.place_of_supply||'').trim()
    if (!/^\d{2}$/.test(pos)) {
      weird++
      if (weird<=6) console.log(`  inv ${v.invoice_number}: place_of_supply="${pos}" (not a 2-digit code)`)
    }
  }
  console.log(`  E034 invoices: ${invs.length}, with non-2-digit place_of_supply: ${weird}`)
}

/* F. E033 — CGST vs SGST equal within rounding ---- */
console.log('\n=== F. E033 — CGST vs SGST near-rounding cases ===')
{
  const r = await pool.query(`
    SELECT i.invoice_id, i.invoice_number, il.cgst_amount, il.sgst_amount,
           (il.cgst_amount - il.sgst_amount) AS diff
      FROM invoices i JOIN invoice_lines il ON il.invoice_id=i.invoice_id,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation'
       AND split_part(e->>'code','_',1)='E033'
       AND il.cgst_amount > 0 AND il.sgst_amount > 0
       AND ABS(il.cgst_amount - il.sgst_amount) < 1
     LIMIT 6`)
  console.log(`  E033 with abs(diff)<1 (likely rounding): ${r.rows.length}`)
  for (const v of r.rows) console.log(`  inv ${v.invoice_number}: cgst=${v.cgst_amount}, sgst=${v.sgst_amount}, diff=${v.diff}`)
}

/* G. W002 — po_number text mismatch — is the resolved PO actually wrong? ---- */
console.log('\n=== G. W002 — invoices where stated po_number ≠ resolved PO ===')
{
  const r = await pool.query(`
    SELECT i.invoice_id, i.invoice_number, i.po_number AS stated, po.po_number AS resolved, po.supplier_id AS po_supplier, i.supplier_id AS inv_supplier
      FROM invoices i LEFT JOIN purchase_orders po ON po.po_id=i.po_id
     WHERE i.status='waiting_for_re_validation'
       AND i.po_id IS NOT NULL AND i.po_number IS NOT NULL
       AND TRIM(i.po_number) <> '' AND TRIM(po.po_number) <> ''
       AND LOWER(TRIM(i.po_number)) <> LOWER(TRIM(po.po_number))
     LIMIT 12`)
  console.log(`  found: ${r.rows.length} (engine resolved to a different PO than the invoice's text reference)`)
  for (const v of r.rows.slice(0,8)) console.log(`  inv ${v.invoice_number}: stated="${v.stated}" → resolved="${v.resolved}" (po-supplier ${v.po_supplier}, inv-supplier ${v.inv_supplier})`)
}

await pool.end()
