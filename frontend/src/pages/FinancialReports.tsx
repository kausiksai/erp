import { useState, useEffect, useRef } from 'react'
import { Chart } from 'primereact/chart'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Button } from 'primereact/button'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import styles from './FinancialReports.module.css'

interface FinancialSummary {
  total_invoices: number
  total_billed: string
  total_tax: string
  avg_invoice_amount: string
}

interface ByMonth {
  month_label: string
  month_date: string
  invoice_count: number
  amount: string
  tax_amount: string
}

interface FinancialReportData {
  summary: FinancialSummary
  byMonth: ByMonth[]
}

interface ProcurementSummary {
  summary: {
    total_pos: number
    total_grn: number
    total_asn: number
    total_invoices: number
    incomplete_po_count: number
  }
  byStatus: { status: string; count: number }[]
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
  legend: { position: 'top' as const, labels: { font: { size: 12 }, usePointStyle: true, padding: 16 } },
  ticks: { font: { size: 11 }, color: '#64748b' }
}

function FinancialReports() {
  const toast = useRef<Toast>(null)
  const [data, setData] = useState<FinancialReportData | null>(null)
  const [procurement, setProcurement] = useState<ProcurementSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchReports = async () => {
    try {
      setLoading(true)
      const [resFin, resProc] = await Promise.all([
        apiFetch('reports/financial-summary'),
        apiFetch('reports/procurement-summary')
      ])
      if (!resFin.ok) {
        const msg = await getErrorMessageFromResponse(resFin, 'Failed to load financial report')
        throw new Error(msg)
      }
      if (!resProc.ok) {
        const msg = await getErrorMessageFromResponse(resProc, 'Failed to load procurement summary')
        throw new Error(msg)
      }
      setData(await resFin.json())
      setProcurement(await resProc.json())
      setLastUpdated(new Date())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load report'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchReports() }, [])

  const primary = '#0f766e'
  const primaryRgba = 'rgba(15, 118, 110, 0.9)'
  const primaryFill = 'rgba(15, 118, 110, 0.08)'
  const taxColor = '#6b21a8'
  const taxRgba = 'rgba(107, 33, 168, 0.9)'
  const taxFill = 'rgba(107, 33, 168, 0.08)'
  const poStatusPalette = ['#0f766e', '#6b21a8', '#c2410c', '#1e40af', '#b91c3c']

  const lineData = data?.byMonth?.length
    ? {
        labels: data.byMonth.map((m) => m.month_label),
        datasets: [
          {
            label: 'Billed amount (₹)',
            data: data.byMonth.map((m) => parseFloat(m.amount)),
            borderColor: primaryRgba,
            backgroundColor: primaryFill,
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            yAxisID: 'y'
          },
          {
            label: 'Tax (₹)',
            data: data.byMonth.map((m) => parseFloat(m.tax_amount)),
            borderColor: taxRgba,
            backgroundColor: taxFill,
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            yAxisID: 'y1'
          }
        ]
      }
    : null

  const barData = data?.byMonth?.length
    ? {
        labels: data.byMonth.map((m) => m.month_label),
        datasets: [{
          label: 'Invoice count',
          data: data.byMonth.map((m) => m.invoice_count),
          backgroundColor: primaryRgba,
          borderRadius: 6,
          borderSkipped: false
        }]
      }
    : null

  const poStatusData = procurement?.byStatus?.length
    ? {
        labels: procurement.byStatus.map((s) => s.status || 'Unknown'),
        datasets: [{
          data: procurement.byStatus.map((s) => s.count),
          backgroundColor: poStatusPalette.slice(0, procurement.byStatus.length),
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
      x: {
        grid: { display: false },
        ticks: { ...chartDefaults.ticks, maxTicksLimit: 8 }
      },
      y: {
        type: 'linear' as const,
        position: 'left' as const,
        grid: { color: chartDefaults.gridColor },
        ticks: chartDefaults.ticks,
        title: { display: true, text: 'Amount (₹)', font: { size: 11 }, color: '#64748b' },
        beginAtZero: true
      },
      y1: {
        type: 'linear' as const,
        position: 'right' as const,
        grid: { drawOnChartArea: false },
        ticks: chartDefaults.ticks,
        title: { display: true, text: 'Tax (₹)', font: { size: 11 }, color: '#64748b' },
        beginAtZero: true
      }
    }
  }

  const barOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: chartDefaults.tooltip },
    scales: {
      x: { grid: { display: false }, ticks: chartDefaults.ticks },
      y: { grid: { color: chartDefaults.gridColor }, ticks: chartDefaults.ticks, beginAtZero: true }
    }
  }

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: {
      legend: { ...chartDefaults.legend, position: 'bottom' as const },
      tooltip: chartDefaults.tooltip
    }
  }

  if (loading && !data) {
    return (
      <div className={styles.page}>
        <Header />
        <div className={styles.container}>
          <PageNavigation />
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
            <span className={styles.breadcrumbCurrent}>Financial Report</span>
          </div>
          <div className={styles.headerRow}>
            <div>
              <h1 className={styles.title}>Financial Analytics</h1>
              <p className={styles.subtitle}>
                Billed amounts, tax, and procurement only. Invoice volume in Invoice Report; supplier detail in Supplier Report.
                {lastUpdated && (
                  <span className={styles.meta}> · Last updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </p>
            </div>
            <Button label="Refresh data" icon="pi pi-refresh" className={styles.refreshBtn} onClick={fetchReports} loading={loading} outlined />
          </div>
        </div>
        <PageNavigation />

        {data && (
          <>
            <section className={styles.kpiSection} aria-label="Key metrics">
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.1)', color: primary }}>
                  <i className="pi pi-file-edit" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Total Invoices</span>
                  <span className={styles.kpiValue}>{Number(data.summary?.total_invoices ?? 0).toLocaleString('en-IN')}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.1)', color: primary }}>
                  <i className="pi pi-wallet" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Total Billed</span>
                  <span className={styles.kpiValue}>{formatCurrency(data.summary?.total_billed ?? 0)}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(107, 33, 168, 0.1)', color: taxColor }}>
                  <i className="pi pi-percentage" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Total Tax</span>
                  <span className={styles.kpiValue}>{formatCurrency(data.summary?.total_tax ?? 0)}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(30, 64, 175, 0.1)', color: '#1e40af' }}>
                  <i className="pi pi-chart-line" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Avg Invoice</span>
                  <span className={styles.kpiValue}>{formatCurrency(data.summary?.avg_invoice_amount ?? 0)}</span>
                </div>
              </div>
            </section>

            <div className={styles.chartGrid}>
              <div className={styles.chartCardWide}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>Billed amount & tax over time</h3>
                  <span className={styles.chartSubtitle}>Monthly billed value (₹) and tax (₹)</span>
                </div>
                <div className={styles.chartWrap}>
                  {lineData ? (
                    <Chart type="line" data={lineData} options={lineOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-chart-line" />
                      <p>No date-based data yet</p>
                      <span>Add invoices with dates to see trends</span>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.chartCard}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>Invoice count by month</h3>
                  <span className={styles.chartSubtitle}>Volume trend (detail in Invoice Report)</span>
                </div>
                <div className={styles.chartWrap}>
                  {barData ? (
                    <Chart type="bar" data={barData} options={barOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-chart-bar" />
                      <p>No data yet</p>
                      <span>Invoice dates will drive this chart</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {data?.byMonth?.length ? (
              <section className="dts-section dts-section-accent">
                <h3 className="dts-sectionTitle">Monthly financial summary (detail)</h3>
                <p className="dts-sectionSubtitle">Invoices, billed amount, and tax by month</p>
                <div className="dts-tableWrapper">
                  <div className="dts-tableContainer">
                    <DataTable value={data.byMonth} size="small" stripedRows>
                      <Column field="month_label" header="Month" />
                      <Column field="invoice_count" header="Invoices" />
                      <Column field="amount" header="Billed (₹)" body={(row) => formatCurrency(row.amount)} />
                      <Column field="tax_amount" header="Tax (₹)" body={(row) => formatCurrency(row.tax_amount)} />
                    </DataTable>
                  </div>
                </div>
              </section>
            ) : null}

            {procurement && (
              <section className={styles.procurementSection}>
                <div className={styles.procurementHead}>
                  <h3 className={styles.sectionTitle}>Procurement overview</h3>
                  <span className={styles.sectionSubtitle}>POs, GRN, ASN, and invoice counts; incomplete POs requiring action</span>
                </div>
                <div className={styles.procurementGrid}>
                  <div className={styles.procCard}>
                    <i className="pi pi-shopping-cart" />
                    <div>
                      <span className={styles.procLabel}>Total POs</span>
                      <span className={styles.procValue}>{Number(procurement.summary?.total_pos ?? 0).toLocaleString('en-IN')}</span>
                    </div>
                  </div>
                  <div className={styles.procCard}>
                    <i className="pi pi-box" />
                    <div>
                      <span className={styles.procLabel}>GRN records</span>
                      <span className={styles.procValue}>{Number(procurement.summary?.total_grn ?? 0).toLocaleString('en-IN')}</span>
                    </div>
                  </div>
                  <div className={styles.procCard}>
                    <i className="pi pi-truck" />
                    <div>
                      <span className={styles.procLabel}>ASN records</span>
                      <span className={styles.procValue}>{Number(procurement.summary?.total_asn ?? 0).toLocaleString('en-IN')}</span>
                    </div>
                  </div>
                  <div className={styles.procCard}>
                    <i className="pi pi-file-edit" />
                    <div>
                      <span className={styles.procLabel}>Invoices</span>
                      <span className={styles.procValue}>{Number(procurement.summary?.total_invoices ?? 0).toLocaleString('en-IN')}</span>
                    </div>
                  </div>
                  <div className={`${styles.procCard} ${styles.procCardWarn}`}>
                    <i className="pi pi-exclamation-triangle" />
                    <div>
                      <span className={styles.procLabel}>Incomplete POs</span>
                      <span className={styles.procValue}>{Number(procurement.summary?.incomplete_po_count ?? 0).toLocaleString('en-IN')}</span>
                    </div>
                  </div>
                </div>
                <div className={styles.poStatusBlock}>
                  <h4 className={styles.poStatusTitle}>POs by status</h4>
                  <div className={styles.poStatusChartWrap}>
                    {poStatusData ? (
                      <Chart type="doughnut" data={poStatusData} options={doughnutOptions} />
                    ) : (
                      <div className={styles.emptyStateSmall}>No PO status data</div>
                    )}
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default FinancialReports
