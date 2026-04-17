import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import StatusChip from './StatusChip'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatDateTime, formatINRSymbol, formatQty, parseAmount } from '../utils/format'

interface PoHeader {
  po_id: number
  po_number: string | null
  po_date: string | null
  supplier_name: string | null
  status: string | null
  amd_no?: number | string | null
  pfx?: string | null
  unit?: string | null
  ref_unit?: string | null
  suplr_id?: string | null
  terms?: string | null
  line_item_count?: number | string | null
  created_at?: string | null
  updated_at?: string | null
}

interface PoLine {
  po_line_id: number
  sequence_number: number | string | null
  item_id: string | null
  description1: string | null
  qty: number | string | null
  unit_cost: number | string | null
  disc_pct: number | string | null
  raw_material: string | null
  process_description: string | null
  norms: string | null
  process_cost: number | string | null
}

const cache = new Map<number, PoLine[]>()

export default function PoExpansion({ po }: { po: PoHeader }) {
  const [lines, setLines] = useState<PoLine[]>(() => cache.get(po.po_id) ?? [])
  const [loading, setLoading] = useState(!cache.has(po.po_id))
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    if (cache.has(po.po_id)) {
      setLines(cache.get(po.po_id)!)
      setLoading(false)
      return
    }
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const res = await apiFetch(`purchase-orders/${po.po_id}/line-items`)
        if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load PO lines'))
        const body = await res.json()
        const rows: PoLine[] = Array.isArray(body) ? body : body.items || []
        cache.set(po.po_id, rows)
        if (alive) setLines(rows)
      } catch (err) {
        if (alive) setError(getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [po.po_id])

  const poValue = lines.reduce((sum, ln) => {
    const q = parseAmount(ln.qty) ?? 0
    const c = parseAmount(ln.unit_cost) ?? 0
    return sum + q * c
  }, 0)

  return (
    <div
      style={{
        padding: '1rem 1.25rem 1.5rem',
        background: 'var(--surface-1)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.9rem'
      }}
    >
      {/* Header hero */}
      <div
        style={{
          position: 'relative',
          padding: '1rem 1.2rem',
          borderRadius: 'var(--radius-lg)',
          background: 'linear-gradient(135deg, rgba(139,92,246,0.10), rgba(6,182,212,0.08))',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap'
        }}
      >
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 11,
            background: 'linear-gradient(135deg, var(--accent-violet), var(--brand-600))',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            flexShrink: 0
          }}
        >
          <i className="pi pi-shopping-cart" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
              Purchase order
            </span>
            <StatusChip status={po.status} />
            {Number(po.amd_no || 0) > 0 && (
              <span
                style={{
                  padding: '0.1rem 0.5rem',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  borderRadius: 9999,
                  background: 'var(--status-info-bg)',
                  color: 'var(--status-info-fg)'
                }}
              >
                AMD {po.amd_no}
              </span>
            )}
          </div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginTop: '0.15rem' }}>
            {po.po_number || '—'}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {po.supplier_name || '—'}
            {po.po_date && <> · {formatDate(po.po_date)}</>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
            PO base value
          </div>
          <div style={{ fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {formatINRSymbol(poValue)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {lines.length} line{lines.length === 1 ? '' : 's'} (qty × unit cost)
          </div>
        </div>
      </div>

      {/* PO facts */}
      <Panel icon="pi-id-card" color="var(--brand-600)" title="PO facts">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '0.85rem'
          }}
        >
          <Field label="PO number"       value={po.po_number} />
          <Field label="PO date"         value={formatDate(po.po_date)} />
          <Field label="Prefix"          value={po.pfx} />
          <Field label="Unit"            value={po.unit} />
          <Field label="Ref unit"        value={po.ref_unit} />
          <Field label="Amendment"       value={po.amd_no != null ? `AMD ${po.amd_no}` : null} />
          <Field label="Supplier"        value={po.supplier_name} />
          <Field label="Supplier code"   value={po.suplr_id} />
          <Field label="Status"          value={po.status} />
          <Field label="Payment terms"   value={po.terms} />
          <Field label="Line items"      value={po.line_item_count != null ? String(po.line_item_count) : String(lines.length)} />
          {po.created_at && <Field label="Created" value={formatDateTime(po.created_at)} />}
          {po.updated_at && <Field label="Updated" value={formatDateTime(po.updated_at)} />}
        </div>
      </Panel>

      {/* PO line items */}
      <Panel icon="pi-list" color="var(--accent-violet)" title={`PO line items${lines.length ? ` (${lines.length})` : ''}`}>
        {loading ? (
          <div style={{ padding: '1.2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="pi pi-spin pi-spinner" style={{ fontSize: '1.3rem', color: 'var(--brand-600)' }} />
            <div style={{ marginTop: '0.45rem', fontSize: '0.85rem' }}>Loading lines…</div>
          </div>
        ) : error ? (
          <div
            style={{
              padding: '0.75rem 0.9rem',
              background: 'var(--status-danger-bg)',
              color: 'var(--status-danger-fg)',
              border: '1px solid var(--status-danger-ring)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.86rem'
            }}
          >
            <i className="pi pi-exclamation-triangle" /> {error}
          </div>
        ) : lines.length === 0 ? (
          <EmptyRow>No line items captured for this PO.</EmptyRow>
        ) : (
          <ScrollTable
            headers={['#', 'Item ID', 'Description', 'Qty', 'Unit cost', 'Disc %', 'Raw material', 'Process', 'Process cost', 'Line value']}
            alignRight={[3, 4, 5, 8, 9]}
            rows={lines.map((ln, i) => {
              const q = parseAmount(ln.qty) ?? 0
              const c = parseAmount(ln.unit_cost) ?? 0
              return [
                String(ln.sequence_number ?? i + 1),
                ln.item_id || '—',
                ln.description1 || '—',
                formatQty(ln.qty),
                formatINRSymbol(ln.unit_cost),
                ln.disc_pct != null ? `${ln.disc_pct}` : '—',
                ln.raw_material || '—',
                ln.process_description || '—',
                formatINRSymbol(ln.process_cost),
                formatINRSymbol(q * c)
              ]
            })}
            footer={[
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              '',
              'Total',
              formatINRSymbol(poValue)
            ]}
          />
        )}
      </Panel>
    </div>
  )
}

/* ========== shared primitives (local copy so this component is self-contained) ========== */

function Panel({
  icon,
  color,
  title,
  children
}: {
  icon: string
  color: string
  title: string
  children: ReactNode
}) {
  return (
    <div
      style={{
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: '1rem 1.15rem',
        boxShadow: 'var(--shadow-sm)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.8rem',
          paddingBottom: '0.6rem',
          borderBottom: '1px dashed var(--border-subtle)'
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: `color-mix(in srgb, ${color} 18%, transparent)`,
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            flexShrink: 0
          }}
        >
          <i className={`pi ${icon}`} />
        </div>
        <h4 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.005em' }}>
          {title}
        </h4>
      </div>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  const empty = value == null || value === '' || value === '—'
  return (
    <div>
      <div
        style={{
          fontSize: '0.66rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
          fontWeight: 700
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '0.88rem',
          color: empty ? 'var(--text-muted)' : 'var(--text-primary)',
          fontWeight: empty ? 400 : 600,
          marginTop: '0.2rem',
          wordBreak: 'break-word'
        }}
      >
        {empty ? '—' : value}
      </div>
    </div>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '1rem',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--surface-1)',
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--border-default)',
        fontSize: '0.85rem'
      }}
    >
      {children}
    </div>
  )
}

function ScrollTable({
  headers,
  rows,
  alignRight = [],
  footer
}: {
  headers: string[]
  rows: string[][]
  alignRight?: number[]
  footer?: string[]
}) {
  const rightSet = new Set(alignRight)
  return (
    <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
        <thead>
          <tr style={{ background: 'var(--surface-1)' }}>
            {headers.map((h, i) => (
              <th
                key={h + i}
                style={{
                  padding: '0.6rem 0.8rem',
                  textAlign: rightSet.has(i) ? 'right' : 'left',
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
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.6rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal'
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr style={{ background: 'var(--surface-2)', fontWeight: 800 }}>
              {footer.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.65rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    borderTop: '2px solid var(--border-default)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal'
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
