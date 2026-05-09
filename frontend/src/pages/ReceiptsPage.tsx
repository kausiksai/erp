import { useEffect, useMemo, useState } from 'react'
import PageHero from '../components/PageHero'
import KPICard from '../components/KPICard'
import { apiFetch } from '../utils/api'
import { useDebounce } from '../hooks/useDebounce'
import { formatDate } from '../utils/format'

/**
 * Receipts — unified view of GRN, ASN, Delivery Challans, and PO
 * Schedules. Replaces four separate top-level pages.
 *
 *   GRN tab       — goods receipt notes
 *   ASN tab       — advance shipping notices
 *   DC tab        — delivery challans
 *   Schedules tab — PO schedules
 *
 * Reads from GET /api/receipts?type=... (Phase 2f). The endpoint normalizes
 * all four shapes into a common row format so this page renders one table
 * regardless of tab.
 */

type Kind = 'grn' | 'asn' | 'dc' | 'schedule'

const KIND_LABEL: Record<Kind, string> = {
  grn: 'GRN',
  asn: 'ASN',
  dc: 'Delivery Challans',
  schedule: 'Schedules'
}
const KIND_ICON: Record<Kind, string> = {
  grn: 'pi-box',
  asn: 'pi-truck',
  dc: 'pi-file-edit',
  schedule: 'pi-calendar'
}

interface ReceiptRow {
  kind: Kind
  id: number
  doc_no: string | null
  doc_date: string | null
  po_number: string | null
  supplier_id: number | null
  supplier_doc_no: string | null
  item: string | null
  qty: number | null
  accepted_qty: number | null
  uom: string | null
  status: string | null
  // optional kind-specific fields
  consumed?: number | null
  balance?: number | null
  transporter?: string | null
  lr_no?: string | null
  promise_date?: string | null
  required_date?: string | null
}

function ReceiptsPage() {
  const [activeTab, setActiveTab] = useState<Kind>('grn')
  const [search, setSearch] = useState('')
  const [poFilter, setPoFilter] = useState('')
  const debouncedSearch = useDebounce(search, 350)
  const debouncedPo = useDebounce(poFilter, 350)

  const [rows, setRows] = useState<ReceiptRow[]>([])
  const [counts, setCounts] = useState<Record<Kind, number>>({ grn: 0, asn: 0, dc: 0, schedule: 0 })
  const [loading, setLoading] = useState(true)

  // Hit each kind once on mount to populate the tab counts.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const kinds: Kind[] = ['grn', 'asn', 'dc', 'schedule']
      try {
        const results = await Promise.all(kinds.map(k =>
          apiFetch(`receipts?type=${k}&limit=1`)
            .then(r => r.ok ? r.json() : { items: [], by_kind: { [k]: 0 } })
            .catch(() => ({ items: [], by_kind: { [k]: 0 } }))
        ))
        if (!alive) return
        // The endpoint doesn't return total per type yet — use list length as
        // a lower bound; the active tab fetches the full page anyway.
        const next: Record<Kind, number> = { grn: 0, asn: 0, dc: 0, schedule: 0 }
        kinds.forEach((k, i) => { next[k] = results[i].by_kind?.[k] ?? results[i].items?.length ?? 0 })
        setCounts(next)
      } catch { /* swallow */ }
    })()
    return () => { alive = false }
  }, [])

  // Page rows for the active tab.
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const qs = new URLSearchParams()
        qs.set('type', activeTab)
        qs.set('limit', '100')
        if (debouncedSearch) qs.set('q', debouncedSearch)
        if (debouncedPo)     qs.set('po', debouncedPo)
        const res = await apiFetch(`receipts?${qs.toString()}`)
        if (!res.ok) { setRows([]); return }
        const body = await res.json()
        if (alive) setRows(body.items || [])
      } catch {
        if (alive) setRows([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [activeTab, debouncedSearch, debouncedPo])

  const total = useMemo(() => counts.grn + counts.asn + counts.dc + counts.schedule, [counts])

  return (
    <>
      <PageHero
        eyebrow="Receipts"
        eyebrowIcon="pi-box"
        title="Receipts"
        subtitle="Goods receipt notes, advance shipping notices, delivery challans, and supplier schedules — unified into one tabbed view, all keyed by PO and invoice number."
      />

      <div className="grid-kpis" style={{ marginBottom: 'var(--space-6)' }}>
        <KPICard label="GRN rows"        value={counts.grn.toLocaleString('en-IN')}      icon="pi-box"        variant="brand"   onClick={() => setActiveTab('grn')} />
        <KPICard label="ASN rows"        value={counts.asn.toLocaleString('en-IN')}      icon="pi-truck"      variant="violet"  onClick={() => setActiveTab('asn')} />
        <KPICard label="Delivery Challans" value={counts.dc.toLocaleString('en-IN')}      icon="pi-file-edit"  variant="amber"   onClick={() => setActiveTab('dc')} />
        <KPICard label="Schedule entries" value={counts.schedule.toLocaleString('en-IN')} icon="pi-calendar"   variant="emerald" onClick={() => setActiveTab('schedule')} />
      </div>

      {/* Tab row + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
        <div className="tab-row">
          {(['grn', 'asn', 'dc', 'schedule'] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`tab-row__btn ${activeTab === k ? 'tab-row__btn--active' : ''}`}
              onClick={() => setActiveTab(k)}
            >
              <i className={`pi ${KIND_ICON[k]}`} style={{ marginRight: 6 }} />
              {KIND_LABEL[k]}
              {counts[k] > 0 && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>· {counts[k].toLocaleString('en-IN')}</span>}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="toolbar__search" style={{ minWidth: 240 }}>
          <i className="pi pi-search toolbar__searchIcon" />
          <input
            type="search"
            className="toolbar__searchInput"
            placeholder={`Search ${KIND_LABEL[activeTab].toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="toolbar__search" style={{ minWidth: 180 }}>
          <i className="pi pi-tag toolbar__searchIcon" />
          <input
            type="search"
            className="toolbar__searchInput"
            placeholder="Filter by PO…"
            value={poFilter}
            onChange={(e) => setPoFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 'var(--space-8) var(--space-4)', textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="pi pi-spin pi-spinner" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="emptyState" style={{ border: 0, borderRadius: 0 }}>
            <div className="emptyState__icon"><i className="pi pi-inbox" /></div>
            <div className="emptyState__title">No {KIND_LABEL[activeTab].toLowerCase()} match</div>
            <div className="emptyState__body">Try clearing the filters above. Total in system: {total.toLocaleString('en-IN')}.</div>
          </div>
        ) : (
          <Table activeTab={activeTab} rows={rows} />
        )}
      </div>
    </>
  )
}

/* Per-tab table — picks the right column set for the active kind. */
function Table({ activeTab, rows }: { activeTab: Kind; rows: ReceiptRow[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'var(--surface-1)', borderBottom: '1px solid var(--border-subtle)' }}>
            <Th>Doc no</Th>
            <Th>Date</Th>
            <Th>PO</Th>
            {(activeTab === 'grn' || activeTab === 'asn') && <Th>Supplier doc</Th>}
            <Th>Item</Th>
            <Th align="right">Qty</Th>
            {activeTab === 'grn' && <Th align="right">Accepted</Th>}
            {activeTab === 'dc' && <><Th align="right">Consumed</Th><Th align="right">Balance</Th></>}
            {activeTab === 'asn' && <Th>Transporter</Th>}
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.kind}-${r.id}`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <Td bold>{r.doc_no || <em style={{ color: 'var(--text-muted)' }}>—</em>}</Td>
              <Td muted>{formatDate(r.doc_date)}</Td>
              <Td><code style={{ fontSize: 'var(--fs-xs)' }}>{r.po_number || '—'}</code></Td>
              {(activeTab === 'grn' || activeTab === 'asn') && (
                <Td><code style={{ fontSize: 'var(--fs-xs)' }}>{r.supplier_doc_no || '—'}</code></Td>
              )}
              <Td>{r.item || <span style={{ color: 'var(--text-muted)' }}>—</span>}</Td>
              <Td align="right" mono>{r.qty != null ? `${r.qty} ${r.uom || ''}` : '—'}</Td>
              {activeTab === 'grn' && (
                <Td align="right" mono>{r.accepted_qty != null ? `${r.accepted_qty} ${r.uom || ''}` : '—'}</Td>
              )}
              {activeTab === 'dc' && (
                <>
                  <Td align="right" mono>{r.consumed != null ? r.consumed : '—'}</Td>
                  <Td align="right" mono>{r.balance != null ? r.balance : '—'}</Td>
                </>
              )}
              {activeTab === 'asn' && (
                <Td muted>{r.transporter || '—'}</Td>
              )}
              <Td>
                {r.status
                  ? <span className="status-chip status-chip--info">{r.status}</span>
                  : <span style={{ color: 'var(--text-muted)' }}>—</span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return (
    <th style={{
      padding: '10px 14px', fontSize: 'var(--fs-xs)', fontWeight: 600,
      color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
      textAlign: align === 'right' ? 'right' : 'left', whiteSpace: 'nowrap'
    }}>{children}</th>
  )
}
function Td({ children, bold, muted, align, mono }: {
  children?: React.ReactNode; bold?: boolean; muted?: boolean; align?: 'right'; mono?: boolean
}) {
  return (
    <td style={{
      padding: '12px 14px', fontSize: 'var(--fs-sm)',
      color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
      fontWeight: bold ? 600 : 400,
      textAlign: align === 'right' ? 'right' : 'left',
      fontFamily: mono ? 'var(--font-mono)' : undefined,
      fontVariantNumeric: mono ? 'tabular-nums' : undefined,
      verticalAlign: 'top'
    }}>{children}</td>
  )
}

export default ReceiptsPage
