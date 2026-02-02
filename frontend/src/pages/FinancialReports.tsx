import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
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

interface DashboardData {
  financial?: { total_invoices?: number; total_billed?: string; total_tax?: string; avg_invoice_amount?: string; tax_pct?: string; current_month_billed?: string; ytd_billed?: string }
  invoiceByStatus?: Array<{ status: string; count: number; total_amount: string }>
  payments?: { pending_approval_count?: number; ready_count?: number; payment_done_count?: number; pending_approval_amount?: string; ready_amount?: string; payment_done_amount?: string }
  debitNote?: { count: number; total_amount: string }
  recentPayments?: Array<{ invoice_number: string; supplier_name: string | null; amount: string; payment_done_at: string | null }>
  topSuppliers?: Array<{ supplier_name: string; invoice_count: number; total_amount: string }>
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

const statusLabel = (s: string) => {
  const labels: Record<string, string> = {
    pending: 'Pending',
    ready_for_payment: 'Ready for payment',
    debit_note_approval: 'Debit note approval',
    exception_approval: 'Exception approval',
    validated: 'Validated',
    waiting_for_validation: 'Waiting for validation',
    waiting_for_re_validation: 'Waiting for re-validation',
    approved: 'Approved',
    rejected: 'Rejected',
    completed: 'Completed'
  }
  return labels[s] || s.replace(/_/g, ' ')
}

const formatDate = (val: string | null) => {
  if (!val) return '—'
  return new Date(val).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function FinancialReports() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [data, setData] = useState<FinancialReportData | null>(null)
  const [procurement, setProcurement] = useState<ProcurementSummary | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchReports = async () => {
    try {
      setLoading(true)
      const [resFin, resProc, resDash] = await Promise.all([
        apiFetch('reports/financial-summary'),
        apiFetch('reports/procurement-summary'),
        apiFetch('reports/dashboard')
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
      if (resDash.ok) setDashboard(await resDash.json())
      else setDashboard(null)
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
            <span className={styles.breadcrumbCurrent}>Financial Reports</span>
          </div>
          <div className={styles.headerRow}>
            <div>
              <h1 className={styles.title}>Financial Reports</h1>
              <p className={styles.subtitle}>
                All financial reports: summary, payment pipeline, monthly trends, procurement, and payment actions.
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

            {dashboard && (
              <>
                {dashboard.invoiceByStatus && dashboard.invoiceByStatus.length > 0 && (
                  <section className={styles.summaryBlock} aria-label="Invoice status breakdown">
                    <h3 className={styles.blockTitle}>Invoice status breakdown</h3>
                    <p className={styles.blockSubtitle}>Count and value by invoice status</p>
                    <div className={styles.tableWrap}>
                      <DataTable value={dashboard.invoiceByStatus} size="small" stripedRows emptyMessage="No invoice data">
                        <Column field="status" header="Status" body={(row) => statusLabel(row.status)} style={{ minWidth: '160px' }} />
                        <Column field="count" header="Count" style={{ minWidth: '80px' }} />
                        <Column field="total_amount" header="Amount (₹)" body={(row) => formatCurrency(row.total_amount)} style={{ minWidth: '140px' }} />
                      </DataTable>
                    </div>
                  </section>
                )}

                {dashboard.payments && (
                  <section className={styles.summaryBlock} aria-label="Payment pipeline">
                    <h3 className={styles.blockTitle}>Payment pipeline</h3>
                    <p className={styles.blockSubtitle}>Approval and disbursement status with amounts</p>
                    <div className={styles.kpiSectionThree}>
                      <div className={styles.kpiCard}>
                        <div className={styles.kpiIconWrap} style={{ background: 'rgba(234, 179, 8, 0.12)', color: '#ca8a04' }}><i className="pi pi-clock" /></div>
                        <div className={styles.kpiContent}>
                          <span className={styles.kpiLabel}>Awaiting approval</span>
                          <span className={styles.kpiValue}>{Number(dashboard.payments?.pending_approval_count ?? 0).toLocaleString('en-IN')}</span>
                          {dashboard.payments?.pending_approval_amount != null && parseFloat(String(dashboard.payments.pending_approval_amount)) > 0 && (
                            <span className={styles.kpiSub}>{formatCurrency(dashboard.payments.pending_approval_amount)}</span>
                          )}
                        </div>
                      </div>
                      <div className={styles.kpiCard}>
                        <div className={styles.kpiIconWrap} style={{ background: 'rgba(13, 148, 136, 0.12)', color: '#0d9488' }}><i className="pi pi-check-circle" /></div>
                        <div className={styles.kpiContent}>
                          <span className={styles.kpiLabel}>Ready for payment</span>
                          <span className={styles.kpiValue}>{Number(dashboard.payments?.ready_count ?? 0).toLocaleString('en-IN')}</span>
                          {dashboard.payments?.ready_amount != null && parseFloat(String(dashboard.payments.ready_amount)) > 0 && (
                            <span className={styles.kpiSub}>{formatCurrency(dashboard.payments.ready_amount)}</span>
                          )}
                        </div>
                      </div>
                      <div className={styles.kpiCard}>
                        <div className={styles.kpiIconWrap} style={{ background: 'rgba(22, 163, 74, 0.12)', color: '#16a34a' }}><i className="pi pi-money-bill" /></div>
                        <div className={styles.kpiContent}>
                          <span className={styles.kpiLabel}>Payment completed</span>
                          <span className={styles.kpiValue}>{Number(dashboard.payments?.payment_done_count ?? 0).toLocaleString('en-IN')}</span>
                          {dashboard.payments?.payment_done_amount != null && parseFloat(String(dashboard.payments.payment_done_amount)) > 0 && (
                            <span className={styles.kpiSub}>{formatCurrency(dashboard.payments.payment_done_amount)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {dashboard.debitNote && Number(dashboard.debitNote.count) > 0 && (
                  <section className={styles.summaryBlock} aria-label="Debit note">
                    <h3 className={styles.blockTitle}>Debit note approval</h3>
                    <p className={styles.blockSubtitle}>Invoices awaiting debit note approval (quantity mismatch)</p>
                    <div className={styles.debitNoteRow}>
                      <span className={styles.debitNoteCount}>{dashboard.debitNote.count} invoice(s)</span>
                      <span className={styles.debitNoteAmount}>{formatCurrency(dashboard.debitNote.total_amount)}</span>
                    </div>
                    <Button label="View debit note list" icon="pi pi-list" size="small" outlined onClick={() => navigate('/purchase-orders/incomplete')} className={styles.debitNoteBtn} />
                  </section>
                )}

                <div className={styles.twoCol}>
                  {dashboard.topSuppliers && dashboard.topSuppliers.length > 0 && (
                    <section className={styles.summaryBlock} aria-label="Top suppliers">
                      <h3 className={styles.blockTitle}>Top suppliers by billed amount</h3>
                      <p className={styles.blockSubtitle}>Top 10 by total invoice value</p>
                      <div className={styles.tableWrap}>
                        <DataTable value={dashboard.topSuppliers} size="small" stripedRows emptyMessage="No supplier data">
                          <Column field="supplier_name" header="Supplier" style={{ minWidth: '180px' }} />
                          <Column field="invoice_count" header="Invoices" style={{ minWidth: '80px' }} />
                          <Column field="total_amount" header="Total (₹)" body={(row) => formatCurrency(row.total_amount)} style={{ minWidth: '120px' }} />
                        </DataTable>
                      </div>
                    </section>
                  )}
                  {dashboard.recentPayments && dashboard.recentPayments.length > 0 && (
                    <section className={styles.summaryBlock} aria-label="Recent payments">
                      <h3 className={styles.blockTitle}>Recent payments</h3>
                      <p className={styles.blockSubtitle}>Last 10 completed payments</p>
                      <div className={styles.tableWrap}>
                        <DataTable value={dashboard.recentPayments} size="small" stripedRows emptyMessage="No recent payments">
                          <Column field="invoice_number" header="Invoice" style={{ minWidth: '120px' }} />
                          <Column field="supplier_name" header="Supplier" body={(row) => row.supplier_name || '—'} style={{ minWidth: '140px' }} />
                          <Column field="amount" header="Amount (₹)" body={(row) => formatCurrency(row.amount)} style={{ minWidth: '110px' }} />
                          <Column field="payment_done_at" header="Paid on" body={(row) => formatDate(row.payment_done_at)} style={{ minWidth: '110px' }} />
                        </DataTable>
                      </div>
                      <Button label="View full payment history" icon="pi pi-history" size="small" outlined onClick={() => navigate('/payments/history')} className={styles.historyBtn} />
                    </section>
                  )}
                </div>

                <section className={styles.summaryBlock} aria-label="Finance actions">
                  <h3 className={styles.blockTitle}>Finance actions</h3>
                  <p className={styles.blockSubtitle}>Payment workflow and quick links</p>
                  <div className={styles.quickLinksGrid}>
                    <Button label="Approve payments" icon="pi pi-check-square" className={styles.quickLink} onClick={() => navigate('/payments/approve')} />
                    <Button label="Ready for payment" icon="pi pi-money-bill" className={styles.quickLink} onClick={() => navigate('/payments/ready')} />
                    <Button label="Payment history" icon="pi pi-history" className={styles.quickLink} onClick={() => navigate('/payments/history')} />
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default FinancialReports
