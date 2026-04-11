import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import StatTile from '../components/StatTile'
import ChartCard from '../components/ChartCard'
import StatusChip from '../components/StatusChip'
import { apiFetch, getDisplayError } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'

interface DashboardData {
  totals?: {
    invoices?: number
    purchase_orders?: number
    suppliers?: number
    grn?: number
    asn?: number
    delivery_challans?: number
  }
  by_status?: Record<string, number>
  monthly?: Array<{ month: string; count: number; total: number }>
  recent_invoices?: Array<{
    invoice_id: number
    invoice_number: string
    supplier_name: string
    invoice_date: string
    total_amount: number
    status: string
  }>
  top_suppliers?: Array<{ supplier_name: string; total: number; count: number }>
  upcoming_payments?: Array<{ supplier_name: string; total: number }>
  alerts?: Array<{ level: 'info' | 'warn' | 'danger'; title: string; description?: string }>
}

const INR = (n: number | null | undefined) =>
  typeof n === 'number'
    ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : '—'

function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        const res = await apiFetch('reports/dashboard-summary')
        if (!res.ok) throw new Error('Dashboard fetch failed')
        const body = await res.json()
        if (alive) setData(body)
      } catch (err) {
        if (alive) setError(getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const totals = data?.totals ?? {}
  const byStatus = data?.by_status ?? {}
  const monthly = data?.monthly ?? []

  // Chart data
  const statusPie = useMemo(() => {
    const labels = Object.keys(byStatus)
    const values = labels.map((k) => byStatus[k])
    return {
      type: 'doughnut' as const,
      data: {
        labels: labels.map((l) => l.replace(/_/g, ' ')),
        datasets: [
          {
            data: values,
            backgroundColor: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b'],
            borderWidth: 0
          }
        ]
      },
      options: {
        cutout: '68%',
        plugins: { legend: { position: 'right' as const, labels: { boxWidth: 10 } } }
      }
    }
  }, [byStatus])

  const monthlyBars = useMemo(
    () => ({
      type: 'bar' as const,
      data: {
        labels: monthly.map((m) => m.month),
        datasets: [
          {
            label: 'Invoices',
            data: monthly.map((m) => m.count),
            backgroundColor: '#6366f1',
            borderRadius: 8
          },
          {
            label: 'Amount (₹)',
            data: monthly.map((m) => m.total),
            backgroundColor: '#06b6d4',
            borderRadius: 8,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        plugins: { legend: { position: 'top' as const, align: 'end' as const } },
        scales: {
          y: { beginAtZero: true, grid: { display: false } },
          y1: { beginAtZero: true, position: 'right' as const, grid: { drawOnChartArea: false } }
        }
      }
    }),
    [monthly]
  )

  return (
    <>
      <PageHero
        eyebrow={`${greeting}${user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}`}
        eyebrowIcon="pi-sun"
        title="Your operational control tower"
        subtitle="Real-time view of invoice flow, supplier health and cashflow — everything that matters, in one place."
        actions={
          <>
            <button className="action-btn action-btn--ghost" onClick={() => navigate('/analytics')}>
              <i className="pi pi-chart-line" /> Analytics
            </button>
            <button className="action-btn" onClick={() => navigate('/invoices/upload')}>
              <i className="pi pi-upload" /> Upload invoice
            </button>
          </>
        }
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}

      {/* KPI row */}
      <div className="grid-kpis fade-in-up--stagger">
        <StatTile
          label="Invoices"
          value={loading ? '—' : INR(totals.invoices || 0)}
          icon="pi-file"
          variant="brand"
          sublabel="Last 30 days"
          onClick={() => navigate('/invoices/validate')}
        />
        <StatTile
          label="Purchase orders"
          value={loading ? '—' : INR(totals.purchase_orders || 0)}
          icon="pi-shopping-cart"
          variant="violet"
          sublabel="Active + amended"
          onClick={() => navigate('/purchase-orders')}
        />
        <StatTile
          label="Suppliers"
          value={loading ? '—' : INR(totals.suppliers || 0)}
          icon="pi-users"
          variant="emerald"
          sublabel="In master"
          onClick={() => navigate('/suppliers')}
        />
        <StatTile
          label="GRNs"
          value={loading ? '—' : INR(totals.grn || 0)}
          icon="pi-box"
          variant="amber"
          sublabel="Recorded"
          onClick={() => navigate('/grn')}
        />
        <StatTile
          label="ASNs"
          value={loading ? '—' : INR(totals.asn || 0)}
          icon="pi-truck"
          variant="rose"
          sublabel="In transit"
          onClick={() => navigate('/asn')}
        />
        <StatTile
          label="Delivery challans"
          value={loading ? '—' : INR(totals.delivery_challans || 0)}
          icon="pi-file-edit"
          variant="slate"
          sublabel="On file"
          onClick={() => navigate('/delivery-challans')}
        />
      </div>

      {/* Charts */}
      <div className="grid-charts">
        <ChartCard
          title="Invoice status mix"
          subtitle="How your invoice pipeline is distributed"
          icon="pi-chart-pie"
          config={statusPie}
          height={300}
        />
        <ChartCard
          title="Monthly volume"
          subtitle="Count vs. total value"
          icon="pi-chart-bar"
          config={monthlyBars}
          height={300}
        />
      </div>

      {/* Two column secondary */}
      <div className="grid-charts">
        <section className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-clock" style={{ color: 'var(--brand-600)' }} /> Recent invoices
          </h3>
          <div className="glass-card__subtitle">Latest 8 entries from your pipeline</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {(data?.recent_invoices || []).slice(0, 8).map((inv) => (
              <button
                key={inv.invoice_id}
                type="button"
                onClick={() => navigate(`/invoices/validate/${inv.invoice_id}`)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.75rem 0.9rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.8rem',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 160ms var(--ease-out)'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-1)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    background: 'linear-gradient(135deg, var(--brand-50), var(--surface-2))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--brand-600)',
                    fontSize: '1rem'
                  }}
                >
                  <i className="pi pi-file" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.invoice_number}
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.supplier_name} · {inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-IN') : '—'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem' }}>
                    ₹{INR(inv.total_amount)}
                  </div>
                  <div style={{ marginTop: '0.2rem' }}>
                    <StatusChip status={inv.status} />
                  </div>
                </div>
              </button>
            ))}
            {!loading && (data?.recent_invoices || []).length === 0 && (
              <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                No invoices yet.
              </div>
            )}
          </div>
        </section>

        <section className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-bolt" style={{ color: 'var(--accent-amber)' }} /> Quick actions
          </h3>
          <div className="glass-card__subtitle">Jump into the most common workflows</div>
          <div className="quick-actions">
            {[
              { icon: 'pi-upload', label: 'Upload invoice', desc: 'Push a new bill into validation', path: '/invoices/upload' },
              { icon: 'pi-wallet', label: 'Approve payments', desc: 'Release cleared invoices', path: '/payments/approve' },
              { icon: 'pi-exclamation-circle', label: 'Incomplete POs', desc: 'POs missing supporting docs', path: '/purchase-orders/incomplete' },
              { icon: 'pi-users', label: 'Suppliers', desc: 'Manage vendor master', path: '/suppliers' }
            ].map((q) => (
              <button key={q.label} type="button" className="quick-action" onClick={() => navigate(q.path)}>
                <div className="quick-action__icon"><i className={`pi ${q.icon}`} /></div>
                <div>
                  <div className="quick-action__label">{q.label}</div>
                  <div className="quick-action__desc">{q.desc}</div>
                </div>
              </button>
            ))}
          </div>

          {(data?.alerts && data.alerts.length > 0) && (
            <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                Alerts
              </div>
              {data.alerts.map((a, i) => (
                <div
                  key={i}
                  style={{
                    padding: '0.7rem 0.85rem',
                    borderRadius: 'var(--radius-md)',
                    background: a.level === 'danger' ? 'var(--status-danger-bg)' : a.level === 'warn' ? 'var(--status-warn-bg)' : 'var(--status-info-bg)',
                    color: a.level === 'danger' ? 'var(--status-danger-fg)' : a.level === 'warn' ? 'var(--status-warn-fg)' : 'var(--status-info-fg)',
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.55rem'
                  }}
                >
                  <i className="pi pi-info-circle" style={{ marginTop: '0.15rem' }} />
                  <div>
                    <div style={{ fontWeight: 700 }}>{a.title}</div>
                    {a.description && <div style={{ opacity: 0.85 }}>{a.description}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

export default Dashboard
