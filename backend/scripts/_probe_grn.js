// Investigate the GRN match for a specific invoice (default STM26-27/63).
// User reports: each invoice has exactly ONE GRN (matched via
// grn.supplier_doc_no = invoice_number), but the engine is summing many.
import 'dotenv/config'
import { pool } from '../src/db.js'

pool.on('error', () => {})

const INV = process.argv[2] || 'STM26-27/63'

const inv = await pool.query(
  `SELECT invoice_id, invoice_number, supplier_id, po_id, po_number, status,
          (SELECT COALESCE(SUM(billed_qty),0) FROM invoice_lines il WHERE il.invoice_id = i.invoice_id) AS inv_qty
     FROM invoices i WHERE invoice_number = $1`,
  [INV]
)
console.log('=== INVOICE ===')
console.table(inv.rows)
if (inv.rows.length === 0) { await pool.end(); process.exit(0) }
const { invoice_id, supplier_id, po_id, invoice_number } = inv.rows[0]

// How the engine currently scopes GRN: po_id + supplier_doc_no = invoice_number
const scoped = await pool.query(
  `SELECT COUNT(*)::int AS grn_rows,
          COUNT(DISTINCT grn_no)::int AS distinct_grn_no,
          COALESCE(SUM(grn_qty),0)::numeric AS sum_grn_qty,
          COALESCE(SUM(COALESCE(accepted_qty, grn_qty, 0)),0)::numeric AS sum_accepted
     FROM grn
    WHERE po_id = $1
      AND TRIM(COALESCE(supplier_doc_no,'')) <> ''
      AND LOWER(TRIM(supplier_doc_no)) = LOWER(TRIM($2))`,
  [po_id, invoice_number]
)
console.log('\n=== ENGINE GRN SCOPE (po_id + supplier_doc_no = invoice_number) ===')
console.table(scoped.rows)

// Detail of the matched GRN rows
const detail = await pool.query(
  `SELECT grn_id, grn_pfx, grn_no, supplier_id, supplier_doc_no, item_id, grn_qty, accepted_qty, grn_date
     FROM grn
    WHERE po_id = $1
      AND LOWER(TRIM(supplier_doc_no)) = LOWER(TRIM($2))
    ORDER BY grn_no, grn_id
    LIMIT 40`,
  [po_id, invoice_number]
)
console.log('\n=== MATCHED GRN ROWS (first 40) ===')
console.table(detail.rows)

// Is the same supplier_doc_no used across MANY GRN groups? distinct (grn_pfx,grn_no)
const groups = await pool.query(
  `SELECT grn_pfx, grn_no, COUNT(*)::int AS line_rows,
          COALESCE(SUM(grn_qty),0)::numeric AS qty,
          MIN(supplier_id) AS supplier_id
     FROM grn
    WHERE po_id = $1
      AND LOWER(TRIM(supplier_doc_no)) = LOWER(TRIM($2))
    GROUP BY grn_pfx, grn_no
    ORDER BY grn_no`,
  [po_id, invoice_number]
)
console.log('\n=== DISTINCT GRN DOCUMENTS for this match (grn_pfx, grn_no) ===')
console.table(groups.rows)

await pool.end()
