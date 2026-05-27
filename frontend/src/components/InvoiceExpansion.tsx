import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import StatusChip from './StatusChip'
import Pipeline from './Pipeline'
import type { PipelineStep, PipelineStepState } from './Pipeline'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatDateTime, formatINRSymbol, formatQty, parseAmount } from '../utils/format'
import { useAuth } from '../contexts/AuthContext'

// Rule codes that mean "we don't have enough reference data to validate yet".
// The admin Approve button is hidden when any of these are present — they
// need to be resolved by loading more data, not by an override.
const REFERENCE_DATA_CODES = new Set(['E002', 'E003', 'E004', 'E051', 'E070', 'E074'])

/**
 * Rich inline detail pane for an invoice row. Redesigned with sub-tabs.
 *
 *   ┌─ header strip (status, invoice #, total, validate btn) ┐
 *   ├─ document timeline (PO → ASN → GRN → Invoice → Paid)  ┤
 *   ├─ sub-tabs: Overview · Line items · PO · GRN/ASN · Val ┤
 *   └─ active sub-tab content ─────────────────────────────┘
 *
 * Fetches (in parallel) on expand:
 *   /invoices/:id                       — header + items + poLineItems
 *   /grn?poNumber=...                   — GRN rows for PO
 *   /asn?poNumber=...                   — ASN rows for PO
 *   /invoices/:id/validation-summary    — errors + warnings
 *
 * Module-level Map cache, keyed by invoice_id, so collapse + expand
 * is instant.
 */

interface InvoiceLine {
  invoice_line_id?: number
  sequence_number?: number | string | null
  item_name?: string | null
  hsn_sac?: string | null
  uom?: string | null
  billed_qty?: number | string | null
  rate?: number | string | null
  line_total?: number | string | null
  taxable_value?: number | string | null
  cgst_rate?: number | string | null
  cgst_amount?: number | string | null
  sgst_rate?: number | string | null
  sgst_amount?: number | string | null
  igst_rate?: number | string | null
  igst_amount?: number | string | null
}

interface PoLine {
  po_line_id?: number
  sequence_number?: number | string | null
  item_id?: string | null
  item_name?: string | null
  item_description?: string | null
  quantity?: number | string | null
  unit_cost?: number | string | null
}

interface InvoiceDetail {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  scanning_number: string | null
  total_amount: number | string | null
  tax_amount: number | string | null
  debit_note_value: number | string | null
  payment_due_date: string | null
  status: string | null
  created_at: string | null
  updated_at: string | null
  notes: string | null
  supplier_name: string | null
  supplier_gst: string | null
  supplier_pan: string | null
  supplier_email: string | null
  supplier_phone: string | null
  supplier_address: string | null
  po_id: number | null
  po_number: string | null
  po_date: string | null
  po_pfx: string | null
  po_amd_no: number | string | null
  po_status: string | null
  po_terms: string | null
  items?: InvoiceLine[]
  poLineItems?: PoLine[]
}

interface Attachment {
  id: number
  type: 'invoice' | 'weight_slip'
  file_name: string | null
}

interface GRNRow {
  id: number
  grn_no: string | null
  grn_date: string | null
  item: string | null
  description_1: string | null
  uom: string | null
  grn_qty: number | string | null
  accepted_qty: number | string | null
  unit_cost: number | string | null
  header_status: string | null
  supplier_doc_no: string | null
}

interface ASNRow {
  id: number
  asn_no: string | null
  dc_date: string | null
  transporter_name: string | null
  transporter: string | null
  lr_no: string | null
  item_code: string | null
  item_desc: string | null
  quantity: number | string | null
  status: string | null
  inv_no: string | null
}

interface ValidationIssue {
  code: string
  message: string
  severity?: string
}

/**
 * The backend currently pushes plain strings into validation `errors`/
 * `warnings` arrays in poInvoiceValidation.js (e.g. `errors.push('Invoice
 * is not linked to a PO')`), but the UI was designed around objects with
 * `{ code, message }`. Normalise both shapes here so the UI keeps working
 * regardless of which side gets cleaned up first. When the backend is
 * updated to emit real `{code, message}` objects, this still passes them
 * through unchanged.
 */
function normalizeIssue(raw: unknown): ValidationIssue {
  if (typeof raw === 'string') return { code: '', message: raw }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    return {
      code: typeof obj.code === 'string' ? obj.code : '',
      message:
        typeof obj.message === 'string'
          ? obj.message
          : typeof obj.text === 'string'
          ? obj.text
          : JSON.stringify(obj),
      severity: typeof obj.severity === 'string' ? obj.severity : undefined,
    }
  }
  return { code: '', message: String(raw ?? '') }
}

function normalizeValidation(raw: unknown): ValidationSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  return {
    ...(obj as ValidationSummary),
    errors: Array.isArray(obj.errors) ? obj.errors.map(normalizeIssue) : [],
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map(normalizeIssue) : [],
    info: Array.isArray(obj.info) ? obj.info.map(normalizeIssue) : [],
  }
}

/* Rich detail bundle returned by /api/invoices/:id/validation-summary.
 * Surfaces WHY the invoice is waiting and WHAT differs (PO vs invoice vs GRN).
 *
 * Field names match what `runFullValidation()` in poInvoiceValidation.js
 * actually emits per line — `index` (1-based row number, NOT sequence_number),
 * `itemName`, camelCase qty/rate/total, plus the three `*Match` flags. */
interface ValidationLineDetail {
  index?: number | null
  invoiceLineId?: number | null
  poLineId?: number | null
  itemName?: string | null
  invQty?: number | string | null
  poQty?: number | string | null
  invRate?: number | string | null
  poRate?: number | string | null
  invLineTotal?: number | string | null
  quantityMatch?: boolean | null
  rateMatch?: boolean | null
  lineTotalMatch?: boolean | null
  errors?: string[]
  warnings?: string[]
}

interface ValidationDetails {
  header?: {
    invoice?: Record<string, unknown> | null
    po?: Record<string, unknown> | null
    supplierMatch?: boolean | null
    errors?: string[]
    warnings?: string[]
  }
  lines?: ValidationLineDetail[]
  totals?: {
    thisInvQty?: number | string | null
    poQty?: number | string | null
    grnQty?: number | string | null
    thisInvAmount?: number | string | null
    poAmount?: number | string | null
    errors?: string[]
    warnings?: string[]
  }
  grn?: {
    grnQty?: number | string | null
    invLteGrn?: boolean | null
    errors?: string[]
  }
  asn?: {
    asnCount?: number | null
    warnings?: string[]
  }
}

interface ValidationSummary {
  valid?: boolean
  reason?: string | null
  validationFailureReason?: string | null
  isShortfall?: boolean
  isOpenPo?: boolean
  poAlreadyFulfilled?: boolean
  thisInvQty?: number | string | null
  poQty?: number | string | null
  grnQty?: number | string | null
  errors?: ValidationIssue[]
  warnings?: ValidationIssue[]
  info?: ValidationIssue[]
  details?: ValidationDetails | null
  validated_at?: string | null
}

interface SnapshotLineItem {
  sequence?: number | null
  item_name?: string | null
  hsn_sac?: string | null
  quantity?: number | null
  uom?: string | null
  rate?: number | null
  taxable_value?: number | null
  cgst_amount?: number | null
  sgst_amount?: number | null
  igst_amount?: number | null
  line_total?: number | null
}

interface InvoiceSnapshot {
  invoice_number?: string | null
  invoice_date?: string | null
  supplier_gstin?: string | null
  supplier_name?: string | null
  po_number?: string | null
  subtotal?: number | null
  cgst?: number | null
  sgst?: number | null
  igst?: number | null
  tax_amount?: number | null
  total_amount?: number | null
  line_items?: SnapshotLineItem[]
}

interface Mismatch {
  field: string
  excel_value: unknown
  ocr_value: unknown
  delta?: number | null
  tolerance?: string
  severity?: 'low' | 'medium' | 'high'
}

interface ReconciliationState {
  source: string | null
  reconciliation_status: string | null
  excel_snapshot: InvoiceSnapshot | null
  excel_received_at: string | null
  ocr_snapshot: InvoiceSnapshot | null
  ocr_received_at: string | null
  mismatches: Mismatch[] | null
  reviewed_by: number | null
  reviewed_at: string | null
}

interface DebitNoteDetailRow {
  debit_note_detail_id: number
  debit_note_id: number
  line_number: number | null
  description: string | null
  quantity: number | string | null
  unit_price: number | string | null
  amount: number | string | null
  notes: string | null
}

interface DebitNote {
  debit_note_id: number
  file_name: string | null
  notes: string | null
  uploaded_at: string | null
  created_at: string | null
  details: DebitNoteDetailRow[]
}

interface PoFulfillment {
  po_value: number | string | null
  invoiced_amount: number | string | null
  pct_consumed: number | null
  sibling_exceptions_count: number | null
}

interface Reviewer {
  user_id: number
  username: string | null
  full_name: string | null
}

interface FetchState {
  loading: boolean
  error: string
  detail: InvoiceDetail | null
  grn: GRNRow[]
  asn: ASNRow[]
  validation: ValidationSummary | null
  attachments: Attachment[]
  reconciliation: ReconciliationState | null
  debitNotes: DebitNote[]
  debitNoteTotal: number
  poFulfillment: PoFulfillment | null
  reviewer: Reviewer | null
}

const emptyState: FetchState = {
  loading: false,
  error: '',
  detail: null,
  grn: [],
  asn: [],
  validation: null,
  attachments: [],
  reconciliation: null,
  debitNotes: [],
  debitNoteTotal: 0,
  poFulfillment: null,
  reviewer: null
}

const cache = new Map<number, FetchState>()

type SubTab = 'overview' | 'lines' | 'po' | 'receipts' | 'validation' | 'attachments' | 'reconciliation' | 'audit'

export default function InvoiceExpansion({
  invoiceId,
  poNumber
}: {
  invoiceId: number
  poNumber: string | null | undefined
}) {
  const { user } = useAuth()
  const role = (user?.role || '').toLowerCase()
  const canManuallyApprove = role === 'admin' || role === 'manager' || role === 'finance'
  const [state, setState] = useState<FetchState>(() => cache.get(invoiceId) ?? emptyState)
  const [validating, setValidating] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [tab, setTab] = useState<SubTab>('overview')
  const [showResolution, setShowResolution] = useState(false)
  const [resolving, setResolving] = useState(false)
  // Inline debit-note review panel — replaces the legacy window.prompt.
  // Pre-fills with SUM(debit_note_details.amount) so the approver normally
  // just clicks "Approve" after sanity-checking the lines.
  const [showDebitNotePanel, setShowDebitNotePanel] = useState(false)
  const [debitNoteValueInput, setDebitNoteValueInput] = useState('')
  const aliveRef = useRef(true)

  const loadAll = useCallback(
    async (forceFresh = false) => {
      if (!forceFresh) {
        const cached = cache.get(invoiceId)
        if (cached && cached.detail) {
          setState(cached)
          return
        }
      }
      setState({ ...emptyState, loading: true })
      try {
        const [invRes, vsRes] = await Promise.all([
          apiFetch(`invoices/${invoiceId}`),
          apiFetch(`invoices/${invoiceId}/validation-summary`).catch(() => null)
        ])
        if (!invRes.ok) throw new Error(await getErrorMessageFromResponse(invRes, 'Failed to load invoice'))
        const detail: InvoiceDetail = await invRes.json()

        const poRef = poNumber || detail.po_number
        let grnRows: GRNRow[] = []
        let asnRows: ASNRow[] = []
        if (poRef) {
          const [grnRes, asnRes] = await Promise.all([
            apiFetch(`grn?poNumber=${encodeURIComponent(poRef)}&limit=500`).catch(() => null),
            apiFetch(`asn?poNumber=${encodeURIComponent(poRef)}&limit=500`).catch(() => null)
          ])
          if (grnRes && grnRes.ok) {
            const body = await grnRes.json()
            const allGrn: GRNRow[] = Array.isArray(body) ? body : (body.items || [])
            // Scope GRN to THIS invoice. The receipt for an invoice is the GRN
            // whose supplier_doc_no equals the invoice number (same link the
            // engine uses for E071). On an open PO the PO-level fetch returns
            // every invoice's GRN (e.g. 119 rows / 84 invoices) — showing them
            // all is misleading. Fall back to the full set only when no GRN
            // carries this invoice number (standard POs / older data where
            // supplier_doc_no isn't populated).
            const invNum = (detail.invoice_number || '').trim().toLowerCase()
            const scoped = invNum
              ? allGrn.filter((g) => (g.supplier_doc_no || '').trim().toLowerCase() === invNum)
              : []
            grnRows = scoped.length > 0 ? scoped : allGrn
          }
          if (asnRes && asnRes.ok) {
            const body = await asnRes.json()
            const allAsn: ASNRow[] = Array.isArray(body) ? body : (body.items || [])
            // Scope ASN to THIS invoice the same way as GRN — match the ASN's
            // inv_no to the invoice number (the engine's E073 link). Falls back
            // to the full PO-level set when no ASN carries this invoice number.
            const invNum = (detail.invoice_number || '').trim().toLowerCase()
            const scoped = invNum
              ? allAsn.filter((a) => (a.inv_no || '').trim().toLowerCase() === invNum)
              : []
            asnRows = scoped.length > 0 ? scoped : allAsn
          }
        }

        let validation: ValidationSummary | null = null
        if (vsRes && vsRes.ok) {
          validation = normalizeValidation(await vsRes.json())
        }

        // Fetch attachments
        let attachments: Attachment[] = []
        try {
          const attRes = await apiFetch(`invoices/${invoiceId}/attachments`)
          if (attRes && attRes.ok) {
            const attBody = await attRes.json()
            attachments = Array.isArray(attBody) ? attBody : []
          }
        } catch {
          /* swallow — attachments are optional */
        }

        // Fetch dual-source reconciliation state
        let reconciliation: ReconciliationState | null = null
        try {
          const recRes = await apiFetch(`invoices/${invoiceId}/reconciliation`)
          if (recRes && recRes.ok) {
            reconciliation = await recRes.json()
          }
        } catch {
          /* swallow — legacy single-source rows return nothing useful */
        }

        // Pull debit-note file rows, PO fulfillment context, and reviewer
        // attribution from /full. Keep this lazy/optional — the slide-over
        // works without it; these fields enrich the action panels.
        let debitNotes: DebitNote[] = []
        let debitNoteTotal = 0
        let poFulfillment: PoFulfillment | null = null
        let reviewer: Reviewer | null = null
        try {
          const fullRes = await apiFetch(`invoices/${invoiceId}/full`)
          if (fullRes && fullRes.ok) {
            const body = await fullRes.json()
            debitNotes      = Array.isArray(body.debit_notes) ? body.debit_notes : []
            debitNoteTotal  = Number(body.debit_note_total || 0)
            poFulfillment   = body.po_fulfillment || null
            reviewer        = body.reviewer || null
          }
        } catch {
          /* swallow — /full is enrichment-only */
        }

        const next: FetchState = {
          loading: false,
          error: '',
          detail,
          grn: grnRows,
          asn: asnRows,
          validation,
          attachments,
          reconciliation,
          debitNotes,
          debitNoteTotal,
          poFulfillment,
          reviewer
        }
        cache.set(invoiceId, next)
        if (aliveRef.current) setState(next)
      } catch (err) {
        if (aliveRef.current) {
          setState({ ...emptyState, error: getDisplayError(err) })
        }
      }
    },
    [invoiceId, poNumber]
  )

  useEffect(() => {
    aliveRef.current = true
    loadAll(false)
    return () => {
      aliveRef.current = false
    }
  }, [loadAll])

  const handleValidate = async () => {
    setActionMessage(null)
    setShowResolution(false)
    setValidating(true)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/validate`, { method: 'POST' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Validation failed'))
      const body = await res.json()
      cache.delete(invoiceId)
      await loadAll(true)
      setTab('validation')
      if (body.action === 'shortfall') {
        // Shortfall detected — show resolution dialog
        setShowResolution(true)
        setActionMessage({ tone: 'danger', text: `Shortfall detected: ${body.validationFailureReason || 'quantity/price mismatch'}. Choose how to proceed below.` })
      } else if (body.action === 'validated') {
        setActionMessage({ tone: 'success', text: 'Invoice validated successfully and ready for payment.' })
      } else if (body.action === 'exception_approval') {
        setActionMessage({ tone: 'danger', text: 'PO is already fulfilled — routed to exception approval.' })
      } else {
        setActionMessage({ tone: 'success', text: 'Validation ran successfully. Latest results loaded below.' })
      }
    } catch (err) {
      setActionMessage({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setValidating(false)
    }
  }

  const handleResolution = async (resolution: 'proceed_to_payment' | 'send_to_debit_note') => {
    setResolving(true)
    setActionMessage(null)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/validate-resolution`, {
        method: 'POST',
        body: JSON.stringify({ resolution })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Resolution failed'))
      const body = await res.json()
      cache.delete(invoiceId)
      await loadAll(true)
      setShowResolution(false)
      if (body.action === 'validated') {
        setActionMessage({ tone: 'success', text: 'Invoice approved for payment despite the shortfall.' })
      } else if (body.action === 'debit_note_approval') {
        setActionMessage({ tone: 'success', text: 'Invoice sent to debit-note approval queue.' })
      }
      setTab('validation')
    } catch (err) {
      setActionMessage({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setResolving(false)
    }
  }

  const handleExceptionApprove = async () => {
    setResolving(true)
    setActionMessage(null)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/exception-approve`, { method: 'PATCH' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Exception approval failed'))
      cache.delete(invoiceId)
      await loadAll(true)
      setActionMessage({ tone: 'success', text: 'Exception approved — invoice moved to validated.' })
    } catch (err) {
      setActionMessage({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setResolving(false)
    }
  }

  /**
   * Admin override — manually mark this invoice validated. Only offered to
   * admin/manager/finance roles, and only when reference data is complete
   * (PO + GRN/DC present, supplier resolved) but soft mismatches remain
   * (rate/qty/supplier/GST drift). The button's visibility is computed
   * later from the engine's findings; the handler itself just POSTs.
   */
  const handleAdminApprove = async () => {
    if (!window.confirm(
      'Manually validate this invoice despite the open blockers? ' +
      'The original validation errors will be kept in the audit log.'
    )) return
    setResolving(true)
    setActionMessage(null)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/admin-approve`, { method: 'POST' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Admin approval failed'))
      cache.delete(invoiceId)
      await loadAll(true)
      setActionMessage({ tone: 'success', text: 'Manually validated — invoice moved to validated.' })
    } catch (err) {
      setActionMessage({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setResolving(false)
    }
  }

  /**
   * Open the inline review panel. Pre-fills the value field with the sum
   * of debit_note_details.amount so the reviewer almost always just clicks
   * "Approve". If no details are on file, falls back to the existing
   * invoice.debit_note_value, else the invoice total_amount.
   */
  const openDebitNotePanel = () => {
    const dnTotal = state.debitNoteTotal
    const existing = parseAmount(state.detail?.debit_note_value)
    const total = parseAmount(state.detail?.total_amount)
    const prefill =
      dnTotal > 0   ? dnTotal :
      existing != null ? existing :
      total != null    ? total : 0
    setDebitNoteValueInput(prefill > 0 ? prefill.toFixed(2) : '')
    setShowDebitNotePanel(true)
    setActionMessage(null)
  }

  const submitDebitNoteApprove = async () => {
    const value = parseFloat(debitNoteValueInput)
    if (!Number.isFinite(value) || value <= 0) {
      setActionMessage({ tone: 'danger', text: 'Enter a valid positive amount.' })
      return
    }
    setResolving(true)
    setActionMessage(null)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/debit-note-approve`, {
        method: 'PATCH',
        body: JSON.stringify({ debit_note_value: value })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Debit note approval failed'))
      cache.delete(invoiceId)
      setShowDebitNotePanel(false)
      await loadAll(true)
      setActionMessage({ tone: 'success', text: `Debit note approved (₹${value.toFixed(2)}) — invoice moved to validated.` })
    } catch (err) {
      setActionMessage({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setResolving(false)
    }
  }

  const handleDownloadAttachment = async (att: Attachment) => {
    try {
      const res = await apiFetch(`invoices/${invoiceId}/attachments/${att.type}/${att.id}?download=1`)
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = att.file_name || `${att.type}_${att.id}.pdf`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (err) {
      setActionMessage({ tone: 'danger', text: getDisplayError(err) })
    }
  }

  /* ---------- derived ---------- */
  const d = state.detail
  const lines: InvoiceLine[] = d?.items || []
  const poLines: PoLine[] = d?.poLineItems || []
  const status = (d?.status || '').toLowerCase().trim()

  const errors = state.validation?.errors ?? []
  const warnings = state.validation?.warnings ?? []
  const issueCount = errors.length + warnings.length

  const ACTIONABLE_STATUSES = useMemo(
    () => new Set(['waiting_for_validation', 'waiting_for_re_validation', 'exception_approval', 'debit_note_approval', '']),
    []
  )
  const showValidateButton = ACTIONABLE_STATUSES.has(status)

  /**
   * Admin Approve visibility — only offer the manual override when the
   * invoice is stuck on soft mismatches (rate / qty / supplier / GST)
   * AND has full reference data (PO, GRN/DC, supplier resolved). The
   * REFERENCE_DATA_CODES set is the "we don't have the documents yet"
   * blockers; if any of those are firing, the right action is to load
   * the missing data, not to override.
   */
  const shortErrCodes = useMemo(
    () => errors.map((e) => (e.code || '').split('_')[0]).filter(Boolean),
    [errors]
  )
  const hasReferenceGap = shortErrCodes.some((c) => REFERENCE_DATA_CODES.has(c))
  const hasMismatchOnly = errors.length > 0 && !hasReferenceGap
  const showAdminApprove =
    canManuallyApprove &&
    status === 'waiting_for_re_validation' &&
    hasMismatchOnly
  const buttonLabel = validating
    ? 'Running…'
    : status === 'waiting_for_validation'
    ? 'Validate now'
    : 'Re-validate'

  // Amount breakdown (parses strings → numbers)
  const totals = useMemo(() => {
    let taxable = 0
    let cgst = 0
    let sgst = 0
    let igst = 0
    for (const ln of lines) {
      taxable += parseAmount(ln.taxable_value) ?? 0
      cgst    += parseAmount(ln.cgst_amount)   ?? 0
      sgst    += parseAmount(ln.sgst_amount)   ?? 0
      igst    += parseAmount(ln.igst_amount)   ?? 0
    }
    const tax = cgst + sgst + igst
    const grand = taxable + tax
    return { taxable, cgst, sgst, igst, tax, grand }
  }, [lines])

  const poTotal = useMemo(() => {
    let t = 0
    for (const pl of poLines) {
      const q = parseAmount(pl.quantity) ?? 0
      const r = parseAmount(pl.unit_cost) ?? 0
      t += q * r
    }
    return t
  }, [poLines])

  /* ---------- early returns ---------- */

  if (state.loading) {
    return (
      <div style={{ padding: '2.2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        <i className="pi pi-spin pi-spinner" style={{ fontSize: '1.6rem', color: 'var(--brand-600)' }} />
        <div style={{ marginTop: '0.6rem', fontSize: '0.88rem' }}>Loading full invoice details…</div>
      </div>
    )
  }

  if (state.error) {
    return (
      <div
        style={{
          margin: '0.75rem 1rem',
          padding: '0.85rem 1rem',
          background: 'var(--status-danger-bg)',
          color: 'var(--status-danger-fg)',
          border: '1px solid var(--status-danger-ring)',
          borderRadius: 'var(--radius-md)'
        }}
      >
        <i className="pi pi-exclamation-triangle" /> {state.error}
      </div>
    )
  }

  if (!d) return null

  /* ---------- render ---------- */

  return (
    <div
      style={{
        padding: '1.1rem 1.25rem 1.5rem',
        background: 'var(--surface-1)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.9rem'
      }}
    >
      {/* ============== Header strip (matches mockup invoiceDetailHTML) ==============
           Flat row: chips above the invoice number on the left, total +
           tax breakdown in the middle, action buttons on the right. No
           gradient background, no icon-in-square — keeps the eye on the
           data, not the chrome. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 18,
          alignItems: 'center'
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            {/* Mockup-canonical chip markup — `chip chip--ok|info|warn|err|mute|vio`.
                Replaces the StatusChip component (which rendered the
                React-DS `status-chip` class). The mockup-compat layer maps
                these classes to the same tokens, so the chrome matches the
                portal.html mockup pixel-for-pixel. */}
            {(() => {
              const s = (d.status || '').toLowerCase()
              if (s === 'validated' || s === 'paid')                  return <span className="chip chip--ok"><i className="pi pi-check" /> Validated</span>
              if (s === 'ready_for_payment' || s === 'partially_paid') return <span className="chip chip--info">Ready for payment</span>
              if (s === 'rejected')                                    return <span className="chip chip--err">Rejected</span>
              if (s === 'waiting_for_validation')                      return <span className="chip chip--warn">Waiting for validation</span>
              if (s === 'waiting_for_re_validation')                   return <span className="chip chip--err">Waiting for re-validation</span>
              if (s === 'debit_note_approval')                         return <span className="chip chip--vio">Debit note</span>
              if (s === 'exception_approval')                          return <span className="chip chip--info">Exception</span>
              return <span className="chip chip--mute">{d.status || '—'}</span>
            })()}
            {(d as InvoiceDetail & { source?: string }).source === 'ocr' && (
              <span className="chip chip--vio">OCR</span>
            )}
            {(d as InvoiceDetail & { source?: string }).source === 'excel' && (
              <span className="chip chip--info">Excel</span>
            )}
            {(d as InvoiceDetail & { source?: string }).source === 'both' && (
              <span className="chip chip--ok">Both</span>
            )}
            {/* PO-type chip — friendly label, not the raw prefix. Open PO
                prefixes are configured in the open_po_prefixes table; for
                anything else we default to "Standard". */}
            {d.po_pfx && (
              <span className="chip chip--mute">
                {/^OP\d?$/i.test(d.po_pfx) ? 'Open PO'
                  : /^SC/i.test(d.po_pfx)  ? 'Subcontract PO'
                  : 'Standard PO'}
              </span>
            )}
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--text-primary)'
            }}
          >
            {d.invoice_number}
          </h2>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--text-muted)',
              marginTop: 2
            }}
          >
            <b style={{ color: 'var(--text-secondary)' }}>{d.supplier_name || '—'}</b>
            {d.invoice_date && <> · {formatDate(d.invoice_date)}</>}
            {d.payment_due_date && <> · due {formatDate(d.payment_due_date)}</>}
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-muted)'
            }}
          >
            Total amount
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              marginTop: 2,
              color: 'var(--text-primary)'
            }}
          >
            {formatINRSymbol(d.total_amount)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Tax {formatINRSymbol(d.tax_amount)} · {lines.length} line{lines.length === 1 ? '' : 's'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {/* Mockup-canonical `.btn .btn--g/p .btn--sm` markup. The
              mockup specifies ghost buttons for read actions (PDF,
              Re-validate) and primary for the decision action (Approve). */}
          <button
            type="button"
            className="btn btn--g btn--sm"
            onClick={() => {
              window.open(`/api/invoices/${d.invoice_id}/pdf`, '_blank', 'noopener,noreferrer')
            }}
          >
            <i className="pi pi-download" /> PDF
          </button>
          {showValidateButton && (
            <button
              type="button"
              className="btn btn--g btn--sm"
              onClick={handleValidate}
              disabled={validating || resolving}
            >
              {validating
                ? <><i className="pi pi-spin pi-spinner" /> {buttonLabel}</>
                : <><i className={`pi ${status === 'waiting_for_validation' ? 'pi-play' : 'pi-refresh'}`} /> {buttonLabel}</>}
            </button>
          )}
          {status === 'exception_approval' && (
            <button
              type="button"
              className="btn btn--p btn--sm"
              onClick={handleExceptionApprove}
              disabled={resolving}
              title="Approve exception — PO was already fulfilled but this invoice should proceed"
            >
              {resolving ? <><i className="pi pi-spin pi-spinner" /> Approving…</> : <><i className="pi pi-check-circle" /> Approve exception</>}
            </button>
          )}
          {showAdminApprove && (
            <button
              type="button"
              className="btn btn--p btn--sm"
              onClick={handleAdminApprove}
              disabled={resolving || validating}
              title="Manually mark this invoice validated. Reference data is complete; only soft mismatches (rate / qty / supplier / GST) remain. Override is recorded in audit."
            >
              {resolving
                ? <><i className="pi pi-spin pi-spinner" /> Approving…</>
                : <><i className="pi pi-check-circle" /> Approve</>}
            </button>
          )}
          {status === 'debit_note_approval' && (
            <button
              type="button"
              className="btn btn--p btn--sm"
              onClick={openDebitNotePanel}
              disabled={resolving}
              title="Review the debit note and approve a value"
            >
              {resolving ? <><i className="pi pi-spin pi-spinner" /> Approving…</> : <><i className="pi pi-minus-circle" /> Review debit note</>}
            </button>
          )}
          {!showValidateButton && status !== 'exception_approval' && status !== 'debit_note_approval' && (
            <span className="chip chip--ok">
              <i className="pi pi-lock" /> Settled
            </span>
          )}
        </div>
      </div>

      {actionMessage && (
        <div
          style={{
            padding: '0.7rem 0.9rem',
            borderRadius: 'var(--radius-md)',
            border: `1px solid var(--status-${actionMessage.tone}-ring)`,
            background: `var(--status-${actionMessage.tone}-bg)`,
            color: `var(--status-${actionMessage.tone}-fg)`,
            fontSize: '0.86rem',
            fontWeight: 600
          }}
        >
          <i className={`pi ${actionMessage.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} />{' '}
          {actionMessage.text}
        </div>
      )}

      {/* Resolution dialog — appears after a shortfall validation result */}
      {showResolution && (
        <div
          style={{
            padding: '1rem 1.15rem',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--status-warn-ring)',
            background: 'var(--status-warn-bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <i className="pi pi-exclamation-triangle" style={{ fontSize: '1.3rem', color: 'var(--status-warn-fg)' }} />
            <div>
              <div style={{ fontWeight: 800, color: 'var(--status-warn-fg)', fontSize: '0.95rem' }}>
                Shortfall detected — how should this invoice proceed?
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--status-warn-fg)', opacity: 0.85, marginTop: '0.15rem' }}>
                The invoice quantity or price differs from the PO. Choose one:
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="action-btn"
              onClick={() => handleResolution('proceed_to_payment')}
              disabled={resolving}
              style={{ flex: 1, justifyContent: 'center', minWidth: 200 }}
            >
              {resolving ? <><i className="pi pi-spin pi-spinner" /></> : <><i className="pi pi-check-circle" /> Proceed to payment</>}
            </button>
            <button
              type="button"
              className="action-btn action-btn--ghost"
              onClick={() => handleResolution('send_to_debit_note')}
              disabled={resolving}
              style={{ flex: 1, justifyContent: 'center', minWidth: 200, color: 'var(--status-warn-fg)' }}
            >
              {resolving ? <><i className="pi pi-spin pi-spinner" /></> : <><i className="pi pi-minus-circle" /> Send to debit note</>}
            </button>
          </div>
        </div>
      )}

      {/* Exception approval context — visible whenever the invoice is in
          exception_approval state so the approver sees *why* the PO is
          considered fulfilled before they bypass the block. */}
      {status === 'exception_approval' && (
        <ExceptionContextStrip
          po_number={d.po_number}
          po_status={d.po_status}
          fulfillment={state.poFulfillment}
        />
      )}

      {/* Debit-note review panel — replaces the legacy window.prompt with a
          structured view of every uploaded debit note + its line items. */}
      {showDebitNotePanel && (
        <DebitNoteReviewPanel
          invoiceId={invoiceId}
          debitNotes={state.debitNotes}
          debitNoteTotal={state.debitNoteTotal}
          invoiceTotal={parseAmount(d.total_amount)}
          valueInput={debitNoteValueInput}
          onChangeValue={setDebitNoteValueInput}
          submitting={resolving}
          onCancel={() => setShowDebitNotePanel(false)}
          onSubmit={submitDebitNoteApprove}
        />
      )}

      {/* Approved debit-note value + reviewer attribution — shown whenever
          a non-null debit_note_value exists. Tells finance the invoice will
          be paid at the negotiated-down amount, by whom, and when. */}
      {d.debit_note_value != null && (
        <AppliedDebitNoteStrip
          totalAmount={d.total_amount}
          debitNoteValue={d.debit_note_value}
          reviewer={state.reviewer}
          updatedAt={d.updated_at}
        />
      )}

      {/* ============== 7-step pipeline (matches mockup invoiceDetailHTML) ==============
           PO → ASN → GRN → Invoice → Validated → Approved → Paid.
           Derived state — `done` if the row exists, `failed` if validation
           found blockers, `current` for the active step, `pending` after. */}
      {(() => {
        const hasPo  = !!d.po_id
        const hasAsn = state.asn.length > 0
        const hasGrn = state.grn.length > 0
        const validated = ['validated', 'ready_for_payment', 'paid', 'partially_paid'].includes(status)
        const approved  = ['ready_for_payment', 'paid', 'partially_paid'].includes(status)
        const paid      = ['paid', 'partially_paid'].includes(status)
        const validateState: PipelineStepState =
          validated ? 'done' :
          errors.length > 0 ? 'failed' :
          hasGrn ? 'current' : 'pending'

        const steps: PipelineStep[] = [
          { label: 'PO',        state: hasPo  ? 'done' : 'pending', meta: d.po_number || '—' },
          { label: 'ASN',       state: hasAsn ? 'done' : 'pending', meta: hasAsn ? 'sent' : '—' },
          { label: 'GRN',       state: hasGrn ? 'done' : 'pending', meta: hasGrn ? 'booked' : '—' },
          { label: 'Invoice',   state: 'done',                       meta: formatDate(d.invoice_date) || '—' },
          { label: 'Validated', state: validateState,                meta: validated ? 'done' : errors.length > 0 ? `${errors.length} issue${errors.length === 1 ? '' : 's'}` : 'pending' },
          { label: 'Approved',  state: approved ? 'done' : validated ? 'current' : 'pending', meta: approved ? 'done' : 'awaiting' },
          { label: 'Paid',      state: paid     ? 'done' : approved  ? 'current' : 'pending', meta: paid ? 'done' : d.payment_due_date ? `due ${formatDate(d.payment_due_date)}` : 'pending' }
        ]
        return <Pipeline steps={steps} />
      })()}

      {/* ============== Sub-tabs ============== */}
      {/* Canonical mockup tabs — `.tabs` container with `.tab` text pills.
          No icons (the mockup deliberately omits them at this level).
          Counts are inlined as `<span class="muted">(N)</span>` to match
          portal.html invoiceDetailHTML lines 2527-2535. */}
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button type="button" className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          Overview
        </button>
        <button type="button" className={`tab ${tab === 'lines' ? 'active' : ''}`} onClick={() => setTab('lines')}>
          Lines <span className="muted">({lines.length})</span>
        </button>
        <button type="button" className={`tab ${tab === 'po' ? 'active' : ''}`} onClick={() => setTab('po')}>
          PO match
        </button>
        <button type="button" className={`tab ${tab === 'receipts' ? 'active' : ''}`} onClick={() => setTab('receipts')}>
          Receipts <span className="muted">({state.grn.length + state.asn.length})</span>
        </button>
        <button type="button" className={`tab ${tab === 'validation' ? 'active' : ''}`} onClick={() => setTab('validation')}>
          Validation
          {issueCount > 0 && (
            <span className={`chip ${errors.length > 0 ? 'chip--err' : 'chip--warn'}`} style={{ marginLeft: 6, padding: '1px 6px', fontSize: 10 }}>
              {issueCount}
            </span>
          )}
        </button>
        <button type="button" className={`tab ${tab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')}>
          Attachments
          {state.attachments.length > 0 && <span className="muted"> ({state.attachments.length})</span>}
        </button>
        {state.reconciliation && (state.reconciliation.excel_snapshot || state.reconciliation.ocr_snapshot) && (
          <button type="button" className={`tab ${tab === 'reconciliation' ? 'active' : ''}`} onClick={() => setTab('reconciliation')}>
            Reconciliation
            {state.reconciliation.reconciliation_status === 'pending_reconciliation' && (
              <span className="chip chip--warn" style={{ marginLeft: 6, padding: '1px 6px', fontSize: 10 }}>
                {state.reconciliation.mismatches?.length ?? '!'}
              </span>
            )}
          </button>
        )}
        <button type="button" className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          Audit
        </button>
      </div>

      {/* ============== Active tab content ============== */}
      {tab === 'overview' && (
        <OverviewTab
          detail={d}
          totals={totals}
          poTotal={poTotal}
          lineCount={lines.length}
          poLineCount={poLines.length}
          grnCount={state.grn.length}
          asnCount={state.asn.length}
        />
      )}

      {tab === 'lines' && <LineItemsTab lines={lines} totals={totals} />}

      {tab === 'po' && <PoTab detail={d} poLines={poLines} poTotal={poTotal} />}

      {tab === 'receipts' && <ReceiptsTab grn={state.grn} asn={state.asn} />}

      {tab === 'validation' && (
        <ValidationTab
          status={status}
          errors={errors}
          warnings={warnings}
          summary={state.validation || null}
          poNumber={d.po_number || null}
          invoiceTotal={d.total_amount}
          validatedAt={state.validation?.validated_at || null}
        />
      )}

      {tab === 'reconciliation' && state.reconciliation && (
        <ReconciliationTab
          invoiceId={invoiceId}
          data={state.reconciliation}
          onReviewed={() => loadAll(true)}
        />
      )}

      {tab === 'attachments' && (
        <Panel icon="pi-paperclip" color="var(--brand-600)" title={`Attachments (${state.attachments.length})`}>
          {state.attachments.length === 0 ? (
            <EmptyRow>No attachments uploaded for this invoice.</EmptyRow>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              {state.attachments.map((att) => (
                <div
                  key={`${att.type}-${att.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.7rem',
                    padding: '0.6rem 0.75rem',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      background: att.type === 'invoice'
                        ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                        : 'linear-gradient(135deg, #f59e0b, #f97316)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.88rem',
                      flexShrink: 0
                    }}
                  >
                    <i className={`pi ${att.type === 'invoice' ? 'pi-file-pdf' : 'pi-sliders-h'}`} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {att.file_name || `${att.type}_${att.id}`}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                      {att.type === 'weight_slip' ? 'Weight slip' : 'Invoice PDF'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="action-btn action-btn--ghost"
                    onClick={() => handleDownloadAttachment(att)}
                    title="Download this file"
                    style={{ fontSize: '0.8rem' }}
                  >
                    <i className="pi pi-download" /> Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === 'audit' && (
        <AuditTab
          status={status}
          errors={errors}
          poNumber={d.po_number}
          invoiceDate={d.invoice_date}
          createdAt={d.created_at}
          updatedAt={d.updated_at}
          validatedAt={state.validation?.validated_at || null}
        />
      )}
    </div>
  )
}

/* ================================================================== *
 *   Sub-components
 * ================================================================== */

// SubTabButton removed — tab row now uses canonical mockup `.tabs > .tab`
// markup straight from portal.html (lines 2527-2535).


interface Totals {
  taxable: number
  cgst: number
  sgst: number
  igst: number
  tax: number
  grand: number
}

function OverviewTab({
  detail,
  totals,
  poTotal,
  lineCount,
  poLineCount,
  grnCount,
  asnCount
}: {
  detail: InvoiceDetail
  totals: Totals
  poTotal: number
  lineCount: number
  poLineCount: number
  grnCount: number
  asnCount: number
}) {
  // Variance between invoice and PO total
  const declaredTotal = parseAmount(detail.total_amount) ?? totals.grand
  const variance = poTotal > 0 ? declaredTotal - poTotal : 0
  const variancePct = poTotal > 0 ? (variance / poTotal) * 100 : 0

  /* Render order matches mockup invoiceDetailHTML overview pane:
     – 3 column grid: Header / Supplier / Bill to
     – Below: a single Totals card with a 5-column inline grid
     – Below: PO linkage + Document coverage panels (kept from prior
       implementation since the mockup's "PO match" lives under a tab,
       not the Overview pane, but our users find them useful here)
  */
  const supplierAddr = detail.supplier_address || ''
  // Friendly PO-type label — `po_pfx` carries the raw ERP prefix (e.g.
  // PO9, SC1, OP2). Render the meaningful category, not the prefix code.
  const poTypeLabel = detail.po_pfx
    ? (/^OP\d?$/i.test(detail.po_pfx) ? 'Open'
       : /^SC/i.test(detail.po_pfx)    ? 'Subcontract'
       : 'Standard')
    : (detail.po_id ? 'Standard' : '—')

  // Match mockup srcChip() helper (portal.html line 731) — just the short
  // source name. Long suffixes like "· Mail inbox" / "· Bill Register"
  // overflow the .dl grid cell and were getting truncated.
  const sourceLabel = (detail as InvoiceDetail & { source?: string }).source === 'ocr'
    ? <span className="chip chip--vio">OCR</span>
    : (detail as InvoiceDetail & { source?: string }).source === 'both'
      ? <span className="chip chip--ok">Both</span>
      : <span className="chip chip--info">Excel</span>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* 3-column g3 grid: Header / Supplier / Bill to. Markup mirrors
          portal.html invoiceDetailHTML overview pane (lines 2538-2557). */}
      <div className="g3">
        <div className="card">
          <div className="card__h"><div className="card__t"><i className="pi pi-file" /> Header</div></div>
          <div className="card__b">
            <dl className="dl">
              <dt>Invoice no</dt><dd className="bold">{detail.invoice_number}</dd>
              <dt>Date</dt><dd>{formatDate(detail.invoice_date) || '—'}</dd>
              <dt>Due</dt><dd>{formatDate(detail.payment_due_date) || '—'}</dd>
              <dt>Type</dt><dd>{poTypeLabel}</dd>
              <dt>Currency</dt><dd>INR (₹)</dd>
              <dt>Source</dt><dd>{sourceLabel}</dd>
              {detail.scanning_number && (<><dt>Scanning #</dt><dd className="mono">{detail.scanning_number}</dd></>)}
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="card__h"><div className="card__t"><i className="pi pi-building" /> Supplier</div></div>
          <div className="card__b">
            <div className="bold" style={{ marginBottom: 3 }}>{detail.supplier_name || '—'}</div>
            {supplierAddr && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{supplierAddr}</div>
            )}
            <dl className="dl">
              <dt>GSTIN</dt><dd className="mono">{detail.supplier_gst || '—'}</dd>
              <dt>PAN</dt><dd className="mono">{detail.supplier_pan || '—'}</dd>
              <dt>Email</dt><dd>{detail.supplier_email || '—'}</dd>
              <dt>Phone</dt><dd>{detail.supplier_phone || '—'}</dd>
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="card__h"><div className="card__t"><i className="pi pi-id-card" /> Bill to</div></div>
          <div className="card__b">
            <div className="bold" style={{ marginBottom: 3 }}>SRIMUKHA PRECISION TECH PVT LTD</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Bommasandra, Bengaluru — 560 099</div>
            <dl className="dl">
              <dt>GSTIN</dt><dd className="mono">29AAFCS5678H1ZN</dd>
              <dt>POS</dt><dd>Karnataka (29)</dd>
              <dt>GST type</dt>
              <dd><span className="chip chip--mute">{totals.igst > 0 ? 'Inter-state · IGST' : 'Intra-state · CGST + SGST'}</span></dd>
            </dl>
          </div>
        </div>
      </div>

      {/* Totals — full-width card with 5-column inline grid. Mirrors
          mockup lines 2561-2569. */}
      <div className="card">
        <div className="card__h">
          <div className="card__t"><i className="pi pi-indian-rupee" /> Totals</div>
          <span className="card__m">All values in INR</span>
        </div>
        <div className="card__b" style={{ padding: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <TotalsCell label="Pre-tax" value={formatINRSymbol(totals.taxable)} />
            <TotalsCell label="CGST"    value={totals.cgst > 0 ? formatINRSymbol(totals.cgst) : '—'} hint={totals.cgst === 0 ? 'inter-state' : undefined} />
            <TotalsCell label="SGST"    value={totals.sgst > 0 ? formatINRSymbol(totals.sgst) : '—'} hint={totals.sgst === 0 ? 'inter-state' : undefined} />
            <TotalsCell label={totals.igst > 0 ? 'IGST' : 'IGST'} value={totals.igst > 0 ? formatINRSymbol(totals.igst) : '—'} hint={totals.igst === 0 ? 'intra-state' : undefined} />
            <TotalsCell label="Grand total" value={formatINRSymbol(totals.grand)} highlight />
          </div>
        </div>
      </div>

      {/* PO linkage + Document coverage retained (mockup also keeps these
          under a "PO match" tab but they're useful at-a-glance here too). */}
      <div className="g2">
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-shopping-cart" /> PO linkage</div>
          </div>
          <div className="card__b">
            {detail.po_id ? (
              <>
                <dl className="dl">
                  <dt>PO number</dt><dd className="bold">{detail.po_number || '—'}</dd>
                  <dt>PO date</dt><dd>{formatDate(detail.po_date) || '—'}</dd>
                  <dt>Amendment</dt><dd>{detail.po_amd_no != null ? `AMD ${detail.po_amd_no}` : '—'}</dd>
                  <dt>PO status</dt><dd>{detail.po_status || '—'}</dd>
                  <dt>Terms</dt><dd>{detail.po_terms || '—'}</dd>
                </dl>
                {poTotal > 0 && (
                  <div
                    className={Math.abs(variancePct) > 1 ? 'chip chip--warn' : 'chip chip--ok'}
                    style={{ marginTop: 12, padding: '6px 10px' }}
                  >
                    PO vs invoice variance: {variance >= 0 ? '+' : ''}{formatINRSymbol(variance)} ({variance >= 0 ? '+' : ''}{variancePct.toFixed(2)}%)
                  </div>
                )}
              </>
            ) : (
              <div className="ph"><i className="pi pi-link" /> No PO linked to this invoice yet.</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-check-square" /> Document coverage</div>
          </div>
          <div className="card__b">
            <dl className="dl">
              <dt>Invoice lines</dt>
              <dd>{lineCount > 0 ? <span className="chip chip--ok">{lineCount}</span> : <span className="chip chip--mute">none</span>}</dd>
              <dt>PO lines</dt>
              <dd>{poLineCount > 0 ? <span className="chip chip--ok">{poLineCount}</span> : <span className="chip chip--mute">PO not linked</span>}</dd>
              <dt>GRN</dt>
              <dd>{grnCount > 0 ? <span className="chip chip--ok">{grnCount}</span> : <span className="chip chip--mute">none</span>}</dd>
              <dt>ASN</dt>
              <dd>{asnCount > 0 ? <span className="chip chip--ok">{asnCount}</span> : <span className="chip chip--mute">none</span>}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}

/* Single cell in the 5-column Totals card. */
function TotalsCell({ label, value, hint, highlight }: { label: string; value: ReactNode; hint?: string; highlight?: boolean }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRight: '1px solid var(--border-subtle)',
        background: highlight ? 'linear-gradient(135deg,rgba(16,185,129,0.06),rgba(20,184,166,0.10))' : undefined
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: highlight ? 'var(--status-success-fg)' : 'var(--text-muted)'
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: highlight ? 20 : 18,
          fontWeight: 700,
          marginTop: 3,
          color: 'var(--text-primary)',
          letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>
      )}
    </div>
  )
}


// FactGrid + CoverageRow removed — OverviewTab now uses canonical `<dl
// className="dl"><dt>/<dd>` markup straight from the mockup, and
// document-coverage values are rendered as `.chip` badges inside that same
// definition list. See mockup-compat.css for the .dl / .chip styling.

function LineItemsTab({ lines, totals }: { lines: InvoiceLine[]; totals: Totals }) {
  // Matches mockup invoiceDetailHTML lines pane (portal.html lines 2572-2583):
  // `.card` with `.card__b--flush`, header strip with title + count,
  // `.tbl compact` body with a `.total` subtotal row.
  const hasIgst = totals.igst > 0
  const hasCgst = totals.cgst > 0 || totals.sgst > 0
  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t">
          <i className="pi pi-list" /> Line items
          <span className="muted" style={{ fontWeight: 500, marginLeft: 6 }}>· {lines.length} line{lines.length === 1 ? '' : 's'}</span>
        </div>
        <span className="card__m">
          {hasIgst ? 'Inter-state · IGST' : hasCgst ? 'Intra-state · CGST + SGST' : 'No tax'}
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="ph">
          <i className="pi pi-info-circle" />
          Line items not yet parsed for this invoice.
        </div>
      ) : (
        <table className="tbl tbl--compact">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Item</th>
              <th>HSN</th>
              <th className="tbl__num">Qty</th>
              <th className="tbl__num">Rate</th>
              <th className="tbl__num">Pre-tax</th>
              {hasCgst && <th className="tbl__num">CGST</th>}
              {hasCgst && <th className="tbl__num">SGST</th>}
              {hasIgst && <th className="tbl__num">IGST</th>}
              <th className="tbl__num">Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((ln, i) => (
              <tr key={ln.invoice_line_id ?? i}>
                <td className="tbl__bold">{ln.sequence_number ?? i + 1}</td>
                <td>
                  <div className="tbl__bold">{ln.item_name || '—'}</div>
                </td>
                <td className="tbl__mono">{ln.hsn_sac || '—'}</td>
                <td className="tbl__num">{formatQty(ln.billed_qty)}{ln.uom ? ` ${ln.uom}` : ''}</td>
                <td className="tbl__num">{formatINRSymbol(ln.rate)}</td>
                <td className="tbl__num">{formatINRSymbol(ln.taxable_value)}</td>
                {hasCgst && <td className="tbl__num">{formatINRSymbol(ln.cgst_amount)}</td>}
                {hasCgst && <td className="tbl__num">{formatINRSymbol(ln.sgst_amount)}</td>}
                {hasIgst && <td className="tbl__num">{formatINRSymbol(ln.igst_amount)}</td>}
                <td className="tbl__num tbl__bold">{formatINRSymbol(ln.line_total)}</td>
              </tr>
            ))}
            <tr className="tbl__total">
              <td className="tbl__num" colSpan={5}>Subtotal</td>
              <td className="tbl__num">{formatINRSymbol(totals.taxable)}</td>
              {hasCgst && <td className="tbl__num">{formatINRSymbol(totals.cgst)}</td>}
              {hasCgst && <td className="tbl__num">{formatINRSymbol(totals.sgst)}</td>}
              {hasIgst && <td className="tbl__num">{formatINRSymbol(totals.igst)}</td>}
              <td className="tbl__num">{formatINRSymbol(totals.grand)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

function PoTab({
  detail,
  poLines,
  poTotal
}: {
  detail: InvoiceDetail
  poLines: PoLine[]
  poTotal: number
}) {
  // Match mockup invoiceDetailHTML PO match pane: dl of PO facts + a
  // consumption progress bar. Empty state branches: no PO ref at all, or
  // PO ref but PO not loaded in master (the SC* case).
  if (!detail.po_id) {
    return (
      <div className="card">
        <div className="card__h">
          <div className="card__t"><i className="pi pi-shopping-cart" /> PO match</div>
        </div>
        <div className="card__b">
          <div className="ph">
            {detail.po_number ? (
              <>
                <i className="pi pi-exclamation-triangle" />
                <b>PO {detail.po_number}</b> referenced but not loaded in master — subcontract POs are missing from the daily ERP export.
              </>
            ) : (
              <>
                <i className="pi pi-link" />
                No PO referenced on this invoice.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const invoiceAmt = parseAmount(detail.total_amount) ?? 0
  const pct = poTotal > 0 ? Math.min(100, Math.round((invoiceAmt / poTotal) * 100)) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* PO match summary card — mockup invoiceDetailHTML PO pane
          (portal.html lines 2587-2594) uses card / dl / pb consumption bar. */}
      <div className="card">
        <div className="card__h">
          <div className="card__t"><i className="pi pi-shopping-cart" /> Purchase order match</div>
        </div>
        <div className="card__b">
          <dl className="dl">
            <dt>PO ref</dt><dd className="bold">{detail.po_number || '—'}</dd>
            <dt>PO date</dt><dd>{formatDate(detail.po_date) || '—'}</dd>
            <dt>Type</dt><dd>{detail.po_pfx || 'Standard'}</dd>
            <dt>Amendment</dt><dd>{detail.po_amd_no != null ? `AMD ${detail.po_amd_no}` : '—'}</dd>
            <dt>Status</dt><dd>{detail.po_status || '—'}</dd>
            <dt>Payment terms</dt><dd>{detail.po_terms || '—'}</dd>
            <dt>PO value</dt><dd className="bold">{formatINRSymbol(poTotal)}</dd>
            <dt>This invoice</dt>
            <dd>{formatINRSymbol(invoiceAmt)} {poTotal > 0 && <span className="muted" style={{ fontSize: 11 }}>({pct}%)</span>}</dd>
            <dt>Remaining</dt><dd>{formatINRSymbol(Math.max(0, poTotal - invoiceAmt))}</dd>
          </dl>

          {poTotal > 0 && (
            <>
              <div style={{ height: 1, background: 'var(--b-1)', margin: '14px 0' }} />
              <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                PO consumption
              </div>
              {/* `.pb` + `.pb__f` is the canonical mockup progress bar
                  (see mockup-compat.css). */}
              <div className="pb"><div className="pb__f pb__f--em" style={{ width: `${pct}%` }} /></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11.5 }}>
                <span>This invoice {pct}%</span>
                <span className="muted">Remaining {100 - pct}%</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* PO lines (kept — useful real data the mockup omits in its demo dataset) */}
      {poLines.length > 0 && (
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-list" /> PO lines</div>
            <span className="card__m">{poLines.length} line{poLines.length === 1 ? '' : 's'}</span>
          </div>
          <table className="tbl tbl--compact">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Item</th>
                <th className="tbl__num">PO qty</th>
                <th className="tbl__num">Rate</th>
                <th className="tbl__num">Line value</th>
              </tr>
            </thead>
            <tbody>
              {poLines.map((pl, i) => {
                const q = parseAmount(pl.quantity) ?? 0
                const r = parseAmount(pl.unit_cost) ?? 0
                return (
                  <tr key={pl.po_line_id ?? i}>
                    <td>{pl.sequence_number ?? i + 1}</td>
                    <td>
                      <div className="tbl__bold">{pl.item_id || pl.item_name || '—'}</div>
                      {pl.item_description && <div className="muted" style={{ fontSize: 11 }}>{pl.item_description}</div>}
                    </td>
                    <td className="tbl__num">{formatQty(pl.quantity)}</td>
                    <td className="tbl__num">{formatINRSymbol(pl.unit_cost)}</td>
                    <td className="tbl__num tbl__bold">{formatINRSymbol(q * r)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ReceiptsTab({ grn, asn }: { grn: GRNRow[]; asn: ASNRow[] }) {
  /* Match mockup invoiceDetailHTML receipts pane: single card with a
     unified .tbl compact listing GRN + ASN rows by Type / Doc no / Date
     / Qty / Status. Cleaner than two side-by-side panels when there are
     only a handful of receipts. */
  const total = grn.length + asn.length

  if (total === 0) {
    return (
      <div className="card">
        <div className="card__h">
          <div className="card__t"><i className="pi pi-box" /> Receipts</div>
          <span className="card__m">GRN · ASN · DC</span>
        </div>
        <div className="card__b">
          <div className="ph">
            <i className="pi pi-inbox" />
            No GRN or ASN matched to this invoice yet.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className="pi pi-box" /> Receipts</div>
        <span className="card__m">{grn.length} GRN · {asn.length} ASN</span>
      </div>
      <table className="tbl tbl--compact">
        <thead>
          <tr>
            <th>Type</th>
            <th>Doc no</th>
            <th>Date</th>
            <th>Item</th>
            <th className="tbl__num">Qty</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {asn.map((a, i) => (
            <tr key={`asn-${i}`}>
              <td><span className="chip chip--info">ASN</span></td>
              <td className="bold">{a.asn_no || '—'}</td>
              <td className="muted">{formatDate(a.dc_date)}</td>
              <td>{a.item_code || '—'}</td>
              <td className="num">{formatQty(a.quantity)}</td>
              <td>{a.status ? <span className="chip chip--ok">{a.status}</span> : '—'}</td>
            </tr>
          ))}
          {grn.map((g, i) => (
            <tr key={`grn-${i}`}>
              <td><span className="chip chip--info">GRN</span></td>
              <td className="bold">{g.grn_no || '—'}</td>
              <td className="muted">{formatDate(g.grn_date)}</td>
              <td>{g.item || '—'}</td>
              <td className="num">{formatQty(g.accepted_qty || g.grn_qty)}</td>
              <td>{g.header_status ? <span className="chip chip--ok">{g.header_status}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ValidationTab({
  status,
  errors,
  warnings,
  summary,
  poNumber,
  invoiceTotal,
  validatedAt
}: {
  status: string
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  /** Full engine output incl. `details` (line / totals / grn diffs) + `reason`. */
  summary: ValidationSummary | null
  /** PO ref to mention in the header card when complaining about a missing PO. */
  poNumber: string | null
  /** Invoice total for the totals comparison block. */
  invoiceTotal: number | string | null | undefined
  validatedAt: string | null
}) {
  const isWaiting = status === 'waiting_for_validation' || status === 'waiting_for_re_validation'
  const allOk    = !isWaiting && errors.length === 0 && warnings.length === 0
  const issueCt  = errors.length + warnings.length
  const tone: 'success' | 'danger' | 'warn' = allOk ? 'success' : errors.length > 0 ? 'danger' : 'warn'
  const bannerBg =
    tone === 'success' ? 'linear-gradient(90deg, rgba(16,185,129,0.08), transparent)' :
    tone === 'danger'  ? 'linear-gradient(90deg, rgba(239,68,68,0.08), transparent)'  :
                         'linear-gradient(90deg, rgba(245,158,11,0.08), transparent)'

  /* The engine's top-level reason (e.g. "Line quantity exceeds PO line qty") —
     this is THE answer to "why is it waiting for validation?". */
  const why = summary?.reason || summary?.validationFailureReason || null
  const details: ValidationDetails = summary?.details || {}
  const headerIssues = [...(details.header?.errors || []), ...(details.header?.warnings || [])]
  const totalsIssues = [...(details.totals?.errors || []), ...(details.totals?.warnings || [])]
  const grnIssues    = details.grn?.errors || []
  const asnIssues    = details.asn?.warnings || []
  /* lineIssues was the old "only failures" filter. The new ValidationLinesTable
     shows EVERY line (passing + failing) so the client can see at a glance
     which lines match and which differ, with side-by-side Invoice / PO / Δ
     columns. The boolean kept here just decides whether to mention "X of N
     lines match" in the section header below. */
  const lineMatchCount  = (details.lines || []).filter((l) => l.quantityMatch !== false && l.rateMatch !== false && l.lineTotalMatch !== false && (l.errors?.length ?? 0) === 0).length
  const lineTotalCount  = (details.lines || []).length

  /* Surface a "what's different" totals row if the engine recorded any
     quantity / amount on its side and the invoice total is known. */
  const invQty   = numOrNull(summary?.thisInvQty)  ?? numOrNull(details.totals?.thisInvQty)
  const poQty    = numOrNull(summary?.poQty)       ?? numOrNull(details.totals?.poQty)
  const grnQty   = numOrNull(summary?.grnQty)      ?? numOrNull(details.totals?.grnQty)
  const invAmt   = numOrNull(invoiceTotal)         ?? numOrNull(details.totals?.thisInvAmount)
  const poAmt    = numOrNull(details.totals?.poAmount)
  const hasTotalsRow = [invQty, poQty, grnQty, invAmt, poAmt].some((v) => v != null)

  const statusLabel =
    status === 'waiting_for_validation'    ? 'waiting for validation' :
    status === 'waiting_for_re_validation' ? 'waiting for re-validation' :
    status === 'exception_approval'        ? 'exception approval' :
    status === 'debit_note_approval'       ? 'debit-note approval' :
    status

  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className="pi pi-shield" /> Validation result</div>
        {validatedAt && (
          <span className="card__m">Last run {formatDateTime(validatedAt)}</span>
        )}
      </div>

      {/* Banner — pass/fail headline */}
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, background: bannerBg }}>
        <div
          style={{
            width: 38, height: 38, borderRadius: '50%',
            background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)`,
            display: 'grid', placeItems: 'center', fontSize: 18, flexShrink: 0
          }}
        >
          <i className={`pi ${allOk ? 'pi-check-circle' : tone === 'danger' ? 'pi-times-circle' : 'pi-exclamation-triangle'}`} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tbl__bold" style={{ color: `var(--status-${tone}-fg)` }}>
            {allOk
              ? 'All checks passed'
              : isWaiting && issueCt === 0
              ? `Invoice is ${statusLabel}`
              : `${issueCt} ${errors.length > 0 ? 'blocker' : 'warning'}${issueCt === 1 ? '' : 's'} — invoice is ${statusLabel}`}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {allOk
              ? 'Engine signed off — this invoice is ready to proceed.'
              : why
              ? <><b>Why:</b> {why}</>
              : isWaiting && issueCt === 0
              ? 'Engine hasn\'t run yet. Click Re-validate in the header strip.'
              : `${errors.length} blocker${errors.length === 1 ? '' : 's'} · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>

      {/* Flat list of every blocker + warning. Renders all engine findings
          as a single scroll-free list (with rule code on the left) so the
          user can verify the headline count without expanding sections. */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '10px 16px' }}>
          <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            {errors.length > 0
              ? `All blockers (${errors.length})${warnings.length > 0 ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}`
              : `All warnings (${warnings.length})`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {errors.map((iss, i) => (
              <FlatIssueRow key={`e-${i}`} issue={iss} tone="danger" />
            ))}
            {warnings.map((iss, i) => (
              <FlatIssueRow key={`w-${i}`} issue={iss} tone="warn" />
            ))}
          </div>
        </div>
      )}

      {/* What's different — totals comparison strip
          Shows Invoice qty vs PO qty vs GRN qty (and amount) side-by-side
          with Δ values, so the user immediately sees where the gap is. */}
      {hasTotalsRow && !allOk && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            What's different
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <DiffCell label="Invoice qty" value={fmtQty(invQty)} tone={poQty != null && invQty != null && Number(invQty) > Number(poQty) ? 'danger' : 'info'} />
            <DiffCell label="PO qty"      value={fmtQty(poQty)}  tone="info" />
            <DiffCell label="GRN qty"     value={fmtQty(grnQty)} tone={invQty != null && grnQty != null && Number(invQty) > Number(grnQty) ? 'danger' : 'info'} />
            {invAmt != null && (
              <DiffCell label="Invoice amount" value={formatINRSymbol(invAmt)} tone={poAmt != null && Number(invAmt) > Number(poAmt) ? 'danger' : 'info'} />
            )}
            {poAmt != null && (
              <DiffCell label="PO amount" value={formatINRSymbol(poAmt)} tone="info" />
            )}
          </div>
          {invQty != null && poQty != null && Math.abs(Number(invQty) - Number(poQty)) > 0.001 && (
            <div style={{ marginTop: 8, fontSize: 12.5 }}>
              <b style={{ color: 'var(--status-danger-fg)' }}>Δ qty:</b>{' '}
              <span className="tbl__mono">{(Number(invQty) - Number(poQty)).toLocaleString('en-IN')}</span>{' '}
              <span className="muted">(invoice {Number(invQty) > Number(poQty) ? 'exceeds' : 'short of'} PO)</span>
            </div>
          )}
          {invQty != null && grnQty != null && Math.abs(Number(invQty) - Number(grnQty)) > 0.001 && (
            <div style={{ marginTop: 4, fontSize: 12.5 }}>
              <b style={{ color: 'var(--status-warn-fg)' }}>Δ vs GRN:</b>{' '}
              <span className="tbl__mono">{(Number(invQty) - Number(grnQty)).toLocaleString('en-IN')}</span>{' '}
              <span className="muted">(billed vs received)</span>
            </div>
          )}
        </div>
      )}

      {/* Per-section issue groups */}
      {headerIssues.length > 0 && (
        <ValidationGroup
          icon="pi-id-card"
          title="Header issues"
          tone="danger"
          items={headerIssues.map((m) => ({ message: m }))}
        />
      )}

      {lineTotalCount > 0 && (
        <ValidationLinesTable lines={details.lines || []} matchCount={lineMatchCount} totalCount={lineTotalCount} />
      )}

      {totalsIssues.length > 0 && (
        <ValidationGroup
          icon="pi-rupee"
          title="Totals"
          tone="danger"
          items={totalsIssues.map((m) => ({ message: m }))}
        />
      )}

      {grnIssues.length > 0 && (
        <ValidationGroup
          icon="pi-box"
          title="GRN coverage"
          tone="warn"
          items={grnIssues.map((m) => ({ message: m }))}
        />
      )}

      {asnIssues.length > 0 && (
        <ValidationGroup
          icon="pi-truck"
          title="ASN"
          tone="warn"
          items={asnIssues.map((m) => ({ message: m }))}
        />
      )}

      {/* Top-level per-issue rows for anything not covered by sections above. */}
      {issueCt > 0 && headerIssues.length === 0 && lineTotalCount === 0 && totalsIssues.length === 0 && grnIssues.length === 0 && asnIssues.length === 0 && (
        <>
          {errors.map((e, i) => (
            <ValidationIssueRow key={`e${i}`} tone="danger" code={e.code} message={e.message} />
          ))}
          {warnings.map((w, i) => (
            <ValidationIssueRow key={`w${i}`} tone="warn" code={w.code} message={w.message} />
          ))}
        </>
      )}

      {/* Empty state for a waiting invoice with no engine output yet. */}
      {isWaiting && issueCt === 0 && !why && !hasTotalsRow && (
        <div style={{ padding: '20px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          <i className="pi pi-clock" style={{ marginRight: 6 }} />
          The validation engine hasn't produced a result for this invoice yet. Click <b>Re-validate</b> in the header strip to run it now.
          {poNumber && <div style={{ marginTop: 4, fontSize: 12 }}>PO: <span className="tbl__mono">{poNumber}</span></div>}
        </div>
      )}
    </div>
  )
}

/** Single issue row in the flat blockers list (one per engine finding). */
function FlatIssueRow({ issue, tone }: { issue: ValidationIssue; tone: 'danger' | 'warn' }) {
  const code = issue.code && issue.code !== 'EXXX' ? issue.code.split('_')[0] : null
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto auto 1fr',
      alignItems: 'baseline',
      gap: 10,
      padding: '6px 8px',
      borderRadius: 6,
      background: tone === 'danger' ? 'var(--status-danger-bg)' : 'var(--status-warn-bg)',
    }}>
      <i
        className={`pi ${tone === 'danger' ? 'pi-times-circle' : 'pi-exclamation-triangle'}`}
        style={{ color: `var(--status-${tone}-fg)`, fontSize: 12 }}
      />
      {code ? (
        <code style={{
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: 11.5,
          fontWeight: 700,
          color: `var(--status-${tone}-fg)`,
          letterSpacing: '0.02em',
        }}>
          {code}
        </code>
      ) : <span />}
      <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{issue.message}</span>
    </div>
  )
}

/** Single Δ cell in the totals comparison strip. */
function DiffCell({ label, value, tone }: { label: string; value: ReactNode; tone: 'info' | 'danger' | 'warn' }) {
  const bg =
    tone === 'danger' ? 'var(--status-danger-bg)' :
    tone === 'warn'   ? 'var(--status-warn-bg)'   :
                        'var(--surface-0)'
  const fg =
    tone === 'danger' ? 'var(--status-danger-fg)' :
    tone === 'warn'   ? 'var(--status-warn-fg)'   :
                        'var(--text-primary)'
  return (
    <div style={{
      padding: '8px 10px',
      borderRadius: 8,
      background: bg,
      border: '1px solid var(--border-subtle)'
    }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: fg, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
        {value}
      </div>
    </div>
  )
}

/** Group header + list of issues for one section (header / lines / totals / grn / asn). */
function ValidationGroup({
  icon,
  title,
  tone,
  items
}: {
  icon: string
  title: string
  tone: 'danger' | 'warn' | 'info'
  items: Array<{ message: string; code?: string; extra?: string; severity?: 'warn' }>
}) {
  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{
        padding: '10px 16px',
        background: 'var(--surface-1)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, fontWeight: 700,
        color: `var(--status-${tone}-fg)`,
        textTransform: 'uppercase',
        letterSpacing: '0.04em'
      }}>
        <i className={`pi ${icon}`} /> {title}
      </div>
      {items.map((it, i) => (
        <div key={i} style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
            {it.code && (
              <StatusChip status={it.code} variant={it.severity === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : 'info'} label={it.code} />
            )}
            <span className="tbl__bold">{it.message}</span>
          </div>
          {it.extra && (
            <div className="muted" style={{ fontSize: 12 }}>
              {it.extra}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Side-by-side line comparison table:
 *
 *  #  Item             Invoice qty  PO qty  Δ qty  | Invoice rate  PO rate  Δ rate  | Line total  Status
 *
 *  Status column shows ✓ green for a fully-matched line, ✗ red for a hard
 *  error (qty/rate breach), ⚠ amber for warnings only. The Δ cells are
 *  signed and tinted by direction (red if invoice exceeds PO, amber if
 *  short). Lines without a PO match still render with the PO columns blank
 *  + a "no PO line" status. */
function ValidationLinesTable({
  lines,
  matchCount,
  totalCount
}: {
  lines: ValidationLineDetail[]
  matchCount: number
  totalCount: number
}) {
  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{
        padding: '10px 16px',
        background: 'var(--surface-1)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, fontWeight: 700,
        color: 'var(--text-primary)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em'
      }}>
        <i className="pi pi-list" /> Line-by-line comparison
        <span className="muted" style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, marginLeft: 'auto' }}>
          {matchCount} of {totalCount} match
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl tbl--compact" style={{ fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>Item</th>
              <th className="tbl__num">Invoice qty</th>
              <th className="tbl__num">PO qty</th>
              <th className="tbl__num">Δ qty</th>
              <th className="tbl__num">Invoice rate</th>
              <th className="tbl__num">PO rate</th>
              <th className="tbl__num">Δ rate</th>
              <th className="tbl__num">Line total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((ln, idx) => {
              const inQ  = numOrNull(ln.invQty)
              const poQ  = numOrNull(ln.poQty)
              const inR  = numOrNull(ln.invRate)
              const poR  = numOrNull(ln.poRate)
              const inT  = numOrNull(ln.invLineTotal)
              const dQty = (inQ != null && poQ != null) ? inQ - poQ : null
              const dRate = (inR != null && poR != null) ? inR - poR : null
              const hasError = (ln.errors?.length ?? 0) > 0
              const hasWarn  = !hasError && (ln.warnings?.length ?? 0) > 0
              const noPo     = ln.poLineId == null
              const status: 'ok' | 'err' | 'warn' | 'mute' =
                noPo      ? 'mute' :
                hasError  ? 'err'  :
                hasWarn   ? 'warn' :
                            'ok'
              const dQtyTone =
                dQty == null      ? 'muted' :
                Math.abs(dQty) < 0.001 ? 'ok' :
                dQty > 0          ? 'err' :
                                    'warn'
              const dRateTone =
                dRate == null      ? 'muted' :
                Math.abs(dRate) < 0.01  ? 'ok' :
                dRate > 0          ? 'err' :
                                     'warn'
              const issueLine = ln.errors?.[0] || ln.warnings?.[0] || null
              return (
                <>
                  <tr key={`line-${idx}`}>
                    <td className="bold">{ln.index ?? idx + 1}</td>
                    <td>
                      <div className="bold">{ln.itemName || '—'}</div>
                    </td>
                    <td className="tbl__num">{fmtQty(inQ)}</td>
                    <td className="tbl__num">{noPo ? <span className="muted">—</span> : fmtQty(poQ)}</td>
                    <td className="tbl__num" style={{ color: deltaColor(dQtyTone), fontWeight: 600 }}>
                      {dQty == null ? '—' : `${dQty > 0 ? '+' : ''}${dQty.toLocaleString('en-IN', { maximumFractionDigits: 3 })}`}
                    </td>
                    <td className="tbl__num">{inR == null ? '—' : formatINRSymbol(inR)}</td>
                    <td className="tbl__num">{poR == null ? '—' : formatINRSymbol(poR)}</td>
                    <td className="tbl__num" style={{ color: deltaColor(dRateTone), fontWeight: 600 }}>
                      {dRate == null ? '—' : `${dRate > 0 ? '+' : ''}${formatINRSymbol(Math.abs(dRate))}`}
                    </td>
                    <td className="tbl__num">{inT == null ? '—' : formatINRSymbol(inT)}</td>
                    <td>
                      <StatusBadge tone={status} />
                    </td>
                  </tr>
                  {issueLine && (
                    <tr key={`line-${idx}-msg`} style={{ background: 'var(--surface-1)' }}>
                      <td />
                      <td colSpan={9} style={{ paddingTop: 0, paddingBottom: 10 }}>
                        <span className="muted" style={{ fontSize: 12 }}>
                          <i className={`pi ${status === 'err' ? 'pi-times-circle' : 'pi-exclamation-triangle'}`}
                             style={{ marginRight: 5, color: `var(--status-${status === 'err' ? 'danger' : 'warn'}-fg)` }} />
                          {issueLine}
                        </span>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StatusBadge({ tone }: { tone: 'ok' | 'err' | 'warn' | 'mute' }) {
  const cfg = {
    ok:   { bg: 'var(--status-success-bg)', fg: 'var(--status-success-fg)', icon: 'pi-check',           label: 'Match' },
    err:  { bg: 'var(--status-danger-bg)',  fg: 'var(--status-danger-fg)',  icon: 'pi-times-circle',    label: 'Differs' },
    warn: { bg: 'var(--status-warn-bg)',    fg: 'var(--status-warn-fg)',    icon: 'pi-exclamation-triangle', label: 'Review' },
    mute: { bg: 'var(--status-muted-bg)',   fg: 'var(--status-muted-fg)',   icon: 'pi-minus-circle',    label: 'No PO' }
  }[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999,
      background: cfg.bg, color: cfg.fg,
      fontSize: 11, fontWeight: 600
    }}>
      <i className={`pi ${cfg.icon}`} style={{ fontSize: 10 }} />
      {cfg.label}
    </span>
  )
}

function deltaColor(tone: 'ok' | 'err' | 'warn' | 'muted'): string {
  return tone === 'err'   ? 'var(--status-danger-fg)'  :
         tone === 'warn'  ? 'var(--status-warn-fg)'    :
         tone === 'ok'    ? 'var(--status-success-fg)' :
                            'var(--text-muted)'
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function fmtQty(v: unknown): string {
  const n = numOrNull(v)
  return n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 3 })
}

function ValidationIssueRow({ tone, code, message }: { tone: 'danger' | 'warn'; code: string; message: string }) {
  return (
    <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <StatusChip status={code} variant={tone === 'danger' ? 'danger' : 'warn'} label={code} />
        <span className="tbl__bold">{validationRuleName(code)}</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>{message}</div>
    </div>
  )
}

/* Quick lookup of friendly rule names by code prefix. Falls back to "Validation rule". */
function validationRuleName(code: string): string {
  const prefix = code.split('_')[0]
  const map: Record<string, string> = {
    E001: 'Invoice has no invoice number',
    E002: 'PO not extracted from PDF',
    E003: 'Referenced PO not found in master',
    E004: 'Supplier not identified',
    E005: 'Supplier mismatch (invoice vs PO)',
    E010: 'Future-dated invoice',
    E011: 'Invoice before PO date',
    E020: 'No matching PO line',
    E021: 'Line qty exceeds PO line',
    E022: 'Line rate mismatch',
    E023: 'Line price mismatch',
    E030: 'CGST sum mismatch',
    E031: 'SGST sum mismatch',
    E032: 'IGST sum mismatch',
    E033: 'CGST vs SGST amount mismatch',
    E034: 'Intra-state invoice with IGST',
    E035: 'Inter-state invoice with CGST + SGST',
    E040: 'Header over-billing',
    E041: 'Header qty under PO',
    E042: 'Pre-tax over PO value',
    E050: 'Over-shipment vs GRN',
    E051: 'No GRN on file',
    E052: 'ASN qty mismatch',
    E060: 'Cumulative over-shipment',
    E061: 'Cumulative amount over PO',
    E070: 'Open PO: no GRN tagged',
    E071: 'GRN qty differs from billed',
    E073: 'Open PO ASN qty mismatch',
    E074: 'Open PO no DC/Schedule',
    E075: 'DC qty mismatch',
    E076: 'Open PO schedule qty mismatch'
  }
  return map[prefix] || 'Validation rule'
}

/* ==================== shared primitives ==================== */

/**
 * Card wrapper used by the secondary panels in the slide-over (Attachments,
 * Reconciliation drill-ins). Renders canonical mockup `.card` chrome with
 * `.card__h` / `.card__t` / `.card__b` — same shell as every other tab so
 * the entire slide-over is visually consistent with portal.html.
 *
 * The legacy `color` prop is accepted for back-compat with existing
 * callers but ignored (the canonical title icon colour comes from
 * `.card__t i { color: var(--brand-600); }` in mockup-compat.css).
 */
function Panel({
  icon,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  color: _color,
  title,
  children,
  rightAdornment
}: {
  icon: string
  color: string
  title: string
  children: ReactNode
  rightAdornment?: ReactNode
}) {
  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className={`pi ${icon}`} /> {title}</div>
        {rightAdornment}
      </div>
      <div className="card__b">{children}</div>
    </div>
  )
}



function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '1rem',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--surface-1)',
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--border-default)',
        fontSize: '0.85rem'
      }}
    >
      {children}
    </div>
  )
}


/* ================================================================== *
 *   Reconciliation Tab — side-by-side Excel vs OCR + approve dialog
 * ================================================================== */

const FIELD_LABELS: Record<string, string> = {
  invoice_number: 'Invoice #',
  invoice_date: 'Invoice date',
  supplier_gstin: 'Supplier GSTIN',
  supplier_name: 'Supplier name',
  po_number: 'PO #',
  subtotal: 'Subtotal',
  cgst: 'CGST',
  sgst: 'SGST',
  igst: 'IGST',
  tax_amount: 'Tax amount',
  total_amount: 'Total amount',
  'line_items.count': 'Line item count'
}

const FIELDS_IN_ORDER: (keyof InvoiceSnapshot)[] = [
  'invoice_number',
  'invoice_date',
  'supplier_gstin',
  'supplier_name',
  'po_number',
  'subtotal',
  'cgst',
  'sgst',
  'igst',
  'tax_amount',
  'total_amount'
]

type Choice = 'excel' | 'ocr'

function ReconciliationTab({
  invoiceId,
  data,
  onReviewed
}: {
  invoiceId: number
  data: ReconciliationState
  onReviewed: () => void
}) {
  const { excel_snapshot: excel, ocr_snapshot: ocr, mismatches, reconciliation_status } = data
  const hasBoth = !!excel && !!ocr
  const pending = reconciliation_status === 'pending_reconciliation'

  // Default each mismatched field to 'excel' (historical system-of-record).
  const mismatchSet = new Set((mismatches ?? []).map((m) => m.field))
  const [choices, setChoices] = useState<Record<string, Choice>>(() => {
    const init: Record<string, Choice> = {}
    for (const m of mismatches ?? []) init[m.field] = 'excel'
    return init
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string>('')

  const handleApprove = async () => {
    setSaving(true)
    setErr('')
    try {
      const approvals: Record<string, Choice> = {}
      for (const field of mismatchSet) {
        if (choices[field]) approvals[field] = choices[field]
      }
      const res = await apiFetch(`invoices/${invoiceId}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvals })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to save reconciliation'))
      onReviewed()
    } catch (e) {
      setErr(getDisplayError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel icon="pi-sync" color="var(--brand-600)" title="Dual-source reconciliation">
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        Status: <strong style={{ color: 'var(--text-primary)' }}>{reconciliation_status ?? '—'}</strong>
        {hasBoth && (
          <>
            {' '}· Excel received {formatDateTime(data.excel_received_at)}
            {' '}· OCR received {formatDateTime(data.ocr_received_at)}
          </>
        )}
      </div>

      {!hasBoth && (
        <EmptyRow>
          Only one source is on file for this invoice — nothing to reconcile yet.
          The second source will arrive via email ingest or portal upload.
        </EmptyRow>
      )}

      {hasBoth && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr', gap: '0.4rem', fontSize: '0.85rem' }}>
          <div style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Field</div>
          <div style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Excel (Bill Register)</div>
          <div style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>OCR (Portal)</div>
          <div style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'right' }}>Approve</div>

          {FIELDS_IN_ORDER.map((field) => {
            const mismatched = mismatchSet.has(field as string)
            const excelVal = excel?.[field]
            const ocrVal = ocr?.[field]
            const disabled = !mismatched || !pending
            return (
              <Row
                key={field as string}
                label={FIELD_LABELS[field as string] ?? (field as string)}
                excelVal={excelVal}
                ocrVal={ocrVal}
                mismatched={mismatched}
                disabled={disabled}
                choice={choices[field as string]}
                onChoice={(c) => setChoices((prev) => ({ ...prev, [field as string]: c }))}
              />
            )
          })}

          {mismatchSet.has('line_items.count') && (
            <Row
              key="line_items.count"
              label={FIELD_LABELS['line_items.count']}
              excelVal={excel?.line_items?.length ?? 0}
              ocrVal={ocr?.line_items?.length ?? 0}
              mismatched
              disabled={!pending}
              choice={choices['line_items.count']}
              onChoice={(c) => setChoices((prev) => ({ ...prev, ['line_items.count']: c }))}
            />
          )}
        </div>
      )}

      {hasBoth && pending && mismatchSet.size > 0 && (
        <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            className="action-btn action-btn--primary"
            disabled={saving}
            onClick={handleApprove}
          >
            <i className="pi pi-check" /> {saving ? 'Saving…' : 'Approve selected values'}
          </button>
          {err && <span style={{ color: 'var(--status-danger-fg)', fontSize: '0.82rem' }}>{err}</span>}
        </div>
      )}

      {hasBoth && reconciliation_status === 'auto_matched' && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--status-success-fg)' }}>
          <i className="pi pi-check-circle" /> Both sources agree within tolerance — no review needed.
        </div>
      )}

      {hasBoth && reconciliation_status === 'manually_approved' && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--status-info-fg)' }}>
          <i className="pi pi-verified" /> Reviewed and approved{data.reviewed_at ? ` on ${formatDateTime(data.reviewed_at)}` : ''}.
        </div>
      )}
    </Panel>
  )
}

function Row({
  label,
  excelVal,
  ocrVal,
  mismatched,
  disabled,
  choice,
  onChoice
}: {
  label: string
  excelVal: unknown
  ocrVal: unknown
  mismatched: boolean
  disabled: boolean
  choice: Choice | undefined
  onChoice: (c: Choice) => void
}) {
  const bg = mismatched ? 'var(--status-warning-bg)' : 'transparent'
  return (
    <>
      <div style={{ padding: '0.45rem 0.6rem', borderBottom: '1px solid var(--border-subtle)', background: bg, fontWeight: 600 }}>
        {label}
      </div>
      <div
        style={{
          padding: '0.45rem 0.6rem',
          borderBottom: '1px solid var(--border-subtle)',
          background: bg,
          fontFamily: mismatched ? 'inherit' : 'var(--font-mono, monospace)'
        }}
      >
        {formatSnapshotValue(excelVal)}
      </div>
      <div
        style={{
          padding: '0.45rem 0.6rem',
          borderBottom: '1px solid var(--border-subtle)',
          background: bg
        }}
      >
        {formatSnapshotValue(ocrVal)}
      </div>
      <div style={{ padding: '0.45rem 0.6rem', borderBottom: '1px solid var(--border-subtle)', background: bg, textAlign: 'right' }}>
        {mismatched ? (
          <div style={{ display: 'inline-flex', gap: '0.3rem' }}>
            <ChoiceBtn active={choice === 'excel'} disabled={disabled} onClick={() => onChoice('excel')}>Excel</ChoiceBtn>
            <ChoiceBtn active={choice === 'ocr'} disabled={disabled} onClick={() => onChoice('ocr')}>OCR</ChoiceBtn>
          </div>
        ) : (
          <span style={{ color: 'var(--status-success-fg)', fontSize: '0.8rem' }}><i className="pi pi-check" /></span>
        )}
      </div>
    </>
  )
}

function ChoiceBtn({
  active,
  disabled,
  onClick,
  children
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '0.2rem 0.65rem',
        fontSize: '0.75rem',
        fontWeight: 700,
        borderRadius: 'var(--radius-sm)',
        border: active ? '2px solid var(--brand-600)' : '1px solid var(--border-default)',
        background: active ? 'var(--brand-50)' : 'var(--surface-0)',
        color: active ? 'var(--brand-700)' : 'var(--text-primary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1
      }}
    >
      {children}
    </button>
  )
}

function formatSnapshotValue(v: unknown): ReactNode {
  if (v == null || v === '') return <span style={{ color: 'var(--text-muted)' }}>—</span>
  if (typeof v === 'number') return formatINRSymbol(v)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return formatDate(s)
  return s
}

/* ==================== Audit tab ==================== *
 * Mockup invoiceDetailHTML audit pane: a vertical list of q-row entries
 * (icon left, title + sub right, timestamp far-right). Derived locally
 * from the invoice's own timestamps + validation result + PO/source.
 * Real audit history will land when /api/audit?entity=invoice&id=... is
 * wired into this pane.
 */
function AuditTab({
  status,
  errors,
  poNumber,
  invoiceDate,
  createdAt,
  updatedAt,
  validatedAt
}: {
  status: string
  errors: ValidationIssue[]
  poNumber: string | null
  invoiceDate: string | null
  createdAt: string | null
  updatedAt: string | null
  validatedAt: string | null
}) {
  const isValidated = ['validated', 'ready_for_payment', 'paid', 'partially_paid'].includes(status)

  type Row = { icon: string; tone: 'ok' | 'err' | 'info' | 'warn'; title: string; sub: string; ts: string }
  const rows: Row[] = []

  if (validatedAt || isValidated || errors.length > 0) {
    rows.push(
      isValidated
        ? { icon: 'pi-check',  tone: 'ok',  title: 'Validated', sub: 'Engine signed off — all rules passed.', ts: formatDateTime(validatedAt || updatedAt) }
        : { icon: 'pi-times',  tone: 'err', title: 'Validation failed', sub: `${errors.length} blocker${errors.length === 1 ? '' : 's'} logged on this invoice.`, ts: formatDateTime(validatedAt || updatedAt) }
    )
  }

  if (poNumber) {
    rows.push({
      icon: 'pi-link',
      tone: 'info',
      title: `PO matched · ${poNumber}`,
      sub: 'Item-code-based PO match resolved during ingest.',
      ts: formatDateTime(createdAt)
    })
  }

  rows.push({
    icon: 'pi-upload',
    tone: 'info',
    title: 'Loaded · Bill Register',
    sub: 'Daily 06:00 IST automation pipeline picked this invoice up.',
    ts: formatDate(invoiceDate || createdAt) || '—'
  })

  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className="pi pi-history" /> Audit trail</div>
        <span className="card__m">{rows.length} event{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div>
        {rows.map((r, i) => (
          <div key={i} className="q-row" style={{ cursor: 'default' }}>
            <div className={`q-row__icon q-row__icon--${r.tone}`}>
              <i className={`pi ${r.icon}`} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="q-row__title">{r.title}</div>
              <div className="q-row__body">{r.sub}</div>
            </div>
            <div className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{r.ts}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ============================================================
 *   ExceptionContextStrip
 *
 *   Shown when invoice.status === 'exception_approval'. Tells the approver
 *   *why* the PO is considered fulfilled before they bypass the block,
 *   and how many other invoices are queued behind the same PO.
 * ============================================================ */
function ExceptionContextStrip({
  po_number,
  po_status,
  fulfillment
}: {
  po_number: string | null
  po_status: string | null
  fulfillment: PoFulfillment | null
}) {
  const pct = fulfillment?.pct_consumed
  const sibling = fulfillment?.sibling_exceptions_count ?? 0
  const poValue = fulfillment?.po_value != null ? parseAmount(fulfillment.po_value) : null
  const invoiced = fulfillment?.invoiced_amount != null ? parseAmount(fulfillment.invoiced_amount) : null

  return (
    <div
      style={{
        padding: '0.85rem 1rem',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--status-warn-ring)',
        background: 'var(--status-warn-bg)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <i className="pi pi-shield" style={{ fontSize: '1.2rem', color: 'var(--status-warn-fg)' }} />
        <div style={{ fontWeight: 800, color: 'var(--status-warn-fg)', fontSize: '0.92rem' }}>
          Exception approval needed
        </div>
      </div>
      <div style={{ fontSize: '0.82rem', color: 'var(--status-warn-fg)', display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.25rem' }}>
        {po_number && (
          <span><b>PO {po_number}</b>{po_status ? ` · ${po_status}` : ''}</span>
        )}
        {pct != null && (
          <span>
            <b>{pct}% consumed</b>
            {poValue != null && invoiced != null && (
              <> ({formatINRSymbol(invoiced)} of {formatINRSymbol(poValue)})</>
            )}
          </span>
        )}
        {sibling > 0 && (
          <span>
            <i className="pi pi-clone" style={{ fontSize: 11, marginRight: 4 }} />
            {sibling} other invoice{sibling === 1 ? '' : 's'} pending exception on this PO
          </span>
        )}
        {pct == null && sibling === 0 && (
          <span style={{ opacity: 0.85 }}>
            PO is flagged as fulfilled — approving will bypass the fulfillment check.
          </span>
        )}
      </div>
    </div>
  )
}

/* ============================================================
 *   DebitNoteReviewPanel
 *
 *   Replaces the legacy `window.prompt()` debit-note approval. Shows every
 *   uploaded debit note file + its line breakdown, pre-fills the value with
 *   SUM(line.amount), and lets the reviewer edit it before approving.
 * ============================================================ */
function DebitNoteReviewPanel({
  invoiceId,
  debitNotes,
  debitNoteTotal,
  invoiceTotal,
  valueInput,
  onChangeValue,
  submitting,
  onCancel,
  onSubmit
}: {
  invoiceId: number
  debitNotes: DebitNote[]
  debitNoteTotal: number
  invoiceTotal: number | null
  valueInput: string
  onChangeValue: (v: string) => void
  submitting: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  const parsed = parseFloat(valueInput)
  const validValue = Number.isFinite(parsed) && parsed > 0
  return (
    <div
      style={{
        padding: '1rem 1.15rem',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--accent-rose)',
        background: 'color-mix(in srgb, var(--accent-rose) 8%, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <i className="pi pi-receipt" style={{ fontSize: '1.2rem', color: 'var(--accent-rose)' }} />
        <div style={{ fontWeight: 800, fontSize: '0.95rem' }}>
          Review debit note
        </div>
        <div style={{ flex: 1 }} />
        {debitNotes.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            <i className="pi pi-exclamation-circle" /> No debit-note file on record — enter the agreed value below.
          </span>
        )}
      </div>

      {debitNotes.map((dn) => (
        <div
          key={dn.debit_note_id}
          style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-0)',
            padding: '0.6rem 0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 13 }}>
            <i className="pi pi-file" style={{ color: 'var(--accent-rose)' }} />
            <b>{dn.file_name || `Debit note #${dn.debit_note_id}`}</b>
            {dn.uploaded_at && (
              <span className="muted" style={{ fontSize: 11 }}>
                · uploaded {formatDateTime(dn.uploaded_at)}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <a
              href={`/api/invoices/${invoiceId}/debit-note/${dn.debit_note_id}/download`}
              target="_blank"
              rel="noreferrer"
              className="action-btn action-btn--ghost"
              style={{ padding: '4px 9px', fontSize: 11 }}
            >
              <i className="pi pi-download" /> View
            </a>
          </div>
          {dn.notes && (
            <div className="muted" style={{ fontSize: 12 }}>{dn.notes}</div>
          )}
          {dn.details.length > 0 ? (
            <table className="tbl tbl--compact" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>#</th>
                  <th>Description</th>
                  <th className="tbl__num">Qty</th>
                  <th className="tbl__num">Unit price</th>
                  <th className="tbl__num">Amount</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {dn.details.map((line) => (
                  <tr key={line.debit_note_detail_id}>
                    <td className="tbl__mono">{line.line_number ?? '—'}</td>
                    <td>{line.description || <span className="muted">—</span>}</td>
                    <td className="tbl__num">{line.quantity ?? '—'}</td>
                    <td className="tbl__num">{line.unit_price != null ? formatINRSymbol(line.unit_price) : '—'}</td>
                    <td className="tbl__num tbl__bold">{line.amount != null ? formatINRSymbol(line.amount) : '—'}</td>
                    <td className="muted">{line.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              No per-line breakdown captured for this debit note.
            </div>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem 1rem', fontSize: 13 }}>
        {invoiceTotal != null && (
          <span>
            <span className="muted">Invoice total · </span>
            <b>{formatINRSymbol(invoiceTotal)}</b>
          </span>
        )}
        {debitNoteTotal > 0 && (
          <span>
            <span className="muted">Debit note total · </span>
            <b>{formatINRSymbol(debitNoteTotal)}</b>
          </span>
        )}
        {invoiceTotal != null && debitNoteTotal > 0 && (
          <span>
            <span className="muted">Net payable · </span>
            <b>{formatINRSymbol(Math.max(0, invoiceTotal - debitNoteTotal))}</b>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.6rem', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 220 }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
            Approved debit-note value (₹)
          </span>
          <input
            type="number"
            step="any"
            min={0}
            value={valueInput}
            onChange={(e) => onChangeValue(e.target.value)}
            placeholder="0.00"
            style={{
              padding: '0.55rem 0.7rem',
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--border-subtle)',
              background: 'var(--surface-0)',
              color: 'var(--text-primary)',
              fontSize: '0.95rem',
              fontFamily: 'inherit',
              outline: 'none'
            }}
          />
        </label>
        <button
          type="button"
          className="action-btn action-btn--ghost"
          onClick={onCancel}
          disabled={submitting}
          style={{ padding: '0.55rem 0.85rem' }}
        >
          <i className="pi pi-times" /> Cancel
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={onSubmit}
          disabled={submitting || !validValue}
          style={{ padding: '0.55rem 0.85rem' }}
        >
          {submitting
            ? <><i className="pi pi-spin pi-spinner" /> Approving…</>
            : <><i className="pi pi-check" /> Approve {validValue ? `₹${parsed.toLocaleString('en-IN')}` : ''}</>}
        </button>
      </div>
    </div>
  )
}

/* ============================================================
 *   AppliedDebitNoteStrip
 *
 *   Shown on every invoice that has a non-null debit_note_value. Tells
 *   downstream readers (finance, audit) the negotiated-down amount, the
 *   reviewer, and when it was set.
 * ============================================================ */
function AppliedDebitNoteStrip({
  totalAmount,
  debitNoteValue,
  reviewer,
  updatedAt
}: {
  totalAmount: number | string | null
  debitNoteValue: number | string | null
  reviewer: Reviewer | null
  updatedAt: string | null
}) {
  const total = parseAmount(totalAmount)
  const dn = parseAmount(debitNoteValue)
  const reduction = total != null && dn != null ? Math.max(0, total - dn) : null
  return (
    <div
      style={{
        padding: '0.7rem 0.9rem',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-1)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem 1.25rem',
        alignItems: 'center',
        fontSize: 13
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
        <i className="pi pi-receipt" style={{ color: 'var(--accent-rose)' }} />
        Debit note applied
      </span>
      {total != null && (
        <span>
          <span className="muted">Invoice · </span>
          {formatINRSymbol(total)}
        </span>
      )}
      {reduction != null && reduction > 0 && (
        <span style={{ color: 'var(--accent-rose)' }}>
          − {formatINRSymbol(reduction)}
        </span>
      )}
      {dn != null && (
        <span>
          <span className="muted">Net payable · </span>
          <b>{formatINRSymbol(dn)}</b>
        </span>
      )}
      {(reviewer || updatedAt) && (
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {reviewer && (
            <>by <b>{reviewer.full_name || reviewer.username || '—'}</b> </>
          )}
          {updatedAt && <>on {formatDateTime(updatedAt)}</>}
        </span>
      )}
    </div>
  )
}
