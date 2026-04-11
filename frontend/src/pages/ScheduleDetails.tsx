import { useState, useEffect, useRef, useCallback } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { InputText } from 'primereact/inputtext'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl, getErrorMessageFromResponse } from '../utils/api'
import { useDebounce } from '../hooks/useDebounce'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import Breadcrumb from '../components/Breadcrumb'
import styles from './GRNDetails.module.css'

interface ScheduleRecord {
  id: number
  po_id: number | null
  po_number: string | null
  linked_po_number: string | null
  ord_pfx: string | null
  ord_no: string | null
  schedule_ref: string | null
  ss_pfx: string | null
  ss_no: string | null
  line_no: number | null
  item_id: string | null
  item_rev: string | null
  description: string | null
  sched_qty: number | null
  sched_date: string | null
  promise_date: string | null
  required_date: string | null
  unit: string | null
  uom: string | null
  supplier: string | null
  supplier_name: string | null
  date_from: string | null
  date_to: string | null
  firm: string | null
  tentative: string | null
  closeshort: string | null
  doc_pfx: string | null
  doc_no: string | null
  status: string | null
}

function ScheduleDetails() {
  const toast = useRef<Toast>(null)
  const [records, setRecords] = useState<ScheduleRecord[]>([])
  const [total, setTotal] = useState<number>(0)
  const [first, setFirst] = useState<number>(0)
  const [rows, setRows] = useState<number>(25)
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const debouncedSearch = useDebounce(searchTerm, 350)
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const token = localStorage.getItem('authToken')
      const params = new URLSearchParams()
      params.set('limit', String(rows))
      params.set('offset', String(first))
      const search = debouncedSearch.trim()
      if (search) {
        const isNumericish = /^[A-Za-z0-9/\-_]+$/.test(search) && /\d/.test(search)
        if (isNumericish) {
          params.set('docNo', search)
        } else {
          params.set('supplier', search)
        }
      }
      const res = await fetch(apiUrl(`po-schedules?${params.toString()}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to load schedules')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        return
      }
      const raw = await res.json()
      if (Array.isArray(raw)) {
        setRecords(raw)
        setTotal(raw.length)
      } else {
        setRecords(raw.items || [])
        setTotal(Number(raw.total) || 0)
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === 'AbortError') return
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: e instanceof Error ? e.message : 'Failed to load',
        life: 5000,
      })
    } finally {
      setLoading(false)
    }
  }, [rows, first, debouncedSearch])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    setFirst(0)
  }, [debouncedSearch])

  const handleExcelUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      toast.current?.show({ severity: 'warn', summary: 'Invalid file', detail: 'Use .xlsx or .xls', life: 5000 })
      return
    }
    setUploadingExcel(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const token = localStorage.getItem('authToken')
      const res = await fetch(apiUrl('po-schedules/upload-excel'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Upload failed')
      const life = data.schedulesInserted === 0 && data.hint ? 12000 : 6000
      toast.current?.show({
        severity: data.schedulesInserted === 0 ? 'warn' : 'success',
        summary: 'Import done',
        detail: data.message + ' Each upload replaces all schedule rows.',
        life,
      })
      await fetchData()
    } catch (err) {
      toast.current?.show({
        severity: 'error',
        summary: 'Import failed',
        detail: err instanceof Error ? err.message : 'Upload failed',
        life: 5000,
      })
    } finally {
      setUploadingExcel(false)
    }
  }, [])

  const dateFmt = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} />
      <div className={styles.pageContainer} id="main-content">
        <Breadcrumb items={[{ label: 'Home', path: '/' }, { label: 'PO Schedules' }]} />
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>PO Schedules</h1>
              <p className={styles.pageSubtitle}>
                Full replace on each Excel upload — link PO by Doc. No. / ORD_NO when present
              </p>
            </div>
            <div className={styles.headerActions}>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} style={{ display: 'none' }} />
              <Button
                label="Upload Excel"
                icon="pi pi-upload"
                className={styles.uploadExcelButton}
                onClick={() => fileInputRef.current?.click()}
                loading={uploadingExcel}
                disabled={uploadingExcel}
              />
              <PageNavigation onRefresh={() => fetchData()} refreshLoading={loading} />
            </div>
          </div>
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">Schedule lines</h2>
          <p className="dts-sectionSubtitle">Used for Open PO validation together with GRN, DC, and ASN.</p>
          {!loading && (
            <div className={styles.toolbar}>
              <span className="p-input-icon-left">
                <i className="pi pi-search" />
                <InputText
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search PO, SS no, item..."
                  className={styles.searchInput}
                />
              </span>
            </div>
          )}
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading…</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable
                  value={records}
                  lazy
                  paginator
                  first={first}
                  rows={rows}
                  totalRecords={total}
                  onPage={(e) => {
                    setFirst(e.first)
                    setRows(e.rows)
                  }}
                  rowsPerPageOptions={[10, 25, 50, 100, 200]}
                  emptyMessage={searchTerm ? 'No matches' : 'No schedules — upload an Excel file'}
                  stripedRows
                  scrollable
                  scrollHeight="480px"
                >
                  <Column field="line_no" header="Line" style={{ minWidth: '4rem' }} />
                  <Column field="unit" header="Unit" style={{ minWidth: '5rem' }} />
                  <Column field="supplier" header="Supplier" style={{ minWidth: '6rem' }} />
                  <Column field="supplier_name" header="Supplier name" style={{ minWidth: '10rem' }} />
                  <Column field="item_id" header="Item" style={{ minWidth: '6rem' }} />
                  <Column field="item_rev" header="Rev." style={{ minWidth: '4rem' }} />
                  <Column field="description" header="Item desc." style={{ minWidth: '12rem' }} />
                  <Column field="uom" header="UOM" style={{ minWidth: '4rem' }} />
                  <Column field="date_from" header="From" body={(r: ScheduleRecord) => dateFmt(r.date_from)} style={{ minWidth: '7rem' }} />
                  <Column field="date_to" header="To" body={(r: ScheduleRecord) => dateFmt(r.date_to)} style={{ minWidth: '7rem' }} />
                  <Column field="firm" header="Firm" style={{ minWidth: '6rem' }} />
                  <Column field="tentative" header="Tentative" style={{ minWidth: '6rem' }} />
                  <Column field="closeshort" header="Closeshort" style={{ minWidth: '7rem' }} />
                  <Column field="doc_pfx" header="Doc Pfx." style={{ minWidth: '5rem' }} />
                  <Column field="doc_no" header="Doc. No." sortable style={{ minWidth: '7rem' }} />
                  <Column field="status" header="Status" style={{ minWidth: '6rem' }} />
                  <Column field="linked_po_number" header="Linked PO" sortable style={{ minWidth: '7rem' }} />
                  <Column field="ord_no" header="Ord no" sortable style={{ minWidth: '7rem' }} />
                  <Column field="sched_qty" header="Sched qty" style={{ minWidth: '6rem' }} />
                  <Column field="sched_date" header="Sched date" body={(r: ScheduleRecord) => dateFmt(r.sched_date)} sortable style={{ minWidth: '7rem' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ScheduleDetails
