import { useState, useEffect, useRef } from 'react'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import styles from './ReadyForPayments.module.css'

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

interface ReadyPayment {
  id: number
  invoice_id: number
  po_id: number | null
  supplier_id: number | null
  status: string
  total_amount: number
  debit_note_value: number | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_ifsc_code: string | null
  bank_name: string | null
  branch_name: string | null
  approved_by: number | null
  approved_at: string | null
  notes: string | null
  invoice_number: string
  invoice_date: string | null
  payment_due_date: string | null
  supplier_name: string | null
  supplier_gst: string | null
  supplier_pan: string | null
  supplier_address: string | null
  supplier_email: string | null
  supplier_phone: string | null
  po_number: string | null
  po_date: string | null
  po_terms: string | null
  grn_list: GrnItem[]
  asn_list: AsnItem[]
}

function ReadyForPayments() {
  const toast = useRef<Toast>(null)
  const [list, setList] = useState<ReadyPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [markingId, setMarkingId] = useState<number | null>(null)
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})

  const fetchReady = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('payments/ready')
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to fetch ready payments')
        throw new Error(msg)
      }
      const data = await res.json()
      setList(data)
      setExpandedRows({})
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load ready payments'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchReady()
  }, [])

  const confirmMarkDone = (row: ReadyPayment) => {
    confirmDialog({
      message: 'Are you sure you want to send this payment to payments?',
      header: 'Confirm send to payments',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-success',
      accept: () => handleMarkDone(row.id),
      reject: () => {}
    })
  }

  const handleMarkDone = async (approvalId: number) => {
    setMarkingId(approvalId)
    try {
      const res = await apiFetch(`payments/${approvalId}/mark-done`, { method: 'PATCH' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message || 'Mark done failed')
      }
      toast.current?.show({ severity: 'success', summary: 'Payment done', detail: 'Payment marked as done.', life: 4000 })
      await fetchReady()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Mark done failed'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setMarkingId(null)
    }
  }

  const amountDisplay = (row: ReadyPayment) => {
    const amt = row.debit_note_value != null ? row.debit_note_value : row.total_amount
    return amt != null ? `₹${Number(amt).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'
  }

  const dateDisplay = (d: string | null) => {
    if (!d) return '-'
    return new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const rowExpansionTemplate = (row: ReadyPayment) => (
    <div className={styles.expandedContent}>
      <div className={styles.sectionTitle}>Supplier</div>
      <div className={styles.detailGrid}>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Name</span><span className={styles.detailValue}>{row.supplier_name || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>GST</span><span className={styles.detailValue}>{row.supplier_gst || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PAN</span><span className={styles.detailValue}>{row.supplier_pan || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Address</span><span className={styles.detailValue}>{row.supplier_address || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Email / Phone</span><span className={styles.detailValue}>{[row.supplier_email, row.supplier_phone].filter(Boolean).join(' / ') || '-'}</span></div>
      </div>
      <div className={styles.sectionTitle}>Banking details (for payment)</div>
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
      <div className={styles.sectionTitle}>PO</div>
      <div className={styles.detailGrid}>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PO Number</span><span className={styles.detailValue}>{row.po_number || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PO Date</span><span className={styles.detailValue}>{dateDisplay(row.po_date)}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Terms</span><span className={styles.detailValue}>{row.po_terms || '-'}</span></div>
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
        <Button label="Payment done" icon="pi pi-check-circle" severity="success" size="small" className={styles.actionButton}
          loading={markingId === row.id} disabled={markingId !== null}
          onClick={() => confirmMarkDone(row)} />
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
            <h1 className={styles.title}>Ready for Payments</h1>
            <p className={styles.subtitle}>Approved payments with full PO, supplier, invoice, GRN, ASN and banking details. Mark as done when payment is completed.</p>
          </div>
          <PageNavigation />
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">Ready for payment</h2>
          <p className="dts-sectionSubtitle">
            Approved payments with full PO, supplier, invoice, GRN, ASN and banking details. Mark as done when payment is completed.
          </p>
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading ready payments...</p>
            </div>
          ) : list.length === 0 ? (
            <div className="dts-emptySection">
              <p>No ready payments. Approved payments from Approve Payments will appear here. Mark as done when payment is completed.</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={list}
                  dataKey="id"
                  expandedRows={expandedRows}
                  onRowToggle={(e) => setExpandedRows(e.data as Record<number, boolean>)}
                  rowExpansionTemplate={rowExpansionTemplate}
                  stripedRows
                  size="small"
                >
                  <Column expander style={{ width: '3rem' }} />
                  <Column field="invoice_number" header="Invoice" sortable style={{ minWidth: '140px' }} />
                  <Column field="po_number" header="PO Number" sortable style={{ minWidth: '120px' }} />
                  <Column field="supplier_name" header="Supplier" sortable style={{ minWidth: '180px' }} />
                  <Column header="Amount" body={amountDisplay} sortable sortField="total_amount" style={{ minWidth: '120px', textAlign: 'right' }} />
                  <Column header="Approved at" body={(r) => dateDisplay(r.approved_at)} sortable sortField="approved_at" style={{ minWidth: '120px' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ReadyForPayments
