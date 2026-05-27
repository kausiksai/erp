// Throwaway: print current invoice status distribution + active error codes
// + validation_errors recency, so we can see if a portal re-run landed.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

const { rows: status } = await pool.query(`
  SELECT status, COUNT(*)::int AS n
    FROM invoices
   GROUP BY status
   ORDER BY n DESC
`)

const { rows: top } = await pool.query(`
  SELECT split_part(e->>'code','_',1) AS code,
         COUNT(DISTINCT i.invoice_id)::int AS n
    FROM invoices i,
         LATERAL jsonb_array_elements(
           COALESCE(i.validation_errors->'errors', '[]'::jsonb)
         ) AS e
   WHERE e->>'code' IS NOT NULL
     AND e->>'code' <> 'EXXX'
     AND i.status IN ('waiting_for_validation','waiting_for_re_validation',
                      'exception_approval','debit_note_approval')
   GROUP BY 1 ORDER BY n DESC
`)

const { rows: recent } = await pool.query(`
  SELECT MAX((validation_errors->>'computed_at')::timestamptz) AS most_recent,
         COUNT(*) FILTER (WHERE validation_errors IS NOT NULL)::int AS rows_with_errors_jsonb,
         COUNT(*) FILTER (
           WHERE (validation_errors->>'computed_at')::timestamptz >= NOW() - INTERVAL '30 minutes'
         )::int AS computed_in_last_30min
    FROM invoices
`)

console.log('=== STATUS DISTRIBUTION ===')
for (const r of status) console.log(r.status.padEnd(28), r.n)
console.log('\n=== ACTIVE ERROR CODES ===')
for (const r of top) console.log(' ', r.code.padEnd(6), r.n)
console.log('\n=== validation_errors freshness ===')
console.log('most_recent computed_at      =', recent[0].most_recent)
console.log('rows with errors JSONB       =', recent[0].rows_with_errors_jsonb)
console.log('computed in last 30 minutes  =', recent[0].computed_in_last_30min)

await pool.end()
