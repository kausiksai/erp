import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { InputText } from 'primereact/inputtext'
import { MultiSelect } from 'primereact/multiselect'
import { Button } from 'primereact/button'
import { Tag } from 'primereact/tag'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { apiUrl, getErrorMessageFromResponse } from '../utils/api'
import styles from './InvoiceValidate.module.css'

interface Invoice {
  invoice_id: number
  invoice_number: string
  invoice_date: string
  scanning_number: string | null
  total_amount: number
  tax_amount: number
  status: string
  supplier_name: string | null
  po_id: number | null
  po_number: string | null
  po_date: string | null
  created_at: string
}

const statusOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Ready for payment', value: 'ready_for_payment' },
  { label: 'Debit note approval', value: 'debit_note_approval' },
  { label: 'Exception approval', value: 'exception_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Completed', value: 'completed' }
]

function InvoiceValidate() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [searchInvoiceNumber, setSearchInvoiceNumber] = useState<string>('')
  const [searchPONumber, setSearchPONumber] = useState<string>('')
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([])
  const [globalFilter, setGlobalFilter] = useState<string>('')

  useEffect(() => {
    fetchInvoices()
  }, [selectedStatuses])

  const fetchInvoices = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedStatuses.length > 0) params.append('status', selectedStatuses.join(','))
      if (searchInvoiceNumber) params.append('invoiceNumber', searchInvoiceNumber)
      if (searchPONumber) params.append('poNumber', searchPONumber)

      const url = apiUrl('invoices') + (params.toString() ? `?${params.toString()}` : '')
      const token = localStorage.getItem('authToken')
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      if (!response.ok) {
        const msg = await getErrorMessageFromResponse(response, 'Failed to load invoices')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        setInvoices([])
        return
      }

      const data = await response.json()
      setInvoices(data)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load invoices'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
      setInvoices([])
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    fetchInvoices()
  }

  const handleClearSearch = () => {
    setSearchInvoiceNumber('')
    setSearchPONumber('')
    setSelectedStatuses([])
    setGlobalFilter('')
    fetchInvoices()
  }

  const handleInvoiceClick = (invoiceId: number) => {
    navigate(`/invoices/validate/${invoiceId}`)
  }

  const handlePOClick = (invoice: Invoice, e: React.MouseEvent) => {
    e.stopPropagation()
    // Navigate to invoice details page which shows both invoice and PO details
    navigate(`/invoices/validate/${invoice.invoice_id}`)
  }

  const dateBodyTemplate = (rowData: Invoice) => {
    if (!rowData.invoice_date) return '-'
    const date = new Date(rowData.invoice_date)
    return date.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const statusLabel = (status: string) => {
    const s = (status || '').toLowerCase().replace(/\s+/g, '_')
    if (s === 'pending' || s === 'open') return 'Open'
    if (s === 'debit_note_approval') return 'Debit note'
    if (s === 'exception_approval') return 'Exception'
    if (s === 'ready_for_payment') return 'Ready for payment'
    if (s === 'approved') return 'Approved'
    if (s === 'rejected') return 'Rejected'
    if (s === 'completed') return 'Completed'
    return (status || 'Open').toUpperCase()
  }

  const statusBodyTemplate = (rowData: Invoice) => {
    const status = rowData.status || 'pending'
    const severity = status === 'completed' ? 'success' :
                     status === 'approved' ? 'info' :
                     status === 'rejected' ? 'danger' :
                     /debit_note|exception|ready_for_payment/i.test(status) ? 'warning' : 'warning'
    return <Tag value={statusLabel(status)} severity={severity} />
  }

  const amountBodyTemplate = (rowData: Invoice) => {
    return rowData.total_amount 
      ? `₹${rowData.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '-'
  }

  const invoiceNumberBodyTemplate = (rowData: Invoice) => {
    return (
      <span 
        className={styles.clickableLink}
        onClick={() => handleInvoiceClick(rowData.invoice_id)}
      >
        {rowData.invoice_number}
      </span>
    )
  }

  const poNumberBodyTemplate = (rowData: Invoice) => {
    if (!rowData.po_number) return '-'
    return (
      <span 
        className={styles.clickableLink}
        onClick={(e) => handlePOClick(rowData, e)}
      >
        {rowData.po_number}
      </span>
    )
  }

  return (
    <div className={styles.invoiceValidatePage}>
      <Header />
      <Toast ref={toast} />
      
      <div className={styles.pageContainer}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Invoice Validate</h1>
              <p className={styles.pageSubtitle}>View and validate all invoice records</p>
            </div>
            <PageNavigation />
          </div>
        </div>

        <div className={styles.searchSection}>
          <div className={styles.searchRow}>
            <div className={styles.searchField}>
              <label className={styles.searchLabel}>Invoice Number</label>
              <InputText
                value={searchInvoiceNumber}
                onChange={(e) => setSearchInvoiceNumber(e.target.value)}
                placeholder="Search by invoice number"
                className={styles.searchInput}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className={styles.searchField}>
              <label className={styles.searchLabel}>PO Number</label>
              <InputText
                value={searchPONumber}
                onChange={(e) => setSearchPONumber(e.target.value)}
                placeholder="Search by PO number"
                className={styles.searchInput}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className={styles.searchField}>
              <label className={styles.searchLabel}>Status</label>
              <MultiSelect
                value={selectedStatuses}
                options={statusOptions}
                onChange={(e) => setSelectedStatuses(e.value ?? [])}
                placeholder="All statuses"
                className={styles.searchDropdown}
                display="chip"
                maxSelectedLabels={2}
              />
            </div>
            <div className={styles.searchActions}>
              <Button
                label="Search"
                icon="pi pi-search"
                onClick={handleSearch}
                className={styles.searchButton}
              />
              <Button
                label="Clear"
                icon="pi pi-times"
                onClick={handleClearSearch}
                className={styles.clearButton}
                outlined
              />
            </div>
          </div>
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">Invoices</h2>
          <p className="dts-sectionSubtitle">Select an invoice to validate and match with PO / GRN.</p>
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading invoices...</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={invoices}
                  paginator
                  rows={10}
                  rowsPerPageOptions={[10, 25, 50, 100]}
                  emptyMessage="No invoices found"
                  stripedRows
                  globalFilter={globalFilter}
                  onRowClick={(e) => handleInvoiceClick(e.data.invoice_id)}
                  rowHover
                  header={
                    <div className={styles.tableHeader}>
                      <span className={styles.tableTitle}>Invoices ({invoices.length})</span>
                      <InputText
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder="Global search..."
                        className={styles.globalSearch}
                      />
                    </div>
                  }
                >
                  <Column field="invoice_number" header="Invoice Number" sortable body={invoiceNumberBodyTemplate} />
                  <Column field="po_number" header="PO Number" sortable body={poNumberBodyTemplate} />
                  <Column field="invoice_date" header="Invoice Date" sortable body={dateBodyTemplate} />
                  <Column field="supplier_name" header="Supplier" sortable />
                  <Column field="total_amount" header="Total Amount" sortable body={amountBodyTemplate} />
                  <Column field="status" header="Status" sortable body={statusBodyTemplate} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default InvoiceValidate
