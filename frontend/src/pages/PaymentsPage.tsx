import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import StatusChip from '../components/StatusChip'
import InvoiceExpansion from '../components/InvoiceExpansion'
import SlideOver from '../components/SlideOver'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatINRSymbol, formatDate, parseAmount } from '../utils/format'
import { downloadCsv } from '../utils/exportCsv'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'

type Tab = 'approve' | 'ready' | 'history'

interface DebitNoteDetailRow {
  debit_note_id: number
  file_name: string | null
  dn_notes: string | null
  uploaded_at: string | null
  line_number: number | null
  description: string | null
  quantity: number | string | null
  unit_price: number | string | null
  amount: number | string | null
  line_notes: string | null
}

interface PaymentTxRow {
  id: number
  amount: number | string | null
  paid_at: string | null
  notes: string | null
  payment_type: string | null
  payment_reference: string | null
  paid_by_username: string | null
  paid_by_name: string | null
}

interface PaymentRow {
  // Approve tab is a list of invoices; Ready / History are rows from payment_approvals.
  // Some fields only appear on specific tabs.
  id?: number                    // payment_approval_id — on Ready + History
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  supplier_name: string | null
  po_number?: string | null
  total_amount: number | string | null
  debit_note_value?: number | string | null
  debit_note_count?: number | null
  debit_note_total?: number | string | null
  debit_note_details?: DebitNoteDetailRow[]
  paid_amount?: number | string | null     // Ready + History
  payment_transactions?: PaymentTxRow[]
  status: string | null
  payment_due_date?: string | null
  approved_by_name?: string | null
  approved_by_username?: string | null
  approved_at?: string | null
  payment_date?: string | null
  payment_done_by_name?: string | null
  payment_done_by_username?: string | null
  payment_done_at?: string | null
  payment_type?: string | null
  payment_reference?: string | null
  // Rejection trail — surfaced on the History tab so the supplier-facing
  // user can see why a payment was blocked, by whom, and when.
  rejection_reason?: string | null
  rejected_by_name?: string | null
  rejected_by_username?: string | null
  rejected_at?: string | null
}

interface RecordPaymentForm {
  amount: string
  paymentType: string
  paymentReference: string
  notes: string
}

const EMPTY_PAY_FORM: RecordPaymentForm = {
  amount: '',
  paymentType: 'NEFT',
  paymentReference: '',
  notes: ''
}

function PaymentsPage() {
  const location = useLocation()
  const navigate = useNavigate()

  const initialTab: Tab =
    location.pathname.endsWith('/history') ? 'history' :
    location.pathname.endsWith('/ready')   ? 'ready'   : 'approve'
  const [tab, setTab] = useState<Tab>(initialTab)

  const toast = useToast()
  const confirmDialog = useConfirm()

  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  /** Whole-system payment KPIs — independent of the active tab. */
  const [stats, setStats] = useState<{
    ready:         { count: number; value: number }
    due_week:      { count: number; value: number }
    overdue:       { count: number; value: number }
    paid_month:    { count: number; value: number }
    // Per-tab chip counts — independent of the current tab's row fetch
    // so all three numbers stay accurate at once.
    approve_queue?: { count: number }
    awaiting_bank?: { count: number }
    history?:       { count: number }
  } | null>(null)

  /** SlideOver — when the user clicks a row chevron we open the rich
   *  invoice detail in a side panel instead of expanding inline. This
   *  matches the Invoices + Purchase-orders pages. */
  const [detailRow, setDetailRow] = useState<PaymentRow | null>(null)

  // Multi-select state for bulk actions on the Approve tab. Set of
  // invoice_id — same key used elsewhere on the page. Cleared whenever the
  // visible rows or tab change so a stale selection can't leak across views.
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set())
  const [bulkRunning, setBulkRunning] = useState(false)
  useEffect(() => { setBulkSelected(new Set()) }, [tab])

  // Row expansion state — keyed by invoice_id. Now only controls the
  // inline action forms (bank override on Approve tab, payment-recording
  // on Ready tab). The rich invoice/PO/GRN/ASN/validation/audit drill-in
  // moved out of the inline expansion and into the slide-over above so
  // it matches the Invoices + Purchase-orders pages.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Inline payment form state — keyed by payment_approval_id (pa.id)
  const [payForms, setPayForms] = useState<Record<number, RecordPaymentForm>>({})
  const [paying, setPaying] = useState<number | null>(null)

  // Bank-override form state for "Modify & Approve" — keyed by invoice_id
  const [bankOverrideId, setBankOverrideId] = useState<number | null>(null)
  const [bankForm, setBankForm] = useState({
    bank_account_name: '',
    bank_account_number: '',
    bank_ifsc_code: '',
    bank_name: '',
    branch_name: ''
  })

  const endpointFor = (t: Tab) =>
    t === 'approve' ? 'payments/pending-approval'
      : t === 'ready' ? 'payments/ready'
      : 'payments/history'

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setExpandedIds(new Set())
      // Fetch with a high limit so the displayed count reflects all
      // pending invoices, not just the first server-default page (100).
      // The backend caps at 1000 internally; we ask for everything.
      const res = await apiFetch(`${endpointFor(tab)}?limit=1000`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load payments'))
      const body = await res.json()
      const items: PaymentRow[] = body.items || body.payments || (Array.isArray(body) ? body : [])
      // Trust the server's `total` (= COUNT(*) of the filter) when present —
      // otherwise fall back to items.length. This keeps the displayed count
      // accurate even if the page is paginated server-side.
      setRows(items)
    } catch (err) {
      toast.danger('Action failed', getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { load() }, [load])

  /* Whole-system payment KPIs — independent of the active tab. Exposed as
     a function so post-mutation handlers (approve / reject / reopen /
     record-payment) can refresh the chip counts in place. */
  const loadStats = useCallback(async () => {
    try {
      const res = await apiFetch('payments/stats')
      if (!res.ok) return
      setStats(await res.json())
    } catch {
      /* swallow — KPIs fall back to "—" */
    }
  }, [])
  useEffect(() => { loadStats() }, [loadStats])

  useEffect(() => {
    const path = tab === 'history' ? '/payments/history' : tab === 'ready' ? '/payments/ready' : '/payments/approve'
    if (location.pathname !== path) navigate(path, { replace: true })
  }, [tab, location.pathname, navigate])

  /* ---------- approve / reject ---------- */

  const handleApprove = async (row: PaymentRow) => {
    const ok = await confirmDialog({
      title: `Approve payment for ${row.invoice_number}?`,
      body: `${formatINRSymbol(row.total_amount)} will move to the Ready for payment queue.`,
      icon: 'pi-check-circle',
      kind: 'success',
      okLabel: 'Approve'
    })
    if (!ok) return
    setBusyId(row.invoice_id)
    try {
      const res = await apiFetch('payments/approve', {
        method: 'POST',
        body: JSON.stringify({ invoiceId: row.invoice_id })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Approve failed'))
      toast.success('Approved for payment', `Invoice ${row.invoice_number} moved to Ready for payment.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      loadStats()
    } catch (err) {
      toast.danger('Action failed', getDisplayError(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleApproveWithBank = async (row: PaymentRow) => {
    setBusyId(row.invoice_id)
    try {
      const payload: Record<string, unknown> = { invoiceId: row.invoice_id }
      if (bankForm.bank_account_name) payload.bank_account_name = bankForm.bank_account_name
      if (bankForm.bank_account_number) payload.bank_account_number = bankForm.bank_account_number
      if (bankForm.bank_ifsc_code) payload.bank_ifsc_code = bankForm.bank_ifsc_code
      if (bankForm.bank_name) payload.bank_name = bankForm.bank_name
      if (bankForm.branch_name) payload.branch_name = bankForm.branch_name
      const res = await apiFetch('payments/approve', {
        method: 'POST',
        body: JSON.stringify(payload)
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Approve failed'))
      toast.success('Approved with bank override', `Invoice ${row.invoice_number} — using the modified bank details.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      loadStats()
      setBankOverrideId(null)
      setBankForm({ bank_account_name: '', bank_account_number: '', bank_ifsc_code: '', bank_name: '', branch_name: '' })
    } catch (err) {
      toast.danger('Action failed', getDisplayError(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleReject = async (row: PaymentRow) => {
    const reason = window.prompt(`Reject invoice ${row.invoice_number}?\n\nReason (required):`)
    if (!reason || !reason.trim()) return
    setBusyId(row.invoice_id)
    try {
      const res = await apiFetch('payments/reject', {
        method: 'PATCH',
        body: JSON.stringify({ invoiceId: row.invoice_id, rejection_reason: reason.trim() })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Reject failed'))
      toast.warn('Invoice rejected', `${row.invoice_number} won't proceed to payment.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      loadStats()
    } catch (err) {
      toast.danger('Action failed', getDisplayError(err))
    } finally {
      setBusyId(null)
    }
  }

  // ---------- bulk approve / reject (Approve tab) ----------
  // The backend has no batch endpoint, but a serial loop is fine: each
  // /payments/approve is a single transaction and ~tens of invoices is the
  // realistic batch size. We collect successes/failures and toast a summary
  // at the end so the user knows exactly what landed.

  const toggleBulkSelect = (invoiceId: number) => {
    setBulkSelected((prev) => {
      const next = new Set(prev)
      if (next.has(invoiceId)) next.delete(invoiceId)
      else next.add(invoiceId)
      return next
    })
  }
  const toggleBulkSelectAll = () => {
    setBulkSelected((prev) => {
      const allOnPage = rows.map((r) => r.invoice_id)
      // If every visible row is already selected, deselect; otherwise select all.
      const allSelected = allOnPage.every((id) => prev.has(id))
      return allSelected ? new Set() : new Set(allOnPage)
    })
  }

  const handleBulkApprove = async () => {
    if (bulkSelected.size === 0) return
    const ok = await confirmDialog({
      title: `Approve ${bulkSelected.size} invoice${bulkSelected.size === 1 ? '' : 's'}?`,
      body: 'Each invoice is approved with its supplier-default banking. To override banking on any single invoice, use the "Modify & Approve" action instead.',
      icon: 'pi-check',
      kind: 'success',
      okLabel: `Approve ${bulkSelected.size}`
    })
    if (!ok) return
    setBulkRunning(true)
    const ids = Array.from(bulkSelected)
    let ok_count = 0
    let fail_count = 0
    for (const invoiceId of ids) {
      try {
        const res = await apiFetch('payments/approve', {
          method: 'POST',
          body: JSON.stringify({ invoiceId })
        })
        if (res.ok) ok_count++
        else fail_count++
      } catch { fail_count++ }
    }
    if (ok_count > 0) {
      setRows((prev) => prev.filter((r) => !ids.includes(r.invoice_id) || !bulkSelected.has(r.invoice_id)))
      loadStats()
    }
    setBulkSelected(new Set())
    setBulkRunning(false)
    if (fail_count === 0) {
      toast.success(`${ok_count} invoices approved`, 'All approvals landed cleanly.')
    } else {
      toast.warn(`${ok_count} approved, ${fail_count} failed`, 'Failed rows stay in the queue — open each to see the error.')
    }
  }

  const handleBulkReject = async () => {
    if (bulkSelected.size === 0) return
    const reason = window.prompt(
      `Reject ${bulkSelected.size} invoice${bulkSelected.size === 1 ? '' : 's'}?\n\nShared reason (required, applied to every row):`
    )
    if (!reason || !reason.trim()) return
    setBulkRunning(true)
    const ids = Array.from(bulkSelected)
    let ok_count = 0
    let fail_count = 0
    for (const invoiceId of ids) {
      try {
        const res = await apiFetch('payments/reject', {
          method: 'PATCH',
          body: JSON.stringify({ invoiceId, rejection_reason: reason.trim() })
        })
        if (res.ok) ok_count++
        else fail_count++
      } catch { fail_count++ }
    }
    if (ok_count > 0) {
      setRows((prev) => prev.filter((r) => !ids.includes(r.invoice_id) || !bulkSelected.has(r.invoice_id)))
      loadStats()
    }
    setBulkSelected(new Set())
    setBulkRunning(false)
    if (fail_count === 0) {
      toast.warn(`${ok_count} invoices rejected`, `Reason: ${reason}`)
    } else {
      toast.warn(`${ok_count} rejected, ${fail_count} failed`, 'Failed rows stay in the queue.')
    }
  }

  /**
   * Re-open a rejected invoice — flips it back to validated/pending_approval
   * so it re-enters the Approve queue. The rejection trail on
   * payment_approvals is preserved for audit.
   */
  const handleReopen = async (row: PaymentRow) => {
    const ok = await confirmDialog({
      title: `Re-open invoice ${row.invoice_number}?`,
      body: 'This puts the invoice back into the Approve queue. The original rejection (reason, who, when) stays on file for audit.',
      okLabel: 'Re-open',
      kind: 'info',
      icon: 'pi-refresh'
    })
    if (!ok) return
    setBusyId(row.invoice_id)
    try {
      const res = await apiFetch('payments/reopen', {
        method: 'PATCH',
        body: JSON.stringify({ invoiceId: row.invoice_id })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Re-open failed'))
      toast.success('Invoice re-opened', `${row.invoice_number} is back in the Approve queue.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      loadStats()
    } catch (err) {
      toast.danger('Action failed', getDisplayError(err))
    } finally {
      setBusyId(null)
    }
  }

  /* ---------- record payment (full / partial) ---------- */

  const remainingFor = (row: PaymentRow): number => {
    const base = parseAmount(row.debit_note_value) ?? parseAmount(row.total_amount) ?? 0
    const paid = parseAmount(row.paid_amount) ?? 0
    return Math.max(0, base - paid)
  }

  const recordPayment = async (row: PaymentRow, amountOverride?: number) => {
    if (!row.id) {
      toast.danger('Missing approval id', 'Reload the page and try again.')
      return
    }
    const formState = payForms[row.id] ?? EMPTY_PAY_FORM
    const remaining = remainingFor(row)
    const amount = amountOverride != null ? amountOverride : Number(formState.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.warn('Invalid amount', 'Enter a payment amount greater than zero.')
      return
    }
    if (amount > remaining + 0.01) {
      toast.warn('Amount too high', `Exceeds the remaining balance ${formatINRSymbol(remaining)}.`)
      return
    }
    setPaying(row.id)
    try {
      const res = await apiFetch('payments/record-payment', {
        method: 'POST',
        body: JSON.stringify({
          paymentApprovalId: row.id,
          amount: amount,
          paymentType: formState.paymentType || null,
          paymentReference: formState.paymentReference || null,
          notes: formState.notes || null
        })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Record payment failed'))
      const body = await res.json()
      if (body.status === 'payment_done') {
        toast.success('Payment recorded', `Invoice ${row.invoice_number} is fully paid.`)
        setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
        loadStats()
      } else {
        toast.success('Partial payment', `${formatINRSymbol(amount)} recorded for ${row.invoice_number}. Remaining ${formatINRSymbol(body.remaining)}.`)
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, paid_amount: body.paidSoFar, status: 'partially_paid' } : r)))
      }
      // Reset this row's form
      setPayForms((p) => ({ ...p, [row.id as number]: EMPTY_PAY_FORM }))
    } catch (err) {
      toast.danger('Action failed', getDisplayError(err))
    } finally {
      setPaying(null)
    }
  }

  const updatePayForm = (approvalId: number, key: keyof RecordPaymentForm, value: string) => {
    setPayForms((prev) => ({
      ...prev,
      [approvalId]: { ...(prev[approvalId] ?? EMPTY_PAY_FORM), [key]: value }
    }))
  }

  return (
    <>
      {/* Hero — verbatim from mockup VIEWS.payments */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-wallet" /> Workflow</span>
          <h1>Payments</h1>
          <p>Validated invoices ready for payment. Bulk-approve into a payment batch, schedule by due date, or split by supplier — then export NEFT/RTGS file.</p>
        </div>
        <div className="hero__act">
          <button
            className="btn btn--g"
            onClick={() => {
              if (tab === 'history') {
                downloadCsv(
                  rows as unknown as Record<string, unknown>[],
                  'payment-history-export',
                  [
                    { key: 'invoice_number', header: 'Invoice #' },
                    { key: 'invoice_date',   header: 'Invoice date' },
                    { key: 'supplier_name',  header: 'Supplier' },
                    { key: 'total_amount',   header: 'Amount' },
                    { key: 'status',         header: 'Status' },
                    { key: 'payment_done_at',header: 'Payment date' },
                    { key: 'payment_type',   header: 'Mode' },
                    { key: 'payment_reference', header: 'Reference' }
                  ]
                )
              } else {
                setTab('history')
              }
            }}
          >
            <i className="pi pi-history" /> {tab === 'history' ? 'Export CSV' : 'Payment history'}
          </button>
        </div>
      </section>

      {/* 4-up KPI strip from /payments/stats — independent of active tab. */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--em">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-check" /></div></div>
          <p className="kpi__l">Ready to approve</p>
          <div className="kpi__v">{stats ? stats.ready.count.toLocaleString('en-IN') : '—'}</div>
          <div className="kpi__f">{stats ? formatINRSymbol(stats.ready.value) : ''}</div>
        </div>
        <div className="kpi kpi--am">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-clock" /></div></div>
          <p className="kpi__l">Due this week</p>
          <div className="kpi__v">{stats ? stats.due_week.count.toLocaleString('en-IN') : '—'}</div>
          <div className="kpi__f">{stats ? formatINRSymbol(stats.due_week.value) : ''}</div>
        </div>
        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-exclamation-circle" /></div></div>
          <p className="kpi__l">Overdue</p>
          <div className="kpi__v">{stats ? stats.overdue.count.toLocaleString('en-IN') : '—'}</div>
          <div className="kpi__f">{stats ? formatINRSymbol(stats.overdue.value) : ''}</div>
        </div>
        <div className="kpi kpi--vio">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-credit-card" /></div></div>
          <p className="kpi__l">Paid this month</p>
          <div className="kpi__v">{stats ? stats.paid_month.count.toLocaleString('en-IN') : '—'}</div>
          <div className="kpi__f">{stats ? formatINRSymbol(stats.paid_month.value) : ''}</div>
        </div>
      </div>

      {/* Mockup tabs row. Each chip uses its OWN count from /payments/stats
          (the totals state only tracks the active tab, so we can't reuse it
          for the inactive tabs without three separate fetches). */}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {(['approve', 'ready', 'history'] as Tab[]).map((t) => {
          const tabCount =
            t === 'approve' ? stats?.approve_queue?.count
            : t === 'ready' ? stats?.awaiting_bank?.count
            : stats?.history?.count
          return (
            <button
              key={t}
              type="button"
              className={`tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'approve' ? 'Approve queue' : t === 'ready' ? 'Approved · awaiting bank' : 'Paid'}
              {tabCount != null && (
                <span className="muted" style={{ marginLeft: 6 }}>({tabCount.toLocaleString('en-IN')})</span>
              )}
            </button>
          )
        })}
      </div>

      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="pi pi-spin pi-spinner" style={{ fontSize: '1.8rem', color: 'var(--brand-600)' }} />
            <div style={{ marginTop: '0.75rem' }}>Loading payments…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="emptyState" style={{ border: 0, borderRadius: 0 }}>
            <div className="emptyState__icon"><i className="pi pi-inbox" /></div>
            <div className="emptyState__title">Nothing in this queue</div>
            <div className="emptyState__body">
              {tab === 'approve'
                ? 'No invoices waiting for approval.'
                : tab === 'ready'
                  ? 'No invoices are ready for payment release.'
                  : 'No payments have been recorded yet.'}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {/* Bulk-action toolbar — only meaningful on the Approve tab.
                Sticks just above the table when one or more rows are
                selected; collapses back to nothing when selection is empty. */}
            {tab === 'approve' && bulkSelected.size > 0 && (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.6rem',
                  padding: '0.6rem 1rem',
                  background: 'color-mix(in srgb, var(--brand-600) 10%, transparent)',
                  borderBottom: '1px solid var(--border-subtle)',
                  position: 'sticky', top: 0, zIndex: 1
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 13 }}>
                  {bulkSelected.size} selected
                </span>
                <button
                  type="button"
                  className="action-btn"
                  onClick={handleBulkApprove}
                  disabled={bulkRunning}
                  style={{ padding: '5px 11px', fontSize: 12 }}
                >
                  {bulkRunning
                    ? <><i className="pi pi-spin pi-spinner" /> Running…</>
                    : <><i className="pi pi-check" /> Approve selected</>}
                </button>
                <button
                  type="button"
                  className="action-btn action-btn--ghost"
                  onClick={handleBulkReject}
                  disabled={bulkRunning}
                  style={{ padding: '5px 11px', fontSize: 12, color: 'var(--status-danger-fg)' }}
                >
                  <i className="pi pi-times" /> Reject selected
                </button>
                <button
                  type="button"
                  className="action-btn action-btn--ghost"
                  onClick={() => setBulkSelected(new Set())}
                  disabled={bulkRunning}
                  style={{ padding: '5px 11px', fontSize: 12 }}
                >
                  Clear
                </button>
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr style={{ background: 'var(--surface-1)' }}>
                  {(() => {
                    const headers =
                      tab === 'ready'
                        ? ['', 'Invoice', 'Supplier', 'Invoice date', 'Amount', 'Paid / Remaining', 'Status', 'Action']
                        : tab === 'history'
                        ? ['', 'Invoice', 'Supplier', 'Invoice date', 'Amount', 'Status', 'Payment date', 'Mode']
                        : ['__BULK__', 'Invoice', 'Supplier', 'Invoice date', 'Amount', 'Status', 'Action']
                    return headers.map((h, i) => (
                      <th
                        key={`${h}-${i}`}
                        style={{
                          padding: '0.8rem 0.95rem',
                          textAlign: ['Amount', 'Paid / Remaining'].includes(h) ? 'right' : 'left',
                          fontSize: '0.73rem',
                          color: 'var(--text-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          fontWeight: 700,
                          borderBottom: '1px solid var(--border-subtle)',
                          width: i === 0 ? 56 : undefined
                        }}
                      >
                        {h === '__BULK__' ? (
                          <input
                            type="checkbox"
                            aria-label="Select all on page"
                            title="Select all visible invoices"
                            checked={rows.length > 0 && rows.every((r) => bulkSelected.has(r.invoice_id))}
                            onChange={toggleBulkSelectAll}
                            style={{ cursor: 'pointer' }}
                          />
                        ) : h}
                      </th>
                    ))
                  })()}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isExpanded = expandedIds.has(r.invoice_id)
                  const remaining = tab === 'ready' || tab === 'history' ? remainingFor(r) : 0
                  const paid = parseAmount(r.paid_amount) ?? 0
                  const baseAmount = parseAmount(r.debit_note_value) ?? parseAmount(r.total_amount) ?? 0
                  const formState = r.id ? payForms[r.id] ?? EMPTY_PAY_FORM : EMPTY_PAY_FORM
                  return (
                    <>
                      <tr
                        key={r.invoice_id}
                        style={{ borderBottom: isExpanded ? 0 : '1px solid var(--border-subtle)', cursor: 'pointer' }}
                        onClick={(e) => {
                          /* Only open the side panel when the user clicks
                             a data cell — not when they click an action
                             button, input or chevron inside the row. */
                          const target = e.target as HTMLElement
                          if (target.closest('button, input, a, select')) return
                          setDetailRow(r)
                        }}
                      >
                        {/* First cell — bulk checkbox on Approve tab only;
                            empty elsewhere. The chevron expand button used to
                            live here but was redundant: "Modify & Approve"
                            (Approve tab) and "Partial" (Ready tab) already
                            auto-toggle the inline form. Row click still opens
                            the slide-over for full detail. */}
                        <td
                          style={{ padding: '0.5rem 0.4rem 0.5rem 0.95rem', width: tab === 'approve' ? 36 : 12 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {tab === 'approve' && (
                            <input
                              type="checkbox"
                              aria-label={`Select invoice ${r.invoice_number}`}
                              checked={bulkSelected.has(r.invoice_id)}
                              onChange={() => toggleBulkSelect(r.invoice_id)}
                              style={{ cursor: 'pointer' }}
                            />
                          )}
                        </td>

                        <td style={{ padding: '0.85rem 0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {r.invoice_number}
                        </td>
                        <td style={{ padding: '0.85rem 0.95rem' }}>{r.supplier_name || '—'}</td>
                        <td style={{ padding: '0.85rem 0.95rem', fontSize: '0.88rem' }}>
                          {formatDate(r.invoice_date)}
                        </td>
                        <td style={{ padding: '0.85rem 0.95rem', textAlign: 'right', fontWeight: 700 }}>
                          {formatINRSymbol(baseAmount)}
                          {Number(r.debit_note_count || 0) > 0 && (
                            <div style={{ fontSize: '0.7rem', fontWeight: 500, color: 'var(--accent-rose)', marginTop: 2 }}>
                              <i className="pi pi-receipt" style={{ fontSize: 9, marginRight: 3 }} />
                              {r.debit_note_count} debit note{Number(r.debit_note_count) === 1 ? '' : 's'}
                              {r.debit_note_total != null && Number(r.debit_note_total) > 0 &&
                                ` · −${formatINRSymbol(r.debit_note_total)}`}
                            </div>
                          )}
                        </td>

                        {tab === 'ready' && (
                          <td style={{ padding: '0.85rem 0.95rem', textAlign: 'right' }}>
                            <div style={{ fontWeight: 700, color: 'var(--status-success-fg)' }}>
                              {formatINRSymbol(paid)}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                              {formatINRSymbol(remaining)} remaining
                            </div>
                          </td>
                        )}

                        <td style={{ padding: '0.85rem 0.95rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                            <StatusChip status={r.status} />
                            {String(r.status || '').toLowerCase() === 'rejected' && r.rejection_reason && (
                              <span
                                className="status-chip status-chip--danger"
                                style={{ fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={r.rejection_reason}
                              >
                                <i className="pi pi-info-circle" /> {r.rejection_reason}
                              </span>
                            )}
                          </div>
                        </td>

                        {tab === 'history' ? (
                          <>
                            <td style={{ padding: '0.85rem 0.95rem', fontSize: '0.88rem' }}>
                              {formatDate(r.payment_done_at || r.rejected_at || r.payment_date)}
                            </td>
                            <td style={{ padding: '0.85rem 0.95rem' }}>
                              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                                {String(r.status || '').toLowerCase() === 'rejected'
                                  ? 'Rejected'
                                  : (r.payment_type || '—')}
                              </div>
                              {r.payment_reference && (
                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                  {r.payment_reference}
                                </div>
                              )}
                              {/* Re-open hatch for rejected rows — flips the
                                  invoice back to validated so it can be
                                  re-approved. Rejection trail stays on file. */}
                              {String(r.status || '').toLowerCase() === 'rejected' && (
                                <button
                                  type="button"
                                  className="action-btn action-btn--ghost"
                                  onClick={(e) => { e.stopPropagation(); handleReopen(r) }}
                                  disabled={busyId === r.invoice_id}
                                  style={{ marginTop: 6, padding: '4px 9px', fontSize: 11 }}
                                  title="Move this invoice back into the Approve queue"
                                >
                                  {busyId === r.invoice_id
                                    ? <><i className="pi pi-spin pi-spinner" /></>
                                    : <><i className="pi pi-refresh" /> Re-open</>}
                                </button>
                              )}
                            </td>
                          </>
                        ) : tab === 'approve' ? (
                          <td style={{ padding: '0.85rem 0.95rem' }}>
                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <button
                                className="action-btn"
                                onClick={() => handleApprove(r)}
                                disabled={busyId === r.invoice_id}
                                title="Approve this invoice for payment"
                              >
                                {busyId === r.invoice_id
                                  ? <><i className="pi pi-spin pi-spinner" /></>
                                  : <><i className="pi pi-check" /> Approve</>}
                              </button>
                              <button
                                className="action-btn action-btn--ghost"
                                onClick={() => {
                                  setBankOverrideId(bankOverrideId === r.invoice_id ? null : r.invoice_id)
                                  if (!isExpanded) toggleExpand(r.invoice_id)
                                }}
                                title="Approve with modified bank details"
                              >
                                <i className="pi pi-pencil" /> Modify &amp; Approve
                              </button>
                              <button
                                className="action-btn action-btn--ghost"
                                onClick={() => handleReject(r)}
                                disabled={busyId === r.invoice_id}
                                style={{ color: 'var(--status-danger-fg)' }}
                                title="Reject this invoice"
                              >
                                <i className="pi pi-times" /> Reject
                              </button>
                            </div>
                          </td>
                        ) : (
                          /* ready tab */
                          <td style={{ padding: '0.85rem 0.95rem' }}>
                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <button
                                className="action-btn"
                                onClick={() => recordPayment(r, remaining)}
                                disabled={paying === r.id || remaining <= 0}
                                title={`Pay the full remaining balance of ${formatINRSymbol(remaining)}`}
                              >
                                {paying === r.id
                                  ? <><i className="pi pi-spin pi-spinner" /></>
                                  : <><i className="pi pi-check-circle" /> Pay full</>}
                              </button>
                              <button
                                className="action-btn action-btn--ghost"
                                onClick={() => {
                                  if (!isExpanded) toggleExpand(r.invoice_id)
                                  if (r.id) {
                                    setPayForms((p) => ({
                                      ...p,
                                      [r.id as number]: {
                                        ...(p[r.id as number] ?? EMPTY_PAY_FORM),
                                        amount: remaining > 0 ? String(remaining / 2) : ''
                                      }
                                    }))
                                  }
                                }}
                                disabled={remaining <= 0}
                                title="Record a partial payment"
                              >
                                <i className="pi pi-wallet" /> Partial
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>

                      {/* Expanded row */}
                      {isExpanded && (
                        <tr key={`${r.invoice_id}-expanded`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td colSpan={tab === 'ready' ? 8 : tab === 'history' ? 8 : 7} style={{ padding: 0 }}>
                            {/* Approver / disputes / transactions context strip — shown on every
                                tab when the data is present. Lets the user see who approved or
                                paid, the debit-note lines that drive the payable amount, and
                                the partial-payment trail before they take the next action. */}
                            <PaymentContextStrip row={r} tab={tab} />

                            {/* Bank-override form (Approve tab) */}
                            {tab === 'approve' && bankOverrideId === r.invoice_id && (
                              <div
                                style={{
                                  padding: '1rem 1.25rem',
                                  background: 'var(--surface-1)',
                                  borderTop: '1px solid var(--border-subtle)'
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
                                  <div style={{ width: 28, height: 28, borderRadius: 7, background: 'color-mix(in srgb, var(--accent-violet) 18%, transparent)', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem' }}>
                                    <i className="pi pi-credit-card" />
                                  </div>
                                  <h4 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                    Override bank details before approving
                                  </h4>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.6rem' }}>
                                  <MiniField label="Account holder">
                                    <input type="text" value={bankForm.bank_account_name} onChange={(e) => setBankForm((f) => ({ ...f, bank_account_name: e.target.value }))} placeholder="Leave blank to keep supplier default" style={inputStyle} />
                                  </MiniField>
                                  <MiniField label="Account number">
                                    <input type="text" value={bankForm.bank_account_number} onChange={(e) => setBankForm((f) => ({ ...f, bank_account_number: e.target.value }))} style={inputStyle} />
                                  </MiniField>
                                  <MiniField label="IFSC code">
                                    <input type="text" value={bankForm.bank_ifsc_code} onChange={(e) => setBankForm((f) => ({ ...f, bank_ifsc_code: e.target.value.toUpperCase() }))} style={inputStyle} />
                                  </MiniField>
                                  <MiniField label="Bank name">
                                    <input type="text" value={bankForm.bank_name} onChange={(e) => setBankForm((f) => ({ ...f, bank_name: e.target.value }))} style={inputStyle} />
                                  </MiniField>
                                  <MiniField label="Branch">
                                    <input type="text" value={bankForm.branch_name} onChange={(e) => setBankForm((f) => ({ ...f, branch_name: e.target.value }))} style={inputStyle} />
                                  </MiniField>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                                  <button type="button" className="action-btn" onClick={() => handleApproveWithBank(r)} disabled={busyId === r.invoice_id}>
                                    {busyId === r.invoice_id ? <><i className="pi pi-spin pi-spinner" /> Approving…</> : <><i className="pi pi-check" /> Approve with these details</>}
                                  </button>
                                  <button type="button" className="action-btn action-btn--ghost" onClick={() => setBankOverrideId(null)}>
                                    <i className="pi pi-times" /> Cancel
                                  </button>
                                </div>
                              </div>
                            )}

                            {/* Payment recording form (Ready tab only) */}
                            {tab === 'ready' && r.id && (
                              <div
                                style={{
                                  padding: '1rem 1.25rem',
                                  background: 'var(--surface-1)',
                                  borderTop: '1px solid var(--border-subtle)'
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.6rem',
                                    marginBottom: '0.75rem'
                                  }}
                                >
                                  <div
                                    style={{
                                      width: 28,
                                      height: 28,
                                      borderRadius: 7,
                                      background: 'color-mix(in srgb, var(--accent-emerald) 18%, transparent)',
                                      color: 'var(--accent-emerald)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '0.85rem'
                                    }}
                                  >
                                    <i className="pi pi-wallet" />
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
                                    Record payment
                                  </h4>
                                  <div style={{ flex: 1 }} />
                                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700 }}>
                                    Approved {formatINRSymbol(baseAmount)} · Paid {formatINRSymbol(paid)} · <strong style={{ color: 'var(--text-primary)' }}>Remaining {formatINRSymbol(remaining)}</strong>
                                  </span>
                                </div>

                                <div
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                                    gap: '0.6rem'
                                  }}
                                >
                                  <MiniField label="Amount *">
                                    <input
                                      type="number"
                                      step="any"
                                      value={formState.amount}
                                      onChange={(e) => updatePayForm(r.id!, 'amount', e.target.value)}
                                      placeholder={`Max ${remaining.toFixed(2)}`}
                                      style={inputStyle}
                                    />
                                  </MiniField>
                                  <MiniField label="Mode">
                                    <select
                                      value={formState.paymentType}
                                      onChange={(e) => updatePayForm(r.id!, 'paymentType', e.target.value)}
                                      style={inputStyle}
                                    >
                                      <option value="NEFT">NEFT</option>
                                      <option value="RTGS">RTGS</option>
                                      <option value="IMPS">IMPS</option>
                                      <option value="UPI">UPI</option>
                                      <option value="Cheque">Cheque</option>
                                      <option value="DD">DD</option>
                                      <option value="Cash">Cash</option>
                                      <option value="Other">Other</option>
                                    </select>
                                  </MiniField>
                                  <MiniField label="Reference">
                                    <input
                                      type="text"
                                      value={formState.paymentReference}
                                      onChange={(e) => updatePayForm(r.id!, 'paymentReference', e.target.value)}
                                      placeholder="UTR / cheque #"
                                      style={inputStyle}
                                    />
                                  </MiniField>
                                  <MiniField label="Notes">
                                    <input
                                      type="text"
                                      value={formState.notes}
                                      onChange={(e) => updatePayForm(r.id!, 'notes', e.target.value)}
                                      placeholder="Optional note"
                                      style={inputStyle}
                                    />
                                  </MiniField>
                                </div>

                                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                                  <button
                                    type="button"
                                    className="action-btn"
                                    onClick={() => recordPayment(r)}
                                    disabled={paying === r.id}
                                  >
                                    {paying === r.id ? (
                                      <><i className="pi pi-spin pi-spinner" /> Recording…</>
                                    ) : (
                                      <><i className="pi pi-check" /> Record payment</>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    className="action-btn action-btn--ghost"
                                    onClick={() => {
                                      if (r.id) {
                                        updatePayForm(r.id, 'amount', String(remaining))
                                      }
                                    }}
                                    disabled={remaining <= 0}
                                    title="Fill the amount with the full remaining balance"
                                  >
                                    <i className="pi pi-angle-double-right" /> Fill remaining
                                  </button>
                                </div>
                              </div>
                            )}

                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rich invoice + PO + GRN + ASN + validation drill-in — matches the
          Invoices + Purchase-orders slide-over pattern. */}
      <SlideOver
        open={!!detailRow}
        onClose={() => setDetailRow(null)}
        title={detailRow ? `Invoice ${detailRow.invoice_number}` : 'Invoice'}
        headerActions={
          detailRow && (
            <button
              type="button"
              className="btn btn--g btn--sm"
              onClick={() => {
                navigate(`/invoices/validate/${detailRow.invoice_id}`)
                setDetailRow(null)
              }}
              title="Open in full page"
            >
              <i className="pi pi-external-link" /> Open full
            </button>
          )
        }
      >
        {detailRow && (
          <InvoiceExpansion
            invoiceId={detailRow.invoice_id}
            poNumber={detailRow.po_number ?? null}
          />
        )}
      </SlideOver>
    </>
  )
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span
        style={{
          fontSize: '0.68rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-muted)'
        }}
      >
        {label}
      </span>
      {children}
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '0.55rem 0.7rem',
  borderRadius: 'var(--radius-md)',
  border: '1.5px solid var(--border-subtle)',
  background: 'var(--surface-0)',
  color: 'var(--text-primary)',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  outline: 'none'
}

/**
 * Context strip rendered above the action form when a row is expanded.
 *
 *   Approve tab → debit-note lines (so the approver knows exactly what
 *                  reduction they're authorising before they release).
 *   Ready tab   → who approved + debit-note lines + transaction trail
 *                  (so finance sees the audit chain before paying).
 *   History tab → approver + payer + transaction trail.
 *
 * Sections render only if the underlying data exists, so the strip
 * collapses to nothing when there's no context to show.
 */
function PaymentContextStrip({ row, tab }: { row: PaymentRow; tab: Tab }) {
  const dn = row.debit_note_details || []
  const dnCount = Number(row.debit_note_count || 0)
  const dnTotal = parseAmount(row.debit_note_total)
  const txs = row.payment_transactions || []
  const showApprover = (tab === 'ready' || tab === 'history') &&
    (row.approved_by_name || row.approved_by_username || row.approved_at)
  const showPayer = tab === 'history' &&
    (row.payment_done_by_name || row.payment_done_by_username || row.payment_done_at)
  const isRejected = String(row.status || '').toLowerCase() === 'rejected'
  const showRejection = isRejected &&
    (row.rejection_reason || row.rejected_by_name || row.rejected_by_username || row.rejected_at)
  if (!showApprover && !showPayer && !showRejection && dn.length === 0 && txs.length === 0) {
    return null
  }
  return (
    <div style={{
      padding: '0.75rem 1.25rem 0.25rem',
      background: 'var(--surface-1)',
      borderTop: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column', gap: '0.75rem'
    }}>
      {showRejection && (
        <div
          style={{
            padding: '0.6rem 0.85rem',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--status-danger-ring)',
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-fg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 12
          }}
        >
          <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className="pi pi-ban" /> Payment rejected
          </div>
          {row.rejection_reason && (
            <div>{row.rejection_reason}</div>
          )}
          <div style={{ opacity: 0.85 }}>
            {row.rejected_by_name || row.rejected_by_username
              ? <>by <b>{row.rejected_by_name || row.rejected_by_username}</b> </>
              : null}
            {row.rejected_at && <>on {formatDate(row.rejected_at)}</>}
          </div>
        </div>
      )}
      {(showApprover || showPayer) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem 1.25rem', fontSize: 12 }}>
          {showApprover && (
            <div>
              <span className="muted">Approved by · </span>
              <strong>{row.approved_by_name || row.approved_by_username || '—'}</strong>
              {row.approved_at && (
                <span className="muted" style={{ marginLeft: 6 }}>
                  on {formatDate(row.approved_at)}
                </span>
              )}
            </div>
          )}
          {showPayer && (
            <div>
              <span className="muted">Marked paid by · </span>
              <strong>{row.payment_done_by_name || row.payment_done_by_username || '—'}</strong>
              {row.payment_done_at && (
                <span className="muted" style={{ marginLeft: 6 }}>
                  on {formatDate(row.payment_done_at)}
                </span>
              )}
              {row.payment_type && (
                <span className="muted" style={{ marginLeft: 6 }}>
                  · {row.payment_type}{row.payment_reference ? ` · ref ${row.payment_reference}` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {(dn.length > 0 || dnCount > 0) && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className="pi pi-receipt" style={{ color: 'var(--accent-rose)' }} />
            Debit notes
            <span className="muted" style={{ fontWeight: 500 }}>
              {dnCount > 0 && `${dnCount} note${dnCount === 1 ? '' : 's'}`}
              {dnTotal != null && dnTotal > 0 && ` · total ${formatINRSymbol(dnTotal)}`}
            </span>
          </div>
          {dn.length > 0 ? (
            <table className="tbl tbl--compact" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  <th className="tbl__num">Qty</th>
                  <th className="tbl__num">Unit price</th>
                  <th className="tbl__num">Amount</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {dn.map((d, i) => (
                  <tr key={`${d.debit_note_id}-${d.line_number ?? i}`}>
                    <td className="tbl__mono">{d.line_number ?? '—'}</td>
                    <td>{d.description || <span className="muted">—</span>}</td>
                    <td className="tbl__num">{d.quantity ?? '—'}</td>
                    <td className="tbl__num">{d.unit_price != null ? formatINRSymbol(d.unit_price) : '—'}</td>
                    <td className="tbl__num tbl__bold">{d.amount != null ? formatINRSymbol(d.amount) : '—'}</td>
                    <td className="muted">{d.line_notes || d.dn_notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>
              {dnCount} debit note{dnCount === 1 ? '' : 's'} on file but no per-line details were captured.
            </div>
          )}
        </div>
      )}

      {txs.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className="pi pi-wallet" style={{ color: 'var(--accent-emerald)' }} />
            Payment transactions
            <span className="muted" style={{ fontWeight: 500 }}>
              ({txs.length})
            </span>
          </div>
          <table className="tbl tbl--compact" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Paid at</th>
                <th>By</th>
                <th>Mode</th>
                <th>Reference</th>
                <th className="tbl__num">Amount</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.id}>
                  <td className="tbl__muted">{formatDate(t.paid_at)}</td>
                  <td>{t.paid_by_name || t.paid_by_username || '—'}</td>
                  <td className="tbl__mono">{t.payment_type || '—'}</td>
                  <td className="tbl__mono">{t.payment_reference || '—'}</td>
                  <td className="tbl__num tbl__bold">{formatINRSymbol(t.amount)}</td>
                  <td className="muted">{t.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default PaymentsPage
