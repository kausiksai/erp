// Replicate the EXACT queries the /api/validation-rules endpoint runs, so
// we can tell whether the data is visible to the backend's own pool/.env.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

// What DB are we actually connected to?
const who = await pool.query('SELECT current_database() AS db, inet_server_addr() AS host, current_user AS usr')
console.log('Connected to:', who.rows[0])

// fetchLiveCounts() query, verbatim
const counts = await pool.query(`
  SELECT split_part(e->>'code', '_', 1) AS code,
         COUNT(DISTINCT i.invoice_id)::int AS n
    FROM invoices i,
         LATERAL jsonb_array_elements(
           COALESCE(i.validation_errors->'errors', '[]'::jsonb)
         ) AS e
   WHERE e->>'code' IS NOT NULL
     AND e->>'code' <> 'EXXX'
     AND i.status IN ('waiting_for_validation', 'waiting_for_re_validation',
                      'exception_approval',    'debit_note_approval')
   GROUP BY split_part(e->>'code', '_', 1)
   ORDER BY n DESC
`)
console.log(`\nfetchLiveCounts → ${counts.rows.length} codes`)
for (const r of counts.rows.slice(0, 6)) console.log('  ', r.code, r.n)

// Sanity: how many invoices even have the JSONB column populated + what statuses
const shape = await pool.query(`
  SELECT
    COUNT(*) FILTER (WHERE validation_errors IS NOT NULL)::int AS has_jsonb,
    COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(validation_errors->'errors','[]'::jsonb)) > 0)::int AS has_errors_arr,
    COUNT(*) FILTER (WHERE status IN ('waiting_for_validation','waiting_for_re_validation'))::int AS pending
  FROM invoices
`)
console.log('\nShape check:', shape.rows[0])

// Peek at one raw validation_errors value to confirm structure
const sample = await pool.query(`
  SELECT invoice_id, status, validation_errors
    FROM invoices
   WHERE jsonb_array_length(COALESCE(validation_errors->'errors','[]'::jsonb)) > 0
   LIMIT 1
`)
if (sample.rows[0]) {
  console.log('\nSample row:')
  console.log('  invoice_id:', sample.rows[0].invoice_id, 'status:', sample.rows[0].status)
  console.log('  validation_errors:', JSON.stringify(sample.rows[0].validation_errors).slice(0, 300))
} else {
  console.log('\n(no row with a non-empty errors array)')
}

await pool.end()
