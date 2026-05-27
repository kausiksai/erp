// Throwaway: list every table that touches PO / invoice / GRN / ASN /
// schedule / OCR data, with current row counts.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

const { rows: allTables } = await pool.query(`
  SELECT tablename
    FROM pg_tables
   WHERE schemaname = 'public'
     AND (
          tablename ~* '(invoice|purchase_order|purchase_orders|grn|asn|schedule|delivery_challan|payment|debit_note|ocr|excel_import|reconcile|email_run|attachment|extract)'
     )
   ORDER BY tablename
`)

console.log('Tables matching the wipe scope:')
for (const t of allTables) {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${t.tablename}"`)
    console.log(`  ${t.tablename.padEnd(42)} ${rows[0].n}`)
  } catch (err) {
    console.log(`  ${t.tablename.padEnd(42)} ? (${err.message})`)
  }
}

await pool.end()
