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
      <table className="tbl">
        <thead>
          <tr>
            <th>Doc no</th>
            <th>Date</th>
            <th>PO</th>
            {(activeTab === 'grn' || activeTab === 'asn') && <th>Supplier doc</th>}
            <th>Item</th>
            <th className="tbl__num">Qty</th>
            {activeTab === 'grn' && <th className="tbl__num">Accepted</th>}
            {activeTab === 'dc' && <><th className="tbl__num">Consumed</th><th className="tbl__num">Balance</th></>}
            {activeTab === 'asn' && <th>Transporter</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.kind}-${r.id}`}>
              <td className="tbl__bold">{r.doc_no || <em className="tbl__muted">—</em>}</td>
              <td className="tbl__muted">{formatDate(r.doc_date)}</td>
              <td className="tbl__mono">{r.po_number || '—'}</td>
              {(activeTab === 'grn' || activeTab === 'asn') && (
                <td className="tbl__mono">{r.supplier_doc_no || '—'}</td>
              )}
              <td>{r.item || <span className="tbl__muted">—</span>}</td>
              <td className="tbl__num">{r.qty != null ? `${r.qty} ${r.uom || ''}` : '—'}</td>
              {activeTab === 'grn' && (
                <td className="tbl__num">{r.accepted_qty != null ? `${r.accepted_qty} ${r.uom || ''}` : '—'}</td>
              )}
              {activeTab === 'dc' && (
                <>
                  <td className="tbl__num">{r.consumed != null ? r.consumed : '—'}</td>
                  <td className="tbl__num">{r.balance != null ? r.balance : '—'}</td>
                </>
              )}
              {activeTab === 'asn' && (
                <td className="tbl__muted">{r.transporter || '—'}</td>
              )}
              <td>
                {r.status
                  ? <span className="status-chip status-chip--info">{r.status}</span>
                  : <span className="tbl__muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default ReceiptsPage
