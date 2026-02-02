import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Divider } from 'primereact/divider'
import { Dialog } from 'primereact/dialog'
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import Breadcrumb from '../components/Breadcrumb'
import { apiUrl, apiFetch } from '../utils/api'
import styles from './InvoiceDetails.module.css'

interface InvoiceLineItem {
  invoice_line_id: number
  item_name: string
  hsn_sac: string | null
  uom: string | null
  billed_qty: number
  weight: number | null
  count: number | null
  rate: number
  rate_per: string | null
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
  po_id: number
  sequence_number: number
  item_id: string | null
  item_name: string
  item_description: string | null
  quantity: number
  unit_cost: number | null
  disc_pct: number | null
  raw_material: string | null
  process_description: string | null
  norms: string | null
  process_cost: number | null
}

interface InvoiceDetails {
  invoice_id: number
  invoice_number: string
  invoice_date: string
  scanning_number: string | null
  total_amount: number
  tax_amount: number
  status: string
  payment_due_date: string | null
  debit_note_value?: number | null
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
  const [validating, setValidating] = useState<boolean>(false)
  const [debitNoteApproving, setDebitNoteApproving] = useState<boolean>(false)
  const [debitNoteValue, setDebitNoteValue] = useState<string>('')
  const [validationSummary, setValidationSummary] = useState<{
    reason?: string
    validationFailureReason?: string
    thisInvQty?: number
    poQty?: number
    grnQty?: number
    isShortfall?: boolean
  } | null>(null)
  const [validationMismatchData, setValidationMismatchData] = useState<{
    validationFailureReason?: string
    thisInvQty?: number
    poQty?: number
    grnQty?: number
    errors?: string[]
    warnings?: string[]
    details?: {
      header?: { invoice?: unknown; po?: unknown; supplierMatch?: boolean; errors?: string[]; warnings?: string[] }
      lines?: Array<{
        index: number
        itemName?: string
        invQty?: number
        poQty?: number
        invRate?: number
        poRate?: number
        quantityMatch?: boolean
        rateMatch?: boolean
        errors?: string[]
        warnings?: string[]
      }>
      totals?: { thisInvQty?: number; poQty?: number; grnQty?: number; thisInvAmount?: number; errors?: string[]; warnings?: string[] }
      grn?: { grnQty?: number; invLteGrn?: boolean; errors?: string[] }
      asn?: { asnCount?: number; warnings?: string[] }
    }
  } | null>(null)
  const [resolvingValidation, setResolvingValidation] = useState<boolean>(false)
  const [validationAttemptFailed, setValidationAttemptFailed] = useState<boolean>(false)
  const [successDialogVisible, setSuccessDialogVisible] = useState<boolean>(false)
  const [successDialogContent, setSuccessDialogContent] = useState<{ summary: string; detail: string }>({ summary: '', detail: '' })

  useEffect(() => {
    if (id) {
      setValidationAttemptFailed(false)
      fetchInvoiceDetails(parseInt(id))
    }
  }, [id])

  // When invoice is in debit_note_approval, fetch validation summary and set default debit note value
  useEffect(() => {
    if (!invoice || (invoice.status || '').toLowerCase() !== 'debit_note_approval') {
      setValidationSummary(null)
      return
    }
    setDebitNoteValue(invoice.total_amount != null ? String(invoice.total_amount) : '')
    const fetchValidationSummary = async () => {
      try {
        const res = await apiFetch(`invoices/${invoice.invoice_id}/validation-summary`)
        if (res.ok) {
          const data = await res.json()
          setValidationSummary(data)
        }
      } catch {
        setValidationSummary(null)
      }
    }
    fetchValidationSummary()
  }, [invoice?.invoice_id, invoice?.status, invoice?.total_amount])

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

  const handleValidate = async () => {
    if (!invoice?.invoice_id || validating) return
    setValidating(true)
    try {
      const res = await apiFetch(`invoices/${invoice.invoice_id}/validate`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setValidationAttemptFailed(true)
        toast.current?.show({
          severity: 'error',
          summary: 'Validation failed',
          detail: data.message || data.error || 'Could not validate invoice',
          life: 6000
        })
        return
      }
      setValidationAttemptFailed(false)
      const action = data.action || data.status
      if (action === 'shortfall') {
        setValidationMismatchData({
          validationFailureReason: data.validationFailureReason || data.reason,
          thisInvQty: data.thisInvQty,
          poQty: data.poQty,
          grnQty: data.grnQty,
          errors: data.errors,
          warnings: data.warnings,
          details: data.details
        })
        setValidating(false)
        return
      }
      if (action === 'validated' || action === 'ready_for_payment') {
        setSuccessDialogContent({
          summary: 'Validation successful',
          detail: 'Invoice validated successfully. It will appear on Approve Payments for manager approval.'
        })
        setSuccessDialogVisible(true)
      } else if (action === 'exception_approval') {
        setSuccessDialogContent({
          summary: 'Validation successful',
          detail: 'Invoice is for an already-fulfilled PO. Use Exception Approve on Incomplete POs when ready.'
        })
        setSuccessDialogVisible(true)
      } else {
        setSuccessDialogContent({
          summary: 'Validation successful',
          detail: data.message || 'Invoice validation completed.'
        })
        setSuccessDialogVisible(true)
      }
      await fetchInvoiceDetails(invoice.invoice_id)
    } catch (e: unknown) {
      setValidationAttemptFailed(true)
      const msg = e instanceof Error ? e.message : 'Validation failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setValidating(false)
    }
  }

  const confirmProceedToPayment = () => {
    confirmDialog({
      message: 'Are you sure you want to send this invoice to payments despite the quantity mismatch?',
      header: 'Confirm send to payments',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleValidationResolution('proceed_to_payment'),
      reject: () => {}
    })
  }

  const handleValidationResolution = async (resolution: 'proceed_to_payment' | 'send_to_debit_note') => {
    if (!invoice?.invoice_id || resolvingValidation || !validationMismatchData) return
    setResolvingValidation(true)
    try {
      const res = await apiFetch(`invoices/${invoice.invoice_id}/validate-resolution`, {
        method: 'POST',
        body: JSON.stringify({ resolution })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.current?.show({
          severity: 'error',
          summary: 'Error',
          detail: (data as { message?: string }).message || data.error || 'Could not apply choice',
          life: 5000
        })
        return
      }
      setValidationMismatchData(null)
      if (resolution === 'proceed_to_payment') {
        toast.current?.show({
          severity: 'success',
          summary: 'Validated',
          detail: 'Invoice will appear on Approve Payments for manager approval.',
          life: 6000
        })
      } else {
        toast.current?.show({
          severity: 'info',
          summary: 'Sent to debit note',
          detail: 'Invoice is in Debit note approval. You can set amount and approve from Incomplete POs.',
          life: 6000
        })
      }
      await fetchInvoiceDetails(invoice.invoice_id)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setResolvingValidation(false)
    }
  }

  const handlePOClick = () => {
    if (invoice?.po_number) {
      navigate(`/purchase-orders/upload`)
    }
  }

  const invoiceStatusLabel = (status: string | null | undefined) => {
    const s = (status || '').toLowerCase().replace(/\s+/g, '_')
    const map: Record<string, string> = {
      waiting_for_validation: 'Waiting for validation',
      validated: 'Validated',
      waiting_for_re_validation: 'Waiting for re-validation',
      debit_note_approval: 'Debit note approval',
      exception_approval: 'Exception approval',
      ready_for_payment: 'Ready for payment',
      partially_paid: 'Partially paid',
      paid: 'Paid',
      rejected: 'Rejected',
      pending: 'Waiting for validation',
      completed: 'Paid'
    }
    return map[s] || (status || 'Waiting for validation')
  }

  const invoiceStatusClass = (status: string | null | undefined) => {
    const s = (status || '').toLowerCase().replace(/\s+/g, '_')
    if (['waiting_for_validation', 'validated', 'waiting_for_re_validation', 'debit_note_approval', 'exception_approval', 'ready_for_payment', 'partially_paid', 'paid', 'rejected', 'pending', 'completed'].includes(s)) return s
    return 'waiting_for_validation'
  }

  const poStatusLabel = (status: string | null | undefined) => {
    const s = (status || '').toLowerCase()
    if (s === 'open') return 'Open'
    if (s === 'partially_fulfilled') return 'Partially fulfilled'
    if (s === 'fulfilled') return 'Fulfilled'
    return (status || 'Open').toUpperCase()
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

  const mismatchReason = validationMismatchData?.validationFailureReason || 'Quantity or GRN mismatch detected.'
  const mismatchQty =
    validationMismatchData?.thisInvQty != null ||
    validationMismatchData?.poQty != null ||
    validationMismatchData?.grnQty != null
      ? ` Invoice qty: ${validationMismatchData?.thisInvQty ?? '—'}, PO total: ${validationMismatchData?.poQty ?? '—'}, GRN total: ${validationMismatchData?.grnQty ?? '—'}`
      : ''

  return (
    <div className={styles.invoiceDetailsPage}>
      <Header />
      <Toast ref={toast} />
      <ConfirmDialog />
      <Dialog
        visible={successDialogVisible}
        onHide={() => setSuccessDialogVisible(false)}
        header={successDialogContent.summary}
        className={styles.validationDialog}
        modal
        closable
        footer={
          <Button
            label="OK"
            icon="pi pi-check"
            onClick={() => {
              setSuccessDialogVisible(false)
            }}
          />
        }
      >
        <p className={styles.validationDialogMessage}>{successDialogContent.detail}</p>
      </Dialog>
      <Dialog
        visible={!!validationMismatchData}
        onHide={() => !resolvingValidation && setValidationMismatchData(null)}
        header="Validation mismatch (partial fulfillment)"
        className={styles.validationDialog}
        modal
        closable={!resolvingValidation}
        footer={
          <div className={styles.validationDialogFooter}>
            <Button
              label="Confirm and proceed for payment"
              icon="pi pi-check"
              severity="success"
              loading={resolvingValidation}
              disabled={resolvingValidation}
              onClick={confirmProceedToPayment}
              className={styles.validationDialogButton}
            />
            <Button
              label="Send to debit note"
              icon="pi pi-file-edit"
              severity="secondary"
              loading={resolvingValidation}
              disabled={resolvingValidation}
              onClick={() => handleValidationResolution('send_to_debit_note')}
              className={styles.validationDialogButton}
              outlined
            />
          </div>
        }
      >
        <p className={styles.validationDialogMessage}>{mismatchReason}{mismatchQty}</p>
        {validationMismatchData?.errors && validationMismatchData.errors.length > 0 && (
          <div style={{ marginTop: '12px' }}>
            <strong>Validation errors:</strong>
            <ul style={{ margin: '6px 0 0 0', paddingLeft: '20px' }}>
              {validationMismatchData.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {validationMismatchData?.warnings && validationMismatchData.warnings.length > 0 && (
          <div style={{ marginTop: '8px', color: '#b45309' }}>
            <strong>Warnings:</strong>
            <ul style={{ margin: '6px 0 0 0', paddingLeft: '20px' }}>
              {validationMismatchData.warnings.slice(0, 10).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {validationMismatchData.warnings.length > 10 && <li>… and {validationMismatchData.warnings.length - 10} more</li>}
            </ul>
          </div>
        )}
        {validationMismatchData?.details?.lines && validationMismatchData.details.lines.length > 0 && (
          <div style={{ marginTop: '12px', overflowX: 'auto' }}>
            <strong>Line-level check:</strong>
            <table style={{ width: '100%', marginTop: '6px', fontSize: '12px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>#</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Item</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>Inv Qty</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>PO Qty</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>Inv Rate</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>PO Rate</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {validationMismatchData.details.lines.map((line) => (
                  <tr key={line.index} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '4px 8px' }}>{line.index}</td>
                    <td style={{ padding: '4px 8px', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }} title={line.itemName}>{line.itemName || '-'}</td>
                    <td style={{ textAlign: 'right', padding: '4px 8px' }}>{line.invQty != null ? line.invQty : '-'}</td>
                    <td style={{ textAlign: 'right', padding: '4px 8px' }}>{line.poQty != null ? line.poQty : '-'}</td>
                    <td style={{ textAlign: 'right', padding: '4px 8px' }}>{line.invRate != null ? line.invRate : '-'}</td>
                    <td style={{ textAlign: 'right', padding: '4px 8px' }}>{line.poRate != null ? line.poRate : '-'}</td>
                    <td style={{ padding: '4px 8px' }}>
                      {line.errors && line.errors.length > 0 ? <span style={{ color: '#dc2626' }}>Error</span> : line.quantityMatch && line.rateMatch !== false ? <span style={{ color: '#16a34a' }}>OK</span> : line.warnings && line.warnings.length > 0 ? <span style={{ color: '#b45309' }}>Warning</span> : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {validationMismatchData?.details?.header && (
          <div style={{ marginTop: '12px', fontSize: '12px' }}>
            <strong>Header:</strong> Supplier match: {validationMismatchData.details.header.supplierMatch === true ? 'Yes' : validationMismatchData.details.header.supplierMatch === false ? 'No' : '—'}
            {validationMismatchData.details.totals != null && (
              <> · Totals: Invoice qty {validationMismatchData.details.totals.thisInvQty ?? '—'}, PO qty {validationMismatchData.details.totals.poQty ?? '—'}, GRN qty {validationMismatchData.details.grn?.grnQty ?? '—'}</>
            )}
          </div>
        )}
        <p className={styles.validationDialogHint} style={{ marginTop: '12px' }}>
          Choose &quot;Confirm and proceed for payment&quot; to move this invoice to Approve Payments, or &quot;Send to debit note&quot; to handle the shortfall in Incomplete POs.
        </p>
      </Dialog>
      <div className={styles.pageContainer} id="main-content">
        <div className={styles.pageHeader}>
          <Breadcrumb items={[
            { label: 'Invoice Validate', path: '/invoices/validate' },
            { label: `Invoice ${invoice.invoice_number}` }
          ]} />
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Invoice Details</h1>
              <p className={styles.pageSubtitle}>Invoice Number: {invoice.invoice_number}</p>
            </div>
            <div className={styles.headerActions}>
              {(() => {
                const statusNorm = (invoice.status || '').toLowerCase().replace(/\s+/g, '_').trim()
                const alreadyValidatedOrInWorkflow = [
                  'validated',
                  'ready_for_payment',
                  'approved',
                  'rejected',
                  'paid',
                  'completed',
                  'partially_paid',
                  'debit_note_approval',
                  'exception_approval'
                ].includes(statusNorm)
                const canValidate = !alreadyValidatedOrInWorkflow
                return canValidate ? (
                  <Button
                    label={validationAttemptFailed ? 'Re-validate' : 'Validate'}
                    icon="pi pi-check-circle"
                    onClick={handleValidate}
                    loading={validating}
                    disabled={validating}
                    className={validationAttemptFailed ? styles.revalidateButton : styles.validateButton}
                    severity={validationAttemptFailed ? 'danger' : 'success'}
                  />
                ) : null
              })()}
              <PageNavigation backTo="/invoices/validate" />
            </div>
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
                  <span className={`${styles.statusBadge} ${styles[invoiceStatusClass(invoice.status)] || styles.waiting_for_validation}`}>
                    {invoiceStatusLabel(invoice.status)}
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
              {invoice.payment_due_date != null && (
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Payment Due Date:</span>
                  <span className={styles.detailValue}>{dateBodyTemplate(invoice.payment_due_date)}</span>
                </div>
              )}
              {(invoice.debit_note_value != null && invoice.debit_note_value !== 0) && (
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Debit Note Value:</span>
                  <span className={styles.detailValue}>{amountBodyTemplate(invoice.debit_note_value)}</span>
                </div>
              )}
              {invoice.notes && (
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Notes:</span>
                  <span className={styles.detailValue}>{invoice.notes}</span>
                </div>
              )}
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
                {invoice.bill_to_address && (
                  <div className={styles.detailItem}>
                    <span className={styles.detailLabel}>Bill To Address:</span>
                    <span className={styles.detailValue}>{invoice.bill_to_address}</span>
                  </div>
                )}
                {invoice.bill_to_gstin && (
                  <div className={styles.detailItem}>
                    <span className={styles.detailLabel}>Bill To GSTIN:</span>
                    <span className={styles.detailValue}>{invoice.bill_to_gstin}</span>
                  </div>
                )}
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>PO Status:</span>
                  <span className={styles.detailValue}>
                    <span className={`${styles.statusBadge} ${styles[invoice.po_status || 'open'] || styles.open}`}>
                      {poStatusLabel(invoice.po_status)}
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
        <div className="dts-section dts-section-accent">
          <h3 className="dts-sectionTitle">
            <i className="pi pi-list" style={{ marginRight: '0.5rem' }}></i>
            Invoice Line Items ({invoice.items.length})
          </h3>
          <div className="dts-tableWrapper">
            <div className="dts-tableContainer">
              <DataTable
                value={invoice.items}
                emptyMessage="No line items found"
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
                header="Quantity/Weight"
                style={{ minWidth: '120px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => {
                  const qty = rowData.billed_qty != null ? quantityBodyTemplate(rowData.billed_qty) : null
                  const wt = rowData.weight != null ? `${quantityBodyTemplate(rowData.weight)} kg` : null
                  if (qty && wt) return <span>{qty} / {wt}</span>
                  if (qty) return <span>{qty}</span>
                  if (wt) return <span>{wt}</span>
                  return '-'
                }}
              />
              <Column
                field="count"
                header="Count"
                style={{ minWidth: '80px', textAlign: 'right' }}
                body={(rowData: InvoiceLineItem) => rowData.count != null ? rowData.count : '-'}
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
                field="rate_per"
                header="Rate Per"
                style={{ minWidth: '90px' }}
                body={(rowData: InvoiceLineItem) => rowData.rate_per || '-'}
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
        </div>

        {/* PO Line Items */}
        {invoice.poLineItems && invoice.poLineItems.length > 0 && (
          <>
            <Divider />
            <div className="dts-section dts-section-accent">
              <h3 className="dts-sectionTitle">
                <i className="pi pi-list" style={{ marginRight: '0.5rem' }}></i>
                Purchase Order Line Items ({invoice.poLineItems.length})
              </h3>
              <div className="dts-tableWrapper">
                <div className="dts-tableContainer">
                  <DataTable
                    value={invoice.poLineItems}
                    emptyMessage="No PO line items found"
                    stripedRows
                    scrollable
                    scrollHeight="400px"
                  >
                  <Column
                    field="sequence_number"
                    header="#"
                    style={{ width: '50px', textAlign: 'center' }}
                    body={(rowData: POLineItem) => rowData.sequence_number ?? '-'}
                  />
                  <Column
                    field="item_id"
                    header="Item ID"
                    style={{ minWidth: '100px' }}
                    body={(rowData: POLineItem) => rowData.item_id ?? '-'}
                  />
                  <Column
                    field="item_name"
                    header="Item Name"
                    style={{ minWidth: '180px' }}
                    body={(rowData: POLineItem) => rowData.item_name ?? '-'}
                  />
                  <Column
                    field="item_description"
                    header="Description"
                    style={{ minWidth: '200px' }}
                    body={(rowData: POLineItem) => rowData.item_description ?? '-'}
                  />
                  <Column
                    field="quantity"
                    header="Qty"
                    style={{ minWidth: '90px', textAlign: 'right' }}
                    body={(rowData: POLineItem) => quantityBodyTemplate(rowData.quantity)}
                  />
                  <Column
                    field="unit_cost"
                    header="Unit Cost"
                    style={{ minWidth: '110px', textAlign: 'right' }}
                    body={(rowData: POLineItem) => amountBodyTemplate(rowData.unit_cost)}
                  />
                  <Column
                    field="disc_pct"
                    header="Disc %"
                    style={{ minWidth: '80px', textAlign: 'right' }}
                    body={(rowData: POLineItem) => rowData.disc_pct != null ? `${rowData.disc_pct}%` : '-'}
                  />
                  <Column
                    field="process_cost"
                    header="Process Cost"
                    style={{ minWidth: '120px', textAlign: 'right' }}
                    body={(rowData: POLineItem) => amountBodyTemplate(rowData.process_cost)}
                  />
                  <Column
                    field="raw_material"
                    header="Raw Material"
                    style={{ minWidth: '140px' }}
                    body={(rowData: POLineItem) => rowData.raw_material ?? '-'}
                  />
                  <Column
                    field="process_description"
                    header="Process Description"
                    style={{ minWidth: '180px' }}
                    body={(rowData: POLineItem) => rowData.process_description ?? '-'}
                  />
                  <Column
                    field="norms"
                    header="Norms"
                    style={{ minWidth: '120px' }}
                    body={(rowData: POLineItem) => rowData.norms ?? '-'}
                  />
                  </DataTable>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default InvoiceDetails
