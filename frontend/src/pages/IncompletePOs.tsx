import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Badge } from 'primereact/badge'
import { InputNumber } from 'primereact/inputnumber'
import { Toast } from 'primereact/toast'
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl, apiFetch } from '../utils/api'
import styles from './IncompletePOs.module.css'

interface IncompletePO {
  po_id: number
  po_number: string
  po_date: string
  po_status?: string
  supplier_name: string | null
  has_invoice: boolean
  has_grn: boolean
  has_asn: boolean
  missing_items: string[]
  pending_invoice_id?: number | null
  pending_invoice_status?: string | null
}

interface PODetailForExpand {
  po: { po_id: number; po_number: string; po_date: string; status: string; supplier_name: string | null; terms: string | null; unit: string | null; [key: string]: unknown }
  lineItems: Array<{ po_line_id: number; sequence_number: number; item_id: string | null; description1: string | null; qty: number | null; unit_cost: number | null }>
  validation?: { reason?: string; thisInvQty?: number; poQty?: number; grnQty?: number; validationFailureReason?: string }
}

interface PendingDebitNote {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  total_amount: number
  status: string
  po_id: number | null
  po_number: string | null
  supplier_name: string
  debit_note_file_name?: string | null
  validation: {
    reason?: string
    thisInvQty?: number
    poQty?: number
    grnQty?: number
  }
}

interface PendingException {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  total_amount: number
  status: string
  po_id: number | null
  po_number: string | null
  supplier_name: string
  validation: { reason?: string }
}

function IncompletePOs() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [incompletePOs, setIncompletePOs] = useState<IncompletePO[]>([])
  const [debitNoteInvoices, setDebitNoteInvoices] = useState<PendingDebitNote[]>([])
  const [exceptionInvoices, setExceptionInvoices] = useState<PendingException[]>([])
  const [loading, setLoading] = useState(true)
  const [debitNoteApprovingId, setDebitNoteApprovingId] = useState<number | null>(null)
  const [exceptionApprovingId, setExceptionApprovingId] = useState<number | null>(null)
  const [debitNoteValues, setDebitNoteValues] = useState<Record<number, number>>({})
  const [debitNoteUploadingId, setDebitNoteUploadingId] = useState<number | null>(null)
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
  const [expandedDetails, setExpandedDetails] = useState<Record<number, PODetailForExpand>>({})
  const [loadingDetailId, setLoadingDetailId] = useState<number | null>(null)
  const fileInputRefs = useRef<Record<number, HTMLInputElement | null>>({})

  useEffect(() => {
    fetchAll()
  }, [])

  const fetchIncompletePOs = async () => {
    const token = localStorage.getItem('authToken')
    const response = await fetch(apiUrl('purchase-orders/incomplete'), {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    if (!response.ok) throw new Error('Failed to fetch incomplete purchase orders')
    const data = await response.json()
    setIncompletePOs(data)
  }

  const fetchDebitNoteInvoices = async () => {
    try {
      const res = await apiFetch('invoices/pending-debit-note')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 403) {
          toast.current?.show({ severity: 'warn', summary: 'Access', detail: 'You do not have permission to view debit note list.', life: 5000 })
        } else {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: (err as { message?: string }).message || 'Failed to load debit note list.', life: 5000 })
        }
        setDebitNoteInvoices([])
        return
      }
      const data = await res.json()
      setDebitNoteInvoices(Array.isArray(data) ? data : [])
      const defaults: Record<number, number> = {}
      ;(Array.isArray(data) ? data : []).forEach((inv: PendingDebitNote) => {
        defaults[inv.invoice_id] = inv.total_amount ?? 0
      })
      setDebitNoteValues((prev) => ({ ...defaults, ...prev }))
    } catch (e) {
      setDebitNoteInvoices([])
      toast.current?.show({ severity: 'error', summary: 'Error', detail: e instanceof Error ? e.message : 'Failed to load debit note list.', life: 5000 })
    }
  }

  const fetchExceptionInvoices = async () => {
    try {
      const res = await apiFetch('invoices/pending-exception')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 403) {
          toast.current?.show({ severity: 'warn', summary: 'Access', detail: 'You do not have permission to view exception invoices.', life: 5000 })
        } else {
          toast.current?.show({ severity: 'error', summary: 'Error', detail: (err as { message?: string }).message || 'Failed to load exception invoices.', life: 5000 })
        }
        setExceptionInvoices([])
        return
      }
      const data = await res.json()
      setExceptionInvoices(Array.isArray(data) ? data : [])
    } catch (e) {
      setExceptionInvoices([])
      toast.current?.show({ severity: 'error', summary: 'Error', detail: e instanceof Error ? e.message : 'Failed to load exception invoices.', life: 5000 })
    }
  }

  const fetchAll = async () => {
    try {
      setLoading(true)
      await Promise.all([fetchIncompletePOs(), fetchDebitNoteInvoices(), fetchExceptionInvoices()])
    } catch (e) {
      toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to load data', life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  const confirmDebitNoteApprove = (invoiceId: number) => {
    confirmDialog({
      message: 'Are you sure you want to approve this debit note and send to payments?',
      header: 'Confirm send to payments',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleDebitNoteApprove(invoiceId),
      reject: () => {}
    })
  }

  const confirmExceptionApprove = (invoiceId: number) => {
    confirmDialog({
      message: 'Are you sure you want to approve this exception invoice and send to payments?',
      header: 'Confirm send to payments',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleExceptionApprove(invoiceId),
      reject: () => {}
    })
  }

  const handleExceptionApprove = async (invoiceId: number) => {
    setExceptionApprovingId(invoiceId)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/exception-approve`, { method: 'PATCH' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { message?: string }).message || 'Exception approve failed')
      }
      toast.current?.show({
        severity: 'success',
        summary: 'Exception approved',
        detail: 'Invoice moved to Ready for Payment. You can approve payment from Approve Payments.',
        life: 5000
      })
      await Promise.all([fetchExceptionInvoices(), fetchDebitNoteInvoices()])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Exception approve failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setExceptionApprovingId(null)
    }
  }

  const handleDebitNoteApprove = async (invoiceId: number) => {
    const value = debitNoteValues[invoiceId] ?? undefined
    setDebitNoteApprovingId(invoiceId)
    try {
      const res = await apiFetch(`invoices/${invoiceId}/debit-note-approve`, {
        method: 'PATCH',
        body: JSON.stringify({ debit_note_value: value })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message || 'Approve failed')
      }
      toast.current?.show({
        severity: 'success',
        summary: 'Debit note approved',
        detail: 'Invoice moved to Ready for Payment. You can approve payment from Approve Payments.',
        life: 5000
      })
      await fetchAll()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Approve failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setDebitNoteApprovingId(null)
    }
  }

  const handleDebitNotePdfUpload = async (invoiceId: number, file: File) => {
    if (!file || file.type !== 'application/pdf') {
      toast.current?.show({ severity: 'warn', summary: 'Invalid file', detail: 'Please select a PDF file.', life: 4000 })
      return
    }
    setDebitNoteUploadingId(invoiceId)
    try {
      const token = localStorage.getItem('authToken')
      const formData = new FormData()
      formData.append('pdf', file)
      const res = await fetch(apiUrl(`invoices/${invoiceId}/debit-note-pdf`), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message || err.error || 'Upload failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Uploaded', detail: 'Debit note PDF saved.', life: 4000 })
      await fetchDebitNoteInvoices()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setDebitNoteUploadingId(null)
    }
  }

  const openDebitNotePdf = (invoiceId: number) => {
    const token = localStorage.getItem('authToken')
    fetch(apiUrl(`invoices/${invoiceId}/debit-note-pdf`), { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => {
        if (!res.ok) throw new Error('Not found')
        return res.blob()
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank', 'noopener')
      })
      .catch(() => toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Could not open debit note PDF.', life: 4000 }))
  }

  const missingItemsTemplate = (rowData: IncompletePO) => {
    const items = Array.isArray(rowData.missing_items) ? rowData.missing_items : []
    return (
      <div className={styles.missingItems}>
        {items.length === 0 ? (
          <span className={styles.noMissing}>—</span>
        ) : (
          items.map((item, index) => (
            <Badge
              key={index}
              value={item}
              severity="warning"
              className={styles.missingBadge}
            />
          ))
        )}
      </div>
    )
  }

  const showInlineDetail = (row: IncompletePO) =>
    row.po_status === 'partially_fulfilled' || !!row.pending_invoice_id

  const loadPODetail = async (row: IncompletePO): Promise<PODetailForExpand> => {
    const token = localStorage.getItem('authToken')
    const poRes = await fetch(apiUrl(`purchase-orders/${encodeURIComponent(row.po_number)}`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    if (!poRes.ok) throw new Error('Failed to load PO details')
    const poData = await poRes.json()
    let validation: PODetailForExpand['validation']
    if (row.pending_invoice_id) {
      try {
        const vRes = await apiFetch(`invoices/${row.pending_invoice_id}/validation-summary`)
        if (vRes.ok) validation = await vRes.json()
      } catch {
        validation = undefined
      }
    }
    return { po: poData, lineItems: poData.lineItems || poData.items || [], validation }
  }

  const handleViewPO = (row: IncompletePO) => {
    if (showInlineDetail(row)) {
      const isExpanded = !!expandedRows[row.po_id]
      if (isExpanded) {
        setExpandedRows((prev) => ({ ...prev, [row.po_id]: false }))
        setExpandedDetails((prev) => {
          const next = { ...prev }
          delete next[row.po_id]
          return next
        })
      } else {
        setExpandedRows((prev) => ({ ...prev, [row.po_id]: true }))
        if (!expandedDetails[row.po_id]) {
          setLoadingDetailId(row.po_id)
          loadPODetail(row)
            .then((detail) => setExpandedDetails((prev) => ({ ...prev, [row.po_id]: detail })))
            .catch(() => toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to load PO details', life: 5000 }))
            .finally(() => setLoadingDetailId(null))
        }
      }
    } else {
      navigate(`/purchase-orders/upload`, { state: { poId: row.po_id } })
    }
  }

  const actionTemplate = (rowData: IncompletePO) => (
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
        {!rowData.has_grn && (
          <Button
            label="GRN"
            icon="pi pi-box"
            size="small"
            outlined
            disabled
            title="GRN entry coming soon"
            className={styles.actionButton}
          />
        )}
        {!rowData.has_asn && (
          <Button
            label="ASN"
            icon="pi pi-truck"
            size="small"
            outlined
            disabled
            title="ASN entry coming soon"
            className={styles.actionButton}
          />
        )}
        <Button
          label={showInlineDetail(rowData) ? (expandedRows[rowData.po_id] ? 'Hide details' : 'View details') : 'View PO'}
          icon="pi pi-eye"
          size="small"
          outlined
          onClick={() => handleViewPO(rowData)}
          className={styles.viewButton}
        />
      </div>
    )

  const statusTemplate = (rowData: IncompletePO) => {
    const s = rowData.po_status || 'open'
    const label = s === 'partially_fulfilled' ? 'Partially Fulfilled' : s === 'fulfilled' ? 'Fulfilled' : 'Open'
    const severity = s === 'partially_fulfilled' ? 'warning' : s === 'fulfilled' ? 'success' : 'info'
    return <Badge value={label} severity={severity} />
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
      <Toast ref={toast} />
      <ConfirmDialog />
      <Header />
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerTitleBlock}>
            <h1 className={styles.title}>Incomplete Purchase Orders</h1>
            <p className={styles.subtitle}>Debit notes, exceptions, and open POs</p>
          </div>
          <div className={styles.headerActions}>
            <PageNavigation onRefresh={fetchAll} refreshLoading={loading} />
          </div>
        </div>

        {/* Debit note approval section - always show so user knows where to find debit note POs */}
        <div className={`dts-section dts-section-accent ${styles.debitNoteSection}`}>
          <h2 className="dts-sectionTitle">Debit note approval</h2>
          <p className="dts-sectionSubtitle">
            Invoices in debit note status (quantity mismatch or GRN &lt; invoice). Upload debit note PDF, enter amount to pay, and approve to move to Ready for Payment.
          </p>
          {debitNoteInvoices.length === 0 ? (
            <div className="dts-emptySection">
              <p>No invoices awaiting debit note approval. Invoices that fail validation (e.g. GRN qty &lt; invoice qty) appear here after you click Validate on Invoice Details.</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={debitNoteInvoices}
                  paginator
                  rows={10}
                  rowsPerPageOptions={[5, 10, 25]}
                  emptyMessage="No debit note invoices"
                  stripedRows
                >
                  <Column field="invoice_number" header="Invoice" sortable className={styles.colInvoice} />
                  <Column field="po_number" header="PO Number" sortable className={styles.colPoNumber} />
                  <Column field="supplier_name" header="Supplier" sortable className={styles.colSupplier} />
                  <Column
                    header="Reason"
                    body={(row: PendingDebitNote) => (
                      <span className="dts-reasonText" title={row.validation?.reason}>
                        {row.validation?.reason || '—'}
                      </span>
                    )}
                    className={styles.colReason}
                  />
                <Column
                  header="Quantities"
                  body={(row: PendingDebitNote) => {
                    const v = row.validation
                    if (v?.thisInvQty == null && v?.poQty == null && v?.grnQty == null) return '—'
                    return `Inv: ${v?.thisInvQty ?? '—'} | PO: ${v?.poQty ?? '—'} | GRN: ${v?.grnQty ?? '—'}`
                  }}
                  className={styles.colQuantities}
                />
                <Column
                  header="Amount to pay"
                  body={(row: PendingDebitNote) => (
                    <InputNumber
                      value={debitNoteValues[row.invoice_id] ?? row.total_amount}
                      onValueChange={(e) =>
                        setDebitNoteValues((prev) => ({ ...prev, [row.invoice_id]: e.value ?? 0 }))
                      }
                      mode="currency"
                      currency="INR"
                      locale="en-IN"
                      minFractionDigits={2}
                      maxFractionDigits={2}
                      className={styles.debitNoteInput}
                    />
                  )}
                  className={styles.colAmount}
                />
                <Column
                  header="Debit note PDF"
                  body={(row: PendingDebitNote) => (
                    <div className={styles.debitNotePdfCell}>
                      <input
                        type="file"
                        accept=".pdf,application/pdf"
                        ref={(el) => { fileInputRefs.current[row.invoice_id] = el }}
                        className={styles.hiddenFileInput}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) handleDebitNotePdfUpload(row.invoice_id, file)
                          e.target.value = ''
                        }}
                      />
                      {row.debit_note_file_name ? (
                        <span className={styles.debitNotePdfLinks}>
                          <button type="button" className={styles.debitNotePdfLink} onClick={() => openDebitNotePdf(row.invoice_id)} title="View PDF">
                            {row.debit_note_file_name}
                          </button>
                          <Button icon="pi pi-upload" size="small" outlined title="Replace PDF" loading={debitNoteUploadingId === row.invoice_id} onClick={() => fileInputRefs.current[row.invoice_id]?.click()} className={styles.uploadIconBtn} />
                        </span>
                      ) : (
                        <Button icon="pi pi-upload" size="small" outlined tooltip="Upload PDF" tooltipOptions={{ position: 'top' }} loading={debitNoteUploadingId === row.invoice_id} onClick={() => fileInputRefs.current[row.invoice_id]?.click()} className={styles.uploadIconBtn} />
                      )}
                    </div>
                  )}
                  className={styles.colDebitNotePdf}
                />
                <Column
                  header="Actions"
                  body={(row: PendingDebitNote) => (
                    <div className="dts-actionButtons">
                      <Button
                        icon="pi pi-eye"
                        size="small"
                        outlined
                        tooltip="View invoice"
                        tooltipOptions={{ position: 'top' }}
                        onClick={() => navigate(`/invoices/validate/${row.invoice_id}`)}
                        className="dts-iconBtn"
                      />
                      <Button
                        icon="pi pi-check"
                        size="small"
                        severity="success"
                        tooltip="Approve debit note"
                        tooltipOptions={{ position: 'top' }}
                        loading={debitNoteApprovingId === row.invoice_id}
                        disabled={debitNoteApprovingId !== null}
                        onClick={() => confirmDebitNoteApprove(row.invoice_id)}
                        className="dts-iconBtn"
                      />
                    </div>
                  )}
                  className={styles.colActions}
                />
              </DataTable>
              </div>
            </div>
          )}
        </div>

        {/* Exception invoices: received after PO was already fulfilled */}
        <div className={`dts-section dts-section-accent ${styles.debitNoteSection}`}>
          <h2 className="dts-sectionTitle">Exception invoices</h2>
          <p className="dts-sectionSubtitle">
            Invoices received after the PO was already fulfilled. Review and approve to send to Ready for Payment.
          </p>
          {exceptionInvoices.length === 0 ? (
            <div className="dts-emptySection">
              <p>No exception invoices. These appear when an invoice is validated for a PO that is already fulfilled.</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={exceptionInvoices}
                  paginator
                  rows={10}
                  rowsPerPageOptions={[5, 10, 25]}
                  emptyMessage="No exception invoices"
                  stripedRows
                >
                  <Column field="invoice_number" header="Invoice" sortable className={styles.colInvoice} />
                  <Column field="po_number" header="PO Number" sortable body={(r: PendingException) => r.po_number ?? '—'} className={styles.colPoNumber} />
                  <Column field="supplier_name" header="Supplier" sortable className={styles.colSupplier} />
                  <Column
                    header="Amount"
                    body={(row: PendingException) =>
                      row.total_amount != null
                        ? `₹${Number(row.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '—'
                    }
                    sortable
                    sortField="total_amount"
                    className={styles.colAmount}
                  />
                  <Column
                    header="Reason"
                    body={(row: PendingException) => (
                      <span className="dts-reasonText" title={row.validation?.reason}>
                        {row.validation?.reason || 'PO already fulfilled'}
                      </span>
                    )}
                    className={styles.colReason}
                  />
                  <Column
                    header="Actions"
                    body={(row: PendingException) => (
                      <div className="dts-actionButtons">
                        <Button
                          icon="pi pi-eye"
                          size="small"
                          outlined
                          tooltip="View invoice"
                          tooltipOptions={{ position: 'top' }}
                          onClick={() => navigate(`/invoices/validate/${row.invoice_id}`)}
                          className="dts-iconBtn"
                        />
                        <Button
                          icon="pi pi-check"
                          size="small"
                          severity="success"
                          tooltip="Approve exception"
                          tooltipOptions={{ position: 'top' }}
                          loading={exceptionApprovingId === row.invoice_id}
                          disabled={exceptionApprovingId !== null}
                          onClick={() => confirmExceptionApprove(row.invoice_id)}
                          className="dts-iconBtn"
                        />
                      </div>
                    )}
                    className={styles.colActions}
                  />
                </DataTable>
              </div>
            </div>
          )}
        </div>

        {/* Same section/table CSS as Exception invoices block */}
        <div className={`dts-section dts-section-accent ${styles.debitNoteSection}`}>
          <h2 className="dts-sectionTitle">Incomplete purchase orders</h2>
          <p className="dts-sectionSubtitle">
            Open POs missing Invoice, GRN, or ASN. PO remains open until all invoices are in the system.
          </p>
          <div className="dts-tableWrapper">
            <div className="dts-tableContainer">
              <DataTable
                value={incompletePOs}
                dataKey="po_id"
                expandedRows={expandedRows}
                onRowToggle={(e) => {
                  const next = e.data as Record<number, boolean>
                  setExpandedRows(next)
                  Object.keys(next).forEach((k) => {
                    const poId = Number(k)
                    if (next[poId] && !expandedDetails[poId]) {
                      const row = incompletePOs.find((r) => r.po_id === poId)
                      if (row && showInlineDetail(row)) {
                        setLoadingDetailId(poId)
                        loadPODetail(row)
                          .then((d) => setExpandedDetails((p) => ({ ...p, [poId]: d })))
                          .catch(() => toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to load PO details', life: 5000 }))
                          .finally(() => setLoadingDetailId(null))
                      }
                    }
                  })
                }}
                rowExpansionTemplate={(row: IncompletePO) => {
                  const detail = expandedDetails[row.po_id]
                  const loading = loadingDetailId === row.po_id
                  const reason = detail?.validation?.reason || detail?.validation?.validationFailureReason
                  const statusLabel = row.pending_invoice_status === 'waiting_for_re_validation' ? 'Waiting for re-validation' : row.pending_invoice_status === 'debit_note_approval' ? 'Debit note approval' : row.pending_invoice_status === 'exception_approval' ? 'Exception approval' : row.po_status === 'partially_fulfilled' ? 'Partially fulfilled' : ''
                  return (
                    <div className={styles.expandedDetail}>
                      {loading ? (
                        <div className={styles.expandedLoading}><ProgressSpinner style={{ width: '32px', height: '32px' }} /></div>
                      ) : detail ? (
                        <>
                          {statusLabel && <div className={styles.expandedReasonHeader}>{statusLabel}</div>}
                          {reason && <div className={styles.expandedReason} title={reason}>{reason}</div>}
                          {detail.validation && (detail.validation.thisInvQty != null || detail.validation.poQty != null || detail.validation.grnQty != null) && (
                            <div className={styles.expandedQty}>Invoice: {detail.validation.thisInvQty ?? '—'} | PO: {detail.validation.poQty ?? '—'} | GRN: {detail.validation.grnQty ?? '—'}</div>
                          )}
                          <div className={styles.expandedPoHeader}>
                            <span><strong>PO:</strong> {detail.po.po_number}</span>
                            <span><strong>Date:</strong> {detail.po.po_date ? new Date(detail.po.po_date).toLocaleDateString() : '—'}</span>
                            <span><strong>Supplier:</strong> {detail.po.supplier_name ?? '—'}</span>
                            <span><strong>Status:</strong> {detail.po.status}</span>
                            {detail.po.terms && <span><strong>Terms:</strong> {detail.po.terms}</span>}
                          </div>
                          <div className={styles.expandedLineItems}>
                            <strong>Line items</strong>
                            <table className={styles.miniTable}>
                              <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit cost</th></tr></thead>
                              <tbody>
                                {(detail.lineItems || detail.po?.items || []).map((line) => (
                                  <tr key={line.po_line_id}>
                                    <td>{line.sequence_number}</td>
                                    <td>{line.description1 || line.item_id || '—'}</td>
                                    <td>{line.qty ?? '—'}</td>
                                    <td>{line.unit_cost != null ? Number(line.unit_cost).toLocaleString() : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {row.pending_invoice_id && (
                            <Button label="Open invoice" icon="pi pi-file" size="small" onClick={() => navigate(`/invoices/validate/${row.pending_invoice_id}`)} className={styles.actionButton} />
                          )}
                        </>
                      ) : null}
                    </div>
                  )
                }}
                paginator
                rows={10}
                rowsPerPageOptions={[10, 25, 50]}
                emptyMessage="No incomplete purchase orders found"
                stripedRows
              >
                <Column expander style={{ width: '3rem' }} />
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
                  field="po_status"
                  header="PO Status"
                  body={statusTemplate}
                  style={{ minWidth: '140px' }}
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
          </div>
        </div>

        {incompletePOs.length === 0 && debitNoteInvoices.length === 0 && !loading && (
          <div className={styles.emptyState}>
            <i className="pi pi-check-circle" style={{ fontSize: '4rem', color: '#059669' }}></i>
            <h2>Nothing pending</h2>
            <p>No incomplete POs and no invoices awaiting debit note approval.</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default IncompletePOs
