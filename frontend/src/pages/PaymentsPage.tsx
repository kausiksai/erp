import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import StatTile from '../components/StatTile'
import StatusChip from '../components/StatusChip'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

type Tab = 'approve' | 'ready' | 'history'

interface PaymentRow {
  invoice_id: number
  invoice_number: string
  supplier_name: string | null
  invoice_date: string | null
  total_amount: number | null
  status: string | null
  approved_at?: string | null
  payment_date?: string | null
  payment_mode?: string | null
  payment_status?: string | null
}

const INR = (n: number | null | undefined) =>
  typeof n === 'number' ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'

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
  const [totals, setTotals] = useState({ count: 0, value: 0 })

  const endpointFor = (t: Tab) =>
    t === 'approve' ? 'payments/pending-approval'
      : t === 'ready' ? 'payments/ready'
      : 'payments/history'

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError('')
      const res = await apiFetch(endpointFor(tab))
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load payments'))
      const body = await res.json()
      const items: PaymentRow[] = body.items || body.payments || body || []
      setRows(items)
      setTotals({
        count: items.length,
        value: items.reduce((s, r) => s + (r.total_amount || 0), 0)
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

  return (
    <>
      <PageHero
        eyebrow="Workflow"
        eyebrowIcon="pi-wallet"
        title="Payments cockpit"
        subtitle="Approve, release and track every rupee going out the door. Tabbed by pipeline stage."
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
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
          value={`₹${INR(totals.value)}`}
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
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800 }}>
              <thead>
                <tr style={{ background: 'var(--surface-1)' }}>
                  {['Invoice', 'Supplier', 'Invoice date', 'Amount', 'Status',
                    tab === 'history' ? 'Payment date' : 'Action'].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: '0.8rem 0.95rem',
                        textAlign: ['Amount'].includes(h) ? 'right' : 'left',
                        fontSize: '0.73rem',
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontWeight: 700,
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.invoice_id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '0.85rem 0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {r.invoice_number}
                    </td>
                    <td style={{ padding: '0.85rem 0.95rem' }}>{r.supplier_name || '—'}</td>
                    <td style={{ padding: '0.85rem 0.95rem', fontSize: '0.88rem' }}>
                      {r.invoice_date ? new Date(r.invoice_date).toLocaleDateString('en-IN') : '—'}
                    </td>
                    <td style={{ padding: '0.85rem 0.95rem', textAlign: 'right', fontWeight: 700 }}>
                      ₹{INR(r.total_amount)}
                    </td>
                    <td style={{ padding: '0.85rem 0.95rem' }}>
                      <StatusChip status={r.payment_status || r.status} />
                    </td>
                    <td style={{ padding: '0.85rem 0.95rem' }}>
                      {tab === 'history' ? (
                        r.payment_date ? new Date(r.payment_date).toLocaleDateString('en-IN') : '—'
                      ) : (
                        <button
                          className="action-btn action-btn--ghost"
                          onClick={() => navigate(`/invoices/validate/${r.invoice_id}`)}
                        >
                          <i className="pi pi-eye" /> View
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

export default PaymentsPage
