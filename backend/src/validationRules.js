// Validation rules library — catalog of every check the engine runs,
// with current per-rule counts pulled from invoice mismatches.
//
// The actual rule logic lives in Python (email_automation/validation/checks.py).
// This module is a thin metadata layer for the new portal's Rules page:
//   - GET    /api/validation-rules         list all rules + live counts
//   - PATCH  /api/validation-rules/:code   toggle active or change severity
//
// Toggling a rule writes to a new tiny config table `validation_rule_overrides`
// that the Python engine consults at runtime. If the table doesn't exist
// yet (migration not applied) the toggle endpoint still works but is a
// no-op until the migration runs.

import { pool } from './db.js'

/**
 * Static catalog of the 32 rule codes the engine emits, mirrored from
 * email_automation/validation/checks.py. Keep in sync when new rules are
 * added on the Python side.
 */
const RULES = [
  // ---- Header / reference ----
  { code: 'E001_NO_INVOICE_NUMBER',       name: 'Invoice number missing',           severity: 'error',   category: 'reference', owner: 'OCR / data entry',         description: 'Invoice has no invoice number — required for any further processing.' },
  { code: 'E002_NO_PO_LINK',              name: 'PO not extracted',                 severity: 'error',   category: 'reference', owner: 'OCR / data entry',         description: 'No PO number could be extracted from the invoice.' },
  { code: 'E003_PO_NOT_FOUND',            name: 'Referenced PO not found',          severity: 'error',   category: 'reference', owner: 'Source ERP',               description: 'Invoice references a PO not in our master.' },
  { code: 'E004_NO_SUPPLIER',             name: 'Supplier not identified',          severity: 'error',   category: 'reference', owner: 'OCR / data entry',         description: 'OCR could not match supplier name / GSTIN against master.' },
  { code: 'E005_SUPPLIER_MISMATCH',       name: 'Supplier ≠ PO supplier',           severity: 'error',   category: 'reference', owner: 'Procurement',              description: 'Invoice supplier doesn\'t match the PO\'s supplier.' },
  { code: 'E006_PO_ALREADY_FULFILLED',    name: 'PO already fulfilled',             severity: 'error',   category: 'reference', owner: 'Procurement',              description: 'PO is closed / fully invoiced — new invoice not allowed.' },
  // ---- Date ----
  { code: 'E010_INVOICE_DATE_IN_FUTURE',  name: 'Invoice date in future',           severity: 'error',   category: 'date',      owner: 'Supplier',                 description: 'Invoice date is later than today.' },
  { code: 'E011_INVOICE_BEFORE_PO',       name: 'Invoice before PO',                severity: 'info',    category: 'date',      owner: 'Finance',                  description: 'Invoice date is earlier than the PO date.' },
  // ---- Line ----
  { code: 'E020_NO_MATCHING_PO_LINE',     name: 'No matching PO line',              severity: 'warning', category: 'line',      owner: 'Procurement',              description: 'Invoice item code/description doesn\'t match any PO line.' },
  { code: 'E021_LINE_QTY_OVER_PO',        name: 'Line qty exceeds PO line',         severity: 'warning', category: 'line',      owner: 'Procurement',              description: 'Invoice line qty > PO line qty.' },
  { code: 'E022_LINE_RATE_MISMATCH',      name: 'Line rate mismatch',               severity: 'warning', category: 'price',     owner: 'Supplier reconciliation',  description: 'Invoice line rate ≠ PO effective rate (after discount).' },
  { code: 'E023_LINE_PRICE_MISMATCH',     name: 'Line price mismatch',              severity: 'warning', category: 'price',     owner: 'Supplier reconciliation',  description: 'Qty × rate doesn\'t match PO line total.' },
  // ---- GST ----
  { code: 'E030_CGST_SLAB_SUM_MISMATCH',  name: 'CGST slab sum mismatch',           severity: 'warning', category: 'gst',       owner: 'Supplier',                 description: 'Sum of per-slab CGST amounts differs from invoice header CGST.' },
  { code: 'E031_SGST_SLAB_SUM_MISMATCH',  name: 'SGST slab sum mismatch',           severity: 'warning', category: 'gst',       owner: 'Supplier',                 description: 'Sum of per-slab SGST amounts differs from invoice header SGST.' },
  { code: 'E032_IGST_SLAB_SUM_MISMATCH',  name: 'IGST slab sum mismatch',           severity: 'warning', category: 'gst',       owner: 'Supplier',                 description: 'Sum of per-slab IGST amounts differs from invoice header IGST.' },
  { code: 'E033_CGST_SGST_NOT_EQUAL',     name: 'CGST and SGST not equal',          severity: 'warning', category: 'gst',       owner: 'Supplier',                 description: 'Under GST law CGST and SGST must be equal — they aren\'t.' },
  { code: 'E034_INTRA_STATE_WITH_IGST',   name: 'Intra-state charged IGST',         severity: 'warning', category: 'gst',       owner: 'Supplier',                 description: 'POS = supplier state but IGST charged instead of CGST + SGST.' },
  { code: 'E035_INTER_STATE_WITH_CGST_SGST', name: 'Inter-state with CGST/SGST',    severity: 'warning', category: 'gst',       owner: 'Supplier',                 description: 'POS ≠ supplier state but CGST + SGST charged instead of IGST.' },
  // ---- Header totals ----
  { code: 'E040_HEADER_QTY_OVER_PO',      name: 'Header qty over PO',               severity: 'warning', category: 'totals',    owner: 'Procurement',              description: 'Sum of invoice line qty > PO total qty.' },
  { code: 'E041_HEADER_QTY_UNDER_PO',     name: 'Header qty under PO',              severity: 'info',    category: 'totals',    owner: 'Procurement',              description: 'Sum of invoice line qty < PO total qty (partial billing).' },
  { code: 'E042_HEADER_AMOUNT_OVER_PO',   name: 'Header amount over PO',            severity: 'warning', category: 'totals',    owner: 'Finance',                  description: 'Pre-tax invoice total > PO computed value.' },
  // ---- GRN ----
  { code: 'E050_GRN_LESS_THAN_INVOICE',   name: 'GRN qty less than invoice',        severity: 'warning', category: 'grn',       owner: 'Receiving',                description: 'Goods received < invoice qty (shortfall).' },
  { code: 'E051_STANDARD_PO_NO_GRN',      name: 'Standard PO has no GRN',           severity: 'warning', category: 'grn',       owner: 'Receiving',                description: 'Standard PO requires a GRN before payment; none on file.' },
  { code: 'E052_STANDARD_PO_ASN_QTY_MISMATCH', name: 'Std PO: ASN qty mismatch',    severity: 'warning', category: 'grn',       owner: 'Supplier',                 description: 'Standard PO\'s ASN qty doesn\'t match billed qty.' },
  // ---- Cumulative ----
  { code: 'E060_CUMULATIVE_QTY_OVER_PO',  name: 'Cumulative qty over PO',           severity: 'warning', category: 'cumulative', owner: 'Procurement',             description: 'Sum of all invoices on this PO exceeds PO qty.' },
  { code: 'E061_CUMULATIVE_AMOUNT_OVER_PO', name: 'Cumulative amount over PO',      severity: 'warning', category: 'cumulative', owner: 'Finance',                 description: 'Sum of all invoices on this PO exceeds PO value.' },
  // ---- Open PO ----
  { code: 'E070_OPEN_PO_NO_GRN',          name: 'Open PO: no GRN tagged',           severity: 'warning', category: 'open_po',   owner: 'Receiving',                description: 'No GRN row carries this invoice number in supplier_doc_no.' },
  { code: 'E071_OPEN_PO_GRN_QTY_MISMATCH', name: 'Open PO: GRN qty mismatch',       severity: 'warning', category: 'open_po',   owner: 'Receiving',                description: 'GRN qty for this invoice ≠ billed qty.' },
  { code: 'E073_OPEN_PO_ASN_QTY_MISMATCH', name: 'Open PO: ASN qty mismatch',       severity: 'warning', category: 'open_po',   owner: 'Supplier',                 description: 'ASN qty ≠ billed qty.' },
  { code: 'E074_OPEN_PO_NO_DC_OR_SCHEDULE', name: 'Open PO: no DC or Schedule',     severity: 'warning', category: 'open_po',   owner: 'Receiving',                description: 'Blanket PO with no Delivery Challan or Schedule on file.' },
  { code: 'E075_OPEN_PO_DC_QTY_MISMATCH', name: 'Open PO: DC qty mismatch',         severity: 'warning', category: 'open_po',   owner: 'Receiving',                description: 'DC qty ≠ billed qty.' },
  { code: 'E076_OPEN_PO_SCHED_QTY_MISMATCH', name: 'Open PO: schedule qty mismatch', severity: 'warning', category: 'open_po',  owner: 'Procurement',              description: 'Schedule qty ≠ billed qty.' }
]

/**
 * Look up the live count of invoices currently failing each rule.
 * Reads from invoices.mismatches->'errors'[].code.
 */
async function fetchLiveCounts() {
  try {
    const { rows } = await pool.query(`
      SELECT e->>'code' AS code, COUNT(DISTINCT i.invoice_id)::int AS n
        FROM invoices i,
             LATERAL jsonb_array_elements(
               COALESCE(i.mismatches->'errors', '[]'::jsonb)
             ) AS e
       GROUP BY e->>'code'
    `)
    return Object.fromEntries(rows.map(r => [r.code, r.n]))
  } catch (err) {
    // mismatches column might not be populated yet — return zeros.
    console.warn('validation-rules: fetchLiveCounts failed, returning empty', err.message)
    return {}
  }
}

/**
 * Look up per-rule overrides (active / severity_override). If the table
 * doesn't exist yet (migration unapplied) returns {}.
 */
async function fetchOverrides() {
  try {
    const { rows } = await pool.query(`
      SELECT code, active, severity_override
        FROM validation_rule_overrides
    `)
    return Object.fromEntries(rows.map(r => [r.code, r]))
  } catch {
    return {}
  }
}

/**
 * GET /api/validation-rules
 *
 * Returns the catalog enriched with live counts and any per-rule overrides.
 */
export async function getValidationRulesRoute(_req, res) {
  try {
    const [counts, overrides] = await Promise.all([fetchLiveCounts(), fetchOverrides()])
    const rules = RULES.map(r => {
      const o = overrides[r.code]
      return {
        ...r,
        count:    counts[r.code] || 0,
        active:   o?.active ?? true,
        severity: o?.severity_override || r.severity
      }
    })
    res.json({ rules, total: rules.length })
  } catch (err) {
    console.error('Error fetching validation rules:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * PATCH /api/validation-rules/:code
 * Body: { active?: boolean, severity?: 'error'|'warning'|'info' }
 *
 * Upserts a row in validation_rule_overrides. The Python engine reads this
 * table at startup (or on each run) to know which rules are muted.
 */
export async function patchValidationRuleRoute(req, res) {
  try {
    const { code } = req.params
    const { active, severity } = req.body || {}

    if (!RULES.find(r => r.code === code)) {
      return res.status(404).json({ error: 'unknown_rule', message: `Unknown rule code: ${code}` })
    }
    if (active === undefined && severity === undefined) {
      return res.status(400).json({ error: 'no_changes', message: 'Provide active and/or severity' })
    }
    if (severity && !['error', 'warning', 'info'].includes(severity)) {
      return res.status(400).json({ error: 'bad_severity', message: 'severity must be error|warning|info' })
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS validation_rule_overrides (
        code              TEXT PRIMARY KEY,
        active            BOOLEAN NOT NULL DEFAULT TRUE,
        severity_override TEXT,
        updated_by        BIGINT,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const userId = req.user?.userId || null
    const { rows } = await pool.query(`
      INSERT INTO validation_rule_overrides (code, active, severity_override, updated_by, updated_at)
      VALUES ($1, COALESCE($2, TRUE), $3, $4, NOW())
      ON CONFLICT (code) DO UPDATE
        SET active = COALESCE($2, validation_rule_overrides.active),
            severity_override = COALESCE($3, validation_rule_overrides.severity_override),
            updated_by = $4,
            updated_at = NOW()
      RETURNING code, active, severity_override
    `, [code, active ?? null, severity ?? null, userId])

    res.json(rows[0])
  } catch (err) {
    console.error('Error patching validation rule:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
