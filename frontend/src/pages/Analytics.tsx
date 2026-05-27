import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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

interface RuleCount { code: string; count: number; severity?: string }

interface DashboardSummaryFull extends DashboardSummary {
  gstBreakdown?: Array<{ month: string; month_date: string; cgst: number | string; sgst: number | string; igst: number | string }>
}

function Analytics() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [suppliers, setSuppliers] = useState<SuppliersSummary | null>(null)
  const [quality, setQuality] = useState<DashboardSummaryFull | null>(null)
  const [ruleCounts, setRuleCounts] = useState<RuleCount[]>([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        setError('')
        const [d, s, q, r] = await Promise.all([
          apiFetch('reports/dashboard'),
          apiFetch('reports/suppliers-summary'),
          apiFetch('reports/dashboard-summary'),
          apiFetch('validation-rules')
        ])
        if (!d.ok) throw new Error('Dashboard report failed')
        const [dj, sj, qj, rj] = await Promise.all([
          d.json(),
          s.ok ? s.json() : Promise.resolve({}),
          q.ok ? q.json() : Promise.resolve({}),
          r.ok ? r.json() : Promise.resolve({ rules: [] })
        ])
        if (!alive) return
        setDashboard(dj)
        setSuppliers(sj)
        setQuality(qj)
        setRuleCounts(Array.isArray(rj?.rules) ? rj.rules : [])
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
      {/* Hero — verbatim from mockup VIEWS.insights */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-chart-line" /> Insights</span>
          <h1>Insights</h1>
          <p>Trends across the billing pipeline. Use these to spot supplier patterns, OCR drift, GST anomalies, and where automation is paying off.</p>
        </div>
        <div className="hero__act">
          <select
            style={{
              padding: '7px 11px',
              border: '1px solid var(--b-2)',
              borderRadius: 8,
              background: 'var(--s-0)',
              fontSize: 12.5,
              color: 'var(--t-1)',
              cursor: 'pointer',
              fontFamily: 'inherit'
            }}
            defaultValue="30"
          >
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="ytd">This year</option>
          </select>
          <button className="btn btn--g" onClick={() => navigate('/')}>
            <i className="pi pi-home" /> Workspace
          </button>
          <button
            className="btn btn--g"
            onClick={() => {
              const win = window.open('', '_blank')
              if (win) {
                win.document.title = 'Insights export'
                win.document.body.innerText = 'Insights CSV export will land with /api/reports/insights/export.'
              }
            }}
          >
            <i className="pi pi-download" /> Export
          </button>
        </div>
      </section>

      {error && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--err-line)', color: 'var(--err-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}

      {/* Mockup tabs row */}
      <div className="tabs" style={{ marginBottom: 14 }}>
        {([
          { k: 'overview',   l: 'Overview' },
          { k: 'cashflow',   l: 'Cashflow' },
          { k: 'suppliers',  l: 'Suppliers' },
          { k: 'procurement',l: 'Procurement' },
          { k: 'quality',    l: 'Quality' }
        ] as Array<{ k: Tab; l: string }>).map((t) => (
          <button
            key={t.k}
            type="button"
            className={`tab ${tab === t.k ? 'active' : ''}`}
            onClick={() => setTab(t.k)}
          >
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
          {/* Mockup highlights — Validation rate / Errors per category /
              OCR accuracy / GST split / Avg time to payment */}
          <MockupHighlights
            validationRate={validationRate}
            validatedCount={Number(qualityTotals.validated) || 0}
            totalForRate={
              (Number(qualityTotals.validated) || 0) +
              (Number(qualityTotals.waiting_for_validation) || 0) +
              (Number(qualityTotals.waiting_for_re_validation) || 0)
            }
            ruleCounts={ruleCounts}
            totalInvoices={Number(fin.total_invoices) || 0}
            gstBreakdown={quality?.gstBreakdown || []}
          />
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

/* =========================================================================
 *   Mockup-aligned highlights row — surfaces the 5 cards from the design
 *   mockup (Validation rate · Errors per category · OCR accuracy ·
 *   GST split · Avg time to payment) above the existing tab body.
 *
 *   Wire-up:
 *   - Validation rate: derived from `qualityTotals` (validated / open total).
 *   - Errors per category: live `validation-rules` counts.
 *   - GST split: 12-month aggregated CGST+SGST vs IGST from `gstBreakdown`.
 *   - OCR accuracy + Avg time to payment: not yet exposed by an endpoint —
 *     rendered with a "no live data" stub so the mockup layout is still
 *     visible until the corresponding APIs land.
 * ========================================================================= */
function MockupHighlights({
  validationRate,
  validatedCount,
  totalForRate,
  ruleCounts,
  totalInvoices,
  gstBreakdown,
}: {
  validationRate: number
  validatedCount: number
  totalForRate: number
  ruleCounts: RuleCount[]
  totalInvoices: number
  gstBreakdown: Array<{ cgst: number | string; sgst: number | string; igst: number | string }>
}) {
  /* ----- Errors per category — top 10 short codes by count ----- */
  const sortedRules = [...ruleCounts]
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  const shortCodeOf = (c: string) => (c || '').split('_')[0]
  const maxBar = sortedRules.reduce((m, r) => Math.max(m, r.count), 0) || 1

  /* ----- GST split — intra (CGST+SGST) vs inter (IGST) ----- */
  const cgstTotal = gstBreakdown.reduce((s, r) => s + (parseAmount(r.cgst) ?? 0), 0)
  const sgstTotal = gstBreakdown.reduce((s, r) => s + (parseAmount(r.sgst) ?? 0), 0)
  const igstTotal = gstBreakdown.reduce((s, r) => s + (parseAmount(r.igst) ?? 0), 0)
  const intraTax = cgstTotal + sgstTotal
  const interTax = igstTotal
  const totalTax = intraTax + interTax
  const intraPct = totalTax > 0 ? Math.round((intraTax / totalTax) * 100) : 0
  const interPct = totalTax > 0 ? 100 - intraPct : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 14 }}>
      {/* Row 1: Validation rate + Errors per category */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 14 }}>
        {/* Validation rate */}
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-chart-line" /> Validation rate</div>
            <span className="card__m">live snapshot</span>
          </div>
          <div className="card__b" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ fontSize: 38, fontWeight: 800, color: 'var(--ok-fg)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
                {validationRate}%
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--t-3)' }}>
                {formatInt(validatedCount)} of {formatInt(totalForRate)} open
              </div>
            </div>
            {/* Sparkline-style flat indicator — single live value, trend backend not yet wired */}
            <svg viewBox="0 0 400 70" width="100%" height={70} preserveAspectRatio="none" style={{ marginTop: 12 }}>
              <defs>
                <linearGradient id="vr-grad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {(() => {
                const y = 70 - (validationRate / 100) * 60
                return (
                  <>
                    <path d={`M0,${y} L400,${y} L400,70 L0,70 Z`} fill="url(#vr-grad)" />
                    <path d={`M0,${y} L400,${y}`} stroke="#10b981" strokeWidth={2.2} fill="none" />
                  </>
                )
              })()}
            </svg>
            <div style={{ fontSize: 11.5, color: 'var(--t-4)', marginTop: 6 }}>
              14-day trend lands with <code>/api/reports/validation-rate-trend</code>.
            </div>
          </div>
        </div>

        {/* Errors per category */}
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-chart-bar" /> Errors per category</div>
            <span className="card__m">distinct invoices · top 10</span>
          </div>
          <div className="card__b" style={{ padding: 18 }}>
            {sortedRules.length === 0 ? (
              <div style={{ color: 'var(--t-3)', fontSize: 13 }}>
                <i className="pi pi-check-circle" style={{ color: 'var(--ok-fg)' }} /> No active validation errors.
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 160, padding: '0 4px' }}>
                {sortedRules.map((r, i) => {
                  const h = (r.count / maxBar) * 130
                  const altColor = i % 2 === 0
                    ? 'linear-gradient(180deg, #3b82f6, #06b6d4)'
                    : 'linear-gradient(180deg, #f59e0b, #fbbf24)'
                  return (
                    <div key={r.code} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                      <div
                        style={{
                          width: '100%',
                          maxWidth: 40,
                          height: h,
                          background: altColor,
                          borderRadius: '6px 6px 2px 2px',
                          minHeight: 4,
                        }}
                        title={`${shortCodeOf(r.code)}: ${formatInt(r.count)}`}
                      />
                      <div style={{ fontSize: 10.5, color: 'var(--t-2)', fontWeight: 700, fontFamily: 'var(--font-mono, monospace)' }}>
                        {shortCodeOf(r.code)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--t-3)', fontVariantNumeric: 'tabular-nums' }}>
                        {formatInt(r.count)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: OCR accuracy + GST split + Avg time to payment */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
        {/* OCR accuracy — stubbed until /api/ocr/health exists */}
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-image" /> OCR accuracy</div>
            <span className="card__m">field-level match</span>
          </div>
          <div className="card__b" style={{ padding: 18 }}>
            <div style={{ fontSize: 38, fontWeight: 800, color: 'var(--ok-fg)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>—</div>
            <div style={{ fontSize: 12, color: 'var(--t-3)', marginTop: 4 }}>
              across — invoices
            </div>
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--vio-bg)', border: '1px solid var(--b-1)', borderRadius: 'var(--r-md)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <i className="pi pi-info-circle" style={{ color: 'var(--vio-fg)', fontSize: 16, marginTop: 2 }} />
              <div style={{ fontSize: 12, color: 'var(--t-2)', lineHeight: 1.5 }}>
                <strong>Drop driver</strong> instrumentation lands with <code>/api/ocr/health</code>.
              </div>
            </div>
          </div>
        </div>

        {/* GST split — donut */}
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-percentage" /> GST split</div>
            <span className="card__m">last 12 months · by tax</span>
          </div>
          <div className="card__b" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
            <GstDonut interPct={interPct} intraPct={intraPct} total={totalInvoices} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#3b82f6' }} />
                <span style={{ flex: 1, color: 'var(--t-2)' }}>Inter-state (IGST)</span>
                <strong style={{ color: 'var(--t-1)', fontVariantNumeric: 'tabular-nums' }}>{interPct}%</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: '#8b5cf6' }} />
                <span style={{ flex: 1, color: 'var(--t-2)' }}>Intra-state</span>
                <strong style={{ color: 'var(--t-1)', fontVariantNumeric: 'tabular-nums' }}>{intraPct}%</strong>
              </div>
              {totalTax === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--t-4)' }}>
                  No GST recorded in the last 12 months.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Avg time to payment — stubbed until lifecycle metrics exist */}
        <div className="card">
          <div className="card__h">
            <div className="card__t"><i className="pi pi-clock" /> Avg time to payment</div>
            <span className="card__m">from load to bank · target 21d</span>
          </div>
          <div className="card__b" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <div style={{ fontSize: 38, fontWeight: 800, color: 'var(--t-1)', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>—</div>
              <div style={{ fontSize: 14, color: 'var(--t-3)', fontWeight: 600 }}>days</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
              {[
                { l: 'Load → validate', v: '—' },
                { l: 'Validate → approve', v: '—' },
                { l: 'Approve → bank', v: '—' },
                { l: 'Bank → confirmed', v: '—' },
              ].map((c) => (
                <div key={c.l} style={{ padding: '8px 10px', background: 'var(--s-1)', border: '1px solid var(--b-1)', borderRadius: 'var(--r-md)' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--t-3)', fontWeight: 600 }}>{c.l}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t-2)', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{c.v}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--t-4)', marginTop: 8 }}>
              Lifecycle metrics land with <code>/api/reports/avg-time-to-payment</code>.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function GstDonut({ interPct, intraPct, total }: { interPct: number; intraPct: number; total: number }) {
  const r = 42
  const c = 2 * Math.PI * r
  const dashInter = (interPct / 100) * c
  const dashIntra = (intraPct / 100) * c
  return (
    <svg viewBox="0 0 110 110" width={120} height={120}>
      <circle cx={55} cy={55} r={r} fill="none" stroke="var(--s-2)" strokeWidth={14} />
      {interPct > 0 && (
        <circle
          cx={55}
          cy={55}
          r={r}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={14}
          strokeDasharray={`${dashInter} ${c}`}
          transform="rotate(-90 55 55)"
        />
      )}
      {intraPct > 0 && (
        <circle
          cx={55}
          cy={55}
          r={r}
          fill="none"
          stroke="#8b5cf6"
          strokeWidth={14}
          strokeDasharray={`${dashIntra} ${c}`}
          strokeDashoffset={-dashInter}
          transform="rotate(-90 55 55)"
        />
      )}
      <text x={55} y={59} textAnchor="middle" fontSize={16} fontWeight={800} fill="var(--t-1)">{formatInt(total)}</text>
    </svg>
  )
}

export default Analytics
