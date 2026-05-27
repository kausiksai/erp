// Full wipe of PO / invoice / GRN / ASN / schedule / OCR / debit-note /
// payment tables. Wrapped in a transaction; the COMMIT only fires after
// every TRUNCATE succeeds, so a midway failure rolls back cleanly.
//
// CASCADE handles any FK-dependent rows in tables I might not have
// enumerated (foreign keys into invoices/POs from other parts of the
// schema get cleared automatically).
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

const TABLES = [
  'asn',
  'debit_note_details',
  'debit_notes',
  'delivery_challans',
  'grn',
  'invoice_attachments',
  'invoice_lines',
  'invoice_status_audit',
  'invoice_weight_attachments',
  'invoices',
  'ocr_automation_log',
  'ocr_automation_runs',
  'payment_approvals',
  'payment_transactions',
  'po_schedules',
  'purchase_order_lines',
  'purchase_orders',
  'unraised_invoices',
]

const client = await pool.connect()
try {
  await client.query('BEGIN')

  const before = {}
  for (const t of TABLES) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)
    before[t] = rows[0].n
  }

  const list = TABLES.map((t) => `"${t}"`).join(', ')
  console.log(`Truncating ${TABLES.length} tables (CASCADE, RESTART IDENTITY)…`)
  await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)

  console.log('\nPer-table delta (before → after):')
  for (const t of TABLES) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)
    const arrow = before[t] > 0 ? `${String(before[t]).padStart(7)} → ${rows[0].n}` : `${String(before[t]).padStart(7)} (was empty)`
    console.log(`  ${t.padEnd(32)} ${arrow}`)
  }

  await client.query('COMMIT')
  console.log('\nCOMMITTED. Wipe complete.')
} catch (err) {
  await client.query('ROLLBACK').catch(() => {})
  console.error('Wipe FAILED — transaction rolled back:', err.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
