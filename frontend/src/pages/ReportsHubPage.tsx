import { useState } from 'react'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { downloadCsv } from '../utils/exportCsv'
import { formatDate, formatINR, parseAmount } from '../utils/format'
import { useToast } from '../contexts/ToastContext'

/**
 * ReportsHubPage — a download center, NOT a router to list pages.
 *
 * Every report here produces a **real CSV artifact** — the kind of file a
 * finance team would email to an auditor or attach to a monthly close pack.
 * Nothing here duplicates the existing list pages (those are for operational
 * work); these are batched point-in-time extracts with flat columns.
 */

/** Mockup-style audience groups for the reports hub. */
type ReportCategory = 'finance' | 'receiving' | 'procurement' | 'system'

interface ReportDef {
  key: string
  category: ReportCategory
  title: string
  description: string
  icon: string
  accent: string
  endpoint: string
  filename: string
  dateRange: boolean
  columns: { key: string; header: string; format?: (v: unknown) => string }[]
}

const REPORTS: ReportDef[] = [
  {
    key: 'invoice-register',
    category: 'finance',
    title: 'Invoice register',
    description:
      'Every invoice in a date range with supplier, GSTIN, PO reference, taxable amount, tax and status. The canonical payables extract for accounting.',
    icon: 'pi-file',
    accent: '#6366f1',
    endpoint: 'reports/data/invoice-register',
    filename: 'invoice-register',
    dateRange: true,
    columns: [
      { key: 'invoice_number',  header: 'Invoice #' },
      { key: 'invoice_date',    header: 'Invoice date', format: (v) => formatDate(v) },
      { key: 'supplier_name',   header: 'Supplier' },
      { key: 'supplier_gstin',  header: 'Supplier GSTIN' },
      { key: 'supplier_state',  header: 'State' },
      { key: 'po_number',       header: 'PO number' },
      { key: 'taxable_amount',  header: 'Taxable amount', format: (v) => formatINR(v) },
      { key: 'tax_amount',      header: 'Tax amount',     format: (v) => formatINR(v) },
      { key: 'total_amount',    header: 'Total amount',   format: (v) => formatINR(v) },
      { key: 'status',          header: 'Status' },
      { key: 'payment_due_date',header: 'Payment due',    format: (v) => formatDate(v) }
    ]
  },
  {
    key: 'gst-summary',
    category: 'finance',
    title: 'GST summary (monthly)',
    description:
      'Month-wise breakdown of taxable value, CGST, SGST, IGST and total tax. The audit-ready GST file — one row per month.',
    icon: 'pi-percentage',
    accent: '#f59e0b',
    endpoint: 'reports/data/gst-summary',
    filename: 'gst-summary',
    dateRange: true,
    columns: [
      { key: 'month',          header: 'Month (YYYY-MM)' },
      { key: 'invoice_count',  header: 'Invoices' },
      { key: 'taxable_value',  header: 'Taxable value', format: (v) => formatINR(v) },
      { key: 'cgst',           header: 'CGST',          format: (v) => formatINR(v) },
      { key: 'sgst',           header: 'SGST',          format: (v) => formatINR(v) },
      { key: 'igst',           header: 'IGST',          format: (v) => formatINR(v) },
      { key: 'total_tax',      header: 'Total tax',     format: (v) => formatINR(v) },
      { key: 'total_billed',   header: 'Total billed',  format: (v) => formatINR(v) }
    ]
  },
  {
    key: 'outstanding-statement',
    category: 'finance',
    title: 'Outstanding statement',
    description:
      'Every unpaid invoice — validated, ready for payment, partially paid — oldest first, with days-overdue. The chase-list.',
    icon: 'pi-clock',
    accent: '#f43f5e',
    endpoint: 'reports/data/outstanding-statement',
    filename: 'outstanding-statement',
    dateRange: false,
    columns: [
      { key: 'invoice_number',    header: 'Invoice #' },
      { key: 'invoice_date',      header: 'Invoice date', format: (v) => formatDate(v) },
      { key: 'supplier_name',     header: 'Supplier' },
      { key: 'supplier_gstin',    header: 'Supplier GSTIN' },
      { key: 'po_number',         header: 'PO number' },
      { key: 'outstanding_amount',header: 'Outstanding',  format: (v) => formatINR(v) },
      { key: 'status',            header: 'Status' },
      { key: 'payment_due_date',  header: 'Due date',     format: (v) => formatDate(v) },
      { key: 'days_overdue',      header: 'Days overdue' }
    ]
  },
  {
    key: 'payment-register',
    category: 'finance',
    title: 'Payment register',
    description:
      'Every payment executed in the selected date range with invoice, supplier, amount, mode and bank reference. The cash-out ledger.',
    icon: 'pi-wallet',
    accent: '#10b981',
    endpoint: 'reports/data/payment-register',
    filename: 'payment-register',
    dateRange: true,
    columns: [
      { key: 'payment_done_at',    header: 'Payment date', format: (v) => formatDate(v) },
      { key: 'invoice_number',     header: 'Invoice #' },
      { key: 'invoice_date',       header: 'Invoice date', format: (v) => formatDate(v) },
      { key: 'supplier_name',      header: 'Supplier' },
      { key: 'supplier_gstin',     header: 'Supplier GSTIN' },
      { key: 'po_number',          header: 'PO number' },
      { key: 'amount_paid',        header: 'Amount paid',  format: (v) => formatINR(v) },
      { key: 'payment_type',       header: 'Mode' },
      { key: 'payment_reference',  header: 'Reference' },
      { key: 'bank_name',          header: 'Bank' },
      { key: 'bank_account',       header: 'Account' }
    ]
  },
  {
    key: 'po-fulfillment',
    category: 'procurement',
    title: 'PO fulfillment',
    description:
      'Every PO with its coverage flags — invoice, GRN, ASN — and overall status. The quick "what closed, what is still open" view for procurement.',
    icon: 'pi-shopping-cart',
    accent: '#8b5cf6',
    endpoint: 'reports/data/po-fulfillment',
    filename: 'po-fulfillment',
    dateRange: false,
    columns: [
      { key: 'po_number',     header: 'PO #' },
      { key: 'po_date',       header: 'PO date', format: (v) => formatDate(v) },
      { key: 'po_prefix',     header: 'Prefix' },
      { key: 'amendment_no',  header: 'Amendment' },
      { key: 'unit',          header: 'Unit' },
      { key: 'supplier_name', header: 'Supplier' },
      { key: 'po_status',     header: 'PO status' },
      { key: 'has_invoice',   header: 'Invoice' },
      { key: 'has_grn',       header: 'GRN' },
      { key: 'has_asn',       header: 'ASN' },
      { key: 'overall_status',header: 'Overall' }
    ]
  }
]

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function monthStartISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

interface RangeState {
  from: string
  to: string
}

function ReportsHubPage() {
  const [ranges, setRanges] = useState<Record<string, RangeState>>(() => {
    const init: Record<string, RangeState> = {}
    REPORTS.filter((r) => r.dateRange).forEach((r) => {
      init[r.key] = { from: monthStartISO(), to: todayISO() }
    })
    return init
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, { count: number; at: Date }>>({})
  const toast = useToast()

  const updateRange = (key: string, field: 'from' | 'to', value: string) => {
    setRanges((r) => ({ ...r, [key]: { ...r[key], [field]: value } }))
  }

  const handleDownload = async (def: ReportDef) => {
    setBusy(def.key)
    try {
      const qs = new URLSearchParams()
      if (def.dateRange) {
        const r = ranges[def.key]
        if (r?.from) qs.set('from', r.from)
        if (r?.to)   qs.set('to',   r.to)
      }
      const url = qs.toString() ? `${def.endpoint}?${qs.toString()}` : def.endpoint
      const res = await apiFetch(url)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Report failed'))
      const body = await res.json()
      const raw: Array<Record<string, unknown>> = Array.isArray(body)
        ? body
        : Array.isArray(body.rows)
          ? body.rows
          : []
      if (raw.length === 0) {
        toast.warn('Nothing to export', `No rows for "${def.title}" in this date range.`)
        return
      }
      // Apply per-column formatters so the CSV is human-readable.
      const formatted = raw.map((row) => {
        const out: Record<string, unknown> = {}
        for (const col of def.columns) {
          const v = row[col.key]
          out[col.key] = col.format ? col.format(v) : (v ?? '')
        }
        return out
      })
      const range = def.dateRange && ranges[def.key] ? `_${ranges[def.key].from}_to_${ranges[def.key].to}` : ''
      const filename = `${def.filename}${range}.csv`
      downloadCsv(formatted, filename, def.columns)
      toast.success('Report exported', `${raw.length.toLocaleString('en-IN')} row(s) → ${filename}`)
      setPreviews((p) => ({ ...p, [def.key]: { count: raw.length, at: new Date() } }))
    } catch (err) {
      toast.danger('Report failed', getDisplayError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {/* Hero — verbatim from mockup VIEWS.reports */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-chart-bar" /> Insights</span>
          <h1>Reports</h1>
          <p>Pre-built reports grouped by audience. Pin to favorites; schedule recurring delivery to email.</p>
        </div>
        <div className="hero__act">
          <button className="btn btn--g"><i className="pi pi-star" /> Favorites</button>
          <button className="btn btn--g">
            <i className="pi pi-calendar" /> Scheduled <span className="chip chip--info" style={{ marginLeft: 6, fontSize: 10 }}>0</span>
          </button>
          <button className="btn btn--p"><i className="pi pi-plus" /> New custom</button>
        </div>
      </section>

      {/* Group reports by audience category — finance / receiving /
          procurement / system. Each group renders a section-title
          separator and a 3-column card grid, matching mockup VIEWS.reports. */}
      {([
        { key: 'finance',     label: 'Finance & payments',     icon: 'pi-wallet' },
        { key: 'receiving',   label: 'Receiving & logistics',  icon: 'pi-box' },
        { key: 'procurement', label: 'Procurement',            icon: 'pi-shopping-cart' },
        { key: 'system',      label: 'System & data quality',  icon: 'pi-cog' }
      ] as Array<{ key: ReportCategory; label: string; icon: string }>).map((cat) => {
        const items = REPORTS.filter((r) => r.category === cat.key)
        if (items.length === 0) return null
        return (
          <div key={cat.key} style={{ marginBottom: 18 }}>
            <div className="sec">
              <span className="sec__l"><i className={`pi ${cat.icon}`} style={{ marginRight: 4 }} /> {cat.label}</span>
              <span className="sec__line" />
            </div>
            <div className="g3">
              {items.map((r) => {
          const range = ranges[r.key]
          const preview = previews[r.key]
          const isBusy = busy === r.key
          return (
            <section
              key={r.key}
              className="card fade-in-up"
              style={{ padding: 18, display: 'flex', flexDirection: 'column', cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 'var(--radius-md)',
                    background: `linear-gradient(135deg, ${r.accent}, ${r.accent}cc)`,
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.2rem',
                    boxShadow: `0 10px 22px -12px ${r.accent}99`,
                    flexShrink: 0
                  }}
                >
                  <i className={`pi ${r.icon}`} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                    {r.title}
                  </div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.55, marginTop: '0.2rem' }}>
                    {r.description}
                  </div>
                </div>
              </div>

              <div style={{
                fontSize: '0.72rem',
                color: 'var(--text-muted)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginTop: '0.85rem'
              }}>
                {r.columns.length} columns · CSV
              </div>

              {/* Spacer that grows so the footer block always sits at the card bottom */}
              <div style={{ flex: 1 }} />

              {/* --- Filter area: fixed height for both range and non-range cards --- */}
              <div style={{ minHeight: 74, marginTop: '1rem', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                {r.dateRange && range ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>From</span>
                      <input
                        type="date"
                        value={range.from}
                        onChange={(e) => updateRange(r.key, 'from', e.target.value)}
                        style={{
                          padding: '0.55rem 0.7rem',
                          borderRadius: 'var(--radius-md)',
                          border: '1.5px solid var(--border-subtle)',
                          background: 'var(--surface-1)',
                          color: 'var(--text-primary)',
                          fontSize: '0.88rem',
                          fontFamily: 'inherit',
                          outline: 'none'
                        }}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>To</span>
                      <input
                        type="date"
                        value={range.to}
                        onChange={(e) => updateRange(r.key, 'to', e.target.value)}
                        style={{
                          padding: '0.55rem 0.7rem',
                          borderRadius: 'var(--radius-md)',
                          border: '1.5px solid var(--border-subtle)',
                          background: 'var(--surface-1)',
                          color: 'var(--text-primary)',
                          fontSize: '0.88rem',
                          fontFamily: 'inherit',
                          outline: 'none'
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: '0.65rem 0.85rem',
                      borderRadius: 'var(--radius-md)',
                      border: '1px dashed var(--border-default)',
                      background: 'var(--surface-1)',
                      color: 'var(--text-muted)',
                      fontSize: '0.78rem',
                      fontWeight: 500,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    <i className="pi pi-info-circle" style={{ color: 'var(--brand-600)' }} />
                    Full history — no date range needed
                  </div>
                )}
              </div>

              {/* --- Footer: download button, always pinned at the bottom --- */}
              <button
                type="button"
                className="action-btn"
                onClick={() => handleDownload(r)}
                disabled={isBusy}
                style={{ width: '100%', marginTop: '0.85rem', justifyContent: 'center' }}
              >
                {isBusy
                  ? <><i className="pi pi-spin pi-spinner" /> Generating…</>
                  : <><i className="pi pi-download" /> Download CSV</>}
              </button>

              {preview && (
                <div style={{
                  marginTop: '0.55rem',
                  padding: '0.55rem 0.7rem',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--status-success-bg)',
                  color: 'var(--status-success-fg)',
                  border: '1px solid var(--status-success-ring)',
                  fontSize: '0.76rem',
                  fontWeight: 600
                }}>
                  <i className="pi pi-check-circle" /> Last export: {(parseAmount(preview.count) ?? 0).toLocaleString('en-IN')} rows at {preview.at.toLocaleTimeString('en-IN')}
                </div>
              )}
            </section>
          )
              })}
            </div>
          </div>
        )
      })}
    </>
  )
}

export default ReportsHubPage
