import { useState, useEffect, useRef } from 'react'
import { Chart } from 'primereact/chart'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Button } from 'primereact/button'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import styles from './InvoiceReports.module.css'

/** Invoice Report only: volume, status, date distribution. No amounts/tax – see Financial Report. */
interface InvoiceSummary {
  total_invoices: number
  avg_amount: string
}

interface ByMonth {
  month_label: string
  month_date: string
  count: number
}

interface ByStatus {
  status: string
  count: number
}

interface InvoiceReportData {
  summary: InvoiceSummary
  byMonth: ByMonth[]
  byStatus: ByStatus[]
}

const formatCurrency = (val: string | number) => {
  const n = typeof val === 'string' ? parseFloat(val) : val
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const chartDefaults = {
  gridColor: 'rgba(148, 163, 184, 0.12)',
  tooltip: {
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    titleFont: { size: 12, weight: '600' as const },
    bodyFont: { size: 13 },
    padding: 12,
    cornerRadius: 8,
    displayColors: true
  },
  legend: { labels: { font: { size: 12 }, usePointStyle: true, padding: 16 }, position: 'top' as const },
  ticks: { font: { size: 11 }, color: '#64748b', maxRotation: 0 }
}

function InvoiceReports() {
  const toast = useRef<Toast>(null)
  const [data, setData] = useState<InvoiceReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchReport = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('reports/invoices-summary')
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to load invoice report')
        throw new Error(msg)
      }
      const json = await res.json()
      setData(json)
      setLastUpdated(new Date())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load invoice report'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchReport() }, [])

  const primary = '#b91c3c'
  const primaryRgba = 'rgba(185, 28, 60, 0.9)'
  const primaryFill = 'rgba(185, 28, 60, 0.08)'
  const statusPalette = ['#b91c3c', '#0f766e', '#1e40af', '#b45309', '#6b21a8', '#0369a1', '#15803d', '#be185d']

  const totalInvoices = Number(data?.summary?.total_invoices ?? 0)

  const lineData = data?.byMonth?.length
    ? {
        labels: data.byMonth.map((m) => m.month_label),
        datasets: [{
          label: 'Invoice count',
          data: data.byMonth.map((m) => m.count),
          borderColor: primaryRgba,
          backgroundColor: primaryFill,
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      }
    : null

  const doughnutData = data?.byStatus?.length
    ? {
        labels: data.byStatus.map((s) => s.status || 'Unknown'),
        datasets: [{
          data: data.byStatus.map((s) => s.count),
          backgroundColor: statusPalette.slice(0, data.byStatus.length),
          borderWidth: 0,
          hoverOffset: 12
        }]
      }
    : null

  const lineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: { legend: chartDefaults.legend, tooltip: chartDefaults.tooltip },
    scales: {
      x: { grid: { display: false }, ticks: { ...chartDefaults.ticks, maxTicksLimit: 10 } },
      y: { grid: { color: chartDefaults.gridColor }, ticks: chartDefaults.ticks, title: { display: true, text: 'Invoice count', font: { size: 11 }, color: '#64748b' }, beginAtZero: true }
    }
  }

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: { legend: { ...chartDefaults.legend, position: 'bottom' as const }, tooltip: chartDefaults.tooltip }
  }

  const statusWithPct = (data?.byStatus ?? []).map((s) => ({
    status: s.status || 'Unknown',
    count: s.count,
    pct: totalInvoices ? ((s.count / totalInvoices) * 100).toFixed(1) : '0'
  }))

  if (loading && !data) {
    return (
      <div className={styles.page}>
        <Header />
        <div className={styles.container}>
          <PageNavigation onRefresh={fetchReport} refreshLoading={loading} />
          <div className={styles.loadingWrap}>
            <ProgressSpinner strokeWidth="3" />
            <p className={styles.loadingText}>Loading report…</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <Toast ref={toast} />
      <Header />
      <div className={styles.container}>
        <div className={styles.reportHeader}>
          <div className={styles.breadcrumb}>
            <span className={styles.breadcrumbItem}>Reports & Analytics</span>
            <span className={styles.breadcrumbSep}>/</span>
            <span className={styles.breadcrumbCurrent}>Invoice Report</span>
          </div>
          <div className={styles.headerRow}>
            <div>
              <h1 className={styles.title}>Invoice Report</h1>
              <p className={styles.subtitle}>
                Volume, status, and date distribution
                {lastUpdated && (
                  <span className={styles.meta}> · Last updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </p>
            </div>
            <PageNavigation onRefresh={fetchReport} refreshLoading={loading} />
          </div>
        </div>

        {data && (
          <>
            <section className={styles.kpiSection} aria-label="Key metrics">
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(185, 28, 60, 0.1)', color: primary }}>
                  <i className="pi pi-file-edit" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Total Invoices</span>
                  <span className={styles.kpiValue}>{totalInvoices.toLocaleString('en-IN')}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.1)', color: '#0f766e' }}>
                  <i className="pi pi-chart-line" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Avg per Invoice</span>
                  <span className={styles.kpiValue}>{formatCurrency(data.summary?.avg_amount ?? 0)}</span>
                </div>
              </div>
              {data.byStatus?.slice(0, 3).map((s, i) => (
                <div key={s.status || i} className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(100, 116, 139, 0.15)', color: '#475569' }}>
                    <i className="pi pi-circle-fill" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>{s.status || 'Unknown'}</span>
                    <span className={styles.kpiValue}>{s.count}</span>
                  </div>
                </div>
              ))}
            </section>

            <div className={styles.chartGrid}>
              <div className={styles.chartCard}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>Invoice volume over time</h3>
                  <span className={styles.chartSubtitle}>Count of invoices by month (volume only)</span>
                </div>
                <div className={styles.chartWrap}>
                  {lineData ? (
                    <Chart type="line" data={lineData} options={lineOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-chart-line" />
                      <p>No invoice dates yet</p>
                      <span>Add invoices with dates to see volume trend</span>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.chartCard}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>Status distribution</h3>
                  <span className={styles.chartSubtitle}>Invoices by current status</span>
                </div>
                <div className={styles.chartWrap}>
                  {doughnutData ? (
                    <Chart type="doughnut" data={doughnutData} options={doughnutOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-circle" />
                      <p>No status data yet</p>
                      <span>Status is set when invoices are saved</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <section className="dts-section dts-section-accent">
              <h3 className="dts-sectionTitle">Status breakdown (detail)</h3>
              <p className="dts-sectionSubtitle">Count and share per status</p>
              <div className="dts-tableWrapper">
                <div className="dts-tableContainer">
                  <DataTable value={statusWithPct} size="small" stripedRows emptyMessage="No status data">
                    <Column field="status" header="Status" />
                    <Column field="count" header="Count" />
                    <Column field="pct" header="%" body={(row) => `${row.pct}%`} />
                  </DataTable>
                </div>
              </div>
            </section>

            <section className="dts-section dts-section-accent">
              <h3 className="dts-sectionTitle">Monthly volume (detail)</h3>
              <p className="dts-sectionSubtitle">Invoice count by month</p>
              <div className="dts-tableWrapper">
                <div className="dts-tableContainer">
                  <DataTable value={data.byMonth ?? []} size="small" stripedRows emptyMessage="No monthly data">
                    <Column field="month_label" header="Month" />
                    <Column field="count" header="Invoice count" />
                  </DataTable>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default InvoiceReports
