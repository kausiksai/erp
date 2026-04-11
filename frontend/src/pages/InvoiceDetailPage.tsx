import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import PageHero from '../components/PageHero'
import StatusChip from '../components/StatusChip'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

interface InvoiceLine {
  line_id: number
  description: string | null
  quantity: number | null
  unit_price: number | null
  line_total: number | null
  hsn_code: string | null
  gst_percent: number | null
}

interface InvoiceDetail {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  supplier_name: string | null
  supplier_gstin: string | null
  po_number: string | null
  total_amount: number | null
  taxable_amount: number | null
  cgst_amount: number | null
  sgst_amount: number | null
  igst_amount: number | null
  status: string | null
  remarks: string | null
  created_at: string | null
  updated_at: string | null
  invoice_lines?: InvoiceLine[]
}

interface ValidationSummary {
  errors?: Array<{ code: string; message: string }>
  warnings?: Array<{ code: string; message: string }>
  info?: Array<{ code: string; message: string }>
  validated_at?: string | null
}

type Tab = 'overview' | 'lines' | 'validation' | 'attachments'

const INR = (n: number | null | undefined) =>
  typeof n === 'number'
    ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—'

function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
  const [validation, setValidation] = useState<ValidationSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [validating, setValidating] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    try {
      setLoading(true)
      setError('')
      const [r1, r2] = await Promise.all([
        apiFetch(`invoices/${id}`),
        apiFetch(`invoices/${id}/validation-summary`)
      ])
      if (!r1.ok) throw new Error(await getErrorMessageFromResponse(r1, 'Could not load invoice'))
      const body = await r1.json()
      setInvoice(body.invoice || body)
      if (r2.ok) {
        const vs = await r2.json()
        setValidation(vs)
      }
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const handleValidate = async () => {
    if (!id) return
    try {
      setValidating(true)
      const res = await apiFetch(`invoices/${id}/validate`, { method: 'POST' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Validation failed'))
      await load()
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setValidating(false)
    }
  }

  if (loading && !invoice) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        <i className="pi pi-spin pi-spinner" style={{ fontSize: '2rem', color: 'var(--brand-600)' }} />
        <div style={{ marginTop: '0.75rem' }}>Loading invoice…</div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="glass-card" style={{ textAlign: 'center' }}>
        <h3 className="glass-card__title"><i className="pi pi-exclamation-triangle" /> Invoice not found</h3>
        <button className="action-btn" onClick={() => navigate('/invoices/validate')}>
          <i className="pi pi-arrow-left" /> Back to invoices
        </button>
      </div>
    )
  }

  return (
    <>
      <PageHero
        eyebrow="Invoice"
        eyebrowIcon="pi-file"
        title={invoice.invoice_number}
        subtitle={
          <>
            <span>{invoice.supplier_name || '—'}</span>
            {invoice.po_number && <> · <code>{invoice.po_number}</code></>}
            {invoice.invoice_date && <> · {new Date(invoice.invoice_date).toLocaleDateString('en-IN')}</>}
          </>
        }
        actions={
          <>
            <button className="action-btn action-btn--ghost" onClick={() => navigate('/invoices/validate')}>
              <i className="pi pi-arrow-left" /> Back
            </button>
            <button className="action-btn" onClick={handleValidate} disabled={validating}>
              {validating ? <><i className="pi pi-spin pi-spinner" /> Validating…</> : <><i className="pi pi-refresh" /> Re-validate</>}
            </button>
          </>
        }
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}

      {/* Status chip row */}
      <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
        <StatusChip status={invoice.status} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
            Grand total
          </div>
          <div style={{ fontSize: '1.65rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            ₹{INR(invoice.total_amount)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>Taxable</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>₹{INR(invoice.taxable_amount)}</div>
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>Tax</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>
            ₹{INR((invoice.cgst_amount || 0) + (invoice.sgst_amount || 0) + (invoice.igst_amount || 0))}
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="tab-row">
        {(['overview', 'lines', 'validation', 'attachments'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`tab-row__btn ${tab === t ? 'tab-row__btn--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'overview'    ? '📋 Overview'    :
             t === 'lines'       ? '📦 Line items'  :
             t === 'validation'  ? '✅ Validation'  : '📎 Attachments'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="glass-card">
          <h3 className="glass-card__title"><i className="pi pi-info-circle" style={{ color: 'var(--brand-600)' }} /> Invoice details</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.2rem', marginTop: '0.75rem' }}>
            <Field label="Supplier name" value={invoice.supplier_name} />
            <Field label="Supplier GSTIN" value={invoice.supplier_gstin} />
            <Field label="PO reference" value={invoice.po_number} />
            <Field label="Invoice date" value={invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString('en-IN') : null} />
            <Field label="Created at" value={invoice.created_at ? new Date(invoice.created_at).toLocaleString('en-IN') : null} />
            <Field label="Updated at" value={invoice.updated_at ? new Date(invoice.updated_at).toLocaleString('en-IN') : null} />
          </div>
          {invoice.remarks && (
            <div style={{ marginTop: '1.25rem', padding: '0.85rem 1rem', background: 'var(--surface-1)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                Remarks
              </div>
              <div style={{ fontSize: '0.92rem', color: 'var(--text-primary)' }}>{invoice.remarks}</div>
            </div>
          )}
        </div>
      )}

      {tab === 'lines' && (
        <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border-subtle)' }}>
            <h3 className="glass-card__title"><i className="pi pi-list" style={{ color: 'var(--accent-violet)' }} /> Line items</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr style={{ background: 'var(--surface-1)' }}>
                  {['#','Description','HSN','Qty','Unit price','GST %','Line total'].map((h) => (
                    <th key={h} style={{ padding: '0.7rem 0.85rem', textAlign: h === 'Description' ? 'left' : 'right', fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, borderBottom: '1px solid var(--border-subtle)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(invoice.invoice_lines || []).map((ln, i) => (
                  <tr key={ln.line_id || i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.86rem', color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 500 }}>{ln.description || '—'}</td>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.86rem', textAlign: 'right' }}>{ln.hsn_code || '—'}</td>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.86rem', textAlign: 'right' }}>{ln.quantity ?? '—'}</td>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.86rem', textAlign: 'right' }}>₹{INR(ln.unit_price)}</td>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.86rem', textAlign: 'right' }}>{ln.gst_percent ?? '—'}%</td>
                    <td style={{ padding: '0.75rem 0.85rem', fontSize: '0.9rem', textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)' }}>₹{INR(ln.line_total)}</td>
                  </tr>
                ))}
                {(!invoice.invoice_lines || invoice.invoice_lines.length === 0) && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-muted)' }}>
                      No line items captured.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'validation' && (
        <div className="glass-card">
          <h3 className="glass-card__title"><i className="pi pi-check-circle" style={{ color: 'var(--accent-emerald)' }} /> Validation summary</h3>
          {validation && (validation.errors?.length || validation.warnings?.length) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.75rem' }}>
              {(validation.errors || []).map((e, i) => (
                <div key={`e${i}`} style={{ padding: '0.75rem 1rem', background: 'var(--status-danger-bg)', color: 'var(--status-danger-fg)', border: '1px solid var(--status-danger-ring)', borderRadius: 'var(--radius-md)' }}>
                  <strong>{e.code}</strong> · {e.message}
                </div>
              ))}
              {(validation.warnings || []).map((w, i) => (
                <div key={`w${i}`} style={{ padding: '0.75rem 1rem', background: 'var(--status-warn-bg)', color: 'var(--status-warn-fg)', border: '1px solid var(--status-warn-ring)', borderRadius: 'var(--radius-md)' }}>
                  <strong>{w.code}</strong> · {w.message}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '1rem', color: 'var(--text-muted)' }}>
              <i className="pi pi-check-circle" style={{ color: 'var(--accent-emerald)' }} /> No issues found.
            </div>
          )}
        </div>
      )}

      {tab === 'attachments' && (
        <div className="glass-card">
          <h3 className="glass-card__title"><i className="pi pi-paperclip" style={{ color: 'var(--brand-600)' }} /> Attachments</h3>
          <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Attachment management opens in a dedicated viewer — visit the Upload page to add new files.
          </div>
        </div>
      )}
    </>
  )
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontWeight: 600, marginTop: '0.2rem' }}>
        {value ?? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>—</span>}
      </div>
    </div>
  )
}

export default InvoiceDetailPage
