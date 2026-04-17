import { useRef, useState } from 'react'
import { apiUrl, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

/**
 * Drop-in Excel upload button for the list pages (PO / GRN / ASN / DC /
 * Schedules). Opens a file picker, POSTs the file as multipart/form-data
 * to the given endpoint, and triggers onSuccess so the caller can refresh
 * the list.
 *
 * Uses native fetch (not apiFetch) because the backend upload endpoints
 * take multipart/form-data and apiFetch force-sets application/json.
 */
interface Props {
  endpoint: string            // e.g. 'purchase-orders/upload-excel'
  label: string               // e.g. 'Upload PO Excel'
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
}

export default function ExcelUploadButton({ endpoint, label, onSuccess, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const handleFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const token = localStorage.getItem('authToken')
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Upload failed'))
      const body = await res.json()
      const message = body.message || 'Upload successful'
      onSuccess?.(message)
    } catch (err) {
      onError?.(getDisplayError(err))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
      />
      <button
        type="button"
        className="action-btn"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Upload an Excel file — fallback for when email automation misses"
      >
        {busy
          ? <><i className="pi pi-spin pi-spinner" /> Uploading…</>
          : <><i className="pi pi-upload" /> {label}</>}
      </button>
    </>
  )
}
