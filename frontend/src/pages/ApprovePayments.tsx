import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Dialog } from 'primereact/dialog'
import { InputText } from 'primereact/inputtext'
import { apiFetch, apiUrl, getErrorMessageFromResponse } from '../utils/api'
import styles from './ApprovePayments.module.css'

interface GrnItem {
  id: number
  grn_no: string | null
  grn_date: string | null
  dc_no: string | null
  dc_date: string | null
  grn_qty?: number
  accepted_qty?: number
  unit_cost?: number
}

interface AsnItem {
  id: number
  asn_no: string | null
  dc_no: string | null
  dc_date: string | null
  inv_no: string | null
  inv_date: string | null
  lr_no: string | null
  transporter_name: string | null
}

interface PendingApproval {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  total_amount: number
  tax_amount: number
  status: string
  payment_due_date: string | null
  debit_note_value: number | null
  po_id: number | null
  supplier_id: number | null
  po_number: string | null
  supplier_name: string | null
  supplier_gst: string | null
  supplier_pan: string | null
  supplier_address: string | null
  supplier_email: string | null
  supplier_phone: string | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_ifsc_code: string | null
  bank_name: string | null
  branch_name: string | null
  po_number_ref: string | null
  po_date: string | null
  po_terms: string | null
  po_status: string | null
  payment_approval_id: number | null
  payment_approval_status: string | null
  grn_list: GrnItem[]
  asn_list: AsnItem[]
}

function ApprovePayments() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [list, setList] = useState<PendingApproval[]>([])
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; item: PendingApproval | null }>({ open: false, item: null })
  const [rejectionReason, setRejectionReason] = useState('')
  const [modifyDialog, setModifyDialog] = useState<{ open: boolean; item: PendingApproval | null }>({ open: false, item: null })
  const [modifyBank, setModifyBank] = useState({
    bank_account_name: '',
    bank_account_number: '',
    bank_ifsc_code: '',
    bank_name: '',
    branch_name: ''
  })

  const fetchPending = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('payments/pending-approval')
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to fetch pending approvals')
        throw new Error(msg)
      }
      const data = await res.json()
      setList(data)
      setExpandedRows({})
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load pending approvals'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPending()
  }, [])

  const handleApprove = async (item: PendingApproval) => {
    setActionLoading(`approve-${item.invoice_id}`)
    try {
      const res = await apiFetch('payments/approve', {
        method: 'POST',
        body: JSON.stringify({ invoiceId: item.invoice_id })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message || 'Approve failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Approved', detail: 'Payment approved. It will appear in Ready for Payments.', life: 4000 })
      await fetchPending()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Approve failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setActionLoading(null)
    }
  }

  const handleApproveWithModify = async () => {
    const item = modifyDialog.item
    if (!item) return
    setActionLoading(`modify-${item.invoice_id}`)
    try {
      const res = await apiFetch('payments/approve', {
        method: 'POST',
        body: JSON.stringify({
          invoiceId: item.invoice_id,
          bank_account_name: modifyBank.bank_account_name || undefined,
          bank_account_number: modifyBank.bank_account_number || undefined,
          bank_ifsc_code: modifyBank.bank_ifsc_code || undefined,
          bank_name: modifyBank.bank_name || undefined,
          branch_name: modifyBank.branch_name || undefined
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message || 'Approve failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Approved', detail: 'Payment approved with modified banking. It will appear in Ready for Payments.', life: 4000 })
      setModifyDialog({ open: false, item: null })
      setModifyBank({ bank_account_name: '', bank_account_number: '', bank_ifsc_code: '', bank_name: '', branch_name: '' })
      await fetchPending()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Approve failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setActionLoading(null)
    }
  }

  const openModify = (item: PendingApproval) => {
    setModifyBank({
      bank_account_name: item.bank_account_name || '',
      bank_account_number: item.bank_account_number || '',
      bank_ifsc_code: item.bank_ifsc_code || '',
      bank_name: item.bank_name || '',
      branch_name: item.branch_name || ''
    })
    setModifyDialog({ open: true, item })
  }

  const handleReject = async () => {
    const item = rejectDialog.item
    if (!item) return
    setActionLoading(`reject-${item.invoice_id}`)
    try {
      const res = await apiFetch('payments/reject', {
        method: 'PATCH',
        body: JSON.stringify({ invoiceId: item.invoice_id, rejection_reason: rejectionReason })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message || 'Reject failed')
      }
      toast.current?.show({ severity: 'info', summary: 'Rejected', detail: 'Payment rejected.', life: 4000 })
      setRejectDialog({ open: false, item: null })
      setRejectionReason('')
      await fetchPending()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Reject failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setActionLoading(null)
    }
  }

  const amountDisplay = (row: PendingApproval) => {
    const amt = row.debit_note_value != null ? row.debit_note_value : row.total_amount
    return amt != null ? `₹${Number(amt).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'
  }

  const dateDisplay = (d: string | null) => {
    if (!d) return '-'
    return new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const rowExpansionTemplate = (row: PendingApproval) => (
    <div className={styles.expandedContent}>
      <div className={styles.sectionTitle}>Supplier</div>
      <div className={styles.detailGrid}>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Name</span><span className={styles.detailValue}>{row.supplier_name || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>GST</span><span className={styles.detailValue}>{row.supplier_gst || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PAN</span><span className={styles.detailValue}>{row.supplier_pan || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Address</span><span className={styles.detailValue}>{row.supplier_address || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Email / Phone</span><span className={styles.detailValue}>{[row.supplier_email, row.supplier_phone].filter(Boolean).join(' / ') || '-'}</span></div>
      </div>
      <div className={styles.sectionTitle}>Banking details</div>
      <div className={styles.bankingBlock}>
        <table className={styles.miniTable}>
          <tbody>
            <tr><th>Account name</th><td>{row.bank_account_name || '-'}</td></tr>
            <tr><th>Account number</th><td>{row.bank_account_number || '-'}</td></tr>
            <tr><th>IFSC</th><td>{row.bank_ifsc_code || '-'}</td></tr>
            <tr><th>Bank / Branch</th><td>{[row.bank_name, row.branch_name].filter(Boolean).join(' — ') || '-'}</td></tr>
          </tbody>
        </table>
      </div>
      <div className={styles.sectionTitle}>PO</div>
      <div className={styles.detailGrid}>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PO Number</span><span className={styles.detailValue}>{row.po_number_ref || row.po_number || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PO Date</span><span className={styles.detailValue}>{dateDisplay(row.po_date)}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Terms</span><span className={styles.detailValue}>{row.po_terms || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Status</span><span className={styles.detailValue}>{row.po_status || '-'}</span></div>
      </div>
      {row.grn_list && row.grn_list.length > 0 && (
        <>
          <div className={styles.sectionTitle}>GRN</div>
          <table className={styles.miniTable}>
            <thead>
              <tr>
                <th>GRN No</th>
                <th>Date</th>
                <th>DC No</th>
                <th>DC Date</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {row.grn_list.map((g) => (
                <tr key={g.id}>
                  <td>{g.grn_no ?? '-'}</td>
                  <td>{dateDisplay(g.grn_date)}</td>
                  <td>{g.dc_no ?? '-'}</td>
                  <td>{dateDisplay(g.dc_date)}</td>
                  <td>{g.grn_qty ?? g.accepted_qty ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {row.asn_list && row.asn_list.length > 0 && (
        <>
          <div className={styles.sectionTitle}>ASN</div>
          <table className={styles.miniTable}>
            <thead>
              <tr>
                <th>ASN No</th>
                <th>DC No</th>
                <th>DC Date</th>
                <th>LR No</th>
                <th>Transporter</th>
              </tr>
            </thead>
            <tbody>
              {row.asn_list.map((a) => (
                <tr key={a.id}>
                  <td>{a.asn_no ?? '-'}</td>
                  <td>{a.dc_no ?? '-'}</td>
                  <td>{dateDisplay(a.dc_date)}</td>
                  <td>{a.lr_no ?? '-'}</td>
                  <td>{a.transporter_name ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className={styles.actionButtons} style={{ marginTop: '1rem' }}>
        <Button label="Approve" icon="pi pi-check" severity="success" size="small" className={styles.actionButton}
          loading={actionLoading === `approve-${row.invoice_id}`} disabled={!!actionLoading}
          onClick={() => handleApprove(row)} />
        <Button label="Modify & Approve" icon="pi pi-pencil" size="small" className={styles.actionButton}
          loading={actionLoading === `modify-${row.invoice_id}`} disabled={!!actionLoading}
          onClick={() => openModify(row)} />
        <Button label="Reject" icon="pi pi-times" severity="danger" size="small" className={styles.actionButton}
          loading={actionLoading === `reject-${row.invoice_id}`} disabled={!!actionLoading}
          onClick={() => { setRejectionReason(''); setRejectDialog({ open: true, item: row }) }} />
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} />
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Approve Payments</h1>
            <p className={styles.subtitle}>Review validated invoices with PO, supplier, GRN, ASN and banking details. Approve, modify banking and approve, or reject.</p>
          </div>
          <PageNavigation />
        </div>

        <div className={styles.tableContainer}>
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading pending approvals...</p>
            </div>
          ) : list.length === 0 ? (
            <div className={styles.emptyState}>
              <h2>No pending approvals</h2>
              <p>This page shows only invoices that are <strong>Ready for Payment</strong>. Invoices get that status after you validate them on Invoice Details (match with PO/GRN).</p>
              <p>Go to <strong>Invoice Management → Invoice Details</strong>, open an invoice linked to a PO with GRN/ASN, and click <strong>Validate</strong>. Once the invoice status becomes &quot;Ready for Payment&quot;, it will appear here for manager approval.</p>
              <Button label="Go to Invoice Details" icon="pi pi-arrow-right" onClick={() => navigate('/invoices/validate')} className={styles.emptyStateButton} />
            </div>
          ) : (
            <DataTable
              value={list}
              dataKey="invoice_id"
              expandedRows={expandedRows}
              onRowToggle={(e) => setExpandedRows(e.data as Record<number, boolean>)}
              rowExpansionTemplate={rowExpansionTemplate}
              className={styles.dataTable}
              stripedRows
              size="small"
            >
              <Column expander style={{ width: '3rem' }} />
              <Column field="invoice_number" header="Invoice" sortable style={{ minWidth: '140px' }} />
              <Column field="po_number_ref" header="PO Number" sortable body={(r) => r.po_number_ref || r.po_number || '-'} style={{ minWidth: '120px' }} />
              <Column field="supplier_name" header="Supplier" sortable style={{ minWidth: '180px' }} />
              <Column header="Amount" body={amountDisplay} sortable sortField="total_amount" style={{ minWidth: '120px', textAlign: 'right' }} />
              <Column header="Due date" body={(r) => dateDisplay(r.payment_due_date)} sortable sortField="payment_due_date" style={{ minWidth: '110px' }} />
            </DataTable>
          )}
        </div>
      </div>

      <Dialog header="Reject payment" visible={rejectDialog.open} onHide={() => setRejectDialog({ open: false, item: null })}
        style={{ width: '400px' }} footer={
          <div className={styles.dialogActions}>
            <Button label="Cancel" severity="secondary" onClick={() => setRejectDialog({ open: false, item: null })} />
            <Button label="Reject" severity="danger" onClick={handleReject} loading={!!actionLoading} />
          </div>
        }>
        <div className={styles.dialogForm}>
          <div className={styles.dialogField}>
            <label>Rejection reason (optional)</label>
            <InputText value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} placeholder="Reason for rejection" />
          </div>
        </div>
      </Dialog>

      <Dialog header="Modify banking & approve" visible={modifyDialog.open} onHide={() => { setModifyDialog({ open: false, item: null }); setModifyBank({ bank_account_name: '', bank_account_number: '', bank_ifsc_code: '', bank_name: '', branch_name: '' }) }}
        style={{ width: '480px' }} footer={
          <div className={styles.dialogActions}>
            <Button label="Cancel" severity="secondary" onClick={() => setModifyDialog({ open: false, item: null })} />
            <Button label="Approve with these details" severity="success" onClick={handleApproveWithModify} loading={!!actionLoading} />
          </div>
        }>
        <div className={styles.dialogForm}>
          <div className={styles.dialogField}>
            <label>Account name</label>
            <InputText value={modifyBank.bank_account_name} onChange={(e) => setModifyBank((p) => ({ ...p, bank_account_name: e.target.value }))} />
          </div>
          <div className={styles.dialogField}>
            <label>Account number</label>
            <InputText value={modifyBank.bank_account_number} onChange={(e) => setModifyBank((p) => ({ ...p, bank_account_number: e.target.value }))} />
          </div>
          <div className={styles.dialogField}>
            <label>IFSC</label>
            <InputText value={modifyBank.bank_ifsc_code} onChange={(e) => setModifyBank((p) => ({ ...p, bank_ifsc_code: e.target.value }))} />
          </div>
          <div className={styles.dialogField}>
            <label>Bank name</label>
            <InputText value={modifyBank.bank_name} onChange={(e) => setModifyBank((p) => ({ ...p, bank_name: e.target.value }))} />
          </div>
          <div className={styles.dialogField}>
            <label>Branch name</label>
            <InputText value={modifyBank.branch_name} onChange={(e) => setModifyBank((p) => ({ ...p, branch_name: e.target.value }))} />
          </div>
        </div>
      </Dialog>
    </div>
  )
}

export default ApprovePayments
