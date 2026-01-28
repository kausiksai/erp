import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Badge } from 'primereact/badge'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl } from '../utils/api'
import styles from './IncompletePOs.module.css'

interface IncompletePO {
  po_id: number
  po_number: string
  po_date: string
  supplier_name: string | null
  has_invoice: boolean
  has_grn: boolean
  has_asn: boolean
  missing_items: string[]
}

function IncompletePOs() {
  const navigate = useNavigate()
  const [incompletePOs, setIncompletePOs] = useState<IncompletePO[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchIncompletePOs()
  }, [])

  const fetchIncompletePOs = async () => {
    try {
      setLoading(true)
      // Fetch all purchase orders
      const poResponse = await fetch(apiUrl('purchase-orders'))
      if (!poResponse.ok) throw new Error('Failed to fetch purchase orders')
      const poData = await poResponse.json()

      // Fetch all invoices
      const invoiceResponse = await fetch(apiUrl('invoices'))
      const invoiceData = invoiceResponse.ok ? await invoiceResponse.json() : []

      // Create a map of PO IDs that have invoices
      const poWithInvoices = new Set(
        invoiceData.map((inv: any) => inv.po_id).filter((id: any) => id !== null && id !== undefined)
      )

      // Analyze each PO to determine what's missing
      // TODO: Add GRN and ASN checks when those endpoints/tables are available
      const incomplete: IncompletePO[] = poData
        .map((po: any) => {
          const missing: string[] = []
          const hasInvoice = poWithInvoices.has(po.po_id)
          
          if (!hasInvoice) {
            missing.push('Invoice')
          }
          
          // GRN and ASN checks will be added when those features are implemented
          // For now, we only check for invoices
          // When GRN/ASN tables/endpoints are available, add checks here:
          // const hasGRN = ... (check GRN table/endpoint)
          // const hasASN = ... (check ASN table/endpoint)
          // if (!hasGRN) missing.push('GRN')
          // if (!hasASN) missing.push('ASN')

          return {
            po_id: po.po_id,
            po_number: po.po_number,
            po_date: po.po_date,
            supplier_name: po.supplier_name || 'N/A',
            has_invoice: hasInvoice,
            has_grn: false, // Will be updated when GRN is implemented
            has_asn: false, // Will be updated when ASN is implemented
            missing_items: missing
          }
        })
        .filter((po: IncompletePO) => po.missing_items.length > 0)

      setIncompletePOs(incomplete)
    } catch (error: any) {
      console.error('Error fetching incomplete POs:', error)
    } finally {
      setLoading(false)
    }
  }

  const missingItemsTemplate = (rowData: IncompletePO) => {
    return (
      <div className={styles.missingItems}>
        {rowData.missing_items.map((item, index) => (
          <Badge
            key={index}
            value={item}
            severity="warning"
            className={styles.missingBadge}
          />
        ))}
      </div>
    )
  }

  const actionTemplate = (rowData: IncompletePO) => {
    return (
      <div className={styles.actionButtons}>
        {!rowData.has_invoice && (
          <Button
            label="Add Invoice"
            icon="pi pi-file-pdf"
            size="small"
            onClick={() => navigate('/invoices/upload', { state: { poId: rowData.po_id, poNumber: rowData.po_number } })}
            className={styles.actionButton}
          />
        )}
        {/* GRN and ASN buttons will be enabled when those features are implemented */}
        <Button
          label="View PO"
          icon="pi pi-eye"
          size="small"
          outlined
          onClick={() => navigate(`/purchase-orders/upload`, { state: { poId: rowData.po_id } })}
          className={styles.viewButton}
        />
      </div>
    )
  }

  const dateTemplate = (rowData: IncompletePO) => {
    return new Date(rowData.po_date).toLocaleDateString()
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <Header />
        <div className={styles.loadingContainer}>
          <ProgressSpinner />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <Header />
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Incomplete Purchase Orders</h1>
            <p className={styles.subtitle}>
              Purchase orders with missing information. Update the missing details to complete the records.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <PageNavigation />
            <Button
              label="Refresh"
              icon="pi pi-refresh"
              onClick={fetchIncompletePOs}
              className={styles.refreshButton}
            />
          </div>
        </div>

        <div className={styles.tableContainer}>
          <DataTable
            value={incompletePOs}
            paginator
            rows={10}
            rowsPerPageOptions={[10, 25, 50]}
            emptyMessage="No incomplete purchase orders found"
            className={styles.dataTable}
          >
            <Column
              field="po_number"
              header="PO Number"
              sortable
              style={{ minWidth: '150px' }}
            />
            <Column
              field="po_date"
              header="PO Date"
              sortable
              body={dateTemplate}
              style={{ minWidth: '120px' }}
            />
            <Column
              field="supplier_name"
              header="Supplier"
              sortable
              style={{ minWidth: '200px' }}
            />
            <Column
              field="missing_items"
              header="Missing Items"
              body={missingItemsTemplate}
              style={{ minWidth: '250px' }}
            />
            <Column
              header="Actions"
              body={actionTemplate}
              style={{ minWidth: '300px' }}
            />
          </DataTable>
        </div>

        {incompletePOs.length === 0 && !loading && (
          <div className={styles.emptyState}>
            <i className="pi pi-check-circle" style={{ fontSize: '4rem', color: '#059669' }}></i>
            <h2>All Purchase Orders are Complete!</h2>
            <p>All purchase orders have their required information.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default IncompletePOs
