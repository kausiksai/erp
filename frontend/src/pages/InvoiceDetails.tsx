import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Divider } from 'primereact/divider'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { apiUrl } from '../utils/api'
import styles from './InvoiceDetails.module.css'

interface InvoiceLineItem {
  invoice_line_id: number
  item_name: string
  hsn_sac: string | null
  uom: string | null
  billed_qty: number
  rate: number
  line_total: number
  taxable_value: number
  cgst_rate: number
  cgst_amount: number
  sgst_rate: number
  sgst_amount: number
  total_tax_amount: number
  sequence_number: number
}

interface POLineItem {
  po_line_id: number
  item_name: string
  item_description: string | null
  hsn_sac: string | null
  uom: string | null
  quantity: number
  sequence_number: number
}

interface InvoiceDetails {
  invoice_id: number
  invoice_number: string
  invoice_date: string
  scanning_number: string | null
  total_amount: number
  tax_amount: number
  status: string
  notes: string | null
  supplier_name: string | null
  supplier_gst: string | null
  supplier_pan: string | null
  supplier_address: string | null
  supplier_email: string | null
  supplier_phone: string | null
  supplier_mobile: string | null
  po_id: number | null
  po_number: string | null
  po_date: string | null
  bill_to: string | null
  bill_to_address: string | null
  bill_to_gstin: string | null
  po_status: string | null
  items: InvoiceLineItem[]
  poLineItems: POLineItem[]
}

function InvoiceDetails() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const toast = useRef<Toast>(null)
  const [invoice, setInvoice] = useState<InvoiceDetails | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    if (id) {
      fetchInvoiceDetails(parseInt(id))
    }
  }, [id])

  const fetchInvoiceDetails = async (invoiceId: number) => {
    setLoading(true)
    try {
      const response = await fetch(apiUrl(`invoices/${invoiceId}`))
      if (!response.ok) {
        throw new Error('Failed to fetch invoice details')
      }
      const data = await response.json()
      setInvoice(data)
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to load invoice details',
        life: 5000
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    navigate('/invoices/validate')
  }

  const handlePOClick = () => {
    if (invoice?.po_number) {
      navigate(`/purchase-orders/upload`)
    }
  }

  const dateBodyTemplate = (date: string | null) => {
    if (!date) return '-'
    const d = new Date(date)
    return d.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  const amountBodyTemplate = (amount: number | null) => {
    return amount 
      ? `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '-'
  }

  const quantityBodyTemplate = (qty: number | null) => {
    return qty ? qty.toLocaleString('en-IN') : '-'
  }

  if (loading) {
    return (
      <div className={styles.invoiceDetailsPage}>
        <Header />
        <div className={styles.pageContainer}>
          <div className={styles.loadingContainer}>
            <ProgressSpinner />
            <p>Loading invoice details...</p>
          </div>
        </div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className={styles.invoiceDetailsPage}>
        <Header />
        <div className={styles.pageContainer}>
          <div className={styles.errorContainer}>
            <p>Invoice not found</p>
            <Button label="Back to Invoices" onClick={handleBack} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.invoiceDetailsPage}>
      <Header />
      <Toast ref={toast} />
      
      <div className={styles.pageContainer}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Invoice Details</h1>
              <p className={styles.pageSubtitle}>Invoice Number: {invoice.invoice_number}</p>
            </div>
            <PageNavigation />
          </div>
        </div>

        <div className={styles.detailsGrid}>
          {/* Invoice Information */}
          <div className={styles.detailsCard}>
            <h3 className={styles.cardTitle}>
              <i className="pi pi-file" style={{ marginRight: '0.5rem' }}></i>
              Invoice Information
            </h3>
            <div className={styles.detailsList}>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Invoice Number:</span>
                <span className={styles.detailValue}>{invoice.invoice_number}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Invoice Date:</span>
                <span className={styles.detailValue}>{dateBodyTemplate(invoice.invoice_date)}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Scanning Number:</span>
                <span className={styles.detailValue}>{invoice.scanning_number || '-'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Status:</span>
                <span className={styles.detailValue}>
                  <span className={`${styles.statusBadge} ${styles[invoice.status] || styles.pending}`}>
                    {invoice.status?.toUpperCase() || 'PENDING'}
                  </span>
                </span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Total Amount:</span>
                <span className={styles.detailValue}>{amountBodyTemplate(invoice.total_amount)}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Tax Amount:</span>
                <span className={styles.detailValue}>{amountBodyTemplate(invoice.tax_amount)}</span>
              </div>
            </div>
          </div>

          {/* Purchase Order Information */}
          {invoice.po_number && (
            <div className={styles.detailsCard}>
              <h3 className={styles.cardTitle}>
                <i className="pi pi-shopping-cart" style={{ marginRight: '0.5rem' }}></i>
                Purchase Order Information
                <Button
                  icon="pi pi-external-link"
                  label="View PO"
                  onClick={handlePOClick}
                  className={styles.viewPOButton}
                  size="small"
                  outlined
                />
              </h3>
              <div className={styles.detailsList}>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>PO Number:</span>
                  <span 
                    className={`${styles.detailValue} ${styles.clickableLink}`}
                    onClick={handlePOClick}
                  >
                    {invoice.po_number}
                  </span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>PO Date:</span>
                  <span className={styles.detailValue}>{dateBodyTemplate(invoice.po_date)}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Bill To:</span>
                  <span className={styles.detailValue}>{invoice.bill_to || '-'}</span>
                </div>
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>PO Status:</span>
                  <span className={styles.detailValue}>
                    <span className={`${styles.statusBadge} ${styles[invoice.po_status || 'pending'] || styles.pending}`}>
                      {(invoice.po_status || 'PENDING').toUpperCase()}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Supplier Information */}
          <div className={styles.detailsCard}>
            <h3 className={styles.cardTitle}>
              <i className="pi pi-building" style={{ marginRight: '0.5rem' }}></i>
              Supplier Information
            </h3>
            <div className={styles.detailsList}>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Supplier Name:</span>
                <span className={styles.detailValue}>{invoice.supplier_name || '-'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>GST Number:</span>
                <span className={styles.detailValue}>{invoice.supplier_gst || '-'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>PAN Number:</span>
                <span className={styles.detailValue}>{invoice.supplier_pan || '-'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Address:</span>
                <span className={styles.detailValue}>{invoice.supplier_address || '-'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Email:</span>
                <span className={styles.detailValue}>{invoice.supplier_email || '-'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Phone:</span>
                <span className={styles.detailValue}>{invoice.supplier_phone || invoice.supplier_mobile || '-'}</span>
              </div>
            </div>
          </div>
        </div>

        <Divider />

        {/* Invoice Line Items */}
        <div className={styles.lineItemsSection}>
          <h3 className={styles.sectionTitle}>
            <i className="pi pi-list" style={{ marginRight: '0.5rem' }}></i>
            Invoice Line Items ({invoice.items.length})
          </h3>
          <div className={styles.tableContainer}>
            <DataTable
              value={invoice.items}
              emptyMessage="No line items found"
              className={styles.dataTable}
              stripedRows
            >
              <Column
                field="sequence_number"
                header="#"
                style={{ width: '60px', textAlign: 'center' }}
                body={(rowData: InvoiceLineItem) => rowData.sequence_number || '-'}
              />
              <Column
                field="item_name"
                header="Item Name"
                style={{ minWidth: '200px' }}
              />
              <Column
                field="hsn_sac"
                header="HSN/SAC"
                style={{ minWidth: '120px' }}
                body={(rowData: InvoiceLineItem) => rowData.hsn_sac || '-'}
              />
              <Column
                field="billed_qty"
                header="Quantity"
                style={{ minWidth: '100px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => quantityBodyTemplate(rowData.billed_qty)}
              />
              <Column
                field="uom"
                header="UOM"
                style={{ minWidth: '80px', textAlign: 'center' }}
                body={(rowData: InvoiceLineItem) => rowData.uom || '-'}
              />
              <Column
                field="rate"
                header="Rate"
                style={{ minWidth: '120px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => amountBodyTemplate(rowData.rate)}
              />
              <Column
                field="taxable_value"
                header="Taxable Value"
                style={{ minWidth: '150px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => amountBodyTemplate(rowData.taxable_value)}
              />
              <Column
                field="cgst_rate"
                header="CGST %"
                style={{ minWidth: '100px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => rowData.cgst_rate ? `${rowData.cgst_rate}%` : '-'}
              />
              <Column
                field="cgst_amount"
                header="CGST Amount"
                style={{ minWidth: '130px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => amountBodyTemplate(rowData.cgst_amount)}
              />
              <Column
                field="sgst_rate"
                header="SGST %"
                style={{ minWidth: '100px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => rowData.sgst_rate ? `${rowData.sgst_rate}%` : '-'}
              />
              <Column
                field="sgst_amount"
                header="SGST Amount"
                style={{ minWidth: '130px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => amountBodyTemplate(rowData.sgst_amount)}
              />
              <Column
                field="line_total"
                header="Line Total"
                style={{ minWidth: '150px', textAlign: 'right', fontWeight: '600' }}
                body={(rowData: InvoiceLineItem) => amountBodyTemplate(rowData.line_total)}
              />
            </DataTable>
          </div>
        </div>

        {/* PO Line Items */}
        {invoice.poLineItems && invoice.poLineItems.length > 0 && (
          <>
            <Divider />
            <div className={styles.lineItemsSection}>
              <h3 className={styles.sectionTitle}>
                <i className="pi pi-list" style={{ marginRight: '0.5rem' }}></i>
                Purchase Order Line Items ({invoice.poLineItems.length})
              </h3>
              <div className={styles.tableContainer}>
                <DataTable
                  value={invoice.poLineItems}
                  emptyMessage="No PO line items found"
                  className={styles.dataTable}
                  stripedRows
                >
                  <Column
                    field="sequence_number"
                    header="#"
                    style={{ width: '60px', textAlign: 'center' }}
                    body={(rowData: POLineItem) => rowData.sequence_number || '-'}
                  />
                  <Column
                    field="item_name"
                    header="Item Name"
                    style={{ minWidth: '200px' }}
                  />
                  <Column
                    field="item_description"
                    header="Description"
                    style={{ minWidth: '250px' }}
                    body={(rowData: POLineItem) => rowData.item_description || '-'}
                  />
                  <Column
                    field="hsn_sac"
                    header="HSN/SAC"
                    style={{ minWidth: '120px' }}
                    body={(rowData: POLineItem) => rowData.hsn_sac || '-'}
                  />
                  <Column
                    field="quantity"
                    header="Quantity"
                    style={{ minWidth: '100px', textAlign: 'right' }}
                    body={(rowData: POLineItem) => quantityBodyTemplate(rowData.quantity)}
                  />
                  <Column
                    field="uom"
                    header="UOM"
                    style={{ minWidth: '80px', textAlign: 'center' }}
                    body={(rowData: POLineItem) => rowData.uom || '-'}
                  />
                </DataTable>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default InvoiceDetails
