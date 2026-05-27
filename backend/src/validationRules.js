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
import { recordAudit } from './auditEvents.js'

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
 * Pull a stored mismatch code down to its short prefix.
 *   "E003_PO_NOT_FOUND"   → "E003"
 *   "E003"                → "E003"
 * The Python engine writes short codes ("E003") into
 * `invoices.mismatches->errors[].code`, but the rule catalog uses long
 * codes ("E003_PO_NOT_FOUND"). All count + sample lookups normalise both
 * sides to the short form before matching, so the two stores stay in
 * sync regardless of which form gets written next.
 */
function shortCode(code) {
  if (!code) return ''
  return String(code).split('_')[0].toUpperCase()
}

/**
 * Look up the live count of invoices currently failing each rule. Counts
 * are aggregated by short prefix (E003, E022, …) so both legacy short
 * codes and the long-form rule codes match.
 *
 * Reads from `invoices.validation_errors->errors[]` (populated by
 * `validateAndUpdateInvoiceStatus` in poInvoiceValidation.js). NOT
 * `mismatches` — that column is owned by the dual-source reconcile flow
 * and uses a different shape (flat array of field diffs).
 *
 * Counts are scoped to invoices currently in a pending status so the
 * reconciliation queue reflects only invoices the user can act on, not
 * historical errors from invoices that have since been validated.
 */
async function fetchLiveCounts() {
  try {
    const { rows } = await pool.query(`
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
    `)
    return Object.fromEntries(rows.map(r => [r.code, r.n]))
  } catch (err) {
    // validation_errors column might not exist yet — first call to
    // validateAndUpdateInvoiceStatus auto-creates it. Return empty until
    // then so the page renders an empty queue instead of 500'ing.
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
 * Distinct-invoice rollups for the Reconciliation page's KPI strip.
 *
 * The previous frontend computed totals by summing per-rule counts, which
 * double-counts every invoice that fails more than one rule (1 invoice with
 * 3 errors → counted 3 times). These queries use COUNT(DISTINCT invoice_id)
 * over the live `validation_errors->errors[]` JSONB so the topline numbers
 * always match what the user sees in the invoice list.
 */
async function fetchReconcileStats() {
  const empty = { total_in_queue: 0, awaiting_reference_data: 0, re_validation_needed: 0 }
  try {
    const { rows } = await pool.query(`
      WITH inv_with_codes AS (
        SELECT i.invoice_id,
               array_agg(DISTINCT split_part(e->>'code','_',1)) AS codes
          FROM invoices i,
               LATERAL jsonb_array_elements(
                 COALESCE(i.validation_errors->'errors', '[]'::jsonb)
               ) AS e
         WHERE e->>'code' IS NOT NULL
           AND e->>'code' <> 'EXXX'
           AND i.status IN ('waiting_for_validation', 'waiting_for_re_validation',
                            'exception_approval',    'debit_note_approval')
         GROUP BY i.invoice_id
      )
      SELECT
        COUNT(*)::int AS total_in_queue,
        -- Awaiting reference data: invoices whose only blockers are missing
        -- master data (PO / supplier). These are unblocked by reloading
        -- reference data, not by code fixes.
        COUNT(*) FILTER (
          WHERE codes && ARRAY['E002','E003','E004']
        )::int AS awaiting_reference_data,
        -- Re-validation needed: has at least one code OTHER than the
        -- reference-data set (qty / price / GST / GRN / open-PO etc.).
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM unnest(codes) c
             WHERE c NOT IN ('E002','E003','E004')
          )
        )::int AS re_validation_needed
      FROM inv_with_codes
    `)
    const row = rows[0] || {}
    return {
      total_in_queue:          Number(row.total_in_queue || 0),
      awaiting_reference_data: Number(row.awaiting_reference_data || 0),
      re_validation_needed:    Number(row.re_validation_needed || 0),
    }
  } catch (err) {
    console.warn('validation-rules: fetchReconcileStats failed, returning empty', err.message)
    return empty
  }
}

/**
 * GET /api/validation-rules
 *
 * Returns the catalog enriched with live counts and any per-rule overrides.
 * Also returns a `stats` block with distinct-invoice counts for the
 * Reconciliation page KPI strip.
 */
export async function getValidationRulesRoute(_req, res) {
  try {
    const [counts, overrides, stats] = await Promise.all([
      fetchLiveCounts(),
      fetchOverrides(),
      fetchReconcileStats(),
    ])
    const rules = RULES.map(r => {
      const o = overrides[r.code]
      // Look counts up by short prefix (E003) so we hit the bucket
      // populated from invoices.mismatches regardless of whether the
      // engine stored the long or short form.
      return {
        ...r,
        count:    counts[shortCode(r.code)] || 0,
        active:   o?.active ?? true,
        severity: o?.severity_override || r.severity
      }
    })
    res.json({ rules, total: rules.length, stats })
  } catch (err) {
    console.error('Error fetching validation rules:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * GET /api/reconciliation/by-code/:code?limit=10
 *
 * Returns the most recent invoices currently failing the given rule code.
 * Used by the redesigned Reconciliation page to populate the sample list
 * inside each error-code group.
 */
export async function getInvoicesByErrorCodeRoute(req, res) {
  try {
    const { code } = req.params
    if (!code) return res.status(400).json({ error: 'code_required' })
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100)

    // Match either the long form (E003_PO_NOT_FOUND) or the short prefix
    // (E003) — both are normalised to the short form for comparison so
    // either format works on the wire.
    const codeShort = shortCode(code)
    const sql = `
      SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.total_amount,
             i.po_number, i.status, i.source,
             COALESCE(s.supplier_name, '') AS supplier_name
        FROM invoices i
        LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
        WHERE i.status IN ('waiting_for_validation', 'waiting_for_re_validation',
                           'exception_approval',    'debit_note_approval')
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements(
                COALESCE(i.validation_errors->'errors', '[]'::jsonb)
              ) AS e
             WHERE split_part(e->>'code', '_', 1) = $1
          )
        ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_id DESC
        LIMIT $2
    `
    try {
      const { rows } = await pool.query(sql, [codeShort, limit])
      res.json({ code, items: rows })
    } catch (err) {
      // mismatches column / errors structure missing — return empty.
      console.warn('reconciliation by-code:', err.message)
      res.json({ code, items: [] })
    }
  } catch (err) {
    console.error('Error fetching invoices by error code:', err)
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

    const userId = req.user?.user_id || null
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

    // Audit the change — compliance teams need to see who muted what and
    // when, which the override table alone (one row per code, overwritten
    // on every change) doesn't preserve historically.
    const ruleDef = RULES.find(r => r.code === code)
    const summary = active === false
      ? `Disabled rule ${code} (${ruleDef?.name || ''})`
      : active === true
        ? `Enabled rule ${code} (${ruleDef?.name || ''})`
        : severity
          ? `Set severity of ${code} to ${severity}`
          : `Updated rule ${code}`
    recordAudit({
      actorKind: 'user',
      actorId: userId,
      actorLabel: req.user?.username || req.user?.full_name || null,
      action: 'validation_rule_changed',
      entityKind: 'rule',
      entityId: code,
      entityLabel: ruleDef?.name || code,
      summary,
      meta: { active: active ?? null, severity: severity ?? null }
    })

    res.json(rows[0])
  } catch (err) {
    console.error('Error patching validation rule:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}

/**
 * POST /api/validation-rules/revalidate-all-pending
 *
 * Re-runs the validation engine on every invoice that hasn't yet been
 * approved by a human (downstream states `ready_for_payment` / `paid` /
 * `rejected` are excluded because they've already cleared the validation
 * gate via human action).
 *
 * Statuses included by default:
 *   • waiting_for_validation
 *   • waiting_for_re_validation
 *   • exception_approval
 *   • debit_note_approval
 *   • **validated**  ← included so rule-set upgrades flush out invoices
 *                       that were marked valid under an older, more
 *                       permissive engine. Any new error demotes them
 *                       back to waiting_for_re_validation.
 *
 * Each invocation persists per-rule findings to `invoices.validation_errors`
 * (auto-created), so the Reconciliation page's count rollup stays accurate.
 *
 * Returns { total, succeeded, failed, started_at, finished_at } so the UI
 * can render a progress summary.
 */
export async function revalidateAllPendingRoute(req, res) {
  // Lazy-imported to avoid circular dep (poInvoiceValidation imports pool
  // which imports this file transitively).
  const { validateAndUpdateInvoiceStatus } = await import('./poInvoiceValidation.js')
  const startedAt = new Date().toISOString()
  try {
    const { rows } = await pool.query(
      `SELECT invoice_id FROM invoices
        WHERE status IN ('waiting_for_validation', 'waiting_for_re_validation',
                         'exception_approval',    'debit_note_approval',
                         'validated')
        ORDER BY invoice_id ASC`
    )
    let succeeded = 0
    let failed = 0
    for (const r of rows) {
      try {
        await validateAndUpdateInvoiceStatus(r.invoice_id)
        succeeded++
      } catch (err) {
        failed++
        console.warn(`revalidate ${r.invoice_id} failed:`, err.message)
      }
    }
    const finishedAt = new Date().toISOString()

    recordAudit({
      actorKind: 'user',
      actorId: req.user?.user_id,
      actorLabel: req.user?.username || req.user?.full_name || null,
      action: 'validation_revalidate_all',
      entityKind: 'rule',
      entityId: 'all',
      summary: `Re-validated ${rows.length} pending invoices (${succeeded} ok / ${failed} failed)`,
      meta: { total: rows.length, succeeded, failed }
    })

    res.json({
      total: rows.length,
      succeeded,
      failed,
      started_at: startedAt,
      finished_at: finishedAt
    })
  } catch (err) {
    console.error('Error in revalidate-all-pending:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
}
