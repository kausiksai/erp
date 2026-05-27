// Look for invoices stuck in waiting_for_re_validation whose listed errors
// don't actually hold against the live DB data. These are bug-driven false
// positives — invoices that *could* validate if the engine got the check
// right.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

// 1) Recency check — anything older than the last full sweep is stale
//    code output and tells us nothing about the current engine.
const recent = await pool.query(`
  SELECT
    COUNT(*) FILTER (WHERE (validation_errors->>'computed_at')::timestamptz >= NOW() - INTERVAL '60 minutes')::int AS fresh,
    COUNT(*) FILTER (WHERE (validation_errors->>'computed_at')::timestamptz <  NOW() - INTERVAL '60 minutes')::int AS stale,
    COUNT(*) FILTER (WHERE validation_errors IS NULL)::int AS no_jsonb_yet
  FROM invoices
`)
console.log('Freshness of validation_errors JSONB:')
console.log('  fresh (last 60 min):', recent.rows[0].fresh)
console.log('  stale (older)      :', recent.rows[0].stale)
console.log('  null               :', recent.rows[0].no_jsonb_yet)

// 2) Codes that are common AND cheap to verify against raw DB rows.
//    For each, pull 3 sample invoices and re-derive the underlying truth.
async function probe(code, header, sampleSql, isFalsePositive) {
  console.log(`\n=== ${header} (code ${code}) ===`)
  const { rows: samples } = await pool.query(sampleSql)
  let fp = 0
  for (const s of samples) {
    const verdict = await isFalsePositive(s)
    if (verdict) {
      fp += 1
      console.log(`  FALSE POSITIVE  inv ${s.invoice_id} (${s.invoice_number}): ${verdict}`)
    }
  }
  if (fp === 0) console.log('  (no false positives in this sample)')
}

// ---- E003 PO not found: check if there's an exact-text match we missed
await probe(
  'E003',
  'E003 — PO not found: any same po_number text actually in master?',
  `
    SELECT i.invoice_id, i.invoice_number, i.po_number, i.open_order_no, i.supplier_id
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
       AND split_part(e->>'code','_',1) = 'E003'
       AND i.po_number IS NOT NULL
     LIMIT 20
  `,
  async (s) => {
    const { rows } = await pool.query(
      `SELECT po_id, supplier_id, po_number FROM purchase_orders
        WHERE po_number = $1 OR po_number = $2
        ORDER BY amd_no DESC LIMIT 3`,
      [s.po_number, s.open_order_no]
    )
    if (rows.length === 0) return null
    const matchingSupplier = rows.find(r => Number(r.supplier_id) === Number(s.supplier_id))
    if (matchingSupplier) return `PO ${s.po_number} actually exists (po_id=${matchingSupplier.po_id}) for supplier ${s.supplier_id}`
    return null
  }
)

// ---- E022 line rate mismatch: how big is the actual drift?
await probe(
  'E022',
  'E022 — line rate mismatch: invoices where drift is <2% of effective rate',
  `
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
       AND split_part(e->>'code','_',1) = 'E022'
     LIMIT 30
  `,
  async (s) => {
    const { rows } = await pool.query(
      `SELECT il.rate AS inv_rate, pol.unit_cost AS po_rate, COALESCE(pol.disc_pct, 0) AS disc
         FROM invoice_lines il
         LEFT JOIN purchase_order_lines pol ON pol.po_line_id = il.po_line_id
        WHERE il.invoice_id = $1 AND pol.po_line_id IS NOT NULL
          AND il.rate IS NOT NULL AND pol.unit_cost IS NOT NULL`,
      [s.invoice_id]
    )
    let allTiny = rows.length > 0
    let worstPct = 0
    for (const r of rows) {
      const eff = Number(r.po_rate) * (1 - Number(r.disc) / 100)
      const drift = Math.abs(Number(r.inv_rate) - eff)
      const pct = eff > 0 ? (drift / eff) * 100 : 0
      worstPct = Math.max(worstPct, pct)
      if (pct >= 1.5) { allTiny = false; break }
    }
    if (allTiny && rows.length > 0 && worstPct < 1.5) {
      return `worst line drift only ${worstPct.toFixed(2)}% (tolerance is 1% — bumping to 1.5% would clear this)`
    }
    return null
  }
)

// ---- E021 line qty over: how big is the overage?
await probe(
  'E021',
  'E021 — line qty over PO: invoices where overage is <1% of PO line qty',
  `
    SELECT DISTINCT i.invoice_id, i.invoice_number
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
       AND split_part(e->>'code','_',1) = 'E021'
     LIMIT 25
  `,
  async (s) => {
    const { rows } = await pool.query(
      `SELECT il.billed_qty AS inv_qty, pol.qty AS po_qty
         FROM invoice_lines il
         JOIN purchase_order_lines pol ON pol.po_line_id = il.po_line_id
        WHERE il.invoice_id = $1`,
      [s.invoice_id]
    )
    let worstPct = 0
    for (const r of rows) {
      const inv = Number(r.inv_qty) || 0
      const po = Number(r.po_qty) || 0
      if (po > 0 && inv > po) {
        const pct = ((inv - po) / po) * 100
        worstPct = Math.max(worstPct, pct)
      }
    }
    if (worstPct > 0 && worstPct < 1.0) {
      return `worst line overage only ${worstPct.toFixed(3)}% (likely weight rounding)`
    }
    return null
  }
)

// ---- E061 cumulative amount: is the 0.85 estimate wrong for this PO's tax rate?
await probe(
  'E061',
  'E061 — cumulative amount: would fit if true pre-tax ratio (not 0.85) was used',
  `
    SELECT DISTINCT i.invoice_id, i.invoice_number, i.po_id
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
       AND split_part(e->>'code','_',1) = 'E061'
     LIMIT 25
  `,
  async (s) => {
    // Compute true ratio of pre-tax to total across all invoices on this PO
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(il.taxable_value), 0)::numeric AS pretax,
              COALESCE(SUM(i.total_amount), 0)::numeric AS total
         FROM invoices i
         JOIN invoice_lines il ON il.invoice_id = i.invoice_id
        WHERE i.po_id = (SELECT po_id FROM invoices WHERE invoice_id = $1)`,
      [s.invoice_id]
    )
    if (!rows[0] || Number(rows[0].total) === 0) return null
    const trueRatio = Number(rows[0].pretax) / Number(rows[0].total)
    if (trueRatio > 0 && trueRatio < 0.82) {
      return `this PO's actual pre-tax ratio is ${(trueRatio * 100).toFixed(1)}% (28% GST?), engine assumes 85% — overcounts the budget consumed`
    }
    return null
  }
)

// ---- E005 supplier mismatch: is the supplier match actually fine via po_number lookup?
await probe(
  'E005',
  'E005 — supplier mismatch: but po_number matches multiple POs incl. one for the right supplier',
  `
    SELECT i.invoice_id, i.invoice_number, i.supplier_id, i.po_id, i.po_number
      FROM invoices i,
           LATERAL jsonb_array_elements(COALESCE(i.validation_errors->'errors','[]'::jsonb)) AS e
     WHERE i.status = 'waiting_for_re_validation'
       AND split_part(e->>'code','_',1) = 'E005'
     LIMIT 20
  `,
  async (s) => {
    if (!s.po_number) return null
    const { rows } = await pool.query(
      `SELECT po_id, supplier_id FROM purchase_orders WHERE po_number = $1`,
      [s.po_number]
    )
    const correct = rows.find(r => Number(r.supplier_id) === Number(s.supplier_id))
    if (correct && Number(correct.po_id) !== Number(s.po_id)) {
      return `po_number ${s.po_number} also matches po_id ${correct.po_id} which belongs to supplier ${s.supplier_id} (currently linked to wrong po_id ${s.po_id})`
    }
    return null
  }
)

await pool.end()
