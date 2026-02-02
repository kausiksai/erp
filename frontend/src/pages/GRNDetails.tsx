import { useState, useEffect, useRef, useCallback } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { InputText } from 'primereact/inputtext'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Tag } from 'primereact/tag'
import { apiUrl, getErrorMessageFromResponse } from '../utils/api'
import { useDebounce } from '../hooks/useDebounce'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import Breadcrumb from '../components/Breadcrumb'
import styles from './GRNDetails.module.css'

interface GRNRecord {
  id: number
  po_id: number | null
  po_number: string | null
  supplier_id: number | null
  supplier_name: string | null
  grn_no: string | null
  grn_date: string | null
  grn_line: number | null
  po_no: string | null
  dc_no: string | null
  dc_date: string | null
  unit: string | null
  item: string | null
  description_1: string | null
  uom: string | null
  grn_qty: number | null
  accepted_qty: number | null
  unit_cost: number | null
  header_status: string | null
  line_status: string | null
  gate_entry_no: string | null
  supplier_doc_no: string | null
  supplier_doc_date: string | null
  supplier: string | null
  exchange_rate: number | null
  grn_year: number | null
  grn_period: number | null
  po_pfx: string | null
  po_line: number | null
}

function GRNDetails() {
  const toast = useRef<Toast>(null)
  const [records, setRecords] = useState<GRNRecord[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [searchTerm, setSearchTerm] = useState('')
  const debouncedSearch = useDebounce(searchTerm, 300)
  const [expandedRows, setExpandedRows] = useState<{ [key: string]: boolean }>({})
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const searchLower = debouncedSearch.trim().toLowerCase()
  const filteredRecords = searchLower
    ? records.filter((r) => {
        const grnNo = (r.grn_no ?? '').toLowerCase()
        const poNumber = (r.po_number ?? r.po_no ?? '').toLowerCase()
        const supplier = (r.supplier_name ?? r.supplier ?? '').toLowerCase()
        const dcNo = (r.dc_no ?? '').toLowerCase()
        const item = (r.item ?? '').toLowerCase()
        const desc = (r.description_1 ?? '').toLowerCase()
        const status = (r.header_status ?? r.line_status ?? '').toLowerCase()
        return grnNo.includes(searchLower) || poNumber.includes(searchLower) || supplier.includes(searchLower) || dcNo.includes(searchLower) || item.includes(searchLower) || desc.includes(searchLower) || status.includes(searchLower)
      })
    : records

  const fetchGRN = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl('grn'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        const msg = await getErrorMessageFromResponse(response, 'Failed to load GRN')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        return
      }
      const data = await response.json()
      setRecords(data)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load GRN'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchGRN()
  }, [])

  const handleExcelUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      toast.current?.show({ severity: 'warn', summary: 'Invalid file', detail: 'Please select an Excel file (.xlsx or .xls)', life: 5000 })
      return
    }
    setUploadingExcel(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const token = localStorage.getItem('authToken')
      const res = await fetch(apiUrl('grn/upload-excel'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Upload failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Import done', detail: data.message, life: 5000 })
      await fetchGRN()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      toast.current?.show({ severity: 'error', summary: 'Import failed', detail: msg, life: 5000 })
    } finally {
      setUploadingExcel(false)
    }
  }, [])

  const openExcelUpload = () => fileInputRef.current?.click()

  const dateBodyTemplate = (rowData: GRNRecord) => {
    if (!rowData.grn_date) return '-'
    return new Date(rowData.grn_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const dcDateBodyTemplate = (rowData: GRNRecord) => {
    if (!rowData.dc_date) return '-'
    return new Date(rowData.dc_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const statusBodyTemplate = (rowData: GRNRecord) => {
    const status = rowData.header_status || rowData.line_status || 'pending'
    const severity = status === 'received' || status === 'completed' ? 'success' : status === 'cancelled' ? 'danger' : 'info'
    return <Tag value={String(status).toUpperCase()} severity={severity} />
  }

  const formatDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '-')
  const formatAmount = (n: number | null) => (n != null ? Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-')

  const rowExpansionTemplate = (rowData: GRNRecord) => (
    <div className={styles.expansionContent}>
      <div className={styles.expansionCards}>
        <div className={styles.expansionCard}>
          <h4 className={styles.expansionCardTitle}>Document & reference</h4>
          <div className={styles.expansionCardGrid}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>PO Number</span>
              <span className={styles.detailValue}>{rowData.po_number ?? rowData.po_no ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>PO PFX</span>
              <span className={styles.detailValue}>{rowData.po_pfx ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>PO Line</span>
              <span className={styles.detailValue}>{rowData.po_line != null ? rowData.po_line : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>GRN Line</span>
              <span className={styles.detailValue}>{rowData.grn_line != null ? rowData.grn_line : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>DC No</span>
              <span className={styles.detailValue}>{rowData.dc_no ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>DC Date</span>
              <span className={styles.detailValue}>{formatDate(rowData.dc_date)}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Gate Entry No</span>
              <span className={styles.detailValue}>{rowData.gate_entry_no ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Supplier Doc No</span>
              <span className={styles.detailValue}>{rowData.supplier_doc_no ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Supplier Doc Date</span>
              <span className={styles.detailValue}>{formatDate(rowData.supplier_doc_date)}</span>
            </div>
          </div>
        </div>
        <div className={styles.expansionCard}>
          <h4 className={styles.expansionCardTitle}>Period & rates</h4>
          <div className={styles.expansionCardGrid}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>GRN Year</span>
              <span className={styles.detailValue}>{rowData.grn_year != null ? rowData.grn_year : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>GRN Period</span>
              <span className={styles.detailValue}>{rowData.grn_period != null ? rowData.grn_period : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Exchange Rate</span>
              <span className={styles.detailValue}>{formatAmount(rowData.exchange_rate)}</span>
            </div>
          </div>
        </div>
        <div className={styles.expansionCard}>
          <h4 className={styles.expansionCardTitle}>Supplier & item</h4>
          <div className={styles.expansionCardGrid}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Supplier</span>
              <span className={styles.detailValue}>{rowData.supplier ?? rowData.supplier_name ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Unit</span>
              <span className={styles.detailValue}>{rowData.unit ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Item</span>
              <span className={styles.detailValue}>{rowData.item ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Description</span>
              <span className={styles.detailValue}>{rowData.description_1 ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>UOM</span>
              <span className={styles.detailValue}>{rowData.uom ?? '-'}</span>
            </div>
          </div>
        </div>
        <div className={styles.expansionCard}>
          <h4 className={styles.expansionCardTitle}>Quantities & cost</h4>
          <div className={styles.expansionCardGrid}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>GRN Qty</span>
              <span className={styles.detailValue}>{rowData.grn_qty != null ? rowData.grn_qty : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Accepted Qty</span>
              <span className={styles.detailValue}>{rowData.accepted_qty != null ? rowData.accepted_qty : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Unit Cost</span>
              <span className={styles.detailValue}>{rowData.unit_cost != null ? `₹${formatAmount(Number(rowData.unit_cost))}` : '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Header Status</span>
              <span className={styles.detailValue}>{rowData.header_status ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Line Status</span>
              <span className={styles.detailValue}>{rowData.line_status ?? '-'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} />
      <div className={styles.pageContainer} id="main-content">
        <Breadcrumb items={[{ label: 'Home', path: '/' }, { label: 'GRN' }]} />
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>GRN Details</h1>
              <p className={styles.pageSubtitle}>View all Goods Receipt Notes (loaded from Excel import)</p>
            </div>
            <div className={styles.headerActions}>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} style={{ display: 'none' }} />
              <Button label="Upload Excel" icon="pi pi-upload" className={styles.uploadExcelButton} onClick={openExcelUpload} loading={uploadingExcel} disabled={uploadingExcel} />
              <Button label="Refresh" icon="pi pi-refresh" className={styles.refreshButton} onClick={() => fetchGRN()} />
              <PageNavigation />
            </div>
          </div>
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">GRN records</h2>
          <p className="dts-sectionSubtitle">View all Goods Receipt Notes (loaded from Excel import). Expand a row for more details.</p>
          {!loading && (
            <div className={styles.toolbar}>
              <span className="p-input-icon-left">
                <i className="pi pi-search" />
                <InputText
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by GRN no, PO number, supplier, DC no, item, status..."
                  className={styles.searchInput}
                />
              </span>
            </div>
          )}
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading GRN...</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={filteredRecords}
                  paginator
                  rows={10}
                  rowsPerPageOptions={[10, 25, 50]}
                  emptyMessage={searchTerm ? 'No matching GRN records' : 'No GRN records found'}
                  stripedRows
                  expandedRows={expandedRows}
                  onRowToggle={(e) => setExpandedRows(e.data)}
                  rowExpansionTemplate={rowExpansionTemplate}
                  dataKey="id"
                >
                  <Column expander style={{ width: '3rem' }} />
                  <Column field="grn_no" header="GRN No" sortable style={{ minWidth: '140px' }} body={(r) => <strong>{r.grn_no ?? '-'}</strong>} />
                  <Column field="po_number" header="PO Number" sortable style={{ minWidth: '130px' }} body={(r) => r.po_number ?? r.po_no ?? '-'} />
                  <Column field="supplier_name" header="Supplier" sortable style={{ minWidth: '200px' }} body={(r) => r.supplier_name ?? r.supplier ?? '-'} />
                  <Column field="grn_date" header="GRN Date" sortable body={dateBodyTemplate} style={{ minWidth: '120px' }} />
                  <Column field="dc_no" header="DC No" sortable style={{ minWidth: '120px' }} body={(r) => r.dc_no ?? '-'} />
                  <Column field="dc_date" header="DC Date" body={dcDateBodyTemplate} style={{ minWidth: '120px' }} />
                  <Column field="item" header="Item" style={{ minWidth: '100px' }} body={(r) => r.item ?? '-'} />
                  <Column field="grn_qty" header="Qty" style={{ minWidth: '80px' }} body={(r) => r.grn_qty != null ? r.grn_qty : '-'} />
                  <Column field="header_status" header="Status" body={statusBodyTemplate} style={{ minWidth: '120px' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default GRNDetails
