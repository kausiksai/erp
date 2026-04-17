import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import StatTile from '../components/StatTile'
import ChartCard from '../components/ChartCard'
import StatusChip from '../components/StatusChip'
import { apiFetch, getDisplayError } from '../utils/api'
import { formatINRCompact, formatINRSymbol, formatInt, formatDate, parseAmount } from '../utils/format'

type Tab = 'overview' | 'cashflow' | 'suppliers' | 'procurement' | 'quality'

/* ------------------------------------------------------------------ *
 *  Response shapes (lenient — backend sends numerics as strings)     *
 * ------------------------------------------------------------------ */

interface DashboardResponse {
  financial?: {
    total_invoices?: number | string
    total_billed?: number | string
    total_tax?: number | string
    avg_invoice_amount?: number | string
    current_month_billed?: number | string
    ytd_billed?: number | string
    tax_pct?: number | string
  }
  invoiceByStatus?: Array<{ status: string; count: number | string; total_amount: number | string }>
  payments?: {
    pending_approval_count?: number | string
    ready_count?: number | string
    payment_done_count?: number | string
    pending_approval_amount?: number | string
    ready_amount?: number | string
    payment_done_amount?: number | string
  }
  debitNote?: { count?: number | string; total_amount?: number | string }
  recentPayments?: Array<{
    id: number
    invoice_number: string
    supplier_name: string | null
    amount: number | string
    payment_done_at: string | null
  }>
  topSuppliers?: Array<{
    supplier_name: string
    invoice_count: number | string
    total_amount: number | string
  }>
  procurement?: {
    total_pos?: number | string
    total_grn?: number | string
    total_asn?: number | string
    total_invoices?: number | string
    incomplete_po_count?: number | string
  }
  byMonth?: Array<{
    month_label: string
    invoice_count: number | string
    amount: number | string
    tax_amount: number | string
  }>
}

interface SuppliersSummary {
  summary?: {
    total_suppliers?: number | string
    total_pos?: number | string
    active_suppliers?: number | string
    suppliers_with_no_invoices?: number | string
  }
  fastest_delivering?: Array<{
    supplier_name: string
    avg_days_po_to_invoice: number | string
    po_count: number | string
    invoice_count: number | string
  }>
  best_suppliers?: Array<{
    supplier_name: string
    invoice_count: number | string
    total_invoice_amount: number | string
  }>
}

interface DashboardSummary {
  totals?: {
    waiting_for_validation?: number | string
    waiting_for_re_validation?: number | string
    validated?: number | string
    ready_for_payment?: number | string
    paid?: number | string
    outstanding_amount?: number | string
    validated_amount?: number | string
    paid_amount?: number | string
  }
  dataQuality?: Array<{ code: string; category: string; affected: number | string }>
}

function Analytics() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [suppliers, setSuppliers] = useState<SuppliersSummary | null>(null)
  const [quality, setQuality] = useState<DashboardSummary | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        setError('')
        const [d, s, q] = await Promise.all([
          apiFetch('reports/dashboard'),
          apiFetch('reports/suppliers-summary'),
          apiFetch('reports/dashboard-summary')
        ])
        if (!d.ok) throw new Error('Dashboard report failed')
        const [dj, sj, qj] = await Promise.all([
          d.json(),
          s.ok ? s.json() : Promise.resolve({}),
          q.ok ? q.json() : Promise.resolve({})
        ])
        if (!alive) return
        setDashboard(dj)
        setSuppliers(sj)
        setQuality(qj)
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

  /* ---------------- derived / memos ----------------- */

  const fin = dashboard?.financial || {}
  const pay = dashboard?.payments || {}
  const proc = dashboard?.procurement || {}
  const topSuppliers = dashboard?.topSuppliers || []
  const byMonth = useMemo(() => dashboard?.byMonth || [], [dashboard])
  const byStatus = dashboard?.invoiceByStatus || []
  const qualityTotals = quality?.totals || {}

  // Monthly trend (count + amount)
  const monthlyTrend = useMemo(() => ({
    type: 'bar' as const,
    data: {
      labels: byMonth.map((m) => m.month_label),
      datasets: [
        {
          label: 'Invoices',
          data: byMonth.map((m) => Number(m.invoice_count) || 0),
          backgroundColor: '#6366f1',
          borderRadius: 6,
          yAxisID: 'y'
        },
        {
          label: 'Amount (₹)',
          data: byMonth.map((m) => parseAmount(m.amount) ?? 0),
          type: 'line' as const,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.18)',
          tension: 0.35,
          pointRadius: 3,
          fill: true,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      plugins: { legend: { position: 'top' as const, align: 'end' as const } },
      scales: {
        y:  { beginAtZero: true, position: 'left' as const,  grid: { display: false } },
        y1: { beginAtZero: true, position: 'right' as const, grid: { drawOnChartArea: false } }
      }
    }
  }), [byMonth])

  // Status distribution doughnut (by count)
  const statusDonut = useMemo(() => ({
    type: 'doughnut' as const,
    data: {
      labels: byStatus.map((r) => r.status.replace(/_/g, ' ')),
      datasets: [
        {
          data: byStatus.map((r) => Number(r.count) || 0),
          backgroundColor: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b', '#ec4899'],
          borderWidth: 0
        }
      ]
    },
    options: {
      cutout: '62%',
      plugins: { legend: { position: 'right' as const, labels: { boxWidth: 10, font: { size: 11 } } } }
    }
  }), [byStatus])

  // Status distribution by amount (bar)
  const statusAmountBar = useMemo(() => ({
    type: 'bar' as const,
    data: {
      labels: byStatus.map((r) => r.status.replace(/_/g, ' ')),
      datasets: [
        {
          label: 'Amount (₹)',
          data: byStatus.map((r) => parseAmount(r.total_amount) ?? 0),
          backgroundColor: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b'],
          borderRadius: 6
        }
      ]
    },
    options: {
      indexAxis: 'y' as const,
      plugins: { legend: { display: false } }
    }
  }), [byStatus])

  // Cashflow (billed vs tax)
  const cashflowBars = useMemo(() => ({
    type: 'bar' as const,
    data: {
      labels: byMonth.map((m) => m.month_label),
      datasets: [
        { label: 'Billed', data: byMonth.map((m) => parseAmount(m.amount) ?? 0), backgroundColor: '#6366f1', borderRadius: 6 },
        { label: 'Tax',    data: byMonth.map((m) => parseAmount(m.tax_amount) ?? 0), backgroundColor: '#f59e0b', borderRadius: 6 }
      ]
    },
    options: { plugins: { legend: { position: 'top' as const, align: 'end' as const } } }
  }), [byMonth])

  // Paid vs outstanding gauge (a doughnut with 2 slices)
  const paidVsOutstanding = useMemo(() => {
    const paid = parseAmount(qualityTotals.paid_amount) ?? 0
    const out  = parseAmount(qualityTotals.outstanding_amount) ?? 0
    return {
      type: 'doughnut' as const,
      data: {
        labels: ['Paid', 'Outstanding'],
        datasets: [
          {
            data: [paid, out],
            backgroundColor: ['#10b981', '#f43f5e'],
            borderWidth: 0
          }
        ]
      },
      options: {
        cutout: '72%',
        plugins: { legend: { position: 'bottom' as const } }
      }
    }
  }, [qualityTotals])

  // Top suppliers horizontal bar
  const topSuppliersBar = useMemo(() => ({
    type: 'bar' as const,
    data: {
      labels: topSuppliers.map((s) => s.supplier_name),
      datasets: [
        {
          label: 'Invoice total',
          data: topSuppliers.map((s) => parseAmount(s.total_amount) ?? 0),
          backgroundColor: '#8b5cf6',
          borderRadius: 6
        }
      ]
    },
    options: {
      indexAxis: 'y' as const,
      plugins: { legend: { display: false } }
    }
  }), [topSuppliers])

  // Supplier concentration bar
  const concentrationBar = useMemo(() => {
    const sorted = [...topSuppliers].sort((a, b) => (parseAmount(b.total_amount) ?? 0) - (parseAmount(a.total_amount) ?? 0))
    const totalSpend = sorted.reduce((s, v) => s + (parseAmount(v.total_amount) ?? 0), 0)
    const buckets = [1, 3, 5, 10]
    const data = buckets.map((n) => {
      const top = sorted.slice(0, n).reduce((s, v) => s + (parseAmount(v.total_amount) ?? 0), 0)
      return totalSpend > 0 ? (top / totalSpend) * 100 : 0
    })
    return {
      type: 'bar' as const,
      data: {
        labels: buckets.map((n) => `Top ${n}`),
        datasets: [
          {
            label: '% of spend',
            data,
            backgroundColor: ['#6366f1', '#8b5cf6', '#f59e0b', '#f43f5e'],
            borderRadius: 8
          }
        ]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v: number | string) => `${v}%` } } }
      }
    }
  }, [topSuppliers])

  // Procurement coverage
  const coverageBar = useMemo(() => {
    const total = Number(proc.total_pos) || 0
    const grn = Number(proc.total_grn) || 0
    const asn = Number(proc.total_asn) || 0
    const inv = Number(proc.total_invoices) || 0
    const toPct = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0)
    return {
      type: 'bar' as const,
      data: {
        labels: ['Invoices', 'GRN', 'ASN'],
        datasets: [
          {
            label: 'Coverage %',
            data: [toPct(inv), toPct(grn), toPct(asn)],
            backgroundColor: ['#6366f1', '#10b981', '#8b5cf6'],
            borderRadius: 8
          }
        ]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, max: 100, ticks: { callback: (v: number | string) => `${v}%` } } }
      }
    }
  }, [proc])

  /* ---------------- derived KPIs ----------------- */

  const totalBilled = parseAmount(fin.total_billed) ?? 0
  const totalTax = parseAmount(fin.total_tax) ?? 0
  const paidAmt = parseAmount(qualityTotals.paid_amount) ?? 0
  const outstandingAmt = parseAmount(qualityTotals.outstanding_amount) ?? 0
  const collectionPct = (paidAmt + outstandingAmt) > 0 ? Math.round((paidAmt / (paidAmt + outstandingAmt)) * 100) : 0

  const totalSuppliers = Number(suppliers?.summary?.total_suppliers) || 0
  const activeSuppliers = Number(suppliers?.summary?.active_suppliers) || 0
  const dormantSuppliers = Number(suppliers?.summary?.suppliers_with_no_invoices) || 0
  const activationRate = totalSuppliers > 0 ? Math.round((activeSuppliers / totalSuppliers) * 100) : 0
  const top3Share = (() => {
    const sorted = [...topSuppliers].sort((a, b) => (parseAmount(b.total_amount) ?? 0) - (parseAmount(a.total_amount) ?? 0))
    const total = sorted.reduce((s, v) => s + (parseAmount(v.total_amount) ?? 0), 0)
    const top3 = sorted.slice(0, 3).reduce((s, v) => s + (parseAmount(v.total_amount) ?? 0), 0)
    return total > 0 ? Math.round((top3 / total) * 100) : 0
  })()

  const fulfillmentRate = (() => {
    const t = Number(proc.total_pos) || 0
    const incomplete = Number(proc.incomplete_po_count) || 0
    return t > 0 ? Math.round(((t - incomplete) / t) * 100) : 0
  })()

  const validationRate = (() => {
    const validated = Number(qualityTotals.validated) || 0
    const waiting = Number(qualityTotals.waiting_for_validation) || 0
    const reVal = Number(qualityTotals.waiting_for_re_validation) || 0
    const denom = validated + waiting + reVal
    return denom > 0 ? Math.round((validated / denom) * 100) : 0
  })()

  return (
    <>
      <PageHero
        eyebrow="Analytics"
        eyebrowIcon="pi-chart-line"
        title="Operational analytics hub"
        subtitle="Executive KPIs, cashflow, suppliers, procurement and compliance — every view you need to run the operation."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/')}>
            <i className="pi pi-home" /> Dashboard
          </button>
        }
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}

      <div className="tab-row">
        {([
          { k: 'overview',   l: 'Overview',    i: 'pi-chart-pie' },
          { k: 'cashflow',   l: 'Cashflow',    i: 'pi-indian-rupee' },
          { k: 'suppliers',  l: 'Suppliers',   i: 'pi-users' },
          { k: 'procurement',l: 'Procurement', i: 'pi-shopping-cart' },
          { k: 'quality',    l: 'Quality',     i: 'pi-shield' }
        ] as Array<{ k: Tab; l: string; i: string }>).map((t) => (
          <button
            key={t.k}
            className={`tab-row__btn ${tab === t.k ? 'tab-row__btn--active' : ''}`}
            onClick={() => setTab(t.k)}
          >
            <i className={`pi ${t.i}`} style={{ marginRight: '0.4rem' }} />
            {t.l}
          </button>
        ))}
      </div>

      {loading && !dashboard && (
        <div className="glass-card" style={{ textAlign: 'center', padding: '2rem' }}>
          <i className="pi pi-spin pi-spinner" style={{ fontSize: '2rem', color: 'var(--brand-600)' }} />
          <div style={{ marginTop: '0.75rem', color: 'var(--text-muted)' }}>Loading analytics…</div>
        </div>
      )}

      {/* ========================= OVERVIEW ========================= */}
      {tab === 'overview' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Total invoices" value={formatInt(fin.total_invoices)} icon="pi-file" variant="brand" sublabel="All time" />
            <StatTile label="Total billed"    value={formatINRCompact(fin.total_billed)} icon="pi-indian-rupee" variant="emerald" sublabel={`YTD ${formatINRCompact(fin.ytd_billed)}`} />
            <StatTile label="Avg ticket"      value={formatINRSymbol(fin.avg_invoice_amount)} icon="pi-calculator" variant="violet" sublabel="Per invoice" />
            <StatTile label="Effective tax"   value={`${Number(fin.tax_pct || 0).toFixed(1)}%`} icon="pi-percentage" variant="amber" sublabel={`${formatINRCompact(fin.total_tax)} collected`} />
            <StatTile label="This month"      value={formatINRCompact(fin.current_month_billed)} icon="pi-calendar" variant="rose" sublabel="Month-to-date" />
            <StatTile label="Validation rate" value={`${validationRate}%`} icon="pi-check-circle" variant="slate" sublabel={`${formatInt(qualityTotals.validated)} validated`} />
          </div>

          <div className="grid-charts">
            <ChartCard title="Monthly volume & value" subtitle="Last 12 months · invoice count (bars) + amount (line)" config={monthlyTrend} height={340} icon="pi-chart-bar" />
            <ChartCard title="Status mix" subtitle="By count — doughnut" config={statusDonut} height={340} icon="pi-chart-pie" />
          </div>

          <div className="grid-charts">
            <section className="glass-card">
              <h3 className="glass-card__title"><i className="pi pi-users" style={{ color: 'var(--accent-violet)' }} /> Top 10 suppliers</h3>
              <div className="glass-card__subtitle">By invoice value</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
                {topSuppliers.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>No suppliers yet.</div>}
                {topSuppliers.map((s, i) => (
                  <div
                    key={s.supplier_name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.7rem',
                      padding: '0.5rem 0.65rem',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-1)',
                      border: '1px solid var(--border-subtle)'
                    }}
                  >
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.74rem',
                        fontWeight: 800
                      }}
                    >
                      {i + 1}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.supplier_name}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        {formatInt(s.invoice_count)} invoice{Number(s.invoice_count) === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {formatINRCompact(s.total_amount)}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-card">
              <h3 className="glass-card__title"><i className="pi pi-history" style={{ color: 'var(--accent-emerald)' }} /> Recent payments</h3>
              <div className="glass-card__subtitle">Latest 10 executed</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.5rem' }}>
                {(dashboard?.recentPayments || []).length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>No payments recorded yet.</div>}
                {(dashboard?.recentPayments || []).map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.7rem',
                      padding: '0.5rem 0.65rem',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-1)',
                      border: '1px solid var(--border-subtle)'
                    }}
                  >
                    <div style={{
                      width: 30, height: 30, borderRadius: 8,
                      background: 'var(--status-success-bg)', color: 'var(--status-success-fg)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem'
                    }}>
                      <i className="pi pi-check" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.invoice_number}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.supplier_name || '—'} · {formatDate(p.payment_done_at)}
                      </div>
                    </div>
                    <div style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {formatINRSymbol(p.amount)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      {/* ========================= CASHFLOW ========================= */}
      {tab === 'cashflow' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Outstanding" value={formatINRCompact(outstandingAmt)} icon="pi-clock" variant="rose" sublabel="Unpaid to suppliers" />
            <StatTile label="Paid (lifetime)" value={formatINRCompact(paidAmt)} icon="pi-check-circle" variant="emerald" sublabel={`${collectionPct}% collected`} />
            <StatTile label="Ready to pay" value={formatINRCompact(pay.ready_amount)} icon="pi-wallet" variant="violet" sublabel={`${formatInt(pay.ready_count)} invoices approved`} />
            <StatTile label="Pending approval" value={formatINRCompact(pay.pending_approval_amount)} icon="pi-hourglass" variant="amber" sublabel={`${formatInt(pay.pending_approval_count)} awaiting review`} />
            <StatTile label="Debit notes" value={formatInt(dashboard?.debitNote?.count)} icon="pi-minus-circle" variant="brand" sublabel={formatINRCompact(dashboard?.debitNote?.total_amount)} />
            <StatTile label="Total tax collected" value={formatINRCompact(totalTax)} icon="pi-percentage" variant="slate" sublabel={`${totalBilled > 0 ? ((totalTax / totalBilled) * 100).toFixed(1) : '0'}% of billed`} />
          </div>

          <div className="grid-charts">
            <ChartCard title="Monthly billed vs tax" subtitle="Last 12 months" config={cashflowBars} height={340} icon="pi-chart-bar" />
            <ChartCard title="Paid vs outstanding" subtitle="By amount across all invoices" config={paidVsOutstanding} height={340} icon="pi-chart-pie" />
          </div>

          <div className="glass-card">
            <h3 className="glass-card__title"><i className="pi pi-money-bill" style={{ color: 'var(--accent-amber)' }} /> Status by value</h3>
            <div className="glass-card__subtitle">Which invoice states hold the most money</div>
            <div style={{ height: 320, marginTop: '0.5rem' }}>
              <ChartCard title="" config={statusAmountBar} height={320} />
            </div>
          </div>
        </>
      )}

      {/* ========================= SUPPLIERS ========================= */}
      {tab === 'suppliers' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Total suppliers" value={formatInt(totalSuppliers)} icon="pi-users" variant="brand" sublabel="In master" />
            <StatTile label="Active" value={formatInt(activeSuppliers)} icon="pi-check-circle" variant="emerald" sublabel={`${activationRate}% activation`} />
            <StatTile label="Dormant" value={formatInt(dormantSuppliers)} icon="pi-exclamation-circle" variant="rose" sublabel="No invoices yet" />
            <StatTile label="Top-3 concentration" value={`${top3Share}%`} icon="pi-percentage" variant="amber" sublabel="of total spend" />
            <StatTile label="Top vendor" value={topSuppliers[0]?.supplier_name ?? '—'} icon="pi-star" variant="violet" sublabel={formatINRCompact(topSuppliers[0]?.total_amount)} />
          </div>

          <div className="grid-charts">
            <ChartCard title="Top 10 suppliers by value" subtitle="Who we spend the most with" config={topSuppliersBar} height={420} icon="pi-chart-bar" />
            <ChartCard title="Spend concentration" subtitle="What % of total spend goes to the top N suppliers" config={concentrationBar} height={420} icon="pi-chart-bar" />
          </div>

          <div className="glass-card">
            <h3 className="glass-card__title"><i className="pi pi-stopwatch" style={{ color: 'var(--accent-emerald)' }} /> Fastest delivering suppliers</h3>
            <div className="glass-card__subtitle">Shortest average days from PO → first invoice</div>
            <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-1)' }}>
                    {['#', 'Supplier', 'Avg days', 'POs', 'Invoices'].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          padding: '0.65rem 0.85rem',
                          textAlign: i === 1 ? 'left' : 'right',
                          fontSize: '0.72rem',
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
                  {(suppliers?.fastest_delivering || []).slice(0, 10).map((s, i) => (
                    <tr key={s.supplier_name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '0.65rem 0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>{i + 1}</td>
                      <td style={{ padding: '0.65rem 0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{s.supplier_name}</td>
                      <td style={{ padding: '0.65rem 0.85rem', textAlign: 'right', fontWeight: 800, color: 'var(--accent-emerald)' }}>
                        {Number(s.avg_days_po_to_invoice).toFixed(1)}
                      </td>
                      <td style={{ padding: '0.65rem 0.85rem', textAlign: 'right' }}>{formatInt(s.po_count)}</td>
                      <td style={{ padding: '0.65rem 0.85rem', textAlign: 'right' }}>{formatInt(s.invoice_count)}</td>
                    </tr>
                  ))}
                  {(suppliers?.fastest_delivering || []).length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                        No data yet — needs POs with matched invoices.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ========================= PROCUREMENT ========================= */}
      {tab === 'procurement' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Purchase orders" value={formatInt(proc.total_pos)} icon="pi-shopping-cart" variant="brand" sublabel="All time" onClick={() => navigate('/purchase-orders')} />
            <StatTile label="GRN records" value={formatInt(proc.total_grn)} icon="pi-box" variant="emerald" sublabel="Goods received" onClick={() => navigate('/grn')} />
            <StatTile label="ASN records" value={formatInt(proc.total_asn)} icon="pi-truck" variant="violet" sublabel="Shipments in transit" onClick={() => navigate('/asn')} />
            <StatTile label="Fulfillment rate" value={`${fulfillmentRate}%`} icon="pi-check-circle" variant="amber" sublabel={`${formatInt(proc.incomplete_po_count)} incomplete`} onClick={() => navigate('/purchase-orders/incomplete')} />
            <StatTile label="Invoices per PO" value={(Number(proc.total_pos) > 0 ? (Number(proc.total_invoices) / Number(proc.total_pos)).toFixed(2) : '0.00')} icon="pi-calculator" variant="slate" sublabel="Match ratio" />
          </div>

          <div className="grid-charts">
            <ChartCard title="Document coverage" subtitle="% of POs that have an invoice / GRN / ASN on file" config={coverageBar} height={340} icon="pi-chart-bar" />
            <section className="glass-card">
              <h3 className="glass-card__title"><i className="pi pi-exclamation-triangle" style={{ color: 'var(--accent-amber)' }} /> Incomplete POs by gap</h3>
              <div className="glass-card__subtitle">What's missing across the {formatInt(proc.incomplete_po_count)} incomplete POs</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
                {[
                  { label: 'Missing invoice', hint: 'POs delivered but no bill yet', icon: 'pi-file',    accent: '#6366f1' },
                  { label: 'Missing GRN',     hint: 'POs without a goods-receipt note', icon: 'pi-box', accent: '#10b981' },
                  { label: 'Missing ASN',     hint: 'POs without a shipment notice',    icon: 'pi-truck', accent: '#8b5cf6' }
                ].map((g) => (
                  <div
                    key={g.label}
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
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        background: `linear-gradient(135deg, ${g.accent}, ${g.accent}cc)`,
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.82rem'
                      }}
                    >
                      <i className={`pi ${g.icon}`} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)' }}>{g.label}</div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{g.hint}</div>
                    </div>
                    <button
                      type="button"
                      className="action-btn action-btn--ghost"
                      onClick={() => navigate('/purchase-orders/incomplete')}
                      style={{ fontSize: '0.78rem' }}
                    >
                      View <i className="pi pi-arrow-right" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      {/* ========================= QUALITY ========================= */}
      {tab === 'quality' && (
        <>
          <div className="grid-kpis fade-in-up--stagger">
            <StatTile label="Validation rate" value={`${validationRate}%`} icon="pi-check-circle" variant="emerald" sublabel={`${formatInt(qualityTotals.validated)} of ${formatInt(Number(qualityTotals.validated) + Number(qualityTotals.waiting_for_validation) + Number(qualityTotals.waiting_for_re_validation))}`} />
            <StatTile label="Awaiting review" value={formatInt(qualityTotals.waiting_for_validation)} icon="pi-clock" variant="amber" sublabel="New invoices" />
            <StatTile label="Re-validation queue" value={formatInt(qualityTotals.waiting_for_re_validation)} icon="pi-refresh" variant="rose" sublabel="Held for fixes" />
            <StatTile label="Debit notes raised" value={formatInt(dashboard?.debitNote?.count)} icon="pi-minus-circle" variant="violet" sublabel={formatINRCompact(dashboard?.debitNote?.total_amount)} />
          </div>

          <section className="glass-card">
            <h3 className="glass-card__title"><i className="pi pi-shield" style={{ color: 'var(--accent-emerald)' }} /> Data quality signals</h3>
            <div className="glass-card__subtitle">Known issue categories and how many invoices are affected</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
              {(quality?.dataQuality || []).length === 0 && (
                <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                  <i className="pi pi-check-circle" style={{ color: 'var(--accent-emerald)' }} /> No quality signals to report.
                </div>
              )}
              {(quality?.dataQuality || []).map((dq) => {
                const affected = Number(dq.affected) || 0
                const severe = affected > 0
                return (
                  <div
                    key={dq.code}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.8rem',
                      padding: '0.75rem 0.9rem',
                      borderRadius: 'var(--radius-md)',
                      border: `1px solid ${severe ? 'var(--status-danger-ring)' : 'var(--border-subtle)'}`,
                      background: severe ? 'var(--status-danger-bg)' : 'var(--surface-1)'
                    }}
                  >
                    <i
                      className={`pi ${severe ? 'pi-exclamation-triangle' : 'pi-check-circle'}`}
                      style={{
                        fontSize: '1.2rem',
                        color: severe ? 'var(--status-danger-fg)' : 'var(--accent-emerald)'
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{dq.category}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{dq.code}</div>
                    </div>
                    <div style={{
                      fontSize: '1.1rem',
                      fontWeight: 800,
                      color: severe ? 'var(--status-danger-fg)' : 'var(--accent-emerald)'
                    }}>
                      {formatInt(affected)}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="glass-card">
            <h3 className="glass-card__title"><i className="pi pi-list" style={{ color: 'var(--brand-600)' }} /> Invoice status snapshot</h3>
            <div className="glass-card__subtitle">Live count + value across every pipeline state</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.55rem', marginTop: '0.75rem' }}>
              {byStatus.map((s) => (
                <div
                  key={s.status}
                  style={{
                    padding: '0.75rem 0.85rem',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-1)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem'
                  }}
                >
                  <StatusChip status={s.status} />
                  <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
                    {formatInt(s.count)}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                    {formatINRSymbol(s.total_amount)}
                  </div>
                </div>
              ))}
              {byStatus.length === 0 && (
                <div style={{ padding: '1rem', color: 'var(--text-muted)' }}>No invoices yet.</div>
              )}
            </div>
          </section>
        </>
      )}
    </>
  )
}

export default Analytics
