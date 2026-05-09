import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, getDisplayError } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { formatINRSymbol, formatDate } from '../utils/format'
import StatusChip from './StatusChip'

/**
 * Supplier 360 — read-only aggregate panel rendered inside the
 * <SlideOver> on the Suppliers list. Hits GET /api/suppliers/:id/360.
 *
 * Sections:
 *   1. Header card — name + GST + health bar
 *   2. KPI strip — invoices / validated / spend (30d) / open issues
 *   3. GST distribution — per-classification chips with counts
 *   4. Top errors — chip row of the 3 most-frequent rule codes
 *   5. Recent invoices — last 10 with click-through
 *   6. Banking + payment terms — definition list
 *
 * If the endpoint hasn't been deployed yet (404), falls back to a hint.
 */

interface Supplier360Data {
  supplier: {
    supplier_id: number
    supplier_name: string | null
    suplr_id: string | null
    gst_number: string | null
    pan_number: string | null
    state_name: string | null
    city: string | null
    address1: string | null
    contact_person: string | null
    phone: string | null
    mobile: string | null
    email: string | null
    bank_account_name: string | null
    bank_account_number: string | null
    bank_ifsc_code: string | null
    bank_name: string | null
    branch_name: string | null
    payment_term_days: number | null
    payment_mode: string | null
    created_at: string | null
  }
  metrics: {
    invoices_total: number
    invoices_validated: number
    invoices_open: number
    invoices_30d: number
    spend_30d: number
    open_issues: number
    health_score: number | null
    avg_payment_days: number | null
  }
  recent_invoices: Array<{
    invoice_id: number
    invoice_number: string
    invoice_date: string | null
    total_amount: string | number | null
    status: string | null
    source: string | null
    po_number: string | null
  }>
  gst_distribution: Array<{ classification: string; n: number }>
  top_error_codes: Array<{ code: string; n: number }>
}

interface Props {
  supplierId: number
}

function Supplier360({ supplierId }: Props) {
  const navigate = useNavigate()
  const toast = useToast()
  const [data, setData] = useState<Supplier360Data | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const res = await apiFetch(`suppliers/${supplierId}/360`)
        if (!res.ok) throw new Error('Supplier 360 endpoint not available')
        const body = await res.json()
        if (alive) setData(body)
      } catch (err) {
        if (alive) toast.danger('Couldn\'t load supplier 360', getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [supplierId, toast])

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--text-muted)' }}>
        <i className="pi pi-spin pi-spinner" /> Loading supplier 360…
      </div>
    )
  }
  if (!data) {
    return (
      <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-muted)' }}>
        Couldn't load supplier data.
      </div>
    )
  }

  const { supplier: s, metrics: m, recent_invoices, gst_distribution, top_error_codes } = data
  const health = m.health_score
  const healthColor =
    health == null  ? 'linear-gradient(90deg,#94a3b8,#64748b)' :
    health >= 80    ? 'linear-gradient(90deg,#10b981,#14b8a6)' :
    health >= 50    ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' :
                      'linear-gradient(90deg,#f43f5e,#ec4899)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* ====== Header ====== */}
      <div className="glass-card" style={{ padding: 'var(--space-5)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: 'linear-gradient(135deg,#2563eb,#06b6d4)',
            color: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0,
            fontWeight: 700, fontSize: 18
          }}>
            {(s.supplier_name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 700 }}>{s.supplier_name}</div>
            <div className="muted" style={{ fontSize: 'var(--fs-sm)', marginTop: 2 }}>
              {[s.address1, s.city, s.state_name].filter(Boolean).join(', ') || '—'}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {s.gst_number && <code style={{ fontSize: 'var(--fs-xs)' }}>{s.gst_number}</code>}
              {s.pan_number && <span className="status-chip status-chip--muted">{s.pan_number}</span>}
              {s.suplr_id && <span className="status-chip status-chip--muted">ID {s.suplr_id}</span>}
            </div>
          </div>
          <div style={{ minWidth: 180 }}>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              Health score
            </div>
            <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
              {health != null ? `${health}%` : '—'}
            </div>
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden', marginTop: 6 }}>
              <div style={{ width: `${health ?? 0}%`, height: '100%', background: healthColor }} />
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 4 }}>
              {m.invoices_validated} of {m.invoices_total} validated
            </div>
          </div>
        </div>
      </div>

      {/* ====== KPI strip ====== */}
      <div className="grid-kpis">
        <Kpi label="Invoices (30d)"   value={m.invoices_30d.toLocaleString('en-IN')}        icon="pi-file"       variant="brand" />
        <Kpi label="Validated"        value={m.invoices_validated.toLocaleString('en-IN')}  icon="pi-check"      variant="emerald" footer={`of ${m.invoices_total} total`} />
        <Kpi label="Open issues"      value={m.open_issues.toLocaleString('en-IN')}         icon="pi-flag"       variant="rose" />
        <Kpi label="Spend (30d)"      value={formatINRSymbol(m.spend_30d)}                  icon="pi-rupee"      variant="violet" />
      </div>

      {/* ====== GST distribution + Top errors ====== */}
      <div className="grid-charts">
        <SectionPanel title="GST classification" icon="pi-percentage">
          {gst_distribution.length === 0 ? (
            <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>No invoices on file yet.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {gst_distribution.map((g) => (
                <span key={g.classification} className="status-chip status-chip--info">
                  {g.classification.replace(/_/g, ' ')} · {g.n}
                </span>
              ))}
            </div>
          )}
        </SectionPanel>

        <SectionPanel title="Top error codes" icon="pi-exclamation-triangle">
          {top_error_codes.length === 0 ? (
            <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>None — clean record.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {top_error_codes.map((e) => (
                <span key={e.code} className="status-chip status-chip--danger">
                  <code style={{ fontSize: 'var(--fs-xs)' }}>{e.code.split('_')[0]}</code> · {e.n}
                </span>
              ))}
            </div>
          )}
        </SectionPanel>
      </div>

      {/* ====== Recent invoices ====== */}
      <SectionPanel title="Recent invoices" icon="pi-history" flush>
        {recent_invoices.length === 0 ? (
          <div className="muted" style={{ padding: 'var(--space-5)', fontSize: 'var(--fs-sm)' }}>
            No invoices on file yet.
          </div>
        ) : (
          <table className="tbl tbl--compact">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>PO</th>
                <th>Status</th>
                <th className="tbl__num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent_invoices.map((r) => (
                <tr
                  key={r.invoice_id}
                  className="is-clickable"
                  onClick={() => navigate(`/invoices/validate/${r.invoice_id}`)}
                >
                  <td className="tbl__bold">{r.invoice_number}</td>
                  <td className="tbl__muted">{formatDate(r.invoice_date)}</td>
                  <td className="tbl__mono">{r.po_number || '—'}</td>
                  <td><StatusChip status={r.status} /></td>
                  <td className="tbl__num tbl__bold">{formatINRSymbol(r.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionPanel>

      {/* ====== Banking + payment terms ====== */}
      <SectionPanel title="Banking & terms" icon="pi-credit-card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3) var(--space-5)', fontSize: 'var(--fs-sm)' }}>
          <Field label="Account holder">{s.bank_account_name || '—'}</Field>
          <Field label="Account number">{s.bank_account_number ? <code>{s.bank_account_number}</code> : '—'}</Field>
          <Field label="IFSC">{s.bank_ifsc_code ? <code>{s.bank_ifsc_code}</code> : '—'}</Field>
          <Field label="Bank">{s.bank_name || '—'}{s.branch_name ? ` · ${s.branch_name}` : ''}</Field>
          <Field label="Payment terms">{s.payment_term_days != null ? `Net ${s.payment_term_days} days` : '—'}</Field>
          <Field label="Default mode">{s.payment_mode || '—'}</Field>
          <Field label="Avg. days to pay">
            {m.avg_payment_days != null ? `${m.avg_payment_days.toFixed(1)} days` : '—'}
          </Field>
          <Field label="Onboarded">{formatDate(s.created_at)}</Field>
        </div>
      </SectionPanel>
    </div>
  )
}

/* ---------- tiny helpers ---------- */
function Kpi({ label, value, icon, variant, footer }: {
  label: string; value: React.ReactNode; icon: string;
  variant: 'brand' | 'emerald' | 'rose' | 'violet'; footer?: React.ReactNode
}) {
  return (
    <div className={`stat-card stat-card--${variant}`}>
      <div className="stat-card__icon"><i className={`pi ${icon}`} /></div>
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {footer && <div className="stat-card__footer">{footer}</div>}
    </div>
  )
}
function SectionPanel({ title, icon, children, flush }: {
  title: string; icon: string; children: React.ReactNode; flush?: boolean
}) {
  return (
    <section className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
      <header style={{
        padding: 'var(--space-3) var(--space-5)',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'linear-gradient(180deg,var(--surface-0),var(--surface-1))',
        display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
      }}>
        <i className={`pi ${icon}`} style={{ color: 'var(--brand-600)' }} />
        <span style={{ fontWeight: 600 }}>{title}</span>
      </header>
      <div style={{ padding: flush ? 0 : 'var(--space-4) var(--space-5)' }}>{children}</div>
    </section>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

export default Supplier360
