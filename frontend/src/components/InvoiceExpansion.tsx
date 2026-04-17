import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import StatusChip from './StatusChip'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatDateTime, formatINRSymbol, formatQty, parseAmount } from '../utils/format'

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
}

interface ValidationIssue {
  code: string
  message: string
  severity?: string
}

interface ValidationSummary {
  errors?: ValidationIssue[]
  warnings?: ValidationIssue[]
  info?: ValidationIssue[]
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

interface FetchState {
  loading: boolean
  error: string
  detail: InvoiceDetail | null
  grn: GRNRow[]
  asn: ASNRow[]
  validation: ValidationSummary | null
  attachments: Attachment[]
  reconciliation: ReconciliationState | null
}

const emptyState: FetchState = {
  loading: false,
  error: '',
  detail: null,
  grn: [],
  asn: [],
  validation: null,
  attachments: [],
  reconciliation: null
}

const cache = new Map<number, FetchState>()

type SubTab = 'overview' | 'lines' | 'po' | 'receipts' | 'validation' | 'attachments' | 'reconciliation'

export default function InvoiceExpansion({
  invoiceId,
  poNumber
}: {
  invoiceId: number
  poNumber: string | null | undefined
}) {
  const [state, setState] = useState<FetchState>(() => cache.get(invoiceId) ?? emptyState)
  const [validating, setValidating] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [tab, setTab] = useState<SubTab>('overview')
  const [showResolution, setShowResolution] = useState(false)
  const [resolving, setResolving] = useState(false)
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
            grnRows = Array.isArray(body) ? body : (body.items || [])
          }
          if (asnRes && asnRes.ok) {
            const body = await asnRes.json()
            asnRows = Array.isArray(body) ? body : (body.items || [])
          }
        }

        let validation: ValidationSummary | null = null
        if (vsRes && vsRes.ok) {
          validation = await vsRes.json()
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

        const next: FetchState = {
          loading: false,
          error: '',
          detail,
          grn: grnRows,
          asn: asnRows,
          validation,
          attachments,
          reconciliation
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

  const handleDebitNoteApprove = async () => {
    const valueStr = window.prompt('Enter the debit note value (₹):')
    if (!valueStr) return
    const value = parseFloat(valueStr)
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
      {/* ============== Hero header strip ============== */}
      <div
        style={{
          position: 'relative',
          padding: '1.1rem 1.25rem',
          borderRadius: 'var(--radius-lg)',
          background:
            'linear-gradient(135deg, rgba(99,102,241,0.10), rgba(139,92,246,0.08) 50%, rgba(6,182,212,0.08))',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -40,
            right: -30,
            width: 160,
            height: 160,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 30% 30%, rgba(99,102,241,0.22), transparent 60%)',
            pointerEvents: 'none'
          }}
          aria-hidden
        />

        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.1rem',
            boxShadow: '0 10px 24px -10px rgba(99,102,241,0.55)',
            flexShrink: 0,
            zIndex: 1
          }}
        >
          <i className="pi pi-file" />
        </div>

        <div style={{ minWidth: 0, flex: 1, zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: '0.7rem',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-muted)',
                fontWeight: 700
              }}
            >
              Invoice
            </span>
            <StatusChip status={d.status} />
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              marginTop: '0.15rem'
            }}
          >
            {d.invoice_number}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {d.supplier_name || '—'}
            {d.po_number && <> · <code style={{ fontSize: '0.78rem' }}>{d.po_number}</code></>}
            {d.invoice_date && <> · {formatDate(d.invoice_date)}</>}
          </div>
        </div>

        <div style={{ textAlign: 'right', zIndex: 1 }}>
          <div
            style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-muted)',
              fontWeight: 700
            }}
          >
            Grand total
          </div>
          <div
            style={{
              fontSize: '1.8rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              letterSpacing: '-0.03em',
              lineHeight: 1
            }}
          >
            {formatINRSymbol(d.total_amount)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            tax {formatINRSymbol(d.tax_amount)} · {lines.length} line{lines.length === 1 ? '' : 's'}
          </div>
        </div>

        <div style={{ zIndex: 1, display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          {showValidateButton && (
            <button
              type="button"
              className="action-btn"
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
              className="action-btn"
              onClick={handleExceptionApprove}
              disabled={resolving}
              title="Approve exception — PO was already fulfilled but this invoice should proceed"
            >
              {resolving ? <><i className="pi pi-spin pi-spinner" /> Approving…</> : <><i className="pi pi-check-circle" /> Approve exception</>}
            </button>
          )}
          {status === 'debit_note_approval' && (
            <button
              type="button"
              className="action-btn"
              onClick={handleDebitNoteApprove}
              disabled={resolving}
              title="Enter the debit note value and approve"
            >
              {resolving ? <><i className="pi pi-spin pi-spinner" /> Approving…</> : <><i className="pi pi-minus-circle" /> Approve debit note</>}
            </button>
          )}
          {!showValidateButton && status !== 'exception_approval' && status !== 'debit_note_approval' && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.45rem 0.85rem',
                borderRadius: 9999,
                background: 'var(--status-success-bg)',
                color: 'var(--status-success-fg)',
                border: '1px solid var(--status-success-ring)',
                fontSize: '0.76rem',
                fontWeight: 700
              }}
            >
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

      {/* ============== Document flow timeline ============== */}
      <DocumentFlow
        hasPo={!!d.po_id}
        hasAsn={state.asn.length > 0}
        hasGrn={state.grn.length > 0}
        invoiceStatus={status}
        issueCount={issueCount}
      />

      {/* ============== Sub-tabs ============== */}
      <div
        style={{
          display: 'flex',
          gap: '0.35rem',
          padding: '0.3rem',
          background: 'var(--surface-0)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          flexWrap: 'wrap'
        }}
      >
        <SubTabButton active={tab === 'overview'}   onClick={() => setTab('overview')}   icon="pi-th-large" label="Overview" />
        <SubTabButton active={tab === 'lines'}      onClick={() => setTab('lines')}      icon="pi-list" label={`Line items · ${lines.length}`} />
        <SubTabButton active={tab === 'po'}         onClick={() => setTab('po')}         icon="pi-shopping-cart" label="Purchase order" />
        <SubTabButton active={tab === 'receipts'}   onClick={() => setTab('receipts')}   icon="pi-box" label={`GRN & ASN · ${state.grn.length + state.asn.length}`} />
        <SubTabButton
          active={tab === 'validation'}
          onClick={() => setTab('validation')}
          icon="pi-shield"
          label="Validation"
          badge={
            issueCount > 0
              ? { count: issueCount, tone: errors.length > 0 ? 'danger' : 'warn' }
              : status === 'validated' || status === 'ready_for_payment' || status === 'paid'
              ? { count: '✓', tone: 'success' }
              : undefined
          }
        />
        <SubTabButton
          active={tab === 'attachments'}
          onClick={() => setTab('attachments')}
          icon="pi-paperclip"
          label="Attachments"
          badge={state.attachments.length > 0 ? { count: state.attachments.length, tone: 'success' } : undefined}
        />
        {state.reconciliation && (state.reconciliation.excel_snapshot || state.reconciliation.ocr_snapshot) && (
          <SubTabButton
            active={tab === 'reconciliation'}
            onClick={() => setTab('reconciliation')}
            icon="pi-sync"
            label="Reconciliation"
            badge={
              state.reconciliation.reconciliation_status === 'pending_reconciliation'
                ? { count: state.reconciliation.mismatches?.length ?? '!', tone: 'warn' }
                : state.reconciliation.reconciliation_status === 'auto_matched'
                ? { count: '✓', tone: 'success' }
                : state.reconciliation.reconciliation_status === 'manually_approved'
                ? { count: '✓', tone: 'success' }
                : undefined
            }
          />
        )}
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
    </div>
  )
}

/* ================================================================== *
 *   Sub-components
 * ================================================================== */

function SubTabButton({
  active,
  onClick,
  icon,
  label,
  badge
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  badge?: { count: number | string; tone: 'danger' | 'warn' | 'success' }
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.45rem',
        padding: '0.55rem 0.95rem',
        borderRadius: 'var(--radius-md)',
        border: 0,
        background: active ? 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))' : 'transparent',
        color: active ? '#fff' : 'var(--text-secondary)',
        fontWeight: 700,
        fontSize: '0.82rem',
        cursor: 'pointer',
        boxShadow: active ? '0 8px 18px -10px rgba(99,102,241,0.55)' : 'none',
        transition: 'background 180ms var(--ease-out), color 180ms var(--ease-out)',
        fontFamily: 'inherit'
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-1)'
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
      }}
    >
      <i className={`pi ${icon}`} style={{ fontSize: '0.8rem' }} />
      {label}
      {badge && (
        <span
          style={{
            padding: '0.1rem 0.45rem',
            borderRadius: 9999,
            background: active
              ? 'rgba(255,255,255,0.25)'
              : `var(--status-${badge.tone}-bg)`,
            color: active ? '#fff' : `var(--status-${badge.tone}-fg)`,
            fontSize: '0.7rem',
            fontWeight: 800,
            minWidth: 18,
            textAlign: 'center'
          }}
        >
          {badge.count}
        </span>
      )}
    </button>
  )
}

function DocumentFlow({
  hasPo,
  hasAsn,
  hasGrn,
  invoiceStatus,
  issueCount
}: {
  hasPo: boolean
  hasAsn: boolean
  hasGrn: boolean
  invoiceStatus: string
  issueCount: number
}) {
  const hasInvoice = true // if we got here, the invoice exists
  const validated = ['validated', 'ready_for_payment', 'paid', 'partially_paid'].includes(invoiceStatus)
  const paid = ['paid', 'partially_paid'].includes(invoiceStatus)

  const steps: Array<{ label: string; done: boolean; icon: string; warn?: boolean }> = [
    { label: 'PO',        done: hasPo,     icon: 'pi-shopping-cart' },
    { label: 'ASN',       done: hasAsn,    icon: 'pi-truck' },
    { label: 'GRN',       done: hasGrn,    icon: 'pi-box' },
    { label: 'Invoice',   done: hasInvoice,icon: 'pi-file' },
    { label: 'Validated', done: validated, icon: 'pi-check-circle', warn: issueCount > 0 && !validated },
    { label: 'Paid',      done: paid,      icon: 'pi-wallet' }
  ]

  return (
    <div
      style={{
        padding: '0.85rem 1rem',
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-sm)'
      }}
    >
      <div
        style={{
          fontSize: '0.66rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
          fontWeight: 700,
          marginBottom: '0.7rem'
        }}
      >
        Document flow
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          flexWrap: 'wrap'
        }}
      >
        {steps.map((step, i) => (
          <div key={step.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: '1 1 0', minWidth: 90 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flex: 1, minWidth: 0 }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.8rem',
                  background: step.warn
                    ? 'var(--status-warn-bg)'
                    : step.done
                    ? 'linear-gradient(135deg, var(--accent-emerald), #34d399)'
                    : 'var(--surface-2)',
                  color: step.warn
                    ? 'var(--status-warn-fg)'
                    : step.done
                    ? '#fff'
                    : 'var(--text-muted)',
                  border: step.done || step.warn ? '0' : '1px dashed var(--border-default)',
                  boxShadow: step.done && !step.warn ? '0 6px 14px -8px rgba(16,185,129,0.55)' : 'none'
                }}
              >
                <i className={`pi ${step.done || step.warn ? step.icon : 'pi-circle'}`} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    color: step.done || step.warn ? 'var(--text-primary)' : 'var(--text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {step.label}
                </div>
                <div
                  style={{
                    fontSize: '0.66rem',
                    color: step.done ? 'var(--accent-emerald)' : step.warn ? 'var(--status-warn-fg)' : 'var(--text-faint)',
                    fontWeight: 600
                  }}
                >
                  {step.done ? 'Done' : step.warn ? `${issueCount} issue${issueCount === 1 ? '' : 's'}` : 'Pending'}
                </div>
              </div>
            </div>
            {i < steps.length - 1 && (
              <div
                style={{
                  height: 2,
                  flex: '0 0 16px',
                  background: steps[i].done && steps[i + 1].done ? 'var(--accent-emerald)' : 'var(--border-subtle)',
                  borderRadius: 2
                }}
                aria-hidden
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

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

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: '0.9rem'
      }}
    >
      {/* Amount breakdown card with mini waterfall */}
      <Panel icon="pi-indian-rupee" color="var(--accent-emerald)" title="Amount breakdown">
        <AmountWaterfall totals={totals} />
      </Panel>

      {/* Invoice facts */}
      <Panel icon="pi-id-card" color="var(--brand-600)" title="Invoice facts">
        <FactGrid
          rows={[
            ['Invoice number',   detail.invoice_number],
            ['Scanning number',  detail.scanning_number || '—'],
            ['Invoice date',     formatDate(detail.invoice_date)],
            ['Payment due date', formatDate(detail.payment_due_date)],
            ['Debit note value', detail.debit_note_value ? formatINRSymbol(detail.debit_note_value) : '—'],
            ['Supplier',         detail.supplier_name || '—'],
            ['Supplier GSTIN',   detail.supplier_gst || '—'],
            ['Supplier phone',   detail.supplier_phone || '—'],
            ['Created',          formatDateTime(detail.created_at)],
            ['Last updated',     formatDateTime(detail.updated_at)]
          ]}
        />
      </Panel>

      {/* PO linkage */}
      <Panel icon="pi-shopping-cart" color="var(--accent-violet)" title="PO linkage">
        {detail.po_id ? (
          <>
            <FactGrid
              rows={[
                ['PO number',    detail.po_number || '—'],
                ['PO date',      formatDate(detail.po_date)],
                ['Amendment',    detail.po_amd_no != null ? `AMD ${detail.po_amd_no}` : '—'],
                ['PO status',    detail.po_status || '—'],
                ['Terms',        detail.po_terms || '—']
              ]}
            />
            {poTotal > 0 && (
              <div
                style={{
                  marginTop: '0.8rem',
                  padding: '0.7rem 0.85rem',
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${Math.abs(variancePct) > 1 ? 'var(--status-warn-ring)' : 'var(--status-success-ring)'}`,
                  background: Math.abs(variancePct) > 1 ? 'var(--status-warn-bg)' : 'var(--status-success-bg)',
                  color: Math.abs(variancePct) > 1 ? 'var(--status-warn-fg)' : 'var(--status-success-fg)'
                }}
              >
                <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, opacity: 0.85 }}>
                  PO vs invoice variance
                </div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, marginTop: '0.2rem' }}>
                  {variance >= 0 ? '+' : ''}
                  {formatINRSymbol(variance)}
                  <span style={{ marginLeft: '0.4rem', fontSize: '0.78rem', opacity: 0.85 }}>
                    ({variance >= 0 ? '+' : ''}{variancePct.toFixed(2)}%)
                  </span>
                </div>
                <div style={{ fontSize: '0.72rem', marginTop: '0.25rem', opacity: 0.85 }}>
                  Invoice {formatINRSymbol(declaredTotal)} · PO base {formatINRSymbol(poTotal)}
                </div>
              </div>
            )}
          </>
        ) : (
          <EmptyRow>No PO linked to this invoice yet.</EmptyRow>
        )}
      </Panel>

      {/* Document coverage */}
      <Panel icon="pi-check-square" color="var(--accent-amber)" title="Document coverage">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <CoverageRow
            icon="pi-list"
            label="Invoice line items"
            value={String(lineCount)}
            ok={lineCount > 0}
            emptyHint="No lines captured"
          />
          <CoverageRow
            icon="pi-shopping-cart"
            label="PO line items"
            value={String(poLineCount)}
            ok={poLineCount > 0}
            emptyHint="PO not linked"
          />
          <CoverageRow
            icon="pi-box"
            label="GRN records (against PO)"
            value={String(grnCount)}
            ok={grnCount > 0}
            emptyHint="No GRN yet"
          />
          <CoverageRow
            icon="pi-truck"
            label="ASN records (against PO)"
            value={String(asnCount)}
            ok={asnCount > 0}
            emptyHint="No ASN yet"
          />
        </div>
      </Panel>
    </div>
  )
}

function AmountWaterfall({ totals }: { totals: Totals }) {
  const grand = totals.grand || 1
  const bars: Array<{ label: string; value: number; color: string }> = [
    { label: 'Taxable', value: totals.taxable, color: '#6366f1' },
    { label: 'CGST',    value: totals.cgst,    color: '#06b6d4' },
    { label: 'SGST',    value: totals.sgst,    color: '#10b981' },
    { label: 'IGST',    value: totals.igst,    color: '#f59e0b' }
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
      <div
        style={{
          display: 'flex',
          height: 14,
          borderRadius: 7,
          overflow: 'hidden',
          border: '1px solid var(--border-subtle)',
          background: 'var(--surface-2)'
        }}
      >
        {bars.map((b) => {
          if (b.value <= 0) return null
          const pct = (b.value / grand) * 100
          return (
            <div
              key={b.label}
              style={{
                width: `${pct}%`,
                background: b.color,
                borderRight: '1px solid rgba(255,255,255,0.25)'
              }}
              title={`${b.label}: ${formatINRSymbol(b.value)}`}
            />
          )
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem 0.85rem' }}>
        {bars.map((b) => (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: b.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{b.label}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-primary)', fontWeight: 700 }}>
              {formatINRSymbol(b.value)}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: '0.3rem',
          paddingTop: '0.6rem',
          borderTop: '1px dashed var(--border-subtle)',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between'
        }}
      >
        <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
          Grand total
        </span>
        <span style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          {formatINRSymbol(totals.grand)}
        </span>
      </div>
    </div>
  )
}

function FactGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        gap: '0.5rem'
      }}
    >
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '0.75rem',
            padding: '0.35rem 0',
            borderBottom: '1px dashed var(--border-subtle)'
          }}
        >
          <span
            style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-muted)',
              fontWeight: 700,
              flexShrink: 0
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: '0.85rem',
              fontWeight: 600,
              color: value === '—' ? 'var(--text-muted)' : 'var(--text-primary)',
              textAlign: 'right',
              wordBreak: 'break-word'
            }}
          >
            {value || '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

function CoverageRow({
  icon,
  label,
  value,
  ok,
  emptyHint
}: {
  icon: string
  label: string
  value: string
  ok: boolean
  emptyHint: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.65rem',
        padding: '0.55rem 0.7rem',
        borderRadius: 'var(--radius-md)',
        background: ok ? 'var(--status-success-bg)' : 'var(--surface-1)',
        border: `1px solid ${ok ? 'var(--status-success-ring)' : 'var(--border-subtle)'}`,
        color: ok ? 'var(--status-success-fg)' : 'var(--text-muted)'
      }}
    >
      <i className={`pi ${icon}`} style={{ fontSize: '0.88rem' }} />
      <div style={{ flex: 1, fontSize: '0.82rem', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '0.82rem', fontWeight: 800 }}>{ok ? value : emptyHint}</div>
    </div>
  )
}

function LineItemsTab({ lines, totals }: { lines: InvoiceLine[]; totals: Totals }) {
  if (lines.length === 0) {
    return <Panel icon="pi-list" color="var(--accent-violet)" title="Invoice line items">
      <EmptyRow>No line items captured on this invoice.</EmptyRow>
    </Panel>
  }
  return (
    <Panel icon="pi-list" color="var(--accent-violet)" title={`Invoice line items (${lines.length})`}>
      <ScrollTable
        headers={['#', 'Item', 'HSN', 'Qty', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST', 'Line total']}
        alignRight={[2, 3, 4, 5, 6, 7, 8, 9]}
        rows={lines.map((ln, i) => [
          String(ln.sequence_number ?? i + 1),
          ln.item_name || '—',
          ln.hsn_sac || '—',
          `${formatQty(ln.billed_qty)}${ln.uom ? ` ${ln.uom}` : ''}`,
          formatINRSymbol(ln.rate),
          formatINRSymbol(ln.taxable_value),
          formatINRSymbol(ln.cgst_amount),
          formatINRSymbol(ln.sgst_amount),
          formatINRSymbol(ln.igst_amount),
          formatINRSymbol(ln.line_total)
        ])}
        footer={[
          '',
          `Totals`,
          '',
          '',
          '',
          formatINRSymbol(totals.taxable),
          formatINRSymbol(totals.cgst),
          formatINRSymbol(totals.sgst),
          formatINRSymbol(totals.igst),
          formatINRSymbol(totals.grand)
        ]}
      />
    </Panel>
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
  if (!detail.po_id) {
    return (
      <Panel icon="pi-shopping-cart" color="var(--accent-emerald)" title="Linked purchase order">
        <EmptyRow>No PO linked to this invoice.</EmptyRow>
      </Panel>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <Panel icon="pi-shopping-cart" color="var(--accent-emerald)" title="Purchase order facts">
        <FactGrid
          rows={[
            ['PO number',    detail.po_number || '—'],
            ['PO date',      formatDate(detail.po_date)],
            ['Prefix',       detail.po_pfx || '—'],
            ['Amendment',    detail.po_amd_no != null ? `AMD ${detail.po_amd_no}` : '—'],
            ['PO status',    detail.po_status || '—'],
            ['Payment terms',detail.po_terms || '—'],
            ['PO base value',formatINRSymbol(poTotal)]
          ]}
        />
      </Panel>
      <Panel icon="pi-box" color="var(--accent-cyan)" title={`PO line items (${poLines.length})`}>
        {poLines.length === 0 ? (
          <EmptyRow>No PO lines available.</EmptyRow>
        ) : (
          <ScrollTable
            headers={['#', 'Item ID', 'Item name', 'Description', 'Qty', 'Unit cost', 'Line value']}
            alignRight={[4, 5, 6]}
            rows={poLines.map((pl, i) => {
              const q = parseAmount(pl.quantity) ?? 0
              const r = parseAmount(pl.unit_cost) ?? 0
              return [
                String(pl.sequence_number ?? i + 1),
                pl.item_id || '—',
                pl.item_name || '—',
                pl.item_description || '—',
                formatQty(pl.quantity),
                formatINRSymbol(pl.unit_cost),
                formatINRSymbol(q * r)
              ]
            })}
          />
        )}
      </Panel>
    </div>
  )
}

function ReceiptsTab({ grn, asn }: { grn: GRNRow[]; asn: ASNRow[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
        gap: '0.9rem'
      }}
    >
      <Panel icon="pi-box" color="var(--accent-amber)" title={`GRN / goods received (${grn.length})`}>
        {grn.length === 0 ? (
          <EmptyRow>No GRN lines recorded against this PO.</EmptyRow>
        ) : (
          <ScrollTable
            headers={['GRN #', 'Date', 'Item', 'Qty', 'Accepted', 'Rate', 'Status']}
            alignRight={[3, 4, 5]}
            rows={grn.map((g) => [
              g.grn_no || '—',
              formatDate(g.grn_date),
              g.item || '—',
              formatQty(g.grn_qty),
              formatQty(g.accepted_qty),
              formatINRSymbol(g.unit_cost),
              g.header_status || '—'
            ])}
          />
        )}
      </Panel>
      <Panel icon="pi-truck" color="var(--accent-rose)" title={`ASN / shipments (${asn.length})`}>
        {asn.length === 0 ? (
          <EmptyRow>No ASN lines recorded against this PO.</EmptyRow>
        ) : (
          <ScrollTable
            headers={['ASN #', 'DC date', 'Transporter', 'Item', 'Qty', 'Status']}
            alignRight={[4]}
            rows={asn.map((a) => [
              a.asn_no || '—',
              formatDate(a.dc_date),
              a.transporter_name || a.transporter || '—',
              a.item_code || '—',
              formatQty(a.quantity),
              a.status || '—'
            ])}
          />
        )}
      </Panel>
    </div>
  )
}

function ValidationTab({
  status,
  errors,
  warnings,
  validatedAt
}: {
  status: string
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  validatedAt: string | null
}) {
  const isWaiting = status === 'waiting_for_validation' || status === 'waiting_for_re_validation'
  const isClean = !isWaiting && errors.length === 0 && warnings.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <Panel
        icon={isClean ? 'pi-check-circle' : errors.length > 0 ? 'pi-times-circle' : 'pi-exclamation-triangle'}
        color={isClean ? 'var(--accent-emerald)' : errors.length > 0 ? 'var(--status-danger-fg)' : 'var(--accent-amber)'}
        title="Validation status"
        rightAdornment={
          validatedAt
            ? <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Last run {formatDateTime(validatedAt)}</span>
            : null
        }
      >
        {isWaiting && errors.length === 0 && warnings.length === 0 && (
          <div
            style={{
              padding: '0.9rem 1rem',
              background: 'var(--status-warn-bg)',
              color: 'var(--status-warn-fg)',
              border: '1px solid var(--status-warn-ring)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem'
            }}
          >
            <i className="pi pi-clock" style={{ fontSize: '1.2rem' }} />
            <div style={{ fontSize: '0.88rem' }}>
              <strong>This invoice is waiting for validation.</strong> Click the <em>Validate now</em> button in the header to run the validation engine.
            </div>
          </div>
        )}

        {isClean && (
          <div
            style={{
              padding: '0.9rem 1rem',
              background: 'var(--status-success-bg)',
              color: 'var(--status-success-fg)',
              border: '1px solid var(--status-success-ring)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              fontWeight: 600,
              fontSize: '0.9rem'
            }}
          >
            <i className="pi pi-check-circle" style={{ fontSize: '1.2rem' }} />
            This invoice passed every validation rule cleanly.
          </div>
        )}

        {errors.length > 0 && (
          <div style={{ marginTop: isWaiting ? '0.6rem' : 0 }}>
            <SectionLabel>
              <i className="pi pi-times-circle" style={{ color: 'var(--status-danger-fg)' }} />{' '}
              {errors.length} hard error{errors.length === 1 ? '' : 's'} · blocks payment
            </SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {errors.map((e, i) => (
                <IssueRow key={`e${i}`} tone="danger" code={e.code} message={e.message} />
              ))}
            </div>
          </div>
        )}

        {warnings.length > 0 && (
          <div style={{ marginTop: errors.length > 0 || isWaiting ? '0.6rem' : 0 }}>
            <SectionLabel>
              <i className="pi pi-exclamation-triangle" style={{ color: 'var(--accent-amber)' }} />{' '}
              {warnings.length} warning{warnings.length === 1 ? '' : 's'} · review recommended
            </SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {warnings.map((w, i) => (
                <IssueRow key={`w${i}`} tone="warn" code={w.code} message={w.message} />
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}

/* ==================== shared primitives ==================== */

function Panel({
  icon,
  color,
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
    <div
      style={{
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: '1rem 1.15rem',
        boxShadow: 'var(--shadow-sm)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.8rem',
          paddingBottom: '0.6rem',
          borderBottom: '1px dashed var(--border-subtle)'
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: `color-mix(in srgb, ${color} 18%, transparent)`,
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            flexShrink: 0
          }}
        >
          <i className={`pi ${icon}`} />
        </div>
        <h4
          style={{
            margin: 0,
            fontSize: '0.92rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            letterSpacing: '-0.005em'
          }}
        >
          {title}
        </h4>
        <div style={{ flex: 1 }} />
        {rightAdornment}
      </div>
      {children}
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.7rem',
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-muted)',
        marginBottom: '0.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem'
      }}
    >
      {children}
    </div>
  )
}

function IssueRow({ tone, code, message }: { tone: 'danger' | 'warn'; code: string; message: string }) {
  const bg = tone === 'danger' ? 'var(--status-danger-bg)' : 'var(--status-warn-bg)'
  const fg = tone === 'danger' ? 'var(--status-danger-fg)' : 'var(--status-warn-fg)'
  const ring = tone === 'danger' ? 'var(--status-danger-ring)' : 'var(--status-warn-ring)'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.7rem',
        padding: '0.7rem 0.9rem',
        background: bg,
        color: fg,
        border: `1px solid ${ring}`,
        borderRadius: 'var(--radius-md)'
      }}
    >
      <code
        style={{
          flexShrink: 0,
          fontSize: '0.74rem',
          fontWeight: 800,
          padding: '0.15rem 0.5rem',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.1)',
          letterSpacing: '0.02em'
        }}
      >
        {code}
      </code>
      <span style={{ fontSize: '0.86rem', fontWeight: 500, lineHeight: 1.5 }}>{message}</span>
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

function ScrollTable({
  headers,
  rows,
  alignRight = [],
  footer
}: {
  headers: string[]
  rows: string[][]
  alignRight?: number[]
  footer?: string[]
}) {
  const rightSet = new Set(alignRight)
  return (
    <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
        <thead>
          <tr style={{ background: 'var(--surface-1)' }}>
            {headers.map((h, i) => (
              <th
                key={h}
                style={{
                  padding: '0.6rem 0.8rem',
                  textAlign: rightSet.has(i) ? 'right' : 'left',
                  fontSize: '0.68rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                  borderBottom: '1px solid var(--border-subtle)',
                  whiteSpace: 'nowrap'
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.6rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal'
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr style={{ background: 'var(--surface-2)', fontWeight: 800 }}>
              {footer.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.65rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    borderTop: '2px solid var(--border-default)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal'
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
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
