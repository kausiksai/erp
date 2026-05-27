// Systematic false-positive hunt across all waiting_for_re_validation
// invoices. For each suspect rule, re-derive the truth from raw rows and
// flag cases where the error looks spurious (i.e. the invoice probably
// should validate). Read-only.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})
const TOL = 0.001

const codesOf = async () => {
  const { rows } = await pool.query(`
    SELECT split_part(e->>'code','_',1) AS code, COUNT(DISTINCT i.invoice_id)::int AS n
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation'
     GROUP BY 1 ORDER BY n DESC`)
  return rows
}

const invsWithCode = async (code) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id, i.supplier_id, i.invoice_date
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation'
       AND split_part(e->>'code','_',1) = $1`, [code])
  return rows
}

console.log('=== ACTIVE CODES (waiting_for_re_validation) ===')
const codes = await codesOf()
for (const r of codes) console.log('  ', r.code.padEnd(6), r.n)

/* ---- E011: invoice date before PO date. Bug if engine compares to a LATER
   amendment's date rather than the ORIGINAL PO date. ---- */
console.log('\n=== E011 — invoice-before-PO: is it an amendment-date artifact? ===')
{
  const invs = await invsWithCode('E011')
  let amendArtifact = 0, real = 0
  for (const v of invs) {
    if (!v.invoice_date || !v.po_id) continue
    // earliest date across ALL amendments of this PO number
    const { rows } = await pool.query(`
      SELECT MIN(date)::date AS earliest, MAX(date)::date AS latest, COUNT(*)::int AS amds
        FROM purchase_orders
       WHERE po_number = (SELECT po_number FROM purchase_orders WHERE po_id=$1)`, [v.po_id])
    const earliest = rows[0]?.earliest, latest = rows[0]?.latest, amds = rows[0]?.amds
    if (earliest && new Date(v.invoice_date) >= new Date(earliest)) {
      amendArtifact++
      if (amendArtifact <= 6) console.log(`  FP inv ${v.invoice_number}: inv ${String(v.invoice_date).slice(0,10)} >= earliest PO ${earliest} (latest ${latest}, ${amds} amds) → E011 fired on amendment date`)
    } else real++
  }
  console.log(`  amendment-date false positives: ${amendArtifact}, genuinely-before-PO: ${real}`)
}

/* ---- E021 / E040: qty over PO. Flag tiny overage (<1%) = rounding/UOM. ---- */
for (const code of ['E021', 'E040']) {
  console.log(`\n=== ${code} — qty over PO: tiny overage (<1%)? ===`)
  const invs = await invsWithCode(code)
  let tiny = 0, big = 0
  for (const v of invs) {
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(il.billed_qty),0)::numeric AS inv_qty,
             (SELECT COALESCE(SUM(qty),0) FROM purchase_order_lines WHERE po_id=$2)::numeric AS po_qty
        FROM invoice_lines il WHERE il.invoice_id=$1`, [v.invoice_id, v.po_id])
    const iq = Number(rows[0]?.inv_qty)||0, pq = Number(rows[0]?.po_qty)||0
    if (pq>0 && iq>pq) {
      const pct = ((iq-pq)/pq)*100
      if (pct < 1) { tiny++; if (tiny<=5) console.log(`  FP inv ${v.invoice_number}: over by ${pct.toFixed(3)}% (${iq} vs ${pq})`) }
      else big++
    }
  }
  console.log(`  <1% overage (likely rounding/UOM): ${tiny}, real overage: ${big}`)
}

/* ---- E022: rate mismatch. Flag (a) drift <2%, (b) invoice rate == gross PO
   rate (supplier ignored discount — real but a known category). ---- */
console.log('\n=== E022 — line rate mismatch: small drift vs gross-rate billing ===')
{
  const invs = await invsWithCode('E022')
  let smallDrift = 0, grossBilled = 0, real = 0
  for (const v of invs) {
    const { rows } = await pool.query(`
      SELECT il.rate AS inv_rate, pol.unit_cost AS po_rate, COALESCE(pol.disc_pct,0) AS disc
        FROM invoice_lines il JOIN purchase_order_lines pol ON pol.po_line_id=il.po_line_id
       WHERE il.invoice_id=$1 AND il.rate IS NOT NULL AND pol.unit_cost IS NOT NULL`, [v.invoice_id])
    let cat = 'real'
    for (const r of rows) {
      const eff = Number(r.po_rate)*(1-Number(r.disc)/100)
      const inv = Number(r.inv_rate)
      const driftPct = eff>0 ? Math.abs(inv-eff)/eff*100 : 0
      const matchesGross = Number(r.disc)>0 && Math.abs(inv-Number(r.po_rate)) < 0.01
      if (matchesGross) { cat = 'gross'; break }
      if (driftPct < 2) cat = 'small'
    }
    if (cat==='gross') grossBilled++
    else if (cat==='small') smallDrift++
    else real++
  }
  console.log(`  <2% drift: ${smallDrift}, billed gross (ignored disc): ${grossBilled}, real: ${real}`)
}

/* ---- E050: standard-PO GRN shortfall. Bug if it compares cumulative PO
   GRN to a single invoice, or ignores this-invoice GRN scoping. ---- */
console.log('\n=== E050 — GRN shortfall: this-invoice GRN vs PO-cumulative GRN ===')
{
  const invs = await invsWithCode('E050')
  let scopeFixable = 0, real = 0
  for (const v of invs) {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COALESCE(SUM(il.billed_qty),0) FROM invoice_lines il WHERE il.invoice_id=$1)::numeric AS inv_qty,
        (SELECT COALESCE(SUM(COALESCE(accepted_qty,grn_qty,0)),0) FROM grn WHERE po_id=$2)::numeric AS grn_po,
        (SELECT COALESCE(SUM(COALESCE(accepted_qty,grn_qty,0)),0) FROM grn WHERE po_id=$2 AND LOWER(TRIM(supplier_doc_no))=LOWER(TRIM($3)))::numeric AS grn_inv
    `, [v.invoice_id, v.po_id, v.invoice_number])
    const iq=Number(rows[0]?.inv_qty)||0, gpo=Number(rows[0]?.grn_po)||0, gi=Number(rows[0]?.grn_inv)||0
    if (gi >= iq - TOL && gi > 0) { scopeFixable++; if (scopeFixable<=5) console.log(`  FP inv ${v.invoice_number}: this-inv GRN ${gi} covers inv ${iq} (PO-cumulative ${gpo}) → shortfall is a scoping artifact`) }
    else real++
  }
  console.log(`  covered by this-invoice GRN (scoping FP): ${scopeFixable}, real shortfall: ${real}`)
}

await pool.end()
