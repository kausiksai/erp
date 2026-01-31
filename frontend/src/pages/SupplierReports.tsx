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
import styles from './SupplierReports.module.css'

/** Supplier Report only: supplier counts, POs, activity. No total invoiced – see Financial Report. */
interface SupplierSummary {
  total_suppliers: number
  total_pos: number
  active_suppliers: number
  suppliers_with_no_invoices: number
}

interface SupplierRow {
  supplier_id: number
  supplier_name: string
  city: string | null
  gst_number: string | null
  po_count: number
  invoice_count: number
  total_invoice_amount: string
}

interface SupplierReportData {
  summary: SupplierSummary
  suppliers: SupplierRow[]
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
  legend: { display: false },
  ticks: { font: { size: 11 }, color: '#64748b' }
}

function SupplierReports() {
  const toast = useRef<Toast>(null)
  const [data, setData] = useState<SupplierReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchReport = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('reports/suppliers-summary')
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to load supplier report')
        throw new Error(msg)
      }
      const json = await res.json()
      setData(json)
      setLastUpdated(new Date())
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load supplier report'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchReport() }, [])

  const topSuppliers = data?.suppliers?.slice(0, 10) ?? []
  const accent = '#c2410c'
  const secondary = '#6b21a8'
  const secondaryRgba = 'rgba(107, 33, 168, 0.85)'
  const barGradients = topSuppliers.map((_, i) => `hsl(${24 - i * 2}, 85%, 45%)`)

  const amountBarData = topSuppliers.length
    ? {
        labels: topSuppliers.map((s) => (s.supplier_name?.length > 18 ? s.supplier_name.slice(0, 18) + '…' : s.supplier_name)),
        datasets: [{
          label: 'Invoice value (₹)',
          data: topSuppliers.map((s) => parseFloat(s.total_invoice_amount)),
          backgroundColor: barGradients,
          borderRadius: 6,
          borderSkipped: false
        }]
      }
    : null

  const poBarData = topSuppliers.length
    ? {
        labels: topSuppliers.map((s) => (s.supplier_name?.length > 18 ? s.supplier_name.slice(0, 18) + '…' : s.supplier_name)),
        datasets: [{
          label: 'PO count',
          data: topSuppliers.map((s) => s.po_count),
          backgroundColor: secondaryRgba,
          borderRadius: 6,
          borderSkipped: false
        }]
      }
    : null

  const invoiceCountBarData = topSuppliers.length
    ? {
        labels: topSuppliers.map((s) => (s.supplier_name?.length > 18 ? s.supplier_name.slice(0, 18) + '…' : s.supplier_name)),
        datasets: [{
          label: 'Invoice count',
          data: topSuppliers.map((s) => s.invoice_count),
          backgroundColor: 'rgba(15, 118, 110, 0.85)',
          borderRadius: 6,
          borderSkipped: false
        }]
      }
    : null

  const horizontalBarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y' as const,
    plugins: { legend: chartDefaults.legend, tooltip: chartDefaults.tooltip },
    scales: {
      x: { grid: { color: chartDefaults.gridColor }, ticks: chartDefaults.ticks, beginAtZero: true },
      y: { grid: { display: false }, ticks: { ...chartDefaults.ticks, font: { size: 11 } } }
    }
  }

  const amountBody = (row: SupplierRow) => (
    <span className={styles.amountCell}>{formatCurrency(row.total_invoice_amount)}</span>
  )

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
            <span className={styles.breadcrumbCurrent}>Supplier Report</span>
          </div>
          <div className={styles.headerRow}>
            <div>
              <h1 className={styles.title}>Supplier Report</h1>
              <p className={styles.subtitle}>
                Supplier activity and engagement only. For total billed amount see Financial Report.
                {lastUpdated && (
                  <span className={styles.meta}> · Last updated {lastUpdated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </p>
            </div>
            <Button label="Refresh data" icon="pi pi-refresh" className={styles.refreshBtn} onClick={fetchReport} loading={loading} outlined />
          </div>
        </div>
        <PageNavigation />

        {data && (
          <>
            <section className={styles.kpiSection} aria-label="Key metrics">
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(194, 65, 12, 0.1)', color: accent }}>
                  <i className="pi pi-users" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Total Suppliers</span>
                  <span className={styles.kpiValue}>{Number(data.summary?.total_suppliers ?? 0).toLocaleString('en-IN')}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(107, 33, 168, 0.1)', color: secondary }}>
                  <i className="pi pi-shopping-cart" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Total POs</span>
                  <span className={styles.kpiValue}>{Number(data.summary?.total_pos ?? 0).toLocaleString('en-IN')}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(15, 118, 110, 0.1)', color: '#0f766e' }}>
                  <i className="pi pi-check-circle" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>Active Suppliers</span>
                  <span className={styles.kpiValue}>{Number(data.summary?.active_suppliers ?? 0).toLocaleString('en-IN')}</span>
                </div>
              </div>
              <div className={styles.kpiCard}>
                <div className={styles.kpiIconWrap} style={{ background: 'rgba(100, 116, 139, 0.15)', color: '#475569' }}>
                  <i className="pi pi-minus-circle" />
                </div>
                <div className={styles.kpiContent}>
                  <span className={styles.kpiLabel}>With no invoices</span>
                  <span className={styles.kpiValue}>{Number(data.summary?.suppliers_with_no_invoices ?? 0).toLocaleString('en-IN')}</span>
                </div>
              </div>
            </section>

            <div className={styles.chartGrid}>
              <div className={styles.chartCard}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>Top 10 suppliers by invoice value</h3>
                  <span className={styles.chartSubtitle}>Billed amount per supplier (see Financial Report for grand total)</span>
                </div>
                <div className={styles.chartWrap}>
                  {amountBarData ? (
                    <Chart type="bar" data={amountBarData} options={horizontalBarOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-chart-bar" />
                      <p>No supplier data yet</p>
                      <span>Add suppliers and link invoices to see analytics</span>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.chartCard}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>PO count by supplier (top 10)</h3>
                  <span className={styles.chartSubtitle}>Purchase orders per supplier</span>
                </div>
                <div className={styles.chartWrap}>
                  {poBarData ? (
                    <Chart type="bar" data={poBarData} options={horizontalBarOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-list" />
                      <p>No PO data yet</p>
                      <span>POs linked to suppliers will appear here</span>
                    </div>
                  )}
                </div>
              </div>
              <div className={styles.chartCard}>
                <div className={styles.chartCardHead}>
                  <h3 className={styles.chartTitle}>Invoice count by supplier (top 10)</h3>
                  <span className={styles.chartSubtitle}>Number of invoices per supplier</span>
                </div>
                <div className={styles.chartWrap}>
                  {invoiceCountBarData ? (
                    <Chart type="bar" data={invoiceCountBarData} options={horizontalBarOptions} />
                  ) : (
                    <div className={styles.emptyState}>
                      <i className="pi pi-file" />
                      <p>No invoice count data yet</p>
                      <span>Link invoices to suppliers to see counts</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <section className={styles.tableSection}>
              <div className={styles.tableHead}>
                <h3 className={styles.sectionTitle}>All suppliers – detail</h3>
                <span className={styles.tableSubtitle}>PO count, invoice count, and total invoiced per supplier (amounts here are per-supplier only; grand total is in Financial Report)</span>
              </div>
              <div className={styles.tableWrap}>
                <DataTable
                  value={data.suppliers ?? []}
                  paginator
                  rows={10}
                  rowsPerPageOptions={[5, 10, 25, 50]}
                  size="small"
                  stripedRows
                  emptyMessage="No suppliers found."
                  className={styles.dataTable}
                  paginatorTemplate="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink CurrentPageReport RowsPerPageDropdown"
                  currentPageReportTemplate="Showing {first} to {last} of {totalRecords} suppliers"
                >
                  <Column field="supplier_name" header="Supplier" sortable />
                  <Column field="city" header="City" />
                  <Column field="gst_number" header="GST No." />
                  <Column field="po_count" header="POs" sortable />
                  <Column field="invoice_count" header="Invoices" sortable />
                  <Column field="total_invoice_amount" header="Total invoiced (₹)" body={amountBody} sortable sortField="total_invoice_amount" />
                </DataTable>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default SupplierReports
