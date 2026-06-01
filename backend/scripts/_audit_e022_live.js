// Run the engine LIVE on every eligible invoice and bucket the E022/E023
// errors by drift pattern: tax-inclusive, multi-tier, percent-band, real.
import 'dotenv/config'
import { pool } from '../src/db.js'
import { runFullValidation } from '../src/poInvoiceValidation.js'

pool.on('error', () => {})

const { rows: ids } = await pool.query(`
  SELECT invoice_id FROM invoices
   WHERE status IN ('waiting_for_validation','waiting_for_re_validation','exception_approval','debit_note_approval','validated')
   ORDER BY invoice_id`)

const e022Buckets = { taxInclusive:0, percentBand:{}, intRatio:0, real:0 }
const samplesByBucket = {}
let processed = 0, e022Count = 0

for (const { invoice_id } of ids) {
  try {
    const r = await runFullValidation(invoice_id)
    const e022Lines = (r.details?.lines||[]).filter(l => l.errors?.some(e => /differs from PO effective rate/.test(e)))
    if (e022Lines.length === 0) { processed++; continue }
    e022Count++
    for (const ln of e022Lines) {
      const inv = Number(ln.invRate)
      const eff = ln.poRate != null ? Number(ln.poRate) : null
      // The full effective rate (with disc) is in the error string; parse:
      const m = (ln.errors||[]).join(' ').match(/PO effective rate \(([\d.]+)/)
      const effR = m ? Number(m[1]) : (eff||0)
      if (!inv || !effR) continue
      const driftPct = ((inv - effR) / effR) * 100
      // tax-inclusive?
      if (Math.abs(inv - effR * 1.18) / effR <= 0.01) { e022Buckets.taxInclusive++; (samplesByBucket.taxInclusive ??= []).push({inv:ln.itemName?.slice(0,30), inv_rate:inv, eff:effR, msg:ln.errors[0]?.slice(0,90)}); continue }
      if (Math.abs(inv - effR * 1.12) / effR <= 0.01) { e022Buckets.taxInclusive++; continue }
      if (Math.abs(inv - effR * 1.05) / effR <= 0.01) { e022Buckets.taxInclusive++; continue }
      // integer ratio?
      let isRatio = false
      for (const k of [2,3,5,10,12,24,100,1000]) {
        if (Math.abs(inv - effR*k)/effR <= 0.01 || Math.abs(inv*k - effR)/effR <= 0.01) { e022Buckets.intRatio++; (samplesByBucket.intRatio ??= []).push({inv_rate:inv, eff:effR, factor:k}); isRatio=true; break }
      }
      if (isRatio) continue
      // percent band — round drift to nearest 5%
      const band = Math.round(driftPct / 5) * 5
      e022Buckets.percentBand[band] = (e022Buckets.percentBand[band]||0) + 1
      if (Math.abs(band) === 5 || Math.abs(band) === 10) {
        (samplesByBucket['band'+band] ??= []).push({item:ln.itemName?.slice(0,30), inv_rate:inv, eff:effR, drift:driftPct.toFixed(1)+'%'})
      }
    }
    processed++
    if (processed % 200 === 0) process.stdout.write(`  ...${processed}/${ids.length}\r`)
  } catch { processed++; continue }
}

console.log(`\n\nProcessed ${processed}/${ids.length}, ${e022Count} invoices have at least one E022 line.`)
console.log('\n=== E022 line-level pattern breakdown ===')
console.log('  tax-inclusive (rate ≈ eff × 1.18 / 1.12 / 1.05):', e022Buckets.taxInclusive)
console.log('  integer ratio (1:N / N:1 unit conversion):', e022Buckets.intRatio)
console.log('  percent drift bands (lines):')
const sortedBands = Object.entries(e022Buckets.percentBand).sort((a,b)=>b[1]-a[1])
for (const [band, n] of sortedBands) console.log(`    ${band.padStart(5)}%:  ${n}`)

console.log('\n--- samples ---')
for (const [k, arr] of Object.entries(samplesByBucket)) if (arr.length) {
  console.log(k+':')
  for (const e of arr.slice(0,4)) console.log('  ', JSON.stringify(e))
}

await pool.end()
