// Round-2 false-positive hunt — focused on codes still firing after the
// discount-at-amount fix. Read-only.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

const invsWith = async (code) => (await pool.query(`
  SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id, i.supplier_id,
                  i.gstin AS invoice_gstin, i.place_of_supply,
                  (SELECT COALESCE(SUM(billed_qty),0) FROM invoice_lines il WHERE il.invoice_id=i.invoice_id)::numeric AS inv_qty
    FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
   WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1) = $1`, [code])).rows

/* ------------- E034 — intra-state IGST: invoice GSTIN coverage ------------- */
console.log('\n=== E034 — does the invoice GSTIN actually drive state derivation? ===')
{
  const invs = await invsWith('E034')
  let withGstin=0, withoutGstin=0, gstinDiffersFromMaster=0
  for (const v of invs) {
    const sup = await pool.query(`SELECT gst_number, state_code FROM suppliers WHERE supplier_id=$1`, [v.supplier_id])
    const masterGstin = sup.rows[0]?.gst_number
    const masterState = sup.rows[0]?.state_code
    const invGstinState = (v.invoice_gstin && /^\d{2}/.test(String(v.invoice_gstin).trim())) ? String(v.invoice_gstin).trim().slice(0,2) : null
    const masterGstinState = (masterGstin && /^\d{2}/.test(String(masterGstin).trim())) ? String(masterGstin).trim().slice(0,2) : null
    if (invGstinState) {
      withGstin++
      if (masterGstinState && invGstinState !== masterGstinState) gstinDiffersFromMaster++
    } else {
      withoutGstin++
    }
  }
  console.log(`  has invoice.gstin: ${withGstin}, missing: ${withoutGstin}`)
  console.log(`  ...where invoice gstin state ≠ master gstin state: ${gstinDiffersFromMaster}`)
  console.log(`  (these are multi-state suppliers — engine uses invoice gstin, correctly. E034 firing means real intra/inter mismatch.)`)
}

/* ------------- E020 — item resolution: description match? ------------- */
console.log('\n=== E020 — could item description match a PO line that item_id missed? ===')
{
  const invs = await invsWith('E020')
  let descMatch = 0
  for (const v of invs) {
    const r = await pool.query(`
      SELECT COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM purchase_order_lines pol
           WHERE pol.po_id=$2
             AND (
               UPPER(TRIM(COALESCE(pol.description1,''))) = UPPER(TRIM(COALESCE(il.item_name,'')))
               OR UPPER(TRIM(COALESCE(pol.item_id,''))) = UPPER(TRIM(COALESCE(il.item_name,'')))
             )
        )
      )::int AS n
        FROM invoice_lines il WHERE il.invoice_id=$1`, [v.invoice_id, v.po_id])
    if ((r.rows[0]?.n||0) > 0) {
      descMatch++
      if (descMatch <= 5) console.log(`  POSSIBLE FP inv ${v.invoice_number}: item NAME matches a PO line description1, but resolver said no match`)
    }
  }
  console.log(`  total E020: ${invs.length}, with description-match potential: ${descMatch}`)
}

/* ------------- E023 — line price: how big is the drift? ------------- */
console.log('\n=== E023 — line price mismatch: small drift vs real ===')
{
  const invs = await invsWith('E023')
  let smallDrift=0, real=0
  for (const v of invs) {
    const lines = await pool.query(`
      SELECT il.billed_qty AS q, il.rate AS inv_rate, il.taxable_value AS taxable,
             pol.unit_cost AS po_rate, COALESCE(pol.disc_pct,0) AS disc
        FROM invoice_lines il JOIN purchase_order_lines pol ON pol.po_line_id=il.po_line_id
       WHERE il.invoice_id=$1`, [v.invoice_id])
    let smallest = 100
    for (const ln of lines.rows) {
      const eff = Number(ln.po_rate)*(1-Number(ln.disc)/100)
      const expected = Number(ln.q)*eff
      const taxable = Number(ln.taxable)
      if (expected>0 && taxable>0) {
        const driftPct = Math.abs(taxable-expected)/expected*100
        smallest = Math.min(smallest, driftPct)
      }
    }
    if (smallest < 1) { smallDrift++; if(smallDrift<=5) console.log(`  FP inv ${v.invoice_number}: line-price drift only ${smallest.toFixed(3)}%`) }
    else real++
  }
  console.log(`  E023 with <1% drift (likely rounding): ${smallDrift}, real: ${real}`)
}

/* ------------- E060 cumulative qty over: do siblings include rejected/old? ------------- */
console.log('\n=== E060 — cumulative qty over: does it include non-active sibling invoices? ===')
{
  const invs = await invsWith('E060')
  let fpFromRejectedSiblings = 0
  for (const v of invs) {
    // breakdown of sibling invoice statuses on this PO
    const r = await pool.query(`
      SELECT i.status, COUNT(*)::int n,
             COALESCE(SUM((SELECT SUM(billed_qty) FROM invoice_lines il WHERE il.invoice_id=i.invoice_id)),0)::numeric AS qty
        FROM invoices i WHERE i.po_id=$1 AND i.invoice_id <> $2
        GROUP BY i.status`, [v.po_id, v.invoice_id])
    const rejected = r.rows.find(x => x.status === 'rejected')
    if (rejected && Number(rejected.qty) > 0) {
      fpFromRejectedSiblings++
      if (fpFromRejectedSiblings <= 5) console.log(`  FP candidate inv ${v.invoice_number}: a rejected sibling on the PO contributes ${rejected.qty} to cumulative qty`)
    }
  }
  console.log(`  E060 invoices with rejected sibling included: ${fpFromRejectedSiblings} (engine currently counts ALL siblings)`)
}

/* ------------- E021/E040 — same-line UOM clue (kg/pcs/doz) ------------- */
console.log('\n=== E021/E040 — qty over PO: any UOM mismatch hint (uom on line)? ===')
{
  for (const code of ['E021','E040']) {
    const invs = await invsWith(code)
    let uomMismatch = 0
    for (const v of invs.slice(0, 60)) {
      const ln = await pool.query(`
        SELECT il.uom AS inv_uom, pol.uom AS po_uom
          FROM invoice_lines il JOIN purchase_order_lines pol ON pol.po_line_id=il.po_line_id
         WHERE il.invoice_id=$1 AND il.uom IS NOT NULL AND pol.uom IS NOT NULL
           AND LOWER(TRIM(il.uom)) <> LOWER(TRIM(pol.uom)) LIMIT 1`, [v.invoice_id])
      if (ln.rows.length > 0) {
        uomMismatch++
        if (uomMismatch<=3) console.log(`  ${code} POSSIBLE UOM bug inv ${v.invoice_number}: inv uom=${ln.rows[0].inv_uom} vs po uom=${ln.rows[0].po_uom}`)
      }
    }
    console.log(`  ${code}: ${invs.length} invoices, ${uomMismatch} with UOM mismatch (qty comparison ignores UOM)`)
  }
}

await pool.end()
