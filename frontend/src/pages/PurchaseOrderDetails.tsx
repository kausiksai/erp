import { useState, useEffect, useRef, useCallback } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { InputText } from 'primereact/inputtext'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Tag } from 'primereact/tag'
import { Divider } from 'primereact/divider'
import { apiUrl, getErrorMessageFromResponse } from '../utils/api'
import { useDebounce } from '../hooks/useDebounce'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import Breadcrumb from '../components/Breadcrumb'
import styles from './PurchaseOrderDetails.module.css'

interface PurchaseOrderLineItem {
  po_line_id: number
  po_id: number
  sequence_number: number
  item_id: string | null
  description1: string | null
  qty: number | null
  unit_cost: number | null
  disc_pct: number | null
  raw_material: string | null
  process_description: string | null
  norms: string | null
  process_cost: number | null
}

interface PurchaseOrder {
  po_id: number
  po_number: string
  po_date: string
  unit: string | null
  ref_unit: string | null
  pfx: string | null
  amd_no: number | null
  suplr_id: string | null
  supplier_id: number | null
  supplier_name: string | null
  terms: string | null
  status: string
  line_item_count: number
  lineItems?: PurchaseOrderLineItem[]
}

function PurchaseOrderDetails() {
  const toast = useRef<Toast>(null)
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [searchTerm, setSearchTerm] = useState('')
  const debouncedSearch = useDebounce(searchTerm, 300)
  const [expandedRows, setExpandedRows] = useState<{ [key: string]: boolean }>({})
  const [loadingLineItems, setLoadingLineItems] = useState<Set<number>>(new Set())
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const searchLower = debouncedSearch.trim().toLowerCase()
  const filteredPOs = searchLower
    ? purchaseOrders.filter((po) => {
        const poNumber = (po.po_number ?? '').toLowerCase()
        const supplier = (po.supplier_name ?? '').toLowerCase()
        const unit = (po.unit ?? '').toLowerCase()
        const pfx = (po.pfx ?? '').toLowerCase()
        const terms = (po.terms ?? '').toLowerCase()
        const status = (po.status ?? '').toLowerCase()
        return poNumber.includes(searchLower) || supplier.includes(searchLower) || unit.includes(searchLower) || pfx.includes(searchLower) || terms.includes(searchLower) || status.includes(searchLower)
      })
    : purchaseOrders

  const fetchPurchaseOrders = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl('purchase-orders'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        const msg = await getErrorMessageFromResponse(response, 'Failed to load purchase orders')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        return
      }
      const data = await response.json()
      setPurchaseOrders(data)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load purchase orders'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPurchaseOrders()
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
      const res = await fetch(apiUrl('purchase-orders/upload-excel'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Upload failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Import done', detail: data.message, life: 5000 })
      await fetchPurchaseOrders()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      toast.current?.show({ severity: 'error', summary: 'Import failed', detail: msg, life: 5000 })
    } finally {
      setUploadingExcel(false)
    }
  }, [])

  const openExcelUpload = () => fileInputRef.current?.click()

  const dateBodyTemplate = (rowData: PurchaseOrder) => {
    if (!rowData.po_date) return '-'
    const date = new Date(rowData.po_date)
    return date.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const statusBodyTemplate = (rowData: PurchaseOrder) => {
    const status = rowData.status || 'open'
    const severity = status === 'completed' ? 'success' : 
                     status === 'cancelled' ? 'danger' : 
                     status === 'in_progress' ? 'warning' : 'info'
    return <Tag value={status.toUpperCase()} severity={severity} />
  }

  const supplierBodyTemplate = (rowData: PurchaseOrder) => {
    return rowData.supplier_name || '-'
  }

  const lineItemCountBodyTemplate = (rowData: PurchaseOrder) => {
    return (
      <div className={styles.lineItemCount}>
        <i className="pi pi-list" style={{ marginRight: '0.5rem' }}></i>
        <span>{rowData.line_item_count || 0}</span>
      </div>
    )
  }

  const fetchLineItems = async (poId: number) => {
    // Check if line items are already loaded
    const po = purchaseOrders.find(p => p.po_id === poId)
    if (po?.lineItems) {
      return
    }

    setLoadingLineItems(prev => new Set(prev).add(poId))
    try {
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl(`purchase-orders/${poId}/line-items`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        const msg = await getErrorMessageFromResponse(response, 'Failed to load line items')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        return
      }
      const lineItems = await response.json()

      setPurchaseOrders(prev =>
        prev.map(po =>
          po.po_id === poId ? { ...po, lineItems } : po
        )
      )
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load line items'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoadingLineItems(prev => {
        const next = new Set(prev)
        next.delete(poId)
        return next
      })
    }
  }

  const onRowExpand = (event: any) => {
    const poId = event.data.po_id
    fetchLineItems(poId)
  }

  const rowExpansionTemplate = (rowData: PurchaseOrder) => {
    const lineItems = rowData.lineItems || []
    const isLoading = loadingLineItems.has(rowData.po_id)

    return (
      <div className={styles.expansionContent}>
        <div className={styles.poDetailsSection}>
          <div className={styles.detailRow}>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Amendment No:</span>
              <span className={styles.detailValue}>{rowData.amd_no != null ? rowData.amd_no : '0'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Unit:</span>
              <span className={styles.detailValue}>{rowData.unit || '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Ref Unit:</span>
              <span className={styles.detailValue}>{rowData.ref_unit || '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>PFX:</span>
              <span className={styles.detailValue}>{rowData.pfx || '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>Supplier Code (Suplr ID):</span>
              <span className={styles.detailValue}>{rowData.suplr_id || '-'}</span>
            </div>
          </div>
          {rowData.terms && (
            <div className={styles.detailRow}>
              <div className={styles.detailItem} style={{ gridColumn: '1 / -1' }}>
                <span className={styles.detailLabel}>Terms:</span>
                <span className={styles.detailValue}>{rowData.terms}</span>
              </div>
            </div>
          )}
        </div>

        <Divider />

        <div className={styles.lineItemsSection}>
          <h4 className={styles.lineItemsHeader}>
            <i className="pi pi-list" style={{ marginRight: '0.5rem' }}></i>
            Line Items ({lineItems.length})
          </h4>
          
          {isLoading ? (
            <div className={styles.lineItemsLoading}>
              <ProgressSpinner size="small" />
              <span>Loading line items...</span>
            </div>
          ) : lineItems.length === 0 ? (
            <div className={styles.noLineItems}>No line items found</div>
          ) : (
            <div className={styles.lineItemsTable}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Item ID</th>
                    <th>Description</th>
                    <th>Qty</th>
                    <th>Unit Cost</th>
                    <th>Disc %</th>
                    <th>Raw Material</th>
                    <th>Process Description</th>
                    <th>Norms</th>
                    <th>Process Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, index) => (
                    <tr key={item.po_line_id}>
                      <td className={styles.sequenceCell}>{item.sequence_number ?? index + 1}</td>
                      <td className={styles.itemIdCell}>{item.item_id || '-'}</td>
                      <td className={styles.descriptionCell}>{item.description1 || '-'}</td>
                      <td className={styles.quantityCell}>{item.qty != null ? item.qty : '-'}</td>
                      <td className={styles.unitCostCell}>{item.unit_cost != null ? Number(item.unit_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '-'}</td>
                      <td className={styles.discPctCell}>{item.disc_pct != null ? Number(item.disc_pct) : '-'}</td>
                      <td className={styles.textCell}>{item.raw_material || '-'}</td>
                      <td className={styles.textCell}>{item.process_description || '-'}</td>
                      <td className={styles.textCell}>{item.norms || '-'}</td>
                      <td className={styles.unitCostCell}>{item.process_cost != null ? Number(item.process_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.purchaseOrderPage}>
      <Header />
      <Toast ref={toast} />
      
      <div className={styles.pageContainer} id="main-content">
        <Breadcrumb items={[{ label: 'Home', path: '/' }, { label: 'Purchase Orders' }]} />
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Purchase Order Details</h1>
              <p className={styles.pageSubtitle}>View and manage all purchase orders</p>
            </div>
            <div className={styles.headerActions}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleExcelUpload}
                style={{ display: 'none' }}
              />
              <Button label="Upload Excel" icon="pi pi-upload" className={styles.uploadExcelButton} onClick={openExcelUpload} loading={uploadingExcel} disabled={uploadingExcel} />
              <Button label="Refresh" icon="pi pi-refresh" className={styles.refreshButton} onClick={() => fetchPurchaseOrders()} />
              <PageNavigation />
            </div>
          </div>
        </div>

      <div className="dts-section dts-section-accent">
        <h2 className="dts-sectionTitle">Purchase orders</h2>
        <p className="dts-sectionSubtitle">View and manage all purchase orders. Expand a row to see line items.</p>
        {!loading && (
          <div className={styles.toolbar}>
            <span className="p-input-icon-left">
              <i className="pi pi-search" />
              <InputText
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by PO number, supplier, unit, terms, status..."
                className={styles.searchInput}
              />
            </span>
          </div>
        )}
        {loading ? (
          <div className={styles.loadingContainer}>
            <ProgressSpinner />
            <p>Loading purchase orders...</p>
          </div>
        ) : (
          <div className="dts-tableWrapper">
            <div className="dts-tableContainer">
              <DataTable
                value={filteredPOs}
                paginator
                rows={10}
                rowsPerPageOptions={[10, 25, 50]}
                emptyMessage={searchTerm ? 'No matching purchase orders' : 'No purchase orders found'}
                stripedRows
                expandedRows={expandedRows}
                onRowToggle={(e) => setExpandedRows(e.data)}
                rowExpansionTemplate={rowExpansionTemplate}
                onRowExpand={onRowExpand}
                dataKey="po_id"
              >
            <Column expander style={{ width: '3rem' }} />
            <Column
              field="po_number"
              header="PO Number"
              sortable
              style={{ minWidth: '200px' }}
              body={(rowData: PurchaseOrder) => (
                <div className={styles.poNumberCell}>
                  <i className="pi pi-file" style={{ marginRight: '0.5rem', color: '#2563eb' }}></i>
                  <strong>{rowData.po_number}</strong>
                </div>
              )}
            />
            <Column
              field="po_date"
              header="PO Date"
              sortable
              body={dateBodyTemplate}
              style={{ minWidth: '150px' }}
            />
            <Column
              field="supplier_name"
              header="Supplier"
              sortable
              body={supplierBodyTemplate}
              style={{ minWidth: '220px' }}
            />
            <Column
              field="unit"
              header="Unit"
              sortable
              style={{ minWidth: '80px' }}
              body={(rowData: PurchaseOrder) => rowData.unit || '-'}
            />
            <Column
              field="terms"
              header="Terms"
              style={{ minWidth: '180px', maxWidth: '280px' }}
              body={(rowData: PurchaseOrder) => (
                <span title={rowData.terms || ''} className={styles.termsCell}>
                  {rowData.terms ? (rowData.terms.length > 40 ? `${rowData.terms.slice(0, 40)}…` : rowData.terms) : '-'}
                </span>
              )}
            />
            <Column
              field="line_item_count"
              header="Line Items"
              body={lineItemCountBodyTemplate}
              style={{ minWidth: '120px', textAlign: 'center' }}
            />
            <Column
              field="status"
              header="Status"
              sortable
              body={statusBodyTemplate}
              style={{ minWidth: '150px' }}
            />
              </DataTable>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

export default PurchaseOrderDetails
