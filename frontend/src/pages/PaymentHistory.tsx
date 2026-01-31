import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import styles from './PaymentHistory.module.css'

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

interface PaymentHistoryItem {
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
  payment_done_by: number | null
  payment_done_at: string | null
  payment_done_by_username: string | null
  payment_done_by_name: string | null
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

function PaymentHistory() {
  const navigate = useNavigate()
  const toast = useRef<Toast>(null)
  const [list, setList] = useState<PaymentHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})

  const fetchHistory = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('payments/history')
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to fetch payment history')
        throw new Error(msg)
      }
      const data = await res.json()
      setList(data)
      setExpandedRows({})
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load payment history'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchHistory()
  }, [])

  const amountDisplay = (row: PaymentHistoryItem) => {
    const amt = row.debit_note_value != null ? row.debit_note_value : row.total_amount
    return amt != null ? `₹${Number(amt).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'
  }

  const dateDisplay = (d: string | null) => {
    if (!d) return '-'
    return new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const dateTimeDisplay = (d: string | null) => {
    if (!d) return '-'
    return new Date(d).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
  }

  const doneByDisplay = (row: PaymentHistoryItem) => {
    return row.payment_done_by_name || row.payment_done_by_username || '-'
  }

  const rowExpansionTemplate = (row: PaymentHistoryItem) => (
    <div className={styles.expandedContent}>
      <div className={styles.sectionTitle}>Supplier</div>
      <div className={styles.detailGrid}>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Name</span><span className={styles.detailValue}>{row.supplier_name || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>GST</span><span className={styles.detailValue}>{row.supplier_gst || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>PAN</span><span className={styles.detailValue}>{row.supplier_pan || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Address</span><span className={styles.detailValue}>{row.supplier_address || '-'}</span></div>
        <div className={styles.detailItem}><span className={styles.detailLabel}>Email / Phone</span><span className={styles.detailValue}>{[row.supplier_email, row.supplier_phone].filter(Boolean).join(' / ') || '-'}</span></div>
      </div>
      <div className={styles.sectionTitle}>Banking details (paid to)</div>
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
      <div style={{ marginTop: '1rem' }}>
        <Button
          label="View invoice"
          icon="pi pi-external-link"
          size="small"
          outlined
          onClick={() => navigate(`/invoices/validate/${row.invoice_id}`)}
        />
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
            <h1 className={styles.title}>Payment History</h1>
            <p className={styles.subtitle}>
              All payments marked as done. Expand a row to see supplier, banking, PO, GRN, and ASN details.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Button label="Refresh" icon="pi pi-refresh" onClick={fetchHistory} outlined />
            <PageNavigation />
          </div>
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">Payment history</h2>
          <p className="dts-sectionSubtitle">
            All payments marked as done. Expand a row to see supplier, banking, PO, GRN, and ASN details.
          </p>
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading payment history...</p>
            </div>
          ) : list.length === 0 ? (
            <div className="dts-emptySection">
              <p>No payment history. Payments marked as done on Ready for Payments will appear here.</p>
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
                  paginator
                  rows={10}
                  rowsPerPageOptions={[10, 25, 50]}
                >
                  <Column expander style={{ width: '3rem' }} />
                  <Column field="invoice_number" header="Invoice" sortable style={{ minWidth: '140px' }} />
                  <Column field="po_number" header="PO Number" sortable style={{ minWidth: '120px' }} />
                  <Column field="supplier_name" header="Supplier" sortable style={{ minWidth: '180px' }} />
                  <Column header="Amount" body={amountDisplay} sortable sortField="total_amount" style={{ minWidth: '120px', textAlign: 'right' }} />
                  <Column header="Payment done at" body={(r) => dateTimeDisplay(r.payment_done_at)} sortable sortField="payment_done_at" style={{ minWidth: '160px' }} />
                  <Column header="Done by" body={doneByDisplay} style={{ minWidth: '140px' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default PaymentHistory
