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
import styles from './ASNDetails.module.css'

interface ASNRecord {
  id: number
  po_id: number | null
  po_number: string | null
  supplier_id: number | null
  supplier_name: string | null
  asn_no: string | null
  supplier: string | null
  dc_no: string | null
  dc_date: string | null
  inv_no: string | null
  inv_date: string | null
  lr_no: string | null
  lr_date: string | null
  unit: string | null
  transporter: string | null
  transporter_name: string | null
  doc_no_date: string | null
  status: string | null
}

function ASNDetails() {
  const toast = useRef<Toast>(null)
  const [records, setRecords] = useState<ASNRecord[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [searchTerm, setSearchTerm] = useState('')
  const debouncedSearch = useDebounce(searchTerm, 300)
  const [expandedRows, setExpandedRows] = useState<{ [key: string]: boolean }>({})
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const searchLower = debouncedSearch.trim().toLowerCase()
  const filteredRecords = searchLower
    ? records.filter((r) => {
        const asnNo = (r.asn_no ?? '').toLowerCase()
        const poNumber = (r.po_number ?? '').toLowerCase()
        const supplier = (r.supplier_name ?? r.supplier ?? '').toLowerCase()
        const dcNo = (r.dc_no ?? '').toLowerCase()
        const lrNo = (r.lr_no ?? '').toLowerCase()
        const transporter = (r.transporter ?? r.transporter_name ?? '').toLowerCase()
        const status = (r.status ?? '').toLowerCase()
        return asnNo.includes(searchLower) || poNumber.includes(searchLower) || supplier.includes(searchLower) || dcNo.includes(searchLower) || lrNo.includes(searchLower) || transporter.includes(searchLower) || status.includes(searchLower)
      })
    : records

  const fetchASN = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl('asn'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        const msg = await getErrorMessageFromResponse(response, 'Failed to load ASN')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        return
      }
      const data = await response.json()
      setRecords(data)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load ASN'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchASN()
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
      const res = await fetch(apiUrl('asn/upload-excel'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Upload failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Import done', detail: data.message, life: 5000 })
      await fetchASN()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      toast.current?.show({ severity: 'error', summary: 'Import failed', detail: msg, life: 5000 })
    } finally {
      setUploadingExcel(false)
    }
  }, [])

  const openExcelUpload = () => fileInputRef.current?.click()

  const dateBodyTemplate = (rowData: ASNRecord) => {
    if (!rowData.dc_date) return '-'
    return new Date(rowData.dc_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const lrDateBodyTemplate = (rowData: ASNRecord) => {
    if (!rowData.lr_date) return '-'
    return new Date(rowData.lr_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const statusBodyTemplate = (rowData: ASNRecord) => {
    const status = rowData.status || 'pending'
    const severity = status === 'received' || status === 'completed' ? 'success' : status === 'cancelled' ? 'danger' : 'info'
    return <Tag value={String(status).toUpperCase()} severity={severity} />
  }

  const formatDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '-')

  const rowExpansionTemplate = (rowData: ASNRecord) => (
    <div className={styles.expansionContent}>
      <div className={styles.expansionCards}>
        <div className={styles.expansionCard}>
          <h4 className={styles.expansionCardTitle}>Document & reference</h4>
          <div className={styles.expansionCardGrid}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>PO Number</span>
              <span className={styles.detailValue}>{rowData.po_number ?? '-'}</span>
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
              <span className={styles.detailLabel}>Invoice No</span>
              <span className={styles.detailValue}>{rowData.inv_no ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Invoice Date</span>
              <span className={styles.detailValue}>{formatDate(rowData.inv_date)}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>LR No</span>
              <span className={styles.detailValue}>{rowData.lr_no ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>LR Date</span>
              <span className={styles.detailValue}>{formatDate(rowData.lr_date)}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Doc No / Date</span>
              <span className={styles.detailValue}>{rowData.doc_no_date ?? '-'}</span>
            </div>
          </div>
        </div>
        <div className={styles.expansionCard}>
          <h4 className={styles.expansionCardTitle}>Supplier & logistics</h4>
          <div className={styles.expansionCardGrid}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Supplier</span>
              <span className={styles.detailValue}>{rowData.supplier_name ?? rowData.supplier ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Unit</span>
              <span className={styles.detailValue}>{rowData.unit ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Transporter</span>
              <span className={styles.detailValue}>{rowData.transporter ?? rowData.transporter_name ?? '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Status</span>
              <span className={styles.detailValue}>{rowData.status ?? '-'}</span>
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
        <Breadcrumb items={[{ label: 'Home', path: '/' }, { label: 'ASN' }]} />
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>ASN Details</h1>
              <p className={styles.pageSubtitle}>View all Advanced Shipping Notices (loaded from Excel import)</p>
            </div>
            <div className={styles.headerActions}>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} style={{ display: 'none' }} />
              <Button label="Upload Excel" icon="pi pi-upload" className={styles.uploadExcelButton} onClick={openExcelUpload} loading={uploadingExcel} disabled={uploadingExcel} />
              <PageNavigation onRefresh={() => fetchASN()} refreshLoading={loading} />
            </div>
          </div>
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">ASN records</h2>
          <p className="dts-sectionSubtitle">View all Advanced Shipping Notices (loaded from Excel import). Expand a row for more details.</p>
          {!loading && (
            <div className={styles.toolbar}>
              <span className="p-input-icon-left">
                <i className="pi pi-search" />
                <InputText
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by ASN no, PO number, supplier, DC no, LR no, transporter, status..."
                  className={styles.searchInput}
                />
              </span>
            </div>
          )}
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading ASN...</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={filteredRecords}
                  paginator
                  rows={10}
                  rowsPerPageOptions={[10, 25, 50]}
                  emptyMessage={searchTerm ? 'No matching ASN records' : 'No ASN records found'}
                  stripedRows
                  expandedRows={expandedRows}
                  onRowToggle={(e) => setExpandedRows(e.data)}
                  rowExpansionTemplate={rowExpansionTemplate}
                  dataKey="id"
                >
                  <Column expander style={{ width: '3rem' }} />
                  <Column field="asn_no" header="ASN No" sortable style={{ minWidth: '140px' }} body={(r) => <strong>{r.asn_no ?? '-'}</strong>} />
                  <Column field="po_number" header="PO Number" sortable style={{ minWidth: '130px' }} body={(r) => r.po_number ?? '-'} />
                  <Column field="supplier_name" header="Supplier" sortable style={{ minWidth: '200px' }} body={(r) => r.supplier_name ?? r.supplier ?? '-'} />
                  <Column field="dc_no" header="DC No" sortable style={{ minWidth: '120px' }} body={(r) => r.dc_no ?? '-'} />
                  <Column field="dc_date" header="DC Date" sortable body={dateBodyTemplate} style={{ minWidth: '120px' }} />
                  <Column field="lr_no" header="LR No" style={{ minWidth: '120px' }} body={(r) => r.lr_no ?? '-'} />
                  <Column field="lr_date" header="LR Date" body={lrDateBodyTemplate} style={{ minWidth: '120px' }} />
                  <Column field="transporter" header="Transporter" style={{ minWidth: '140px' }} body={(r) => r.transporter ?? r.transporter_name ?? '-'} />
                  <Column field="status" header="Status" body={statusBodyTemplate} style={{ minWidth: '120px' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ASNDetails
