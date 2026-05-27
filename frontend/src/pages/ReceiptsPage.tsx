import { useEffect, useMemo, useState } from 'react'
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
// KIND_ICON map intentionally inlined into the KPI cards now that the
// tab-row no longer carries per-tab icons. Kept here only as a reference.

interface ReceiptRow {
  kind: Kind
  id: number
  doc_no: string | null
  doc_date: string | null
  po_number: string | null
  supplier_id: number | null
  supplier_doc_no: string | null
  supplier_doc_date?: string | null
  item: string | null
  qty: number | null
  accepted_qty: number | null
  uom: string | null
  status: string | null
  // GRN quality breakdown
  rejected_qty?: number | null
  rework_qty?: number | null
  excess_qty?: number | null
  warehouse?: string | null
  gross_weight?: number | null
  nett_weight?: number | null
  // DC-specific
  consumed?: number | null
  in_process?: number | null
  balance?: number | null
  // ASN-specific
  transporter?: string | null
  lr_no?: string | null
  // Schedule-specific
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

  // One fetch on mount populates every tab's count. The backend returns
  // `total_by_kind` ({ grn, asn, dc, schedule }) with real COUNT(*) per
  // table — independent of the limit/offset on this request, so a single
  // limit=1 request is enough to seed all four KPI tiles.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('receipts?limit=1')
        if (!res.ok || !alive) return
        const body = await res.json()
        const totals = body.total_by_kind || {}
        setCounts({
          grn:      Number(totals.grn) || 0,
          asn:      Number(totals.asn) || 0,
          dc:       Number(totals.dc)  || 0,
          schedule: Number(totals.schedule) || 0
        })
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
      {/* Hero — verbatim from mockup VIEWS.receipts */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-box" /> Documents</span>
          <h1>Receipts</h1>
          <p>Goods receipt notes, advance shipping notices, delivery challans and supplier schedules — unified into a single tabbed view, all keyed by PO and invoice number.</p>
        </div>
        <div className="hero__act">
          <button
            type="button"
            className="btn btn--g"
            onClick={() => window.dispatchEvent(new CustomEvent('receipts:export'))}
          >
            <i className="pi pi-download" /> Export
          </button>
        </div>
      </section>

      {/* 4-up KPI strip */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--brand" onClick={() => setActiveTab('grn')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-box" /></div></div>
          <p className="kpi__l">GRN rows</p>
          <div className="kpi__v">{counts.grn.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--vio" onClick={() => setActiveTab('asn')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-truck" /></div></div>
          <p className="kpi__l">ASN rows</p>
          <div className="kpi__v">{counts.asn.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--am" onClick={() => setActiveTab('dc')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-file-edit" /></div></div>
          <p className="kpi__l">Delivery Challans</p>
          <div className="kpi__v">{counts.dc.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--em" onClick={() => setActiveTab('schedule')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-calendar" /></div></div>
          <p className="kpi__l">Schedule entries</p>
          <div className="kpi__v">{counts.schedule.toLocaleString('en-IN')}</div>
        </div>
      </div>

      {/* Mockup tabs row */}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {(['grn', 'asn', 'dc', 'schedule'] as Kind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`tab ${activeTab === k ? 'active' : ''}`}
            onClick={() => setActiveTab(k)}
          >
            {KIND_LABEL[k]}
            <span className="muted" style={{ marginLeft: 6 }}>({counts[k].toLocaleString('en-IN')})</span>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="tb__sr">
          <i className="pi pi-search" />
          <input
            placeholder={`Search ${KIND_LABEL[activeTab].toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="tb__sr" style={{ maxWidth: 220 }}>
          <i className="pi pi-tag" />
          <input
            placeholder="Filter by PO…"
            value={poFilter}
            onChange={(e) => setPoFilter(e.target.value)}
          />
        </div>
        <span className="tb__c">{rows.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="ph"><i className="pi pi-spin pi-spinner" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="ph">
            <i className="pi pi-inbox" />
            No {KIND_LABEL[activeTab].toLowerCase()} match.
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
            {(activeTab === 'grn' || activeTab === 'asn' || activeTab === 'dc') && <th>Supplier doc</th>}
            <th>Item</th>
            <th className="tbl__num">Qty</th>
            {activeTab === 'grn' && <>
              <th className="tbl__num">Accepted</th>
              <th className="tbl__num">Quality breakdown</th>
              <th>Warehouse</th>
              <th className="tbl__num">Weight (g/n)</th>
            </>}
            {activeTab === 'dc' && <>
              <th className="tbl__num">Consumed</th>
              <th className="tbl__num">In&nbsp;process</th>
              <th className="tbl__num">Balance</th>
            </>}
            {activeTab === 'asn' && <><th>Transporter</th><th>LR&nbsp;no</th></>}
            {activeTab === 'schedule' && <><th>Promise</th><th>Required</th></>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.kind}-${r.id}`}>
              <td className="tbl__bold">{r.doc_no || <em className="tbl__muted">—</em>}</td>
              <td className="tbl__muted">{formatDate(r.doc_date)}</td>
              <td className="tbl__mono">{r.po_number || '—'}</td>
              {(activeTab === 'grn' || activeTab === 'asn' || activeTab === 'dc') && (
                <td className="tbl__mono">{r.supplier_doc_no || '—'}</td>
              )}
              <td>{r.item || <span className="tbl__muted">—</span>}</td>
              <td className="tbl__num">{r.qty != null ? `${r.qty} ${r.uom || ''}` : '—'}</td>
              {activeTab === 'grn' && <>
                <td className="tbl__num">{r.accepted_qty != null ? `${r.accepted_qty} ${r.uom || ''}` : '—'}</td>
                <td><GrnQualityBar row={r} /></td>
                <td className="tbl__muted">{r.warehouse || '—'}</td>
                <td className="tbl__num" style={{ whiteSpace: 'nowrap' }}>
                  {/* gross / nett — important on weight-based receipts. Slash
                      separator + tabular-nums so columns align visually. */}
                  {r.gross_weight != null || r.nett_weight != null
                    ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {r.gross_weight != null ? r.gross_weight : '—'}
                        <span className="muted"> / </span>
                        {r.nett_weight != null ? r.nett_weight : '—'}
                      </span>
                    : <span className="tbl__muted">—</span>}
                </td>
              </>}
              {activeTab === 'dc' && (
                <>
                  <td className="tbl__num">{r.consumed != null ? r.consumed : '—'}</td>
                  <td className="tbl__num">{r.in_process != null ? r.in_process : '—'}</td>
                  <td className="tbl__num">{r.balance != null ? r.balance : '—'}</td>
                </>
              )}
              {activeTab === 'asn' && (
                <>
                  <td className="tbl__muted">{r.transporter || '—'}</td>
                  <td className="tbl__mono">{r.lr_no || '—'}</td>
                </>
              )}
              {activeTab === 'schedule' && (
                <>
                  <td className="tbl__muted">{formatDate(r.promise_date)}</td>
                  <td className="tbl__muted">{formatDate(r.required_date)}</td>
                </>
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

/**
 * Mini quality breakdown for a GRN row. Shows accepted / rejected / rework /
 * excess as a small horizontal stack bar plus a numeric "98% acc" label.
 * Falls back gracefully when only `accepted_qty` is present.
 */
function GrnQualityBar({ row }: { row: ReceiptRow }) {
  const acc  = Number(row.accepted_qty || 0)
  const rej  = Number(row.rejected_qty || 0)
  const rew  = Number(row.rework_qty   || 0)
  const exc  = Number(row.excess_qty   || 0)
  const total = acc + rej + rew + exc
  if (total <= 0) {
    return <span className="tbl__muted">—</span>
  }
  const pct = (x: number) => (total > 0 ? (x / total) * 100 : 0)
  const accPct = Math.round((acc / total) * 100)
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{
        display: 'flex',
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        background: 'var(--surface-2)'
      }}>
        <div style={{ width: `${pct(acc)}%`, background: '#10b981' }} title={`Accepted ${acc}`} />
        <div style={{ width: `${pct(rej)}%`, background: '#f43f5e' }} title={`Rejected ${rej}`} />
        <div style={{ width: `${pct(rew)}%`, background: '#f59e0b' }} title={`Rework ${rew}`} />
        <div style={{ width: `${pct(exc)}%`, background: '#a78bfa' }} title={`Excess ${exc}`} />
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{accPct}% acc</span>
        {rej > 0 && <span>· rej {rej}</span>}
        {rew > 0 && <span>· rew {rew}</span>}
        {exc > 0 && <span>· exc {exc}</span>}
      </div>
    </div>
  )
}

export default ReceiptsPage
