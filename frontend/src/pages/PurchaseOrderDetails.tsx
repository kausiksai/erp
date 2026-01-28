import { useState, useEffect, useRef } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Tag } from 'primereact/tag'
import { Divider } from 'primereact/divider'
import { apiUrl } from '../utils/api'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import styles from './PurchaseOrderDetails.module.css'

interface PurchaseOrderLineItem {
  po_line_id: number
  po_id: number
  item_name: string
  item_description: string | null
  hsn_sac: string | null
  uom: string | null
  quantity: number
  sequence_number: number
}

interface PurchaseOrder {
  po_id: number
  po_number: string
  po_date: string
  bill_to: string
  bill_to_address: string | null
  bill_to_gstin: string | null
  status: string
  terms_and_conditions: string | null
  payment_terms: string | null
  delivery_terms: string | null
  supplier_name: string | null
  supplier_id: number | null
  line_item_count: number
  created_at: string
  updated_at: string
  lineItems?: PurchaseOrderLineItem[]
}

function PurchaseOrderDetails() {
  const toast = useRef<Toast>(null)
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [refreshing, setRefreshing] = useState<boolean>(false)
  const [expandedRows, setExpandedRows] = useState<{ [key: string]: boolean }>({})
  const [loadingLineItems, setLoadingLineItems] = useState<Set<number>>(new Set())

  const fetchPurchaseOrders = async () => {
    try {
      const response = await fetch(apiUrl('purchase-orders'))
      if (!response.ok) {
        throw new Error('Failed to fetch purchase orders')
      }
      const data = await response.json()
      setPurchaseOrders(data)
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to load purchase orders',
        life: 5000
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    fetchPurchaseOrders()
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    // TODO: Call Python script to sync from ERP API
    // For now, just refresh from database
    await fetchPurchaseOrders()
    
    toast.current?.show({
      severity: 'info',
      summary: 'Refresh',
      detail: 'Purchase orders refreshed. Python integration will be added later.',
      life: 3000
    })
  }

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
    const status = rowData.status || 'pending'
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
      const response = await fetch(apiUrl(`purchase-orders/${poId}/line-items`))
      if (!response.ok) {
        throw new Error('Failed to fetch line items')
      }
      const lineItems = await response.json()
      
      setPurchaseOrders(prev => 
        prev.map(po => 
          po.po_id === poId 
            ? { ...po, lineItems } 
            : po
        )
      )
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to load line items',
        life: 3000
      })
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
              <span className={styles.detailLabel}>Bill To Address:</span>
              <span className={styles.detailValue}>{rowData.bill_to_address || '-'}</span>
            </div>
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>GSTIN:</span>
              <span className={styles.detailValue}>{rowData.bill_to_gstin || '-'}</span>
            </div>
          </div>
          {(rowData.payment_terms || rowData.delivery_terms) && (
            <div className={styles.detailRow}>
              {rowData.payment_terms && (
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Payment Terms:</span>
                  <span className={styles.detailValue}>{rowData.payment_terms}</span>
                </div>
              )}
              {rowData.delivery_terms && (
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Delivery Terms:</span>
                  <span className={styles.detailValue}>{rowData.delivery_terms}</span>
                </div>
              )}
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
                    <th>Item Name</th>
                    <th>Description</th>
                    <th>HSN/SAC</th>
                    <th>UOM</th>
                    <th>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, index) => (
                    <tr key={item.po_line_id}>
                      <td className={styles.sequenceCell}>{item.sequence_number || index + 1}</td>
                      <td className={styles.itemNameCell}>{item.item_name}</td>
                      <td className={styles.descriptionCell}>{item.item_description || '-'}</td>
                      <td className={styles.hsnCell}>{item.hsn_sac || '-'}</td>
                      <td className={styles.uomCell}>{item.uom || '-'}</td>
                      <td className={styles.quantityCell}>{item.quantity}</td>
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
      
      <div className={styles.pageContainer}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Purchase Order Details</h1>
              <p className={styles.pageSubtitle}>View and manage all purchase orders</p>
            </div>
            <PageNavigation />
            <Button
              label="Refresh"
              icon="pi pi-refresh"
              onClick={handleRefresh}
              loading={refreshing}
              className={styles.refreshButton}
            />
          </div>
        </div>

      <div className={styles.tableContainer}>
        {loading ? (
          <div className={styles.loadingContainer}>
            <ProgressSpinner />
            <p>Loading purchase orders...</p>
          </div>
        ) : (
          <DataTable
            value={purchaseOrders}
            paginator
            rows={10}
            rowsPerPageOptions={[10, 25, 50]}
            emptyMessage="No purchase orders found"
            className={styles.dataTable}
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
              style={{ minWidth: '250px' }}
            />
            <Column
              field="bill_to"
              header="Bill To"
              sortable
              style={{ minWidth: '200px' }}
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
        )}
      </div>
      </div>
    </div>
  )
}

export default PurchaseOrderDetails
