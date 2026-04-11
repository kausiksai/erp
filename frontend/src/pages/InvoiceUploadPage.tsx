import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import { apiUrl, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

interface UploadedResult {
  invoice_id: number
  invoice_number: string
  status: string
  message?: string
}

function InvoiceUploadPage() {
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [drag, setDrag] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<UploadedResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const onDrop = useCallback((e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files?.[0]
    if (f) setFile(f)
  }, [])

  const handleUpload = async () => {
    if (!file) return
    setError('')
    setResult(null)
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('pdf', file)
      const token = localStorage.getItem('authToken')
      const res = await fetch(apiUrl('invoices/upload'), {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Upload failed'))
      const body = await res.json()
      setResult({
        invoice_id: body.invoice?.invoice_id ?? body.invoice_id ?? 0,
        invoice_number: body.invoice?.invoice_number ?? body.invoice_number ?? 'Unknown',
        status: body.invoice?.status ?? body.status ?? 'uploaded',
        message: body.message
      })
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setUploading(false)
    }
  }

  const reset = () => {
    setFile(null)
    setResult(null)
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const sizeMb = file ? (file.size / (1024 * 1024)).toFixed(2) : null

  return (
    <>
      <PageHero
        eyebrow="Workflow"
        eyebrowIcon="pi-upload"
        title="Upload invoice"
        subtitle="Drop a PDF here to extract data, run validations and route it into the workflow. We support single or multi-page scans."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/invoices/validate')}>
            <i className="pi pi-list" /> All invoices
          </button>
        }
      />

      <div className="grid-charts">
        <div className="glass-card" style={{ minHeight: 360 }}>
          <h3 className="glass-card__title">
            <i className="pi pi-cloud-upload" style={{ color: 'var(--brand-600)' }} /> Drop zone
          </h3>
          <div className="glass-card__subtitle">Accepted: PDF up to 20 MB</div>

          <label
            htmlFor="invoice-upload-input"
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.85rem',
              padding: '2.5rem 1.5rem',
              marginTop: '0.85rem',
              borderRadius: 'var(--radius-lg)',
              border: `2px dashed ${drag ? 'var(--brand-500)' : 'var(--border-default)'}`,
              background: drag ? 'var(--brand-50)' : 'var(--surface-1)',
              cursor: 'pointer',
              textAlign: 'center',
              minHeight: 200,
              transition: 'all 200ms var(--ease-out)'
            }}
          >
            <div style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: '1.6rem'
            }}>
              <i className="pi pi-upload" />
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {file ? file.name : 'Click to browse or drop your PDF here'}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {file ? `${sizeMb} MB` : 'PDF · one invoice per file'}
            </div>
            <input
              id="invoice-upload-input"
              ref={inputRef}
              type="file"
              accept="application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button className="action-btn" disabled={!file || uploading} onClick={handleUpload}>
              {uploading ? <><i className="pi pi-spin pi-spinner" /> Uploading…</> : <><i className="pi pi-send" /> Upload &amp; validate</>}
            </button>
            {file && (
              <button className="action-btn action-btn--ghost" onClick={reset}>
                <i className="pi pi-times" /> Remove
              </button>
            )}
          </div>

          {error && (
            <div style={{
              marginTop: '1rem',
              padding: '0.85rem 1rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-danger-bg)',
              color: 'var(--status-danger-fg)',
              border: '1px solid var(--status-danger-ring)'
            }}>
              <i className="pi pi-exclamation-triangle" /> {error}
            </div>
          )}

          {result && (
            <div style={{
              marginTop: '1rem',
              padding: '0.95rem 1rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--status-success-bg)',
              color: 'var(--status-success-fg)',
              border: '1px solid var(--status-success-ring)'
            }}>
              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <i className="pi pi-check-circle" /> Invoice uploaded
              </div>
              <div style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                {result.invoice_number} — {result.message || result.status}
              </div>
              <button
                className="action-btn"
                style={{ marginTop: '0.75rem' }}
                onClick={() => navigate(`/invoices/validate/${result.invoice_id}`)}
              >
                <i className="pi pi-arrow-right" /> Open invoice
              </button>
            </div>
          )}
        </div>

        <div className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-info-circle" style={{ color: 'var(--accent-violet)' }} /> How it works
          </h3>
          <ol style={{ paddingLeft: '1.2rem', lineHeight: 1.7, color: 'var(--text-secondary)', fontSize: '0.92rem' }}>
            <li><strong>Drop a PDF.</strong> Our OCR extracts supplier, invoice #, line items, totals and tax.</li>
            <li><strong>Auto-match.</strong> The invoice is cross-checked against your PO, GRN, ASN, DC and schedule.</li>
            <li><strong>Validate.</strong> 40+ rules run instantly — price, qty, GST, amendments, cumulative caps.</li>
            <li><strong>Route.</strong> Clean invoices go to payment; exceptions flow into the approval queue.</li>
          </ol>
          <div style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)', borderTop: '1px dashed var(--border-subtle)', paddingTop: '0.8rem' }}>
            Tip: for bulk uploads, drop multiple files into the email mailbox — nightly automation will pick them up.
          </div>
        </div>
      </div>
    </>
  )
}

export default InvoiceUploadPage
