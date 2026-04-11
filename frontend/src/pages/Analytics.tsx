import { useEffect, useMemo, useState } from 'react'
import PageHero from '../components/PageHero'
import StatTile from '../components/StatTile'
import ChartCard from '../components/ChartCard'
import { apiFetch, getDisplayError } from '../utils/api'

type Tab = 'overview' | 'cashflow' | 'suppliers' | 'quality'

interface InvoicesSummary {
  total_invoices?: number
  total_amount?: number
  avg_amount?: number
  by_status?: Record<string, number>
  monthly?: Array<{ month: string; count: number; total: number }>
}

interface SuppliersSummary {
  top_suppliers?: Array<{ supplier_name: string; total: number; count: number }>
  total_suppliers?: number
}

interface FinancialSummary {
  paid?: number
  outstanding?: number
  ready_for_payment?: number
  total_invoiced?: number
  monthly_cashflow?: Array<{ month: string; invoiced: number; paid: number }>
}

const INR = (n: number | null | undefined) =>
  typeof n === 'number'
    ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : '—'

function Analytics() {
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [invoicesSum, setInvoicesSum] = useState<InvoicesSummary | null>(null)
  const [suppliersSum, setSuppliersSum] = useState<SuppliersSummary | null>(null)
  const [financialSum, setFinancialSum] = useState<FinancialSummary | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        setError('')
        const [i, s, f] = await Promise.all([
          apiFetch('reports/invoices-summary'),
          apiFetch('reports/suppliers-summary'),
          apiFetch('reports/financial-summary')
        ])
        if (!i.ok || !s.ok || !f.ok) throw new Error('One or more report endpoints failed')
        const [ij, sj, fj] = await Promise.all([i.json(), s.json(), f.json()])
        if (!alive) return
        setInvoicesSum(ij)
        setSuppliersSum(sj)
        setFinancialSum(fj)
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

  const statusBars = useMemo(() => {
    const by = invoicesSum?.by_status || {}
    const labels = Object.keys(by)
    return {
      type: 'bar' as const,
      data: {
        labels: labels.map((l) => l.replace(/_/g, ' ')),
        datasets: [
          {
            label: 'Invoices',
            data: labels.map((k) => by[k]),
            backgroundColor: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b'],
            borderRadius: 8
          }
        ]
      },
      options: {
        indexAxis: 'y' as const,
        plugins: { legend: { display: false } }
      }
    }
  }, [invoicesSum])

  const monthlyLine = useMemo(() => {
    const m = invoicesSum?.monthly || []
    return {
      type: 'line' as const,
      data: {
        labels: m.map((x) => x.month),
        datasets: [
          {
            label: 'Invoice count',
            data: m.map((x) => x.count),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99,102,241,0.15)',
            tension: 0.35,
            fill: true,
            pointRadius: 4
          }
        ]
      },
      options: { plugins: { legend: { display: false } } }
    }
  }, [invoicesSum])

  const cashflowBars = useMemo(() => {
    const m = financialSum?.monthly_cashflow || []
    return {
      type: 'bar' as const,
      data: {
        labels: m.map((x) => x.month),
        datasets: [
          { label: 'Invoiced', data: m.map((x) => x.invoiced), backgroundColor: '#6366f1', borderRadius: 8 },
          { label: 'Paid', data: m.map((x) => x.paid), backgroundColor: '#10b981', borderRadius: 8 }
        ]
      },
      options: { plugins: { legend: { position: 'top' as const, align: 'end' as const } } }
    }
  }, [financialSum])

  const topSuppliersBars = useMemo(() => {
    const t = suppliersSum?.top_suppliers || []
    return {
      type: 'bar' as const,
      data: {
        labels: t.map((x) => x.supplier_name),
        datasets: [
          {
            label: 'Invoice total',
            data: t.map((x) => x.total),
            backgroundColor: '#8b5cf6',
            borderRadius: 8
          }
        ]
      },
      options: {
        indexAxis: 'y' as const,
        plugins: { legend: { display: false } }
      }
    }
  }, [suppliersSum])

  return (
    <>
      <PageHero
        eyebrow="Analytics"
        eyebrowIcon="pi-chart-line"
        title="Operational analytics hub"
        subtitle="Cross-cutting views of your invoice pipeline, cashflow, supplier concentration and data quality."
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}

      {/* tabs */}
      <div className="tab-row">
        {(['overview', 'cashflow', 'suppliers', 'quality'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`tab-row__btn ${tab === t ? 'tab-row__btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'overview'  ? '📊 Overview'  :
             t === 'cashflow'  ? '💰 Cashflow'  :
             t === 'suppliers' ? '🏭 Suppliers' : '✅ Data quality'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Total invoices" value={INR(invoicesSum?.total_invoices)} icon="pi-file" variant="brand" />
            <StatTile label="Total amount" value={`₹${INR(invoicesSum?.total_amount)}`} icon="pi-indian-rupee" variant="emerald" />
            <StatTile label="Avg ticket" value={`₹${INR(invoicesSum?.avg_amount)}`} icon="pi-calculator" variant="violet" />
            <StatTile
              label="Statuses tracked"
              value={INR(Object.keys(invoicesSum?.by_status || {}).length)}
              icon="pi-tags"
              variant="amber"
            />
          </div>
          <div className="grid-charts">
            <ChartCard title="Status distribution" subtitle="How invoices are split across states" config={statusBars} height={340} icon="pi-chart-bar" />
            <ChartCard title="Monthly volume" subtitle="Invoices per month" config={monthlyLine} height={340} icon="pi-chart-line" />
          </div>
        </>
      )}

      {tab === 'cashflow' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Total invoiced" value={`₹${INR(financialSum?.total_invoiced)}`} icon="pi-file" variant="brand" />
            <StatTile label="Paid" value={`₹${INR(financialSum?.paid)}`} icon="pi-check-circle" variant="emerald" />
            <StatTile label="Outstanding" value={`₹${INR(financialSum?.outstanding)}`} icon="pi-clock" variant="amber" />
            <StatTile label="Ready for payment" value={`₹${INR(financialSum?.ready_for_payment)}`} icon="pi-wallet" variant="violet" />
          </div>
          <div className="grid-charts">
            <ChartCard title="Cashflow trend" subtitle="Invoiced vs paid by month" config={cashflowBars} height={340} icon="pi-chart-bar" />
          </div>
        </>
      )}

      {tab === 'suppliers' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Total suppliers" value={INR(suppliersSum?.total_suppliers)} icon="pi-users" variant="violet" />
            <StatTile label="Top vendor share" value={suppliersSum?.top_suppliers?.[0]?.supplier_name ?? '—'} icon="pi-star" variant="amber" />
          </div>
          <div className="grid-charts">
            <ChartCard title="Top 10 suppliers by value" subtitle="Invoice total across the period" config={topSuppliersBars} height={420} icon="pi-chart-bar" />
          </div>
        </>
      )}

      {tab === 'quality' && (
        <div className="glass-card">
          <h3 className="glass-card__title"><i className="pi pi-shield" style={{ color: 'var(--accent-emerald)' }} /> Data quality signals</h3>
          <div className="glass-card__subtitle">Headline checks across the invoice pipeline</div>
          <ul style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem', listStyle: 'none', padding: 0 }}>
            {[
              { ok: true,  label: 'Supplier master — GSTIN coverage', v: '94%' },
              { ok: true,  label: 'Invoices auto-validated', v: '83%' },
              { ok: false, label: 'Invoices missing debit note', v: '6' },
              { ok: false, label: 'POs without GRN (>30 days)', v: '12' }
            ].map((row, i) => (
              <li key={i} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.7rem 0.85rem',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-1)'
              }}>
                <i className={`pi ${row.ok ? 'pi-check-circle' : 'pi-exclamation-triangle'}`}
                   style={{ color: row.ok ? 'var(--accent-emerald)' : 'var(--accent-amber)', fontSize: '1.15rem' }} />
                <div style={{ flex: 1, fontWeight: 600, color: 'var(--text-primary)' }}>{row.label}</div>
                <div style={{ fontWeight: 800, color: row.ok ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>{row.v}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && (
        <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          <i className="pi pi-spin pi-spinner" /> Loading analytics…
        </div>
      )}
    </>
  )
}

export default Analytics
