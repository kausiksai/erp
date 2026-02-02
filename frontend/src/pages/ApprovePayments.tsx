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
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
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

interface PoLineItem {
  po_line_id: number
  sequence_number: number | null
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

interface InvoiceLineItem {
  invoice_line_id: number
  sequence_number: number | null
  po_line_id: number | null
  item_name: string | null
  hsn_sac: string | null
  uom: string | null
  billed_qty: number | null
  weight: number | null
  count: number | null
  rate: number | null
  rate_per: string | null
  line_total: number | null
  taxable_value: number | null
  cgst_rate: number | null
  cgst_amount: number | null
  sgst_rate: number | null
  sgst_amount: number | null
  total_tax_amount: number | null
}

interface PendingApproval {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  scanning_number: string | null
  total_amount: number
  tax_amount: number
  status: string
  payment_due_date: string | null
  debit_note_value: number | null
  notes: string | null
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
  po_lines?: PoLineItem[]
  invoice_lines?: InvoiceLineItem[]
}

function ApprovePayments() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [list, setList] = useState<PendingApproval[]>([])
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [selected, setSelected] = useState<PendingApproval[]>([])
  const [rejectDialog, setRejectDialog] = useState<{ open: boolean; item: PendingApproval | null; bulk: PendingApproval[] }>({ open: false, item: null, bulk: [] })
  const [rejectionReason, setRejectionReason] = useState('')
  const [modifyDialog, setModifyDialog] = useState<{ open: boolean; item: PendingApproval | null }>({ open: false, item: null })
  const [bulkActionLoading, setBulkActionLoading] = useState(false)
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
      const sorted = [...data].sort((a, b) => {
        const da = a.payment_due_date ? new Date(a.payment_due_date).getTime() : Infinity
        const db = b.payment_due_date ? new Date(b.payment_due_date).getTime() : Infinity
        return da - db
      })
      setList(sorted)
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

  const confirmApprove = (item: PendingApproval) => {
    confirmDialog({
      message: 'Are you sure you want to send this invoice to payments?',
      header: 'Confirm send to payments',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleApprove(item),
      reject: () => {}
    })
  }

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

  const handleBulkApprove = async () => {
    if (selected.length === 0) return
    setBulkActionLoading(true)
    let ok = 0
    let failed = 0
    for (const item of selected) {
      try {
        const res = await apiFetch('payments/approve', {
          method: 'POST',
          body: JSON.stringify({ invoiceId: item.invoice_id })
        })
        if (res.ok) ok++
        else failed++
      } catch {
        failed++
      }
    }
    setBulkActionLoading(false)
    setSelected([])
    await fetchPending()
    if (failed === 0) {
      toast.current?.show({ severity: 'success', summary: 'Approved', detail: `${ok} payment(s) approved. They will appear in Ready for Payments.`, life: 4000 })
    } else {
      toast.current?.show({ severity: 'warn', summary: 'Partial', detail: `${ok} approved, ${failed} failed.`, life: 5000 })
    }
  }

  const confirmBulkApprove = () => {
    confirmDialog({
      message: `Approve ${selected.length} selected payment(s)? They will move to Ready for Payments.`,
      header: 'Confirm approve selected',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleBulkApprove(),
      reject: () => {}
    })
  }

  const confirmApproveWithModify = () => {
    confirmDialog({
      message: 'Are you sure you want to send this invoice to payments with the modified banking details?',
      header: 'Confirm send to payments',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleApproveWithModify(),
      reject: () => {}
    })
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
    const { item, bulk } = rejectDialog
    const toReject = bulk.length > 0 ? bulk : (item ? [item] : [])
    if (toReject.length === 0) return
    setBulkActionLoading(true)
    let ok = 0
    let failed = 0
    for (const row of toReject) {
      try {
        const res = await apiFetch('payments/reject', {
          method: 'PATCH',
          body: JSON.stringify({ invoiceId: row.invoice_id, rejection_reason: rejectionReason })
        })
        if (res.ok) ok++
        else failed++
      } catch {
        failed++
      }
    }
    setBulkActionLoading(false)
    setRejectDialog({ open: false, item: null, bulk: [] })
    setRejectionReason('')
    setSelected([])
    await fetchPending()
    if (failed === 0) {
      toast.current?.show({ severity: 'info', summary: 'Rejected', detail: `${ok} payment(s) rejected.`, life: 4000 })
    } else {
      toast.current?.show({ severity: 'warn', summary: 'Partial', detail: `${ok} rejected, ${failed} failed.`, life: 5000 })
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
      <div className={styles.sectionCards}>
        <div className={styles.sectionCard}>
          <div className={styles.sectionCardHeader}>Invoice summary</div>
          <div className={styles.sectionCardBody}>
            <div className={styles.summaryGrid}>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Invoice number</span>
                <span className={styles.detailValueHighlight}>{row.invoice_number}</span>
              </div>
              {row.scanning_number && (
                <div className={styles.detailItem}><span className={styles.detailLabel}>Scanning number</span><span className={styles.detailValue}>{row.scanning_number}</span></div>
              )}
              <div className={styles.detailItem}><span className={styles.detailLabel}>Invoice date</span><span className={styles.detailValue}>{dateDisplay(row.invoice_date)}</span></div>
              <div className={styles.detailItem}><span className={styles.detailLabel}>Payment due date</span><span className={styles.detailValue}>{dateDisplay(row.payment_due_date)}</span></div>
              <div className={styles.detailItem}><span className={styles.detailLabel}>Status</span><span className={styles.detailValue}>{row.status}</span></div>
              <div className={styles.detailItem}><span className={styles.detailLabel}>Total amount</span><span className={styles.detailValueHighlight}>{amountDisplay(row)}</span></div>
              {row.debit_note_value != null && (
                <div className={styles.detailItem}><span className={styles.detailLabel}>Debit note value</span><span className={styles.detailValue}>₹{Number(row.debit_note_value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
              )}
              <div className={styles.detailItem}><span className={styles.detailLabel}>Tax amount</span><span className={styles.detailValue}>₹{Number(row.tax_amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
              {row.notes && (
                <div className={styles.detailItem} style={{ gridColumn: '1 / -1' }}><span className={styles.detailLabel}>Notes</span><span className={styles.detailValue}>{row.notes}</span></div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.twoColGrid}>
          <div className={styles.sectionCard}>
            <div className={styles.sectionCardHeader}>Supplier</div>
            <div className={styles.sectionCardBody}>
              <div className={styles.summaryGrid}>
                <div className={styles.detailItem} style={{ gridColumn: '1 / -1' }}><span className={styles.detailLabel}>Name</span><span className={styles.detailValue}>{row.supplier_name || '-'}</span></div>
                <div className={styles.detailItem}><span className={styles.detailLabel}>GST</span><span className={styles.detailValue}>{row.supplier_gst || '-'}</span></div>
                <div className={styles.detailItem}><span className={styles.detailLabel}>PAN</span><span className={styles.detailValue}>{row.supplier_pan || '-'}</span></div>
                <div className={styles.detailItem} style={{ gridColumn: '1 / -1' }}><span className={styles.detailLabel}>Address</span><span className={styles.detailValue}>{row.supplier_address || '-'}</span></div>
                <div className={styles.detailItem}><span className={styles.detailLabel}>Email</span><span className={styles.detailValue}>{row.supplier_email || '-'}</span></div>
                <div className={styles.detailItem}><span className={styles.detailLabel}>Phone</span><span className={styles.detailValue}>{row.supplier_phone || '-'}</span></div>
              </div>
            </div>
          </div>
          <div className={styles.sectionCard}>
            <div className={styles.sectionCardHeader}>Banking details (pay to)</div>
            <div className={styles.sectionCardBody}>
              <div className={styles.bankingBlock}>
                <table className={styles.miniTable}>
                  <tbody>
                    <tr><th>Account name</th><td>{row.bank_account_name || '-'}</td></tr>
                    <tr><th>Account number</th><td>{row.bank_account_number || '-'}</td></tr>
                    <tr><th>IFSC</th><td>{row.bank_ifsc_code || '-'}</td></tr>
                    <tr><th>Bank</th><td>{row.bank_name || '-'}</td></tr>
                    <tr><th>Branch</th><td>{row.branch_name || '-'}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.sectionCard}>
          <div className={styles.sectionCardHeader}>Purchase order</div>
          <div className={styles.sectionCardBody}>
            <div className={styles.summaryGrid}>
              <div className={styles.detailItem}><span className={styles.detailLabel}>PO number</span><span className={styles.detailValue}>{row.po_number_ref || row.po_number || '-'}</span></div>
              <div className={styles.detailItem}><span className={styles.detailLabel}>PO date</span><span className={styles.detailValue}>{dateDisplay(row.po_date)}</span></div>
              <div className={styles.detailItem}><span className={styles.detailLabel}>PO status</span><span className={styles.detailValue}>{row.po_status || '-'}</span></div>
              <div className={styles.detailItem} style={{ gridColumn: '1 / -1' }}><span className={styles.detailLabel}>Terms</span><span className={styles.detailValue}>{row.po_terms || '-'}</span></div>
            </div>
          </div>
        </div>

        {row.po_lines && row.po_lines.length > 0 && (
          <div className={styles.sectionCard}>
            <div className={styles.sectionCardHeader}>PO lines ({row.po_lines.length})</div>
            <div className={styles.sectionCardBody}>
              <div className={styles.tableScroll}>
                <table className={styles.miniTable}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item ID</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Unit cost (₹)</th>
                      <th>Disc %</th>
                      <th>Raw material</th>
                      <th>Process</th>
                      <th>Norms</th>
                      <th>Process cost (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.po_lines.map((pl) => (
                      <tr key={pl.po_line_id}>
                        <td>{pl.sequence_number ?? '-'}</td>
                        <td>{pl.item_id ?? '-'}</td>
                        <td>{pl.description1 ?? '-'}</td>
                        <td>{pl.qty != null ? Number(pl.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '-'}</td>
                        <td>{pl.unit_cost != null ? `₹${Number(pl.unit_cost).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '-'}</td>
                        <td>{pl.disc_pct != null ? `${Number(pl.disc_pct).toFixed(2)}%` : '-'}</td>
                        <td>{pl.raw_material ?? '-'}</td>
                        <td>{pl.process_description ?? '-'}</td>
                        <td>{pl.norms ?? '-'}</td>
                        <td>{pl.process_cost != null ? `₹${Number(pl.process_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {row.invoice_lines && row.invoice_lines.length > 0 && (
          <div className={styles.sectionCard}>
            <div className={styles.sectionCardHeader}>Invoice lines ({row.invoice_lines.length})</div>
            <div className={styles.sectionCardBody}>
              <div className={styles.tableScroll}>
                <table className={styles.miniTable}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Item name</th>
                      <th>HSN/SAC</th>
                      <th>UOM</th>
                      <th>Billed qty</th>
                      <th>Weight</th>
                      <th>Count</th>
                      <th>Rate (₹)</th>
                      <th>Rate per</th>
                      <th>Line total (₹)</th>
                      <th>Taxable value (₹)</th>
                      <th>CGST %</th>
                      <th>CGST (₹)</th>
                      <th>SGST %</th>
                      <th>SGST (₹)</th>
                      <th>Tax (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.invoice_lines.map((il) => (
                      <tr key={il.invoice_line_id}>
                        <td>{il.sequence_number ?? '-'}</td>
                        <td>{il.item_name ?? '-'}</td>
                        <td>{il.hsn_sac ?? '-'}</td>
                        <td>{il.uom ?? '-'}</td>
                        <td>{il.billed_qty != null ? Number(il.billed_qty).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '-'}</td>
                        <td>{il.weight != null ? Number(il.weight).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '-'}</td>
                        <td>{il.count ?? '-'}</td>
                        <td>{il.rate != null ? `₹${Number(il.rate).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                        <td>{il.rate_per ?? '-'}</td>
                        <td>{il.line_total != null ? `₹${Number(il.line_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                        <td>{il.taxable_value != null ? `₹${Number(il.taxable_value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                        <td>{il.cgst_rate != null ? `${Number(il.cgst_rate)}%` : '-'}</td>
                        <td>{il.cgst_amount != null ? `₹${Number(il.cgst_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                        <td>{il.sgst_rate != null ? `${Number(il.sgst_rate)}%` : '-'}</td>
                        <td>{il.sgst_amount != null ? `₹${Number(il.sgst_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                        <td>{il.total_tax_amount != null ? `₹${Number(il.total_tax_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {row.grn_list && row.grn_list.length > 0 && (
          <div className={styles.sectionCard}>
            <div className={styles.sectionCardHeader}>GRN ({row.grn_list.length})</div>
            <div className={styles.sectionCardBody}>
              <table className={styles.miniTable}>
                <thead>
                  <tr>
                    <th>GRN No</th>
                    <th>Date</th>
                    <th>DC No</th>
                    <th>DC Date</th>
                    <th>Qty</th>
                    <th>Unit cost</th>
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
                      <td>{g.unit_cost != null ? `₹${Number(g.unit_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {row.asn_list && row.asn_list.length > 0 && (
          <div className={styles.sectionCard}>
            <div className={styles.sectionCardHeader}>ASN ({row.asn_list.length})</div>
            <div className={styles.sectionCardBody}>
              <table className={styles.miniTable}>
                <thead>
                  <tr>
                    <th>ASN No</th>
                    <th>DC No</th>
                    <th>DC Date</th>
                    <th>Inv No</th>
                    <th>Inv Date</th>
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
                      <td>{a.inv_no ?? '-'}</td>
                      <td>{dateDisplay(a.inv_date)}</td>
                      <td>{a.lr_no ?? '-'}</td>
                      <td>{a.transporter_name ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className={styles.expandedActions}>
          <Button label="Approve" icon="pi pi-check" severity="success" size="small" className={`btnPrimary ${styles.actionButton}`}
            loading={actionLoading === `approve-${row.invoice_id}`} disabled={!!actionLoading}
            onClick={() => confirmApprove(row)} />
          <Button label="Modify & Approve" icon="pi pi-pencil" size="small" className={styles.actionButton}
            loading={actionLoading === `modify-${row.invoice_id}`} disabled={!!actionLoading}
            onClick={() => openModify(row)} />
          <Button label="Reject" icon="pi pi-times" severity="danger" size="small" className={styles.actionButton}
            loading={actionLoading === `reject-${row.invoice_id}`} disabled={!!actionLoading}
            onClick={() => { setRejectionReason(''); setRejectDialog({ open: true, item: row, bulk: [] }) }} />
        </div>
      </div>
    </div>
  )

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} />
      <ConfirmDialog />
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Approve Payments</h1>
            <p className={styles.subtitle}>Review validated invoices with PO, supplier, GRN, ASN and banking details. Approve, modify banking and approve, or reject.</p>
          </div>
          <PageNavigation onRefresh={fetchPending} refreshLoading={loading} />
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">Pending approvals</h2>
          <p className="dts-sectionSubtitle">
            Review validated invoices with PO, supplier, GRN, ASN and banking details. Approve, modify banking and approve, or reject. Select multiple rows to approve or reject in bulk.
          </p>
          {selected.length > 0 && (
            <div className={styles.bulkToolbar}>
              <span className={styles.bulkLabel}>{selected.length} selected</span>
              <Button
                label={`Approve selected (${selected.length})`}
                icon="pi pi-check"
                severity="success"
                size="small"
                loading={bulkActionLoading}
                disabled={!!actionLoading || bulkActionLoading}
                onClick={confirmBulkApprove}
                className={`btnPrimary ${styles.bulkButton}`}
              />
              <Button
                label={`Reject selected (${selected.length})`}
                icon="pi pi-times"
                severity="danger"
                size="small"
                disabled={!!actionLoading || bulkActionLoading}
                onClick={() => { setRejectionReason(''); setRejectDialog({ open: true, item: null, bulk: [...selected] }) }}
                className={styles.bulkButton}
              />
              <Button label="Clear selection" icon="pi pi-times" severity="secondary" size="small" outlined onClick={() => setSelected([])} />
            </div>
          )}
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading pending approvals...</p>
            </div>
          ) : list.length === 0 ? (
            <div className="dts-emptySection">
              <p>No pending approvals. This page shows invoices with status <strong>Validated</strong> (ready to send to payment). Invoices get that status after you validate them on Invoice Details (match with PO/GRN). Go to <strong>Invoice Management → Invoice Details</strong>, open an invoice linked to a PO with GRN/ASN, and click <strong>Validate</strong>.</p>
              <Button label="Go to Invoice Details" icon="pi pi-arrow-right" onClick={() => navigate('/invoices/validate')} className={styles.emptyStateButton} style={{ marginTop: '0.75rem' }} />
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={list}
                  dataKey="invoice_id"
                  selection={selected}
                  onSelectionChange={(e) => setSelected(e.value ?? [])}
                  expandedRows={expandedRows}
                  onRowToggle={(e) => setExpandedRows(e.data as Record<number, boolean>)}
                  rowExpansionTemplate={rowExpansionTemplate}
                  stripedRows
                  size="small"
                  sortField="payment_due_date"
                  sortOrder={1}
                >
                  <Column selectionMode="multiple" headerStyle={{ width: '2.5rem' }} />
                  <Column expander style={{ width: '3rem' }} />
                  <Column field="invoice_number" header="Invoice" sortable style={{ minWidth: '140px' }} />
                  <Column field="po_number_ref" header="PO Number" sortable body={(r) => r.po_number_ref || r.po_number || '-'} style={{ minWidth: '120px' }} />
                  <Column field="supplier_name" header="Supplier" sortable style={{ minWidth: '180px' }} />
                  <Column header="Amount" body={amountDisplay} sortable sortField="total_amount" style={{ minWidth: '120px', textAlign: 'right' }} />
                  <Column header="Due date" body={(r) => dateDisplay(r.payment_due_date)} sortable sortField="payment_due_date" style={{ minWidth: '110px' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog
        header={rejectDialog.bulk.length > 0 ? `Reject ${rejectDialog.bulk.length} payment(s)` : 'Reject payment'}
        visible={rejectDialog.open}
        onHide={() => setRejectDialog({ open: false, item: null, bulk: [] })}
        style={{ width: '400px' }}
        footer={
          <div className={styles.dialogActions}>
            <Button label="Cancel" severity="secondary" onClick={() => setRejectDialog({ open: false, item: null, bulk: [] })} />
            <Button label={rejectDialog.bulk.length > 0 ? `Reject ${rejectDialog.bulk.length}` : 'Reject'} severity="danger" onClick={handleReject} loading={bulkActionLoading} />
          </div>
        }
      >
        <div className={styles.dialogForm}>
          <div className={styles.dialogField}>
            <label>Rejection reason (optional, applies to all when rejecting multiple)</label>
            <InputText value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} placeholder="Reason for rejection" />
          </div>
        </div>
      </Dialog>

      <Dialog header="Modify banking & approve" visible={modifyDialog.open} onHide={() => { setModifyDialog({ open: false, item: null }); setModifyBank({ bank_account_name: '', bank_account_number: '', bank_ifsc_code: '', bank_name: '', branch_name: '' }) }}
        style={{ width: '480px' }} footer={
          <div className={styles.dialogActions}>
            <Button label="Cancel" severity="secondary" onClick={() => setModifyDialog({ open: false, item: null })} />
            <Button label="Approve with these details" severity="success" className="btnPrimary" onClick={confirmApproveWithModify} loading={!!actionLoading} />
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
