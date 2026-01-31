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
import styles from './FinanceDashboard.module.css'

interface DashboardData {
  financial: {
    total_invoices: number
    total_billed: string
    total_tax: string
    avg_invoice_amount: string
    tax_pct?: string
    current_month_billed?: string
    ytd_billed?: string
  }
  invoiceByStatus?: Array<{ status: string; count: number; total_amount: string }>
  payments: {
    pending_approval_count: number
    ready_count: number
    payment_done_count: number
    pending_approval_amount?: string
    ready_amount?: string
    payment_done_amount?: string
  }
  debitNote?: { count: number; total_amount: string }
  recentPayments?: Array<{
    invoice_number: string
    supplier_name: string | null
    amount: string
    payment_done_at: string | null
  }>
  topSuppliers?: Array<{
    supplier_name: string
    invoice_count: number
    total_amount: string
  }>
  byMonth: Array<{
    month_label: string
    month_date: string
    invoice_count: number
    amount: string
    tax_amount: string
  }>
}

const formatCurrency = (val: string | number) => {
  const n = typeof val === 'string' ? parseFloat(val) : val
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const formatDate = (val: string | null) => {
  if (!val) return '—'
  return new Date(val).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

const statusLabel = (s: string) => {
  const labels: Record<string, string> = {
    pending: 'Pending',
    ready_for_payment: 'Ready for payment',
    debit_note_approval: 'Debit note approval',
    exception_approval: 'Exception approval',
    approved: 'Approved',
    rejected: 'Rejected',
    completed: 'Completed'
  }
  return labels[s] || s.replace(/_/g, ' ')
}

function FinanceDashboard() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchDashboard = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('reports/dashboard')
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to load dashboard')
        throw new Error(msg)
      }
      setData(await res.json())
      setLastUpdated(new Date())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load dashboard'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDashboard()
  }, [])

  const primary = '#0f766e'
  const primaryRgba = 'rgba(15, 118, 110, 0.9)'
  const taxColor = '#6b21a8'
  const taxRgba = 'rgba(107, 33, 168, 0.85)'
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' as const, labels: { font: { size: 12 }, usePointStyle: true } },
      tooltip: {
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        padding: 12,
        cornerRadius: 8,
        callbacks: {
          label: (ctx: { raw: unknown }) => typeof ctx.raw === 'number' ? formatCurrency(ctx.raw) : String(ctx.raw)
        }
      }
    },
    scales: {
      y: { beginAtZero: true, grid: { color: 'rgba(148, 163, 184, 0.12)' }, ticks: { font: { size: 11 } } },
      x: { grid: { display: false }, ticks: { font: { size: 11 } } }
    }
  }

  const last6Months = data?.byMonth?.slice(-6) ?? []
  const barData = last6Months.length
    ? {
        labels: last6Months.map((m) => m.month_label),
        datasets: [
          {
            label: 'Billed (₹)',
            data: last6Months.map((m) => parseFloat(m.amount)),
            backgroundColor: primaryRgba,
            borderRadius: 6,
            borderSkipped: false
          }
        ]
      }
    : null

  const lineData = last6Months.length
    ? {
        labels: last6Months.map((m) => m.month_label),
        datasets: [
          {
            label: 'Billed (₹)',
            data: last6Months.map((m) => parseFloat(m.amount)),
            borderColor: primaryRgba,
            backgroundColor: 'rgba(15, 118, 110, 0.08)',
            fill: true,
            tension: 0.35,
            borderWidth: 2
          },
          {
            label: 'Tax (₹)',
            data: last6Months.map((m) => parseFloat(m.tax_amount)),
            borderColor: taxRgba,
            backgroundColor: 'rgba(107, 33, 168, 0.08)',
            fill: true,
            tension: 0.35,
            borderWidth: 2
          }
        ]
      }
    : null

  if (loading) {
    return (
      <div className={styles.page}>
        <Header />
        <div className={styles.loadingWrap}>
          <ProgressSpinner />
          <p className={styles.loadingText}>Loading dashboard…</p>
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
            <span className={styles.breadcrumbItem}>Finance</span>
            <span className={styles.breadcrumbSep}>/</span>
            <span className={styles.breadcrumbCurrent}>Dashboard</span>
          </div>
          <div className={styles.headerRow}>
            <div>
              <h1 className={styles.title}>Finance Dashboard</h1>
              <p className={styles.subtitle}>
                Executive financial overview and payment pipeline. Key metrics at a glance.
                {lastUpdated && (
                  <span className={styles.meta}> · As of {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </p>
            </div>
            <Button label="Refresh" icon="pi pi-refresh" className={styles.refreshBtn} onClick={fetchDashboard} outlined />
          </div>
        </div>
        <PageNavigation />

        {data && (
          <>
            <section className={styles.summaryBlock} aria-label="Financial summary">
              <h2 className={styles.blockTitle}>Financial summary</h2>
              <p className={styles.blockSubtitle}>Billing and tax totals across all invoices</p>
              <div className={styles.kpiSection}>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.12)', color: primary }}>
                    <i className="pi pi-wallet" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Total billed</span>
                    <span className={styles.kpiValue}>{formatCurrency(data.financial?.total_billed ?? 0)}</span>
                  </div>
                </div>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(107, 33, 168, 0.1)', color: taxColor }}>
                    <i className="pi pi-percentage" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Total tax</span>
                    <span className={styles.kpiValue}>{formatCurrency(data.financial?.total_tax ?? 0)}</span>
                  </div>
                </div>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(30, 64, 175, 0.1)', color: '#1e40af' }}>
                    <i className="pi pi-file-edit" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Invoice count</span>
                    <span className={styles.kpiValue}>{Number(data.financial?.total_invoices ?? 0).toLocaleString('en-IN')}</span>
                  </div>
                </div>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(100, 116, 139, 0.12)', color: '#475569' }}>
                    <i className="pi pi-chart-line" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Avg. invoice</span>
                    <span className={styles.kpiValue}>{formatCurrency(data.financial?.avg_invoice_amount ?? 0)}</span>
                  </div>
                </div>
                {data.financial?.tax_pct != null && (
                  <div className={styles.kpiCard}>
                    <div className={styles.kpiIconWrap} style={{ background: 'rgba(107, 33, 168, 0.08)', color: taxColor }}>
                      <i className="pi pi-percentage" />
                    </div>
                    <div className={styles.kpiContent}>
                      <span className={styles.kpiLabel}>Tax % of billed</span>
                      <span className={styles.kpiValue}>{data.financial.tax_pct}%</span>
                    </div>
                  </div>
                )}
                {data.financial?.current_month_billed != null && parseFloat(data.financial.current_month_billed) > 0 && (
                  <div className={styles.kpiCard}>
                    <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.1)', color: primary }}>
                      <i className="pi pi-calendar" />
                    </div>
                    <div className={styles.kpiContent}>
                      <span className={styles.kpiLabel}>This month billed</span>
                      <span className={styles.kpiValue}>{formatCurrency(data.financial.current_month_billed)}</span>
                    </div>
                  </div>
                )}
                {data.financial?.ytd_billed != null && parseFloat(data.financial.ytd_billed) > 0 && (
                  <div className={styles.kpiCard}>
                    <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.1)', color: primary }}>
                      <i className="pi pi-calendar-plus" />
                    </div>
                    <div className={styles.kpiContent}>
                      <span className={styles.kpiLabel}>YTD billed</span>
                      <span className={styles.kpiValue}>{formatCurrency(data.financial.ytd_billed)}</span>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {data.invoiceByStatus && data.invoiceByStatus.length > 0 && (
              <section className="dts-section dts-section-accent" aria-label="Invoice status breakdown">
                <h2 className="dts-sectionTitle">Invoice status breakdown</h2>
                <p className="dts-sectionSubtitle">Count and value by invoice status</p>
                <div className="dts-tableWrapper">
                  <div className="dts-tableContainer">
                    <DataTable
                      value={data.invoiceByStatus}
                      size="small"
                      stripedRows
                      emptyMessage="No invoice data"
                    >
                      <Column
                        field="status"
                        header="Status"
                        body={(row) => statusLabel(row.status)}
                        style={{ minWidth: '160px' }}
                      />
                      <Column field="count" header="Count" style={{ minWidth: '80px' }} />
                      <Column
                        field="total_amount"
                        header="Amount (₹)"
                        body={(row) => formatCurrency(row.total_amount)}
                        style={{ minWidth: '140px' }}
                      />
                    </DataTable>
                  </div>
                </div>
              </section>
            )}

            <section className={styles.summaryBlock} aria-label="Payment pipeline">
              <h2 className={styles.blockTitle}>Payment pipeline</h2>
              <p className={styles.blockSubtitle}>Approval and disbursement status with amounts</p>
              <div className={`${styles.kpiSection} ${styles.kpiSectionThree}`}>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(234, 179, 8, 0.12)', color: '#ca8a04' }}>
                    <i className="pi pi-clock" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Awaiting approval</span>
                    <span className={styles.kpiValue}>{Number(data.payments?.pending_approval_count ?? 0).toLocaleString('en-IN')}</span>
                    {(data.payments?.pending_approval_amount != null && parseFloat(String(data.payments.pending_approval_amount)) > 0) && (
                      <span className={styles.kpiSub}>{formatCurrency(data.payments.pending_approval_amount)}</span>
                    )}
                  </div>
                </div>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(13, 148, 136, 0.12)', color: '#0d9488' }}>
                    <i className="pi pi-check-circle" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Ready for payment</span>
                    <span className={styles.kpiValue}>{Number(data.payments?.ready_count ?? 0).toLocaleString('en-IN')}</span>
                    {(data.payments?.ready_amount != null && parseFloat(String(data.payments.ready_amount)) > 0) && (
                      <span className={styles.kpiSub}>{formatCurrency(data.payments.ready_amount)}</span>
                    )}
                  </div>
                </div>
                <div className={styles.kpiCard}>
                  <div className={styles.kpiIconWrap} style={{ background: 'rgba(22, 163, 74, 0.12)', color: '#16a34a' }}>
                    <i className="pi pi-money-bill" />
                  </div>
                  <div className={styles.kpiContent}>
                    <span className={styles.kpiLabel}>Payment completed</span>
                    <span className={styles.kpiValue}>{Number(data.payments?.payment_done_count ?? 0).toLocaleString('en-IN')}</span>
                    {(data.payments?.payment_done_amount != null && parseFloat(String(data.payments.payment_done_amount)) > 0) && (
                      <span className={styles.kpiSub}>{formatCurrency(data.payments.payment_done_amount)}</span>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {data.debitNote && Number(data.debitNote.count) > 0 && (
              <section className={styles.summaryBlock} aria-label="Debit note summary">
                <h2 className={styles.blockTitle}>Debit note approval</h2>
                <p className={styles.blockSubtitle}>Invoices awaiting debit note approval (quantity mismatch)</p>
                <div className={styles.debitNoteRow}>
                  <span className={styles.debitNoteCount}>{data.debitNote.count} invoice(s)</span>
                  <span className={styles.debitNoteAmount}>{formatCurrency(data.debitNote.total_amount)}</span>
                </div>
                <Button
                  label="View debit note list"
                  icon="pi pi-list"
                  size="small"
                  outlined
                  onClick={() => navigate('/purchase-orders/incomplete')}
                  className={styles.debitNoteBtn}
                />
              </section>
            )}

            {(barData || lineData) && (
              <section className={styles.chartsRow}>
                {barData && (
                  <div className={styles.chartCard}>
                    <div className={styles.chartCardHead}>
                      <h3 className={styles.chartTitle}>Billing trend</h3>
                      <span className={styles.chartSubtitle}>Monthly billed amount (₹) — last 6 months</span>
                    </div>
                    <div className={styles.chartWrap}>
                      <Chart type="bar" data={barData} options={chartOptions} />
                    </div>
                  </div>
                )}
                {lineData && (
                  <div className={styles.chartCard}>
                    <div className={styles.chartCardHead}>
                      <h3 className={styles.chartTitle}>Billed vs tax</h3>
                      <span className={styles.chartSubtitle}>Monthly billed and tax (₹)</span>
                    </div>
                    <div className={styles.chartWrap}>
                      <Chart type="line" data={lineData} options={chartOptions} />
                    </div>
                  </div>
                )}
              </section>
            )}

            {data.byMonth && data.byMonth.length > 0 && (
              <section className="dts-section dts-section-accent" aria-label="Monthly summary">
                <h2 className="dts-sectionTitle">Monthly financial summary</h2>
                <p className="dts-sectionSubtitle">Invoices, billed amount, and tax by month (last 12 months)</p>
                <div className="dts-tableWrapper">
                  <div className="dts-tableContainer">
                    <DataTable
                      value={data.byMonth.slice(-12).reverse()}
                      size="small"
                      stripedRows
                      emptyMessage="No monthly data"
                    >
                      <Column field="month_label" header="Month" style={{ minWidth: '120px' }} />
                      <Column field="invoice_count" header="Invoices" style={{ minWidth: '90px' }} />
                      <Column field="amount" header="Billed (₹)" body={(row) => formatCurrency(row.amount)} style={{ minWidth: '130px' }} />
                      <Column field="tax_amount" header="Tax (₹)" body={(row) => formatCurrency(row.tax_amount)} style={{ minWidth: '130px' }} />
                    </DataTable>
                  </div>
                </div>
              </section>
            )}

            <div className={styles.twoCol}>
              {data.topSuppliers && data.topSuppliers.length > 0 && (
                <section className="dts-section dts-section-accent" aria-label="Top suppliers">
                  <h2 className="dts-sectionTitle">Top suppliers by billed amount</h2>
                  <p className="dts-sectionSubtitle">Top 10 by total invoice value</p>
                  <div className="dts-tableWrapper">
                    <div className="dts-tableContainer">
                      <DataTable
                        value={data.topSuppliers}
                        size="small"
                        stripedRows
                        emptyMessage="No supplier data"
                      >
                        <Column field="supplier_name" header="Supplier" style={{ minWidth: '180px' }} />
                        <Column field="invoice_count" header="Invoices" style={{ minWidth: '80px' }} />
                        <Column
                          field="total_amount"
                          header="Total (₹)"
                          body={(row) => formatCurrency(row.total_amount)}
                          style={{ minWidth: '120px' }}
                        />
                      </DataTable>
                    </div>
                  </div>
                </section>
              )}
              {data.recentPayments && data.recentPayments.length > 0 && (
                <section className="dts-section dts-section-accent" aria-label="Recent payments">
                  <h2 className="dts-sectionTitle">Recent payments</h2>
                  <p className="dts-sectionSubtitle">Last 10 completed payments</p>
                  <div className="dts-tableWrapper">
                    <div className="dts-tableContainer">
                      <DataTable
                        value={data.recentPayments}
                        size="small"
                        stripedRows
                        emptyMessage="No recent payments"
                      >
                        <Column field="invoice_number" header="Invoice" style={{ minWidth: '120px' }} />
                        <Column field="supplier_name" header="Supplier" body={(row) => row.supplier_name || '—'} style={{ minWidth: '140px' }} />
                        <Column field="amount" header="Amount (₹)" body={(row) => formatCurrency(row.amount)} style={{ minWidth: '110px' }} />
                        <Column field="payment_done_at" header="Paid on" body={(row) => formatDate(row.payment_done_at)} style={{ minWidth: '110px' }} />
                      </DataTable>
                    </div>
                  </div>
                  <Button
                    label="View full payment history"
                    icon="pi pi-history"
                    size="small"
                    outlined
                    onClick={() => navigate('/payments/history')}
                    className={styles.historyBtn}
                  />
                </section>
              )}
            </div>

            <section className={styles.actionsSection}>
              <h2 className={styles.blockTitle}>Finance actions</h2>
              <p className={styles.blockSubtitle}>Payment workflow and detailed financial reports</p>
              <div className={styles.quickLinksGrid}>
                <Button
                  label="Approve payments"
                  icon="pi pi-check-square"
                  className={styles.quickLink}
                  onClick={() => navigate('/payments/approve')}
                />
                <Button
                  label="Ready for payment"
                  icon="pi pi-money-bill"
                  className={styles.quickLink}
                  onClick={() => navigate('/payments/ready')}
                />
                <Button
                  label="Payment history"
                  icon="pi pi-history"
                  className={styles.quickLink}
                  onClick={() => navigate('/payments/history')}
                />
                <Button
                  label="Financial reports"
                  icon="pi pi-chart-bar"
                  className={styles.quickLink}
                  onClick={() => navigate('/reports/financial')}
                />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default FinanceDashboard
