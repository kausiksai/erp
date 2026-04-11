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

interface DCRecord {
  id: number
  po_id: number | null
  po_number: string | null
  doc_no: number | null
  dc_no: string | null
  dc_date: string | null
  supplier: string | null
  supplier_display_name: string | null
  item: string | null
  rev: number | null
  revision: string | null
  uom: string | null
  description: string | null
  sf_code: string | null
  dc_qty: number | null
  ord_type: string | null
  ord_no: string | null
  ord_pfx: string | null
  unit: string | null
  unit_description: string | null
  dc_line: number | null
  dc_pfx: string | null
  source: string | null
  grn_pfx: string | null
  grn_no: string | null
  open_order_pfx: string | null
  open_order_no: string | null
  line_no: number | null
  temp_qty: number | null
  received_qty: number | null
  suplr_dc_no: string | null
  suplr_dc_date: string | null
  material_type: string | null
  received_item: string | null
  received_item_rev: string | null
  received_item_uom: string | null
}

function DCDetails() {
  const toast = useRef<Toast>(null)
  const [records, setRecords] = useState<DCRecord[]>([])
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
          params.set('dcNo', search)
        } else {
          params.set('supplier', search)
        }
      }
      const res = await fetch(apiUrl(`delivery-challans?${params.toString()}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      })
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to load delivery challans')
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
      const res = await fetch(apiUrl('delivery-challans/upload-excel'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Upload failed')
      const life = data.dcInserted === 0 && data.hint ? 12000 : 6000
      toast.current?.show({
        severity: data.dcInserted === 0 ? 'warn' : 'success',
        summary: 'Import done',
        detail: data.message + ' Each upload replaces all DC rows.',
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
        <Breadcrumb items={[{ label: 'Home', path: '/' }, { label: 'Delivery Challan' }]} />
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Delivery Challan (DC)</h1>
              <p className={styles.pageSubtitle}>
                Full replace on each Excel upload — matches PO by ORDER NO.; TRANSACTION DATE maps to DC date
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
          <h2 className="dts-sectionTitle">DC transactions</h2>
          <p className="dts-sectionSubtitle">Upload overwrites the entire DC table.</p>
          {!loading && (
            <div className={styles.toolbar}>
              <span className="p-input-icon-left">
                <i className="pi pi-search" />
                <InputText
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search PO, DC no, item, supplier..."
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
                  emptyMessage={searchTerm ? 'No matches' : 'No DC rows — upload an Excel file'}
                  stripedRows
                  scrollable
                  scrollHeight="480px"
                >
                  <Column field="po_number" header="PO No" sortable style={{ minWidth: '7rem' }} />
                  <Column field="dc_no" header="DC No" sortable style={{ minWidth: '7rem' }} />
                  <Column
                    field="dc_date"
                    header="Trans. date"
                    body={(r: DCRecord) => dateFmt(r.dc_date)}
                    sortable
                    style={{ minWidth: '7rem' }}
                  />
                  <Column field="unit" header="Unit" style={{ minWidth: '5rem' }} />
                  <Column field="item" header="Item" style={{ minWidth: '6rem' }} />
                  <Column field="revision" header="Rev." style={{ minWidth: '4rem' }} />
                  <Column field="description" header="Item desc." style={{ minWidth: '12rem' }} />
                  <Column field="uom" header="UOM" style={{ minWidth: '4rem' }} />
                  <Column field="supplier_display_name" header="Supplier name" style={{ minWidth: '10rem' }} />
                  <Column field="dc_line" header="DC line" style={{ minWidth: '5rem' }} />
                  <Column field="dc_pfx" header="DC PFX" style={{ minWidth: '5rem' }} />
                  <Column field="ord_no" header="Order no" sortable style={{ minWidth: '7rem' }} />
                  <Column field="ord_type" header="Order type" style={{ minWidth: '6rem' }} />
                  <Column field="source" header="Source" style={{ minWidth: '6rem' }} />
                  <Column field="sf_code" header="SF code" style={{ minWidth: '5rem' }} />
                  <Column field="dc_qty" header="Trans. qty" style={{ minWidth: '6rem' }} />
                  <Column field="grn_pfx" header="GRN PFX" style={{ minWidth: '5rem' }} />
                  <Column field="grn_no" header="GRN no" style={{ minWidth: '6rem' }} />
                  <Column field="open_order_pfx" header="Open ord PFX" style={{ minWidth: '6rem' }} />
                  <Column field="open_order_no" header="Open ord no" style={{ minWidth: '7rem' }} />
                  <Column field="material_type" header="Mat. type" style={{ minWidth: '7rem' }} />
                  <Column field="line_no" header="Line no" style={{ minWidth: '5rem' }} />
                  <Column field="temp_qty" header="Temp qty" style={{ minWidth: '6rem' }} />
                  <Column field="received_qty" header="Rcvd qty" style={{ minWidth: '6rem' }} />
                  <Column field="suplr_dc_no" header="Suplr DC no" style={{ minWidth: '7rem' }} />
                  <Column
                    field="suplr_dc_date"
                    header="Suplr DC date"
                    body={(r: DCRecord) => dateFmt(r.suplr_dc_date)}
                    style={{ minWidth: '7rem' }}
                  />
                  <Column field="received_item" header="Rcvd item" style={{ minWidth: '6rem' }} />
                  <Column field="received_item_rev" header="Rcvd rev" style={{ minWidth: '5rem' }} />
                  <Column field="received_item_uom" header="Rcvd UOM" style={{ minWidth: '5rem' }} />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default DCDetails
