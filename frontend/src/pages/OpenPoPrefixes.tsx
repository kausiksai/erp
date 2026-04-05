import { useState, useEffect, useRef, useCallback } from 'react'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl, getErrorMessageFromResponse } from '../utils/api'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import Breadcrumb from '../components/Breadcrumb'
import styles from './GRNDetails.module.css'

interface PrefixRow {
  id: number
  prefix: string
  description: string | null
  created_at?: string
  updated_at?: string
}

function OpenPoPrefixes() {
  const toast = useRef<Toast>(null)
  const [rows, setRows] = useState<PrefixRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadingExcel, setUploadingExcel] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchData = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const res = await fetch(apiUrl('open-po-prefixes'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const msg = await getErrorMessageFromResponse(res, 'Failed to load prefixes')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        return
      }
      setRows(await res.json())
    } catch (e: unknown) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: e instanceof Error ? e.message : 'Failed to load',
        life: 5000,
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

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
      const res = await fetch(apiUrl('open-po-prefixes/upload-excel'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'Upload failed')
      toast.current?.show({
        severity: 'success',
        summary: 'Import done',
        detail: data.message + ' A PO is Open PO when purchase_orders.pfx matches any prefix (starts-with, case-insensitive).',
        life: 8000,
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

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} />
      <div className={styles.pageContainer} id="main-content">
        <Breadcrumb items={[{ label: 'Home', path: '/' }, { label: 'Open PO Prefixes' }]} />
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Open PO prefixes</h1>
              <p className={styles.pageSubtitle}>
                Excel columns: <strong>PREFIX</strong> (required), DESCRIPTION (optional). Each upload replaces all rows.
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
          <h2 className="dts-sectionTitle">Configured prefixes</h2>
          <p className="dts-sectionSubtitle">Example: prefix <code>OP</code> matches PO PFX <code>OP1</code>, <code>OP2</code>, …</p>
          {loading ? (
            <div className={styles.loadingContainer}>
              <ProgressSpinner />
              <p>Loading…</p>
            </div>
          ) : (
            <div className="dts-tableWrapper">
              <div className="dts-tableContainer">
                <DataTable value={rows} paginator rows={15} emptyMessage="No prefixes — upload an Excel file" stripedRows>
                  <Column field="prefix" header="Prefix" sortable />
                  <Column field="description" header="Description" />
                </DataTable>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default OpenPoPrefixes
