// Audit remaining E070/E071/E073/E076/E042/E060/E061 — looking for engine
// bugs (wrong scoping, including-self, rejected-sibling sums).
import 'dotenv/config'
import { pool } from '../src/db.js'
import { runFullValidation } from '../src/poInvoiceValidation.js'
pool.on('error', () => {})

/* ---------- E070 / E071 — open PO GRN scoping ---------- */
console.log('\n=== E070 / E071 — does the invoice have a grn reference that points to a valid GRN the engine missed? ===')
{
  const r = await pool.query(`
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id, i.grn_pfx, i.grn_no, split_part(e->>'code','_',1) AS code
      FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1) IN ('E070','E071')`)
  let missedByRef = 0
  const samples = []
  for (const v of r.rows) {
    if (!v.grn_pfx || !v.grn_no) continue
    // GRN scoped by invoice's own grn reference
    const g = await pool.query(`
      SELECT COUNT(*)::int AS rows,
             COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)),0)::numeric AS qty
        FROM grn
       WHERE LOWER(TRIM(grn_pfx))=LOWER(TRIM($1)) AND LOWER(TRIM(grn_no))=LOWER(TRIM($2))`, [v.grn_pfx, v.grn_no])
    // GRN scoped by engine (po_id + supplier_doc_no=invoice_number)
    const g2 = await pool.query(`
      SELECT COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)),0)::numeric AS qty FROM grn
       WHERE po_id=$1 AND LOWER(TRIM(supplier_doc_no))=LOWER(TRIM($2))`, [v.po_id, v.invoice_number])
    const refQty = Number(g.rows[0]?.qty||0)
    const engineQty = Number(g2.rows[0]?.qty||0)
    if (refQty > 0 && engineQty <= 0.001) {
      missedByRef++
      if (samples.length<6) samples.push({inv:v.invoice_number, code:v.code, grn_ref:v.grn_pfx+'/'+v.grn_no, ref_qty:refQty, engine_qty:engineQty})
    }
  }
  console.log(`  invoices where engine GRN qty = 0 but grn_pfx/grn_no reference finds GRN: ${missedByRef} of ${r.rows.length}`)
  for (const s of samples) console.log('  ', JSON.stringify(s))
}

/* ---------- E060 / E061 — siblings include "rejected" or self? ---------- */
console.log('\n=== E060 / E061 — sibling sum integrity (excludes self? includes rejected?) ===')
{
  const r = await pool.query(`
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id, split_part(e->>'code','_',1) AS code
      FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1) IN ('E060','E061','E042')
     LIMIT 30`)
  let withRejectedSibling = 0, withDuplicateInvoice = 0
  for (const v of r.rows) {
    if (!v.po_id) continue
    const sibs = await pool.query(`
      SELECT i2.invoice_id, i2.invoice_number, i2.status,
             (SELECT COALESCE(SUM(billed_qty),0) FROM invoice_lines il WHERE il.invoice_id=i2.invoice_id) AS qty,
             i2.total_amount
        FROM invoices i2 WHERE i2.po_id=$1 AND i2.invoice_id <> $2`, [v.po_id, v.invoice_id])
    const rejected = sibs.rows.filter(s => s.status === 'rejected')
    if (rejected.length > 0 && rejected.some(r => Number(r.qty) > 0)) withRejectedSibling++
  }
  console.log(`  cumulative-check invoices with rejected siblings contributing qty: ${withRejectedSibling} of ${r.rows.length}`)
}

/* ---------- E040 — header qty over PO: invoice include rejected sibling-overlap? ---------- */
console.log('\n=== E040 — header qty over PO with same supplier+invoice# variants? ===')
{
  const r = await pool.query(`
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id
      FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1)='E040'`)
  let weight = 0, qty = 0
  for (const v of r.rows) {
    const ln = await pool.query(`
      SELECT COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE billed_qty IS NULL AND weight IS NOT NULL)::int AS weight_only
        FROM invoice_lines WHERE invoice_id=$1`, [v.invoice_id])
    if ((ln.rows[0]?.weight_only||0) > 0) weight++; else qty++
  }
  console.log(`  E040 invoices: ${r.rows.length}, with lines using weight (not billed_qty): ${weight}`)
}

/* ---------- E076 schedule over — engine uses thisInvoiceSchedQty; what if multiple schedules ---------- */
console.log('\n=== E076 — invoices where ss_pfx/ss_no resolves to MULTIPLE schedule rows (sum may be wrong) ===')
{
  const r = await pool.query(`
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.ss_pfx, i.ss_no
      FROM invoices i, LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status='waiting_for_re_validation' AND split_part(e->>'code','_',1)='E076'`)
  let multiSched = 0
  for (const v of r.rows) {
    if (!v.ss_pfx || !v.ss_no) continue
    const s = await pool.query(`SELECT COUNT(*)::int AS n FROM po_schedules WHERE LOWER(TRIM(COALESCE(ss_pfx,'')))=LOWER($1) AND LOWER(TRIM(COALESCE(ss_no,'')))=LOWER($2)`, [v.ss_pfx, v.ss_no])
    if ((s.rows[0]?.n||0) > 1) multiSched++
  }
  console.log(`  E076 invoices total: ${r.rows.length}, with multi-row schedule for ss_pfx/ss_no: ${multiSched}`)
}

await pool.end()
