import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import StatTile from '../components/StatTile'
import StatusChip from '../components/StatusChip'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatINRSymbol, formatDate, parseAmount } from '../utils/format'
import { downloadCsv } from '../utils/exportCsv'

type Tab = 'approve' | 'ready' | 'history'

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
  paid_amount?: number | string | null     // Ready + History
  status: string | null
  payment_due_date?: string | null
  approved_at?: string | null
  payment_date?: string | null
  payment_done_at?: string | null
  payment_type?: string | null
  payment_reference?: string | null
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

  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [totals, setTotals] = useState({ count: 0, value: 0 })

  // Row expansion state — keyed by invoice_id
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
      setError('')
      setSuccess('')
      setExpandedIds(new Set())
      const res = await apiFetch(endpointFor(tab))
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load payments'))
      const body = await res.json()
      const items: PaymentRow[] = body.items || body.payments || (Array.isArray(body) ? body : [])
      setRows(items)
      setTotals({
        count: items.length,
        value: items.reduce((s, r) => s + (parseAmount(r.total_amount) ?? 0), 0)
      })
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const path = tab === 'history' ? '/payments/history' : tab === 'ready' ? '/payments/ready' : '/payments/approve'
    if (location.pathname !== path) navigate(path, { replace: true })
  }, [tab, location.pathname, navigate])

  /* ---------- approve / reject ---------- */

  const handleApprove = async (row: PaymentRow) => {
    if (!confirm(`Approve payment for invoice ${row.invoice_number} (${formatINRSymbol(row.total_amount)})?`)) return
    setError(''); setSuccess('')
    setBusyId(row.invoice_id)
    try {
      const res = await apiFetch('payments/approve', {
        method: 'POST',
        body: JSON.stringify({ invoiceId: row.invoice_id })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Approve failed'))
      setSuccess(`Invoice ${row.invoice_number} approved — moved to Ready for payment.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      setTotals((t) => ({
        count: Math.max(0, t.count - 1),
        value: Math.max(0, t.value - (parseAmount(row.total_amount) ?? 0))
      }))
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleApproveWithBank = async (row: PaymentRow) => {
    setError(''); setSuccess('')
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
      setSuccess(`Invoice ${row.invoice_number} approved with modified bank details.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      setTotals((t) => ({
        count: Math.max(0, t.count - 1),
        value: Math.max(0, t.value - (parseAmount(row.total_amount) ?? 0))
      }))
      setBankOverrideId(null)
      setBankForm({ bank_account_name: '', bank_account_number: '', bank_ifsc_code: '', bank_name: '', branch_name: '' })
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleReject = async (row: PaymentRow) => {
    const reason = window.prompt(`Reject invoice ${row.invoice_number}?\n\nReason (required):`)
    if (!reason || !reason.trim()) return
    setError(''); setSuccess('')
    setBusyId(row.invoice_id)
    try {
      const res = await apiFetch('payments/reject', {
        method: 'PATCH',
        body: JSON.stringify({ invoiceId: row.invoice_id, rejection_reason: reason.trim() })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Reject failed'))
      setSuccess(`Invoice ${row.invoice_number} rejected.`)
      setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
      setTotals((t) => ({
        count: Math.max(0, t.count - 1),
        value: Math.max(0, t.value - (parseAmount(row.total_amount) ?? 0))
      }))
    } catch (err) {
      setError(getDisplayError(err))
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
      setError('Missing payment approval id — reload and try again.')
      return
    }
    const formState = payForms[row.id] ?? EMPTY_PAY_FORM
    const remaining = remainingFor(row)
    const amount = amountOverride != null ? amountOverride : Number(formState.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter a valid payment amount greater than zero.')
      return
    }
    if (amount > remaining + 0.01) {
      setError(`Amount exceeds remaining balance ${formatINRSymbol(remaining)}.`)
      return
    }
    setError(''); setSuccess('')
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
        setSuccess(`Invoice ${row.invoice_number} fully paid.`)
        setRows((prev) => prev.filter((r) => r.invoice_id !== row.invoice_id))
        setTotals((t) => ({
          count: Math.max(0, t.count - 1),
          value: Math.max(0, t.value - (parseAmount(row.total_amount) ?? 0))
        }))
      } else {
        setSuccess(`Partial payment of ${formatINRSymbol(amount)} recorded for ${row.invoice_number}. Remaining ${formatINRSymbol(body.remaining)}.`)
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, paid_amount: body.paidSoFar, status: 'partially_paid' } : r)))
      }
      // Reset this row's form
      setPayForms((p) => ({ ...p, [row.id as number]: EMPTY_PAY_FORM }))
    } catch (err) {
      setError(getDisplayError(err))
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
      <PageHero
        eyebrow="Workflow"
        eyebrowIcon="pi-wallet"
        title="Payments cockpit"
        subtitle="Approve, release and track every rupee going out the door. Tabbed by pipeline stage."
        actions={
          tab === 'history' ? (
            <button
              className="action-btn action-btn--ghost"
              onClick={() => {
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
              }}
            >
              <i className="pi pi-download" /> Export CSV
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}
      {success && (
        <div className="glass-card" style={{ borderColor: 'var(--status-success-ring)', color: 'var(--status-success-fg)' }}>
          <i className="pi pi-check-circle" /> {success}
        </div>
      )}

      <div className="grid-kpis fade-in-up--stagger">
        <StatTile
          label={tab === 'approve' ? 'Pending approval' : tab === 'ready' ? 'Ready to pay' : 'Payments made'}
          value={totals.count.toLocaleString('en-IN')}
          icon="pi-file"
          variant="brand"
        />
        <StatTile
          label="Total value"
          value={formatINRSymbol(totals.value)}
          icon="pi-indian-rupee"
          variant="emerald"
        />
      </div>

      <div className="tab-row">
        {(['approve', 'ready', 'history'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`tab-row__btn ${tab === t ? 'tab-row__btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'approve' ? '⏳ Approve' : t === 'ready' ? '💰 Ready' : '📜 History'}
          </button>
        ))}
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
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr style={{ background: 'var(--surface-1)' }}>
                  {(() => {
                    const headers =
                      tab === 'ready'
                        ? ['', 'Invoice', 'Supplier', 'Invoice date', 'Amount', 'Paid / Remaining', 'Status', 'Action']
                        : tab === 'history'
                        ? ['', 'Invoice', 'Supplier', 'Invoice date', 'Amount', 'Status', 'Payment date', 'Mode']
                        : ['', 'Invoice', 'Supplier', 'Invoice date', 'Amount', 'Status', 'Action']
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
                          width: i === 0 ? 36 : undefined
                        }}
                      >
                        {h}
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
                      <tr key={r.invoice_id} style={{ borderBottom: isExpanded ? 0 : '1px solid var(--border-subtle)' }}>
                        {/* Expander */}
                        <td style={{ padding: '0.5rem 0.4rem 0.5rem 0.95rem', width: 36 }}>
                          <button
                            type="button"
                            onClick={() => toggleExpand(r.invoice_id)}
                            aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 7,
                              border: '1px solid var(--border-subtle)',
                              background: isExpanded ? 'var(--brand-50)' : 'var(--surface-0)',
                              color: isExpanded ? 'var(--brand-700)' : 'var(--text-secondary)',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '0.75rem',
                              transition: 'background 160ms var(--ease-out)'
                            }}
                          >
                            <i className={`pi ${isExpanded ? 'pi-chevron-down' : 'pi-chevron-right'}`} />
                          </button>
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
                          <StatusChip status={r.status} />
                        </td>

                        {tab === 'history' ? (
                          <>
                            <td style={{ padding: '0.85rem 0.95rem', fontSize: '0.88rem' }}>
                              {formatDate(r.payment_done_at || r.payment_date)}
                            </td>
                            <td style={{ padding: '0.85rem 0.95rem' }}>
                              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{r.payment_type || '—'}</div>
                              {r.payment_reference && (
                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                  {r.payment_reference}
                                </div>
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

                            {/* Rich invoice + PO + GRN + ASN + validation drill-in */}
                            <InvoiceExpansion
                              invoiceId={r.invoice_id}
                              poNumber={r.po_number ?? null}
                            />
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

export default PaymentsPage
