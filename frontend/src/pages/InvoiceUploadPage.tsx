import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/esm/Page/AnnotationLayer.css'
import 'react-pdf/dist/esm/Page/TextLayer.css'
import PageHero from '../components/PageHero'
import { apiFetch, apiUrl, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatINRSymbol, parseAmount } from '../utils/format'

// Wire up the PDF.js worker via jsDelivr CDN — exact version react-pdf expects.
pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs'

/**
 * InvoiceUploadPage — end-to-end ingest flow:
 *
 *   Step 1  Drop a PDF / image  → POST /invoices/upload (multipart)
 *                                 returns extracted header + line items
 *   Step 2  Edit the extracted fields + line items inline
 *   Step 3  Run basic validation (PO lookup, supplier lookup, totals,
 *           line-item math)
 *   Step 4  Save  → POST /invoices with the shaped payload
 *
 * Matches the pre-redesign behaviour the team is used to, but lives
 * inside the new design system.
 */

/* ---------------- Types ---------------- */

interface InvoiceItem {
  itemName: string
  itemCode: string
  hsnSac: string
  quantity: number | null
  unitPrice: number | null
  lineTotal: number | null
  taxableValue: number | null
  cgstRate: number | null
  cgstAmount: number | null
  sgstRate: number | null
  sgstAmount: number | null
  igstRate: number | null
  igstAmount: number | null
  totalTaxAmount: number | null
}

interface InvoiceForm {
  invoiceNumber: string
  invoiceDate: string
  poNumber: string
  supplierName: string
  billTo: string
  subtotal: number | null
  cgst: number | null
  sgst: number | null
  taxAmount: number | null
  roundOff: number | null
  totalAmount: number | null
  totalAmountInWords: string
  termsAndConditions: string
  authorisedSignatory: string
  items: InvoiceItem[]
}

const EMPTY_FORM: InvoiceForm = {
  invoiceNumber: '',
  invoiceDate: '',
  poNumber: '',
  supplierName: '',
  billTo: '',
  subtotal: null,
  cgst: null,
  sgst: null,
  taxAmount: null,
  roundOff: null,
  totalAmount: null,
  totalAmountInWords: '',
  termsAndConditions: '',
  authorisedSignatory: '',
  items: []
}

const EMPTY_ITEM: InvoiceItem = {
  itemName: '',
  itemCode: '',
  hsnSac: '',
  quantity: null,
  unitPrice: null,
  lineTotal: null,
  taxableValue: null,
  cgstRate: null,
  cgstAmount: null,
  sgstRate: null,
  sgstAmount: null,
  igstRate: null,
  igstAmount: null,
  totalTaxAmount: null
}

interface ValidationBucket {
  ok: boolean
  label: string
  errors: string[]
  info?: string[]
}

interface ValidationReport {
  overallOk: boolean
  invoiceHeader: ValidationBucket
  totals: ValidationBucket
  po: ValidationBucket
  supplier: ValidationBucket
  lineItems: ValidationBucket
}

/* ---------------- helpers ---------------- */

const toNum = (v: unknown): number | null => {
  const n = parseAmount(v)
  return n == null ? null : n
}

function parseDate(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return ''
    return d.toISOString().slice(0, 10)
  }
  return ''
}

/* =========================================================== *
 *                       Component                             *
 * =========================================================== */

function InvoiceUploadPage() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [drag, setDrag] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // PDF / image preview state
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewKind, setPreviewKind] = useState<'pdf' | 'image' | null>(null)
  const [pdfPageCount, setPdfPageCount] = useState(0)
  const [pdfPage, setPdfPage] = useState(1)
  const [pdfZoom, setPdfZoom] = useState(1)
  const [pdfError, setPdfError] = useState('')

  // Revoke any old object URL when a new file comes in or on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const [form, setForm] = useState<InvoiceForm>(EMPTY_FORM)
  const [pdfBuffer, setPdfBuffer] = useState<string | null>(null)
  const [pdfFileName, setPdfFileName] = useState<string | null>(null)
  const [poId, setPoId] = useState<number | null>(null)
  const [supplierId, setSupplierId] = useState<number | null>(null)

  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [savedInvoiceId, setSavedInvoiceId] = useState<number | null>(null)

  const hasExtracted = Boolean(pdfBuffer)

  /* ---------- step 1: upload + extract ---------- */

  const handleFile = useCallback(async (f: File | null) => {
    if (!f) return
    setError('')
    setInfo('')
    setValidation(null)
    setSavedInvoiceId(null)
    setFile(f)
    setExtracting(true)

    // Build the local preview immediately so the user sees the document
    // while extraction runs in the background.
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(f)
    })
    setPreviewKind(f.type.startsWith('image/') ? 'image' : 'pdf')
    setPdfPage(1)
    setPdfPageCount(f.type.startsWith('image/') ? 1 : 0)
    setPdfZoom(1)
    setPdfError('')

    try {
      const fd = new FormData()
      fd.append('pdf', f)
      const token = localStorage.getItem('authToken')
      const res = await fetch(apiUrl('invoices/upload'), {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Extraction failed'))
      const body = await res.json()
      const extracted = body.invoiceData || {}
      setPdfBuffer(body.pdfBuffer ?? null)
      setPdfFileName(body.pdfFileName ?? f.name)
      setPoId(body.poId ?? null)
      setSupplierId(body.supplierId ?? null)

      setForm({
        invoiceNumber: extracted.invoiceNumber || '',
        invoiceDate: parseDate(extracted.invoiceDate),
        poNumber: extracted.poNumber || '',
        supplierName: extracted.supplierName || '',
        billTo: extracted.billTo || '',
        subtotal: toNum(extracted.subtotal),
        cgst: toNum(extracted.cgst),
        sgst: toNum(extracted.sgst),
        taxAmount: toNum(extracted.taxAmount),
        roundOff: toNum(extracted.roundOff),
        totalAmount: toNum(extracted.totalAmount),
        totalAmountInWords: extracted.totalAmountInWords || '',
        termsAndConditions: extracted.termsAndConditions || '',
        authorisedSignatory: extracted.authorisedSignatory || '',
        items: Array.isArray(extracted.items)
          ? extracted.items.map((it: Record<string, unknown>) => ({
              itemName: (it.itemName as string) || '',
              itemCode: (it.itemCode as string) || (it.hsnSac as string) || '',
              hsnSac: (it.hsnSac as string) || (it.itemCode as string) || '',
              quantity: toNum(it.quantity),
              unitPrice: toNum(it.unitPrice),
              lineTotal: toNum(it.lineTotal),
              taxableValue: toNum(it.taxableValue),
              cgstRate: toNum(it.cgstRate),
              cgstAmount: toNum(it.cgstAmount),
              sgstRate: toNum(it.sgstRate),
              sgstAmount: toNum(it.sgstAmount),
              igstRate: toNum(it.igstRate),
              igstAmount: toNum(it.igstAmount),
              totalTaxAmount: toNum(it.totalTaxAmount)
            }))
          : []
      })

      const parts: string[] = []
      if (extracted.invoiceNumber) parts.push(`#${extracted.invoiceNumber}`)
      if (extracted.supplierName) parts.push(extracted.supplierName)
      if (Array.isArray(extracted.items) && extracted.items.length) parts.push(`${extracted.items.length} line items`)
      setInfo(
        body.extracted
          ? `Extracted successfully${parts.length ? ` · ${parts.join(' · ')}` : ''}. Review the fields below, run validation, then save.`
          : 'Upload stored. OCR could not extract automatically — fill the fields manually, then save.'
      )
    } catch (err) {
      setError(getDisplayError(err))
      setFile(null)
    } finally {
      setExtracting(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault()
      setDrag(false)
      handleFile(e.dataTransfer.files?.[0] ?? null)
    },
    [handleFile]
  )

  const reset = () => {
    setFile(null)
    setPdfBuffer(null)
    setPdfFileName(null)
    setPoId(null)
    setSupplierId(null)
    setForm(EMPTY_FORM)
    setValidation(null)
    setSavedInvoiceId(null)
    setError('')
    setInfo('')
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setPreviewKind(null)
    setPdfPage(1)
    setPdfPageCount(0)
    setPdfZoom(1)
    setPdfError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  /* ---------- form helpers ---------- */

  const updateField = <K extends keyof InvoiceForm>(key: K, value: InvoiceForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const updateItem = (index: number, key: keyof InvoiceItem, value: string | number | null) => {
    setForm((f) => {
      const items = [...f.items]
      const row = { ...items[index], [key]: value } as InvoiceItem
      // Recompute line total when qty / unit price change
      if (key === 'quantity' || key === 'unitPrice') {
        const q = key === 'quantity' ? (value as number | null) : row.quantity
        const p = key === 'unitPrice' ? (value as number | null) : row.unitPrice
        if (q != null && p != null) row.lineTotal = Number((q * p).toFixed(2))
      }
      items[index] = row
      return { ...f, items }
    })
  }

  const addItem = () => setForm((f) => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))
  const removeItem = (i: number) =>
    setForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }))

  /* ---------- derived totals ---------- */

  const computedTotals = useMemo(() => {
    let taxable = 0
    let cgst = 0
    let sgst = 0
    let total = 0
    for (const it of form.items) {
      taxable += it.taxableValue ?? ((it.quantity ?? 0) * (it.unitPrice ?? 0))
      cgst += it.cgstAmount ?? 0
      sgst += it.sgstAmount ?? 0
      total += it.lineTotal ?? ((it.quantity ?? 0) * (it.unitPrice ?? 0))
    }
    const tax = cgst + sgst
    // `total` already equals Σ line_total (which includes tax for each line).
    // Use it as the grand total when line_totals are present; otherwise fall
    // back to taxable + tax. Never add tax on top of total — that double-counts.
    const grand = total > 0 ? total : taxable + tax
    return { taxable, cgst, sgst, tax, total, grand }
  }, [form.items])

  /* ---------- step 3: validate ---------- */

  const runValidation = async () => {
    setError('')
    setValidation(null)
    setInfo('')
    const report: ValidationReport = {
      overallOk: true,
      invoiceHeader: { ok: true, label: 'Invoice header', errors: [] },
      totals:        { ok: true, label: 'Totals & line math', errors: [] },
      po:            { ok: true, label: 'Purchase order', errors: [], info: [] },
      supplier:      { ok: true, label: 'Supplier master', errors: [], info: [] },
      lineItems:     { ok: true, label: 'Line items', errors: [] }
    }

    /* --- header --- */
    if (!form.invoiceNumber.trim()) report.invoiceHeader.errors.push('Invoice number is required.')
    if (!form.invoiceDate)          report.invoiceHeader.errors.push('Invoice date is required.')
    if (!form.supplierName.trim())  report.invoiceHeader.errors.push('Supplier name is required.')
    if (!form.totalAmount || form.totalAmount <= 0) report.invoiceHeader.errors.push('Total amount is required.')

    /* --- totals & line math --- */
    const declared = form.totalAmount ?? 0
    const computedGrand = computedTotals.taxable + computedTotals.tax
    if (form.items.length > 0 && declared > 0 && Math.abs(declared - computedGrand) > 1) {
      report.totals.errors.push(
        `Declared total ${formatINRSymbol(declared)} differs from sum of line items ${formatINRSymbol(computedGrand)}.`
      )
    }
    if (form.items.length === 0) {
      report.totals.errors.push('Invoice has no line items.')
    }

    form.items.forEach((it, i) => {
      const label = `Line ${i + 1}${it.itemName ? ` (${it.itemName})` : ''}`
      if (!it.itemName.trim()) report.lineItems.errors.push(`${label}: item name is missing.`)
      if (it.quantity == null || it.quantity <= 0) report.lineItems.errors.push(`${label}: quantity must be > 0.`)
      if (it.unitPrice == null || it.unitPrice <= 0) report.lineItems.errors.push(`${label}: unit price must be > 0.`)
      if (it.quantity != null && it.unitPrice != null && it.lineTotal != null) {
        // Acceptable formulations:
        //   A) line_total ≈ qty × price                 (tax in header only)
        //   B) line_total ≈ qty × price + cgst + sgst + igst   (tax in line)
        //   C) line_total ≈ taxable_value + cgst + sgst + igst (taxable may include discount)
        // We accept any of the three within ±₹1 OR ±1 %.
        const base = it.quantity * it.unitPrice
        const tax = (it.cgstAmount ?? 0) + (it.sgstAmount ?? 0) + (it.igstAmount ?? 0)
        const taxableBase = it.taxableValue ?? base
        const candidates = [base, base + tax, taxableBase + tax]
        const okWithin = (a: number, b: number) =>
          Math.abs(a - b) <= 1 || Math.abs(a - b) <= Math.abs(b) * 0.01
        const matches = candidates.some((c) => okWithin(it.lineTotal as number, c))
        if (!matches) {
          report.lineItems.errors.push(
            `${label}: line total ${formatINRSymbol(it.lineTotal)} does not match qty × price (${formatINRSymbol(base)}) or qty × price + tax (${formatINRSymbol(base + tax)}).`
          )
        }
      }
    })

    /* --- PO lookup (optional) --- */
    if (form.poNumber.trim()) {
      try {
        const res = await apiFetch(`purchase-orders/${encodeURIComponent(form.poNumber.trim())}`)
        if (res.ok) {
          const po = await res.json()
          if (po?.po_id) {
            setPoId(po.po_id)
            report.po.info?.push(`PO found: ${po.po_number} (${po.supplier_name ?? 'unknown supplier'}).`)
          } else {
            report.po.errors.push(`PO "${form.poNumber}" not found in the database.`)
          }
        } else if (res.status === 404) {
          report.po.errors.push(`PO "${form.poNumber}" not found in the database.`)
        } else {
          report.po.errors.push(`PO lookup failed (HTTP ${res.status}).`)
        }
      } catch (err) {
        report.po.errors.push(`PO lookup failed: ${getDisplayError(err)}`)
      }
    } else {
      report.po.info?.push('No PO reference entered — validation will run without PO cross-checks.')
    }

    /* --- supplier lookup --- */
    if (form.supplierName.trim()) {
      try {
        const res = await apiFetch(`suppliers/${encodeURIComponent(form.supplierName.trim())}`)
        if (res.ok) {
          const sup = await res.json()
          if (sup?.supplier_id) {
            setSupplierId(sup.supplier_id)
            const missing: string[] = []
            if (!sup.gst_number) missing.push('GSTIN')
            if (!sup.pan_number) missing.push('PAN')
            if (!sup.bank_account_number) missing.push('bank account')
            if (!sup.bank_ifsc_code) missing.push('IFSC')
            if (missing.length > 0) {
              report.supplier.errors.push(
                `Supplier "${sup.supplier_name}" is missing: ${missing.join(', ')}. Update the supplier master before saving.`
              )
            } else {
              report.supplier.info?.push(`Supplier "${sup.supplier_name}" resolved with full master data.`)
            }
          } else {
            report.supplier.errors.push(`Supplier "${form.supplierName}" not found in the master.`)
          }
        } else if (res.status === 404) {
          report.supplier.errors.push(`Supplier "${form.supplierName}" not found in the master.`)
        } else {
          report.supplier.errors.push(`Supplier lookup failed (HTTP ${res.status}).`)
        }
      } catch (err) {
        report.supplier.errors.push(`Supplier lookup failed: ${getDisplayError(err)}`)
      }
    }

    /* --- finalise bucket.ok flags --- */
    for (const key of ['invoiceHeader', 'totals', 'po', 'supplier', 'lineItems'] as const) {
      report[key].ok = report[key].errors.length === 0
    }
    report.overallOk = report.invoiceHeader.ok && report.totals.ok && report.lineItems.ok && report.supplier.ok
    // PO is non-blocking — we warn but don't block save if PO is missing.

    setValidation(report)
    if (report.overallOk) {
      setInfo('Validation passed. You can now save the invoice.')
    } else {
      setError('Validation found issues. Please review each section below and fix before saving.')
    }
  }

  /* ---------- step 4: save ---------- */

  const handleSave = async () => {
    setError('')
    setInfo('')
    if (!validation || !validation.overallOk) {
      setError('Run validation first — and make sure every required section is green before saving.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        invoiceNumber: form.invoiceNumber.trim(),
        invoiceDate: form.invoiceDate || null,
        supplierId: supplierId,
        poId: poId,
        poNumber: form.poNumber.trim() || null,
        totalAmount: form.totalAmount ?? computedTotals.grand,
        taxAmount: form.taxAmount ?? computedTotals.tax,
        notes: form.termsAndConditions || null,
        pdfFileName,
        pdfBuffer,
        items: form.items.map((it) => ({
          itemName: it.itemName,
          itemCode: it.itemCode,
          hsnSac: it.hsnSac || it.itemCode,
          billedQty: it.quantity,
          rate: it.unitPrice,
          unitPrice: it.unitPrice,
          lineTotal: it.lineTotal,
          taxableValue: it.taxableValue,
          cgstRate: it.cgstRate,
          cgstAmount: it.cgstAmount,
          sgstRate: it.sgstRate,
          sgstAmount: it.sgstAmount,
          totalTaxAmount: it.totalTaxAmount
        }))
      }
      const res = await apiFetch('invoices', {
        method: 'POST',
        body: JSON.stringify(payload)
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Save failed'))
      const body = await res.json()
      const id = body.invoiceId ?? body.invoice_id ?? null
      setSavedInvoiceId(id)
      setInfo(`Invoice saved successfully${id ? ` · ID ${id}` : ''}.`)
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setSaving(false)
    }
  }

  /* =========================================================== *
   *                         Render                              *
   * =========================================================== */

  const stepNumber = savedInvoiceId ? 4 : validation ? 3 : hasExtracted ? 2 : 1

  return (
    <>
      <PageHero
        eyebrow="Workflow"
        eyebrowIcon="pi-upload"
        title="Upload invoice"
        subtitle="Drop a PDF or image — we extract the header and line items automatically, you review &amp; edit, run a quick validation, then save."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/invoices/validate')}>
            <i className="pi pi-list" /> All invoices
          </button>
        }
      />

      {/* ============ Stepper ============ */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: '0.5rem',
          padding: '0.5rem',
          background: 'var(--surface-0)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-sm)'
        }}
      >
        {[
          { n: 1, label: 'Upload PDF',          icon: 'pi-upload' },
          { n: 2, label: 'Review & edit',       icon: 'pi-pencil' },
          { n: 3, label: 'Validate',            icon: 'pi-shield' },
          { n: 4, label: 'Save',                icon: 'pi-check' }
        ].map((s) => {
          const active = stepNumber === s.n
          const done = stepNumber > s.n
          return (
            <div
              key={s.n}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.55rem',
                padding: '0.6rem 0.8rem',
                borderRadius: 'var(--radius-md)',
                background: active
                  ? 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))'
                  : done
                  ? 'var(--status-success-bg)'
                  : 'var(--surface-1)',
                color: active ? '#fff' : done ? 'var(--status-success-fg)' : 'var(--text-muted)',
                border: `1px solid ${active ? 'transparent' : done ? 'var(--status-success-ring)' : 'var(--border-subtle)'}`,
                boxShadow: active ? '0 10px 22px -12px rgba(99,102,241,0.55)' : 'none'
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: active ? 'rgba(255,255,255,0.2)' : done ? 'var(--status-success-fg)' : 'var(--surface-2)',
                  color: active || done ? '#fff' : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  flexShrink: 0
                }}
              >
                {done ? <i className="pi pi-check" /> : s.n}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, opacity: 0.85 }}>
                  Step {s.n}
                </span>
                <span style={{ fontSize: '0.84rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Messages */}
      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}
      {info && !error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-success-ring)', color: 'var(--status-success-fg)' }}>
          <i className="pi pi-check-circle" /> {info}
        </div>
      )}

      {/* ============ Step 1: upload ============ */}
      {!hasExtracted && (
        <div className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-cloud-upload" style={{ color: 'var(--brand-600)' }} /> Drop zone
          </h3>
          <div className="glass-card__subtitle">Accepted: PDF or image up to 20 MB. We extract the header and line items automatically.</div>

          <label
            htmlFor="invoice-upload-input"
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={handleDrop}
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
              minHeight: 220,
              transition: 'all 200ms var(--ease-out)'
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: '1.6rem'
              }}
            >
              <i className={`pi ${extracting ? 'pi-spin pi-spinner' : 'pi-upload'}`} />
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {extracting
                ? 'Extracting invoice data…'
                : file
                ? file.name
                : 'Click to browse or drop your PDF / image here'}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {file ? `${(file.size / (1024 * 1024)).toFixed(2)} MB` : 'PDF or image · one invoice per file'}
            </div>
            <input
              id="invoice-upload-input"
              ref={inputRef}
              type="file"
              accept="application/pdf,image/*"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
      )}

      {/* ============ Step 2: review & edit ============ */}
      {hasExtracted && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(320px, 440px) 1fr',
            gap: 'var(--space-4)',
            alignItems: 'start'
          }}
          // Grid layout:
          //   row 1, col 1 → PDF preview (sticky)
          //   row 1, col 2 → invoice header form
          //   row 2+ span both cols → line items / actions / validation
        >
          {/* ============ LEFT: PDF / image preview ============ */}
          <aside
            className="glass-card"
            style={{
              position: 'sticky',
              top: 'calc(var(--topbar-h, 64px) + 1rem)',
              padding: 0,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              maxHeight: 'calc(100vh - 6rem)'
            }}
          >
            <div
              style={{
                padding: '0.85rem 1rem',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.55rem'
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  background: 'color-mix(in srgb, var(--brand-600) 18%, transparent)',
                  color: 'var(--brand-600)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.85rem',
                  flexShrink: 0
                }}
              >
                <i className="pi pi-file-pdf" />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: '0.88rem',
                    fontWeight: 800,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {pdfFileName || file?.name || 'uploaded file'}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {previewKind === 'pdf'
                    ? pdfPageCount > 0
                      ? `Page ${pdfPage} of ${pdfPageCount}`
                      : 'Loading PDF…'
                    : previewKind === 'image'
                    ? 'Image preview'
                    : '—'}
                </div>
              </div>
            </div>

            {/* Toolbar: zoom + paging */}
            {previewKind === 'pdf' && (
              <div
                style={{
                  padding: '0.5rem 0.75rem',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  background: 'var(--surface-1)'
                }}
              >
                <button
                  type="button"
                  onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                  disabled={pdfPage <= 1}
                  style={toolBtnStyle}
                  title="Previous page"
                >
                  <i className="pi pi-chevron-left" />
                </button>
                <span
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--text-muted)',
                    fontWeight: 700,
                    minWidth: 54,
                    textAlign: 'center'
                  }}
                >
                  {pdfPage} / {pdfPageCount || '?'}
                </span>
                <button
                  type="button"
                  onClick={() => setPdfPage((p) => Math.min(pdfPageCount || p, p + 1))}
                  disabled={pdfPage >= pdfPageCount}
                  style={toolBtnStyle}
                  title="Next page"
                >
                  <i className="pi pi-chevron-right" />
                </button>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setPdfZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))}
                  style={toolBtnStyle}
                  title="Zoom out"
                >
                  <i className="pi pi-minus" />
                </button>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 700, minWidth: 44, textAlign: 'center' }}>
                  {Math.round(pdfZoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setPdfZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))}
                  style={toolBtnStyle}
                  title="Zoom in"
                >
                  <i className="pi pi-plus" />
                </button>
                <button
                  type="button"
                  onClick={() => setPdfZoom(1)}
                  style={toolBtnStyle}
                  title="Reset zoom"
                >
                  <i className="pi pi-refresh" />
                </button>
              </div>
            )}

            {/* Preview area */}
            <div
              style={{
                flex: 1,
                overflow: 'auto',
                background: 'var(--surface-2)',
                padding: '0.75rem',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-start'
              }}
            >
              {!previewUrl ? (
                <div style={{ padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  No preview available.
                </div>
              ) : previewKind === 'image' ? (
                <img
                  src={previewUrl}
                  alt="Invoice preview"
                  style={{
                    maxWidth: '100%',
                    height: 'auto',
                    borderRadius: 'var(--radius-sm)',
                    boxShadow: 'var(--shadow-md)',
                    background: '#fff'
                  }}
                />
              ) : pdfError ? (
                <div style={{ padding: '1.2rem', color: 'var(--status-danger-fg)', fontSize: '0.85rem', textAlign: 'center' }}>
                  <i className="pi pi-exclamation-triangle" /> {pdfError}
                </div>
              ) : (
                <Document
                  file={previewUrl}
                  onLoadSuccess={({ numPages }) => {
                    setPdfPageCount(numPages)
                    setPdfError('')
                  }}
                  onLoadError={(e) => setPdfError(e?.message || 'Failed to load PDF')}
                  loading={
                    <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>
                      <i className="pi pi-spin pi-spinner" /> Loading PDF…
                    </div>
                  }
                >
                  <Page
                    pageNumber={pdfPage}
                    width={380 * pdfZoom}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                    loading={
                      <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>
                        <i className="pi pi-spin pi-spinner" /> Rendering page…
                      </div>
                    }
                  />
                </Document>
              )}
            </div>
          </aside>

          {/* ============ RIGHT (row 1, col 2): invoice header form ============ */}
          <section className="glass-card" style={{ gridColumn: 2, gridRow: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
              <h3 className="glass-card__title" style={{ margin: 0 }}>
                <i className="pi pi-file" style={{ color: 'var(--brand-600)' }} /> Invoice header
              </h3>
              <div style={{ flex: 1 }} />
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  fontWeight: 600
                }}
              >
                <i className="pi pi-paperclip" /> {pdfFileName || file?.name || 'uploaded file'}
              </span>
              <button type="button" className="action-btn action-btn--ghost" onClick={reset}>
                <i className="pi pi-replay" /> Upload a different file
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '0.9rem'
              }}
            >
              <TextField label="Invoice number *" value={form.invoiceNumber} onChange={(v) => updateField('invoiceNumber', v)} />
              <DateField  label="Invoice date *"   value={form.invoiceDate}   onChange={(v) => updateField('invoiceDate', v)} />
              <TextField label="PO number"         value={form.poNumber}      onChange={(v) => updateField('poNumber', v)} />
              <TextField label="Supplier name *"   value={form.supplierName}  onChange={(v) => updateField('supplierName', v)} />
              <TextField label="Bill to"           value={form.billTo}        onChange={(v) => updateField('billTo', v)} />
              <NumberField label="Subtotal"        value={form.subtotal}      onChange={(v) => updateField('subtotal', v)} />
              <NumberField label="CGST"            value={form.cgst}          onChange={(v) => updateField('cgst', v)} />
              <NumberField label="SGST"            value={form.sgst}          onChange={(v) => updateField('sgst', v)} />
              <NumberField label="Tax amount"      value={form.taxAmount}     onChange={(v) => updateField('taxAmount', v)} />
              <NumberField label="Round off"       value={form.roundOff}      onChange={(v) => updateField('roundOff', v)} />
              <NumberField label="Total amount *"  value={form.totalAmount}   onChange={(v) => updateField('totalAmount', v)} />
              <TextField label="Total in words"    value={form.totalAmountInWords} onChange={(v) => updateField('totalAmountInWords', v)} />
            </div>

            <div style={{ marginTop: '0.9rem' }}>
              <TextAreaField
                label="Terms & conditions / notes"
                value={form.termsAndConditions}
                onChange={(v) => updateField('termsAndConditions', v)}
              />
            </div>
          </section>

          {/* ============ Line items table — spans both columns ============ */}
          <section className="glass-card" style={{ padding: 0, overflow: 'hidden', gridColumn: '1 / -1', minWidth: 0 }}>
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <h3 className="glass-card__title" style={{ margin: 0 }}>
                <i className="pi pi-list" style={{ color: 'var(--accent-violet)' }} /> Line items ({form.items.length})
              </h3>
              <div style={{ flex: 1 }} />
              <button type="button" className="action-btn" onClick={addItem}>
                <i className="pi pi-plus" /> Add line
              </button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-1)' }}>
                    {['#', 'Item', 'HSN / Code', 'Qty', 'Unit price', 'Taxable', 'CGST %', 'CGST amt', 'SGST %', 'SGST amt', 'Line total', ''].map((h, i) => (
                      <th
                        key={h + i}
                        style={{
                          padding: '0.65rem 0.8rem',
                          textAlign: i === 0 || i === 1 || i === 2 ? 'left' : i === 11 ? 'center' : 'right',
                          fontSize: '0.68rem',
                          color: 'var(--text-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          fontWeight: 700,
                          borderBottom: '1px solid var(--border-subtle)',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {form.items.map((it, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)' }}>{i + 1}</td>
                      <td style={{ padding: '0.5rem 0.75rem', minWidth: 220 }}>
                        <InlineText value={it.itemName} onChange={(v) => updateItem(i, 'itemName', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', minWidth: 110 }}>
                        <InlineText value={it.hsnSac} onChange={(v) => updateItem(i, 'hsnSac', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 90 }}>
                        <InlineNumber value={it.quantity} onChange={(v) => updateItem(i, 'quantity', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 100 }}>
                        <InlineNumber value={it.unitPrice} onChange={(v) => updateItem(i, 'unitPrice', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 110 }}>
                        <InlineNumber value={it.taxableValue} onChange={(v) => updateItem(i, 'taxableValue', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 75 }}>
                        <InlineNumber value={it.cgstRate} onChange={(v) => updateItem(i, 'cgstRate', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 100 }}>
                        <InlineNumber value={it.cgstAmount} onChange={(v) => updateItem(i, 'cgstAmount', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 75 }}>
                        <InlineNumber value={it.sgstRate} onChange={(v) => updateItem(i, 'sgstRate', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', minWidth: 100 }}>
                        <InlineNumber value={it.sgstAmount} onChange={(v) => updateItem(i, 'sgstAmount', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', fontWeight: 700, minWidth: 110 }}>
                        <InlineNumber value={it.lineTotal} onChange={(v) => updateItem(i, 'lineTotal', v)} />
                      </td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'center' }}>
                        <button
                          type="button"
                          onClick={() => removeItem(i)}
                          style={{
                            background: 'transparent',
                            border: 0,
                            color: 'var(--status-danger-fg)',
                            cursor: 'pointer',
                            padding: '0.3rem 0.5rem',
                            borderRadius: 6
                          }}
                          title="Remove line"
                        >
                          <i className="pi pi-trash" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {form.items.length === 0 && (
                    <tr>
                      <td colSpan={12} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                        No line items extracted. Click <strong>Add line</strong> to enter them manually.
                      </td>
                    </tr>
                  )}
                </tbody>
                {form.items.length > 0 && (
                  <tfoot>
                    <tr style={{ background: 'var(--surface-2)', fontWeight: 800 }}>
                      <td colSpan={5} style={{ padding: '0.65rem 0.8rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                        Totals (computed)
                      </td>
                      <td style={{ padding: '0.65rem 0.8rem', textAlign: 'right' }}>{formatINRSymbol(computedTotals.taxable)}</td>
                      <td />
                      <td style={{ padding: '0.65rem 0.8rem', textAlign: 'right' }}>{formatINRSymbol(computedTotals.cgst)}</td>
                      <td />
                      <td style={{ padding: '0.65rem 0.8rem', textAlign: 'right' }}>{formatINRSymbol(computedTotals.sgst)}</td>
                      <td style={{ padding: '0.65rem 0.8rem', textAlign: 'right' }}>{formatINRSymbol(computedTotals.grand)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>

          {/* ============ Action bar — spans both columns ============ */}
          <div
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.7rem',
              padding: '0.9rem 1rem',
              background: 'var(--surface-0)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-sm)'
            }}
          >
            <button type="button" className="action-btn action-btn--ghost" onClick={runValidation}>
              <i className="pi pi-shield" /> Run validation
            </button>
            <button
              type="button"
              className="action-btn"
              onClick={handleSave}
              disabled={saving || !validation || !validation.overallOk}
              title={
                !validation
                  ? 'Run validation first'
                  : !validation.overallOk
                  ? 'Fix the validation issues before saving'
                  : 'Save the invoice to the database'
              }
            >
              {saving ? <><i className="pi pi-spin pi-spinner" /> Saving…</> : <><i className="pi pi-check" /> Save invoice</>}
            </button>
            {savedInvoiceId && (
              <button
                type="button"
                className="action-btn action-btn--ghost"
                onClick={() => navigate(`/invoices/validate`)}
              >
                <i className="pi pi-list" /> Back to invoices
              </button>
            )}
          </div>

          {/* ============ Validation report — spans both columns ============ */}
          {validation && (
            <section
              className="glass-card"
              style={{
                gridColumn: '1 / -1',
                borderColor: validation.overallOk ? 'var(--status-success-ring)' : 'var(--status-warn-ring)'
              }}
            >
              <h3 className="glass-card__title">
                <i
                  className={`pi ${validation.overallOk ? 'pi-check-circle' : 'pi-exclamation-triangle'}`}
                  style={{ color: validation.overallOk ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}
                />
                Validation report
              </h3>
              <div className="glass-card__subtitle">
                {validation.overallOk
                  ? 'All blocking checks passed. You can now save.'
                  : 'Some checks failed. Review each section and fix before saving.'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', marginTop: '0.75rem' }}>
                <ValidationBlock bucket={validation.invoiceHeader} />
                <ValidationBlock bucket={validation.totals} />
                <ValidationBlock bucket={validation.lineItems} />
                <ValidationBlock bucket={validation.supplier} />
                <ValidationBlock bucket={validation.po} />
              </div>
            </section>
          )}
        </div>
      )}
    </>
  )
}

/* ==================== small inputs ==================== */

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={fieldStyle}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      />
    </label>
  )
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={fieldStyle}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      />
    </label>
  )
}

function NumberField({
  label,
  value,
  onChange
}: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
}) {
  const [raw, setRaw] = useState<string>(value == null ? '' : String(value))
  // Keep raw string in sync if parent updates value externally
  const lastValueRef = useRef(value)
  if (lastValueRef.current !== value) {
    lastValueRef.current = value
    const next = value == null ? '' : String(value)
    if (next !== raw) setRaw(next)
  }
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <input
        type="number"
        step="any"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value)
          if (e.target.value === '') onChange(null)
          else {
            const n = Number(e.target.value)
            onChange(Number.isFinite(n) ? n : null)
          }
        }}
        style={fieldStyle}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      />
    </label>
  )
}

function TextAreaField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        style={{ ...fieldStyle, resize: 'vertical' }}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      />
    </label>
  )
}

function InlineText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={inlineInputStyle}
      onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
      onBlur={(e) => (e.currentTarget.style.borderColor = 'transparent')}
    />
  )
}

function InlineNumber({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [raw, setRaw] = useState<string>(value == null ? '' : String(value))
  const lastRef = useRef(value)
  if (lastRef.current !== value) {
    lastRef.current = value
    const next = value == null ? '' : String(value)
    if (next !== raw) setRaw(next)
  }
  return (
    <input
      type="number"
      step="any"
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value)
        if (e.target.value === '') onChange(null)
        else {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? n : null)
        }
      }}
      style={{ ...inlineInputStyle, textAlign: 'right' }}
      onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
      onBlur={(e) => (e.currentTarget.style.borderColor = 'transparent')}
    />
  )
}

const fieldStyle: React.CSSProperties = {
  padding: '0.65rem 0.8rem',
  borderRadius: 'var(--radius-md)',
  border: '1.5px solid var(--border-subtle)',
  background: 'var(--surface-0)',
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 160ms var(--ease-out)'
}

const toolBtnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 7,
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-0)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '0.8rem',
  flexShrink: 0,
  fontFamily: 'inherit'
}

const inlineInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.35rem 0.45rem',
  borderRadius: 6,
  border: '1.5px solid transparent',
  background: 'var(--surface-1)',
  color: 'var(--text-primary)',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 160ms var(--ease-out), background 160ms var(--ease-out)'
}

/* ==================== validation block ==================== */

function ValidationBlock({ bucket }: { bucket: ValidationBucket }) {
  const { ok, label, errors, info } = bucket
  return (
    <div
      style={{
        padding: '0.75rem 0.9rem',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${ok ? 'var(--status-success-ring)' : 'var(--status-danger-ring)'}`,
        background: ok ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
        color: ok ? 'var(--status-success-fg)' : 'var(--status-danger-fg)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', marginBottom: errors.length || info?.length ? '0.5rem' : 0 }}>
        <i className={`pi ${ok ? 'pi-check-circle' : 'pi-times-circle'}`} />
        <strong style={{ fontSize: '0.88rem' }}>{label}</strong>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '0.72rem', fontWeight: 700 }}>{ok ? 'OK' : `${errors.length} issue${errors.length === 1 ? '' : 's'}`}</span>
      </div>
      {errors.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.82rem', lineHeight: 1.5 }}>
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {info && info.length > 0 && (
        <div style={{ fontSize: '0.78rem', marginTop: errors.length > 0 ? '0.4rem' : 0, opacity: 0.85 }}>
          {info.map((line, i) => (
            <div key={i}>
              <i className="pi pi-info-circle" style={{ marginRight: '0.35rem' }} />
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default InvoiceUploadPage
