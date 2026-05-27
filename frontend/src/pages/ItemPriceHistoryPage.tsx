import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatINRSymbol, formatQty, parseAmount } from '../utils/format'
import { useToast } from '../contexts/ToastContext'

/* =========================================================================
 *   Types — invoice-side rate history (mirrors /items/:itemCode/invoice-history)
 * ========================================================================= */

interface InvoiceRow {
  invoice_id: number | string
  invoice_number: string | null
  invoice_date: string | null
  po_id: number | string | null
  po_number: string | null
  po_pfx: string | null
  supplier_id: number | string | null
  supplier_name: string | null
  total_amount: number | string | null
  status: string | null
  po_rate?: number | null
  disc_pct?: number | null
  po_qty?: number | null
  effective_rate?: number | null
}

interface BySupplierRow {
  supplier_name: string
  avg_rate: number
  latest_rate: number | null
  latest_date: string | null
  count: number
}

interface InvoiceHistoryResponse {
  item_code: string
  count: number
  rows: InvoiceRow[]
  by_supplier: BySupplierRow[]
}

interface SuggestionItem {
  item_id: string
  description: string | null
  po_count: number
  latest_unit_cost: number | string | null
  latest_po_date: string | null
  match_field?: 'item_id' | 'description'
}

type TimeRange = 'all' | '12m' | '6m' | '3m'

const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  all: 'All time',
  '12m': 'Last 12 months',
  '6m': 'Last 6 months',
  '3m': 'Last 3 months',
}

const SUPPLIER_PALETTE = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#ec4899', '#64748b']

/* =========================================================================
 *   Page
 * ========================================================================= */

export default function ItemPriceHistoryPage() {
  const [itemCode, setItemCode] = useState('')
  const [searched, setSearched] = useState('')
  const [description, setDescription] = useState<string | null>(null)
  const [data, setData] = useState<InvoiceHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const toast = useToast()

  /* ---------- filters ---------- */
  const [supplierFilter, setSupplierFilter] = useState<string>('all')
  const [timeRange, setTimeRange] = useState<TimeRange>('12m')
  const [hiddenSuppliers, setHiddenSuppliers] = useState<Set<string>>(new Set())

  /* ---------- autocomplete ---------- */
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<number | null>(null)
  const fetchTokenRef = useRef(0)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setSuggestionsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const fetchSuggestions = useCallback(async (q: string) => {
    const token = ++fetchTokenRef.current
    if (!q.trim()) {
      setSuggestions([])
      setSuggestionsLoading(false)
      return
    }
    setSuggestionsLoading(true)
    try {
      const res = await apiFetch(`items/search?q=${encodeURIComponent(q)}&limit=20`)
      if (token !== fetchTokenRef.current) return
      if (!res.ok) {
        setSuggestions([])
      } else {
        const body: SuggestionItem[] = await res.json()
        setSuggestions(Array.isArray(body) ? body : [])
        setHighlight(0)
      }
    } catch {
      setSuggestions([])
    } finally {
      if (token === fetchTokenRef.current) setSuggestionsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    if (!itemCode.trim()) {
      setSuggestions([])
      setSuggestionsOpen(false)
      return
    }
    debounceRef.current = window.setTimeout(() => {
      fetchSuggestions(itemCode)
      setSuggestionsOpen(true)
    }, 180)
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [itemCode, fetchSuggestions])

  const search = async (code: string, suggestedDescription?: string | null) => {
    setData(null)
    setSupplierFilter('all')
    setHiddenSuppliers(new Set())
    const trimmed = code.trim()
    if (!trimmed) return
    setSuggestionsOpen(false)
    setSearched(trimmed)
    setDescription(suggestedDescription ?? null)
    setLoading(true)
    try {
      const res = await apiFetch(`items/${encodeURIComponent(trimmed)}/invoice-history?limit=200`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to fetch price history'))
      const body: InvoiceHistoryResponse = await res.json()
      setData(body)
      // Backfill description from the response if we didn't have one from the suggestion
      if (!suggestedDescription) {
        const firstWithDesc = body.rows?.find((r) => (r as InvoiceRow & { description1?: string }).description1)
        if (firstWithDesc) setDescription((firstWithDesc as InvoiceRow & { description1?: string }).description1 || null)
      }
    } catch (err) {
      toast.danger('Search failed', getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const typed = itemCode.trim().toUpperCase()
    const pick = suggestions[highlight]
    if (suggestionsOpen && pick && pick.item_id.toUpperCase() !== typed) {
      setItemCode(pick.item_id)
      setSuggestionsOpen(false)
      search(pick.item_id, pick.description)
      return
    }
    search(itemCode, pick?.description ?? null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestionsOpen || suggestions.length === 0) {
      if (e.key === 'ArrowDown' && suggestions.length > 0) {
        setSuggestionsOpen(true)
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      const pick = suggestions[highlight]
      if (pick) {
        e.preventDefault()
        setItemCode(pick.item_id)
        setSuggestionsOpen(false)
        search(pick.item_id, pick.description)
      }
    } else if (e.key === 'Escape') {
      setSuggestionsOpen(false)
    }
  }

  /* ---------- filter + derive ---------- */
  const allRows = useMemo(() => (data?.rows ?? []).filter((r) => rateOf(r) > 0), [data])

  const rangeCutoff = useMemo(() => {
    if (timeRange === 'all') return null
    const months = timeRange === '12m' ? 12 : timeRange === '6m' ? 6 : 3
    const d = new Date()
    d.setMonth(d.getMonth() - months)
    return d
  }, [timeRange])

  const filteredRows = useMemo(() => {
    return allRows.filter((r) => {
      if (supplierFilter !== 'all' && (r.supplier_name || 'Unknown') !== supplierFilter) return false
      if (rangeCutoff && r.invoice_date) {
        const d = new Date(r.invoice_date)
        if (!Number.isNaN(d.getTime()) && d < rangeCutoff) return false
      }
      return true
    })
  }, [allRows, supplierFilter, rangeCutoff])

  const distinctSuppliers = useMemo(() => {
    const set = new Map<string, number>()
    for (const r of allRows) {
      const k = r.supplier_name || 'Unknown'
      set.set(k, (set.get(k) || 0) + 1)
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  }, [allRows])

  const distinctPos = useMemo(() => new Set(filteredRows.map((r) => r.po_id).filter(Boolean)).size, [filteredRows])

  // KPI values — based on filtered rows (newest first as returned by API)
  const kpis = useMemo(() => computeKpis(filteredRows), [filteredRows])

  // Ordered ascending for the chart
  const asc = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      const da = a.invoice_date ? new Date(a.invoice_date).getTime() : 0
      const db = b.invoice_date ? new Date(b.invoice_date).getTime() : 0
      return da - db
    })
  }, [filteredRows])

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-history" /> Insights</span>
          <h1>Item price history</h1>
          <p>Trace how a part's per-unit rate has moved across suppliers, invoices, and time. Spot creeping costs before they hit the P&amp;L.</p>
        </div>
        <div className="hero__act">
          <button className="btn btn--g" onClick={() => toast.info('Export queued', 'Per-item price-history CSV will land with /api/items/:itemCode/export.')}>
            <i className="pi pi-download" /> Export
          </button>
          <button className="btn btn--g" onClick={() => toast.info('Bookmarked', 'Bookmarks will land with /api/saved-views.')}>
            <i className="pi pi-bookmark" /> Bookmark item
          </button>
        </div>
      </section>

      {/* Search + filters bar */}
      <div ref={wrapperRef} style={{ position: 'relative', marginBottom: 14 }}>
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto auto auto',
            gap: 8,
            alignItems: 'center',
            padding: '10px 12px',
            background: 'var(--s-0)',
            border: '1px solid var(--b-1)',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--sh-xs)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="pi pi-search" style={{ color: 'var(--t-3)' }} />
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              value={itemCode}
              onChange={(e) => setItemCode(e.target.value)}
              onFocus={() => itemCode.trim() && setSuggestionsOpen(true)}
              onKeyDown={onKeyDown}
              placeholder="Start typing… item code (CS001) or part name (HYDRAULIC OIL)"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                fontSize: 14,
                background: 'transparent',
                color: 'var(--t-1)',
                fontFamily: 'var(--font-mono, monospace)',
                letterSpacing: '0.02em',
              }}
            />
            {itemCode && (
              <button
                type="button"
                onClick={() => {
                  setItemCode('')
                  setSuggestions([])
                  setSuggestionsOpen(false)
                  inputRef.current?.focus()
                }}
                title="Clear"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--t-3)', padding: '2px 4px' }}
              >
                <i className="pi pi-times-circle" />
              </button>
            )}
          </div>

          <FilterSelect
            value={supplierFilter}
            onChange={setSupplierFilter}
            disabled={!data}
            options={[{ value: 'all', label: 'All suppliers' }, ...distinctSuppliers.map((s) => ({ value: s, label: s }))]}
          />

          <FilterSelect
            value={timeRange}
            onChange={(v) => setTimeRange(v as TimeRange)}
            disabled={!data}
            options={(['12m', '6m', '3m', 'all'] as TimeRange[]).map((k) => ({ value: k, label: TIME_RANGE_LABEL[k] }))}
          />

          <button type="submit" disabled={loading || !itemCode.trim()} className="btn btn--p btn--sm">
            {loading ? <><i className="pi pi-spin pi-spinner" /> Searching…</> : <><i className="pi pi-search" /> Search</>}
          </button>
        </form>

        {suggestionsOpen && (suggestions.length > 0 || suggestionsLoading) && (
          <div
            role="listbox"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              background: 'var(--s-0)',
              border: '1px solid var(--b-1)',
              borderRadius: 'var(--r-md)',
              boxShadow: 'var(--sh-lg, 0 10px 30px rgba(15,23,42,0.12))',
              maxHeight: 360,
              overflowY: 'auto',
              zIndex: 50,
            }}
          >
            {suggestionsLoading && suggestions.length === 0 && (
              <div style={{ padding: '0.8rem 1rem', color: 'var(--t-3)', fontSize: 13 }}>
                <i className="pi pi-spin pi-spinner" /> Looking up matching items…
              </div>
            )}
            {suggestions.map((s, i) => {
              const matchedOnDesc = s.match_field === 'description'
              return (
                <button
                  key={s.item_id}
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setItemCode(s.item_id)
                    setSuggestionsOpen(false)
                    search(s.item_id, s.description)
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    display: 'grid',
                    gridTemplateColumns: 'minmax(120px, max-content) 1fr auto auto',
                    alignItems: 'center',
                    gap: 12,
                    padding: '8px 12px',
                    border: 'none',
                    background: i === highlight ? 'var(--s-1)' : 'transparent',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--b-1)',
                  }}
                >
                  <code style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 800, color: 'var(--brand-600)', fontSize: 12.5 }}>
                    {matchedOnDesc ? s.item_id : highlightMatch(s.item_id, itemCode)}
                  </code>
                  <span
                    style={{
                      color: matchedOnDesc ? 'var(--t-1)' : 'var(--t-2)',
                      fontWeight: matchedOnDesc ? 600 : 400,
                      fontSize: 12.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={s.description || ''}
                  >
                    {matchedOnDesc ? highlightMatch(s.description || '—', itemCode) : (s.description || '—')}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--t-3)' }}>{s.po_count} PO{s.po_count === 1 ? '' : 's'}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-1)', whiteSpace: 'nowrap' }}>
                    {s.latest_unit_cost != null ? formatINRSymbol(s.latest_unit_cost) : ''}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Count line */}
        {data && (
          <div style={{ marginTop: 8, color: 'var(--t-3)', fontSize: 12.5 }}>
            <strong style={{ color: 'var(--t-2)' }}>{filteredRows.length}</strong> invoice{filteredRows.length === 1 ? '' : 's'} ·{' '}
            <strong style={{ color: 'var(--t-2)' }}>{distinctPos}</strong> PO{distinctPos === 1 ? '' : 's'} found
            {timeRange !== 'all' && <> · {TIME_RANGE_LABEL[timeRange].toLowerCase()}</>}
            {supplierFilter !== 'all' && <> · {supplierFilter}</>}
          </div>
        )}
      </div>

      {/* Loading / empty */}
      {loading && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--t-3)', background: 'var(--s-0)', border: '1px solid var(--b-1)', borderRadius: 'var(--r-lg)' }}>
          <i className="pi pi-spin pi-spinner" style={{ fontSize: 22, color: 'var(--brand-600)' }} />
          <div style={{ marginTop: 8, fontSize: 13 }}>Looking up invoice price history for {searched}…</div>
        </div>
      )}
      {!loading && data && data.count === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--t-3)', background: 'var(--s-1)', borderRadius: 'var(--r-lg)', border: '1px dashed var(--b-2)', fontSize: 13.5 }}>
          <i className="pi pi-inbox" style={{ fontSize: 22, display: 'block', marginBottom: 6 }} />
          No invoices found for item code{' '}
          <code style={{ background: 'var(--s-2)', padding: '1px 6px', borderRadius: 4 }}>{searched}</code>.
        </div>
      )}

      {/* Results */}
      {!loading && data && data.count > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ItemHeaderCard
            itemCode={searched || data.item_code}
            description={description}
            supplierCount={distinctSuppliers.length}
            invoiceCount={allRows.length}
            kpis={kpis}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 14 }}>
            <RateTrendChart
              rowsAsc={asc}
              suppliers={distinctSuppliers}
              hidden={hiddenSuppliers}
              onToggle={(s) => {
                setHiddenSuppliers((prev) => {
                  const next = new Set(prev)
                  if (next.has(s)) next.delete(s)
                  else next.add(s)
                  return next
                })
              }}
              rangeLabel={TIME_RANGE_LABEL[timeRange]}
            />
            <InsightsPanel
              kpis={kpis}
              bySupplier={data.by_supplier || []}
              hiddenSuppliers={hiddenSuppliers}
              onPriceAlert={() => toast.info('Price alert', 'Threshold alerts will land with /api/saved-views/price-alerts.')}
            />
          </div>

          <PurchaseHistoryTable rows={filteredRows} />
        </div>
      )}
    </>
  )
}

/* =========================================================================
 *   Item header card — single row: icon + meta on left, 4 KPIs on right
 * ========================================================================= */

interface KpiBundle {
  latest: { rate: number; date: string | null; supplier: string | null } | null
  avg: number | null
  lowest: { rate: number; date: string | null; supplier: string | null } | null
  highest: { rate: number; date: string | null; supplier: string | null } | null
  deltaPctVsAvg: number | null
}

function ItemHeaderCard({
  itemCode,
  description,
  supplierCount,
  invoiceCount,
  kpis,
}: {
  itemCode: string
  description: string | null
  supplierCount: number
  invoiceCount: number
  kpis: KpiBundle
}) {
  return (
    <div className="card">
      <div className="card__b" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 18, alignItems: 'center' }}>
          {/* Left: icon + code + description + chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 12,
                background: 'linear-gradient(135deg, #3b82f6, #06b6d4)',
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 20,
                flexShrink: 0,
              }}
            >
              <i className="pi pi-box" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <code style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 800, color: 'var(--t-1)', fontSize: 18, letterSpacing: '-0.01em' }}>
                  {itemCode}
                </code>
                {description && (
                  <span style={{ color: 'var(--t-2)', fontWeight: 500, fontSize: 14 }}>{description}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                <span className="chip chip--mute"><i className="pi pi-building" /> {supplierCount} supplier{supplierCount === 1 ? '' : 's'}</span>
                <span className="chip chip--info"><i className="pi pi-file" /> {invoiceCount} invoice{invoiceCount === 1 ? '' : 's'}</span>
                <span className="chip chip--ok"><i className="pi pi-check-circle" /> Active</span>
              </div>
            </div>
          </div>

          {/* Right: 4 KPIs inline */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(140px, 1fr))', gap: 18 }}>
            <KpiTile
              label="Latest rate"
              value={kpis.latest ? formatINRSymbol(kpis.latest.rate) : '—'}
              sub={kpis.latest ? `${formatDate(kpis.latest.date)} · ${kpis.latest.supplier || '—'}` : ''}
              tone={kpis.deltaPctVsAvg != null ? (kpis.deltaPctVsAvg > 0 ? 'up' : kpis.deltaPctVsAvg < 0 ? 'down' : 'flat') : 'flat'}
            />
            <KpiTile
              label="12-mo avg"
              value={kpis.avg != null ? formatINRSymbol(kpis.avg) : '—'}
              sub="across all suppliers"
              tone="flat"
            />
            <KpiTile
              label="Lowest"
              value={kpis.lowest ? formatINRSymbol(kpis.lowest.rate) : '—'}
              sub={kpis.lowest ? `${formatDate(kpis.lowest.date)} · ${kpis.lowest.supplier || '—'}` : ''}
              tone="down"
            />
            <KpiTile
              label="Highest"
              value={kpis.highest ? formatINRSymbol(kpis.highest.rate) : '—'}
              sub={kpis.highest ? `${formatDate(kpis.highest.date)} · ${kpis.highest.supplier || '—'}` : ''}
              tone="up"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function KpiTile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'up' | 'down' | 'flat' }) {
  const tint =
    tone === 'up' ? 'var(--err-fg)' :
    tone === 'down' ? 'var(--ok-fg)' :
    'var(--t-1)'
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t-3)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tint, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', lineHeight: 1.05 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--t-4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={sub}>{sub}</div>
    </div>
  )
}

/* =========================================================================
 *   Rate trend chart — multi-supplier line over the filtered window
 * ========================================================================= */

function RateTrendChart({
  rowsAsc,
  suppliers,
  hidden,
  onToggle,
  rangeLabel,
}: {
  rowsAsc: InvoiceRow[]
  suppliers: string[]
  hidden: Set<string>
  onToggle: (s: string) => void
  rangeLabel: string
}) {
  const series = useMemo(() => buildSupplierSeries(rowsAsc, suppliers), [rowsAsc, suppliers])
  const visibleSuppliers = suppliers.filter((s) => !hidden.has(s))
  const visibleSeries = series.filter((s) => visibleSuppliers.includes(s.supplier))

  const allRates = visibleSeries.flatMap((s) => s.points.map((p) => p.rate))
  const allDates = visibleSeries.flatMap((s) => s.points.map((p) => p.t))
  const hasData = allRates.length > 0

  const W = 800
  const H = 240
  const padL = 56
  const padR = 24
  const padT = 24
  const padB = 38

  const minR = hasData ? Math.min(...allRates) : 0
  const maxR = hasData ? Math.max(...allRates) : 1
  const rRange = Math.max(maxR - minR, 0.001)
  const yPad = rRange * 0.1
  const yMin = minR - yPad
  const yMax = maxR + yPad

  const minT = hasData ? Math.min(...allDates) : 0
  const maxT = hasData ? Math.max(...allDates) : 1
  const tRange = Math.max(maxT - minT, 1)

  const x = (t: number) => padL + ((t - minT) / tRange) * (W - padL - padR)
  const y = (r: number) => padT + (1 - (r - yMin) / (yMax - yMin)) * (H - padT - padB)

  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className="pi pi-chart-line" /> Rate trend</div>
        <span className="card__m">{rangeLabel}</span>
      </div>
      <div className="card__b" style={{ padding: 14 }}>
        {/* Supplier filter chips */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {suppliers.map((s, i) => {
            const color = SUPPLIER_PALETTE[i % SUPPLIER_PALETTE.length]
            const off = hidden.has(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() => onToggle(s)}
                title={off ? 'Show ' + s : 'Hide ' + s}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 'var(--r-full)',
                  border: '1px solid var(--b-1)',
                  background: off ? 'var(--s-1)' : 'var(--s-0)',
                  color: off ? 'var(--t-4)' : 'var(--t-2)',
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: off ? 0.55 : 1,
                }}
              >
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, display: 'inline-block' }} />
                {s}
              </button>
            )
          })}
        </div>

        {!hasData ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--t-3)', fontSize: 13 }}>
            <i className="pi pi-chart-line" style={{ fontSize: 22, display: 'block', marginBottom: 6 }} />
            No data points in this window — try widening the time range or clearing the supplier filter.
          </div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet">
            {/* Y reference lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
              const yy = padT + p * (H - padT - padB)
              const rv = yMax - p * (yMax - yMin)
              return (
                <g key={i}>
                  <line x1={padL} x2={W - padR} y1={yy} y2={yy} stroke="var(--b-1)" strokeDasharray="3 4" />
                  <text x={padL - 8} y={yy + 4} fill="var(--t-4)" fontSize={10} textAnchor="end">{formatINRSymbol(rv)}</text>
                </g>
              )
            })}

            {/* X labels — start / mid / end dates */}
            {[0, 0.5, 1].map((p, i) => {
              const xx = padL + p * (W - padL - padR)
              const t = minT + p * tRange
              return (
                <text key={i} x={xx} y={H - 14} fill="var(--t-4)" fontSize={10} textAnchor="middle">
                  {formatDate(new Date(t).toISOString())}
                </text>
              )
            })}

            {visibleSeries.map((s) => {
              const color = SUPPLIER_PALETTE[suppliers.indexOf(s.supplier) % SUPPLIER_PALETTE.length]
              const pts = s.points
              if (pts.length === 0) return null
              const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)},${y(p.rate).toFixed(2)}`).join(' ')
              return (
                <g key={s.supplier}>
                  <path d={path} fill="none" stroke={color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
                  {pts.map((p, i) => (
                    <circle key={i} cx={x(p.t)} cy={y(p.rate)} r={3.2} fill="#fff" stroke={color} strokeWidth={2} />
                  ))}
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}

/* =========================================================================
 *   Insights panel — heuristic suggestions
 * ========================================================================= */

function InsightsPanel({
  kpis,
  bySupplier,
  hiddenSuppliers,
  onPriceAlert,
}: {
  kpis: KpiBundle
  bySupplier: BySupplierRow[]
  hiddenSuppliers: Set<string>
  onPriceAlert: () => void
}) {
  const visibleSuppliers = bySupplier.filter((s) => !hiddenSuppliers.has(s.supplier_name))
  const cheapest = visibleSuppliers.length > 0
    ? visibleSuppliers.reduce((a, b) => (a.avg_rate < b.avg_rate ? a : b))
    : null
  const latestSupplier = kpis.latest?.supplier
  const latestSupplierAvg = bySupplier.find((s) => s.supplier_name === latestSupplier)?.avg_rate ?? null

  const insights: { icon: string; title: string; body: string; tone: 'up' | 'down' | 'flat' }[] = []

  if (kpis.deltaPctVsAvg != null && kpis.deltaPctVsAvg > 3) {
    insights.push({
      icon: 'pi-arrow-up',
      title: `Rate creeping up (+${kpis.deltaPctVsAvg.toFixed(1)}%)`,
      body: `Latest rate is ${kpis.deltaPctVsAvg.toFixed(1)}% above the period average. Consider re-negotiating or sourcing from another supplier.`,
      tone: 'up',
    })
  } else if (kpis.deltaPctVsAvg != null && kpis.deltaPctVsAvg < -3) {
    insights.push({
      icon: 'pi-arrow-down',
      title: `Rate trending down (${kpis.deltaPctVsAvg.toFixed(1)}%)`,
      body: `Latest rate is ${Math.abs(kpis.deltaPctVsAvg).toFixed(1)}% below the period average — a good window to lock in a longer-term price.`,
      tone: 'down',
    })
  }

  if (cheapest && latestSupplier && cheapest.supplier_name !== latestSupplier && latestSupplierAvg != null && cheapest.avg_rate < latestSupplierAvg) {
    const saving = latestSupplierAvg - cheapest.avg_rate
    const pct = (saving / latestSupplierAvg) * 100
    insights.push({
      icon: 'pi-tag',
      title: `${cheapest.supplier_name} is cheaper`,
      body: `Averages ${formatINRSymbol(cheapest.avg_rate)} vs ${latestSupplier}'s ${formatINRSymbol(latestSupplierAvg)} — a ${pct.toFixed(1)}% saving per unit.`,
      tone: 'down',
    })
  }

  if (insights.length === 0) {
    insights.push({
      icon: 'pi-check',
      title: 'Prices look stable',
      body: 'No notable rate drift or supplier arbitrage in this window.',
      tone: 'flat',
    })
  }

  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className="pi pi-sparkles" /> Insights</div>
      </div>
      <div className="card__b" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {insights.map((it, i) => (
          <div key={i} className="insight">
            <div className="insight__ic" style={{ background: it.tone === 'up' ? 'linear-gradient(135deg, #f43f5e, #ec4899)' : it.tone === 'down' ? 'linear-gradient(135deg, #10b981, #14b8a6)' : 'linear-gradient(135deg, #a78bfa, #7c3aed)' }}>
              <i className={`pi ${it.icon}`} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="insight__t">{it.title}</div>
              <div className="insight__d">{it.body}</div>
            </div>
          </div>
        ))}

        <button onClick={onPriceAlert} className="btn btn--p btn--sm" style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <i className="pi pi-bell" /> Set price alert
        </button>
      </div>
    </div>
  )
}

/* =========================================================================
 *   Purchase history table — chronological invoice list with Δ vs Prior
 * ========================================================================= */

function PurchaseHistoryTable({ rows }: { rows: InvoiceRow[] }) {
  // Sort ascending to compute delta-vs-prior, then render descending
  const asc = useMemo(() => {
    return [...rows].sort((a, b) => {
      const da = a.invoice_date ? new Date(a.invoice_date).getTime() : 0
      const db = b.invoice_date ? new Date(b.invoice_date).getTime() : 0
      return da - db
    })
  }, [rows])

  const withDelta = useMemo(() => {
    return asc.map((r, i) => {
      const rate = rateOf(r)
      if (i === 0) return { ...r, delta: null as null | { amount: number; pct: number | null; kind: 'baseline' | 'change' | 'flat' | 'cross'; note?: string } }
      const priorRate = rateOf(asc[i - 1])
      const diff = rate - priorRate
      const priorSup = asc[i - 1].supplier_name || 'Unknown'
      const thisSup = r.supplier_name || 'Unknown'
      const crossSupplier = priorSup !== thisSup
      if (Math.abs(diff) < 0.005) {
        return { ...r, delta: { amount: 0, pct: 0, kind: 'flat' as const } }
      }
      return {
        ...r,
        delta: {
          amount: diff,
          pct: priorRate > 0 ? (diff / priorRate) * 100 : null,
          kind: crossSupplier ? 'cross' as const : 'change' as const,
          note: crossSupplier ? `vs ${priorSup}` : undefined,
        },
      }
    })
  }, [asc])

  // Render newest first
  const display = useMemo(() => [...withDelta].reverse(), [withDelta])

  return (
    <div className="card">
      <div className="card__h">
        <div className="card__t"><i className="pi pi-history" /> Purchase history</div>
        <span className="card__m">{rows.length} invoice{rows.length === 1 ? '' : 's'}</span>
      </div>
      <div className="card__b" style={{ padding: 0 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--s-1)' }}>
                {['Date', 'Invoice', 'PO Ref', 'Supplier', 'Qty', 'Rate', 'Total', 'Δ vs Prior'].map((h, i) => (
                  <th
                    key={h}
                    style={{
                      padding: '10px 14px',
                      textAlign: i >= 4 ? 'right' : 'left',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--t-3)',
                      fontWeight: 700,
                      borderBottom: '1px solid var(--b-1)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => {
                const isBaseline = i === display.length - 1
                return (
                  <tr key={`${r.invoice_id}-${i}`} style={{ borderBottom: '1px solid var(--b-1)' }}>
                    <td style={{ padding: '10px 14px', color: 'var(--t-2)', whiteSpace: 'nowrap' }}>{formatDate(r.invoice_date)}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono, monospace)', fontWeight: 700, color: 'var(--t-1)' }}>{r.invoice_number || '—'}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'var(--font-mono, monospace)', color: 'var(--t-2)' }}>
                      {r.po_pfx && r.po_number ? `${r.po_pfx}-${r.po_number}` : r.po_number || '—'}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--t-2)' }}>{r.supplier_name || '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--t-2)', fontVariantNumeric: 'tabular-nums' }}>{formatQty(r.po_qty)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: 'var(--t-1)', fontVariantNumeric: 'tabular-nums' }}>{formatINRSymbol(rateOf(r))}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: 'var(--t-2)', fontVariantNumeric: 'tabular-nums' }}>{formatINRSymbol(r.total_amount)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      {isBaseline ? (
                        <span className="chip chip--info">baseline</span>
                      ) : r.delta == null ? (
                        <span className="chip chip--mute">—</span>
                      ) : r.delta.kind === 'flat' ? (
                        <span className="chip chip--mute">unchanged</span>
                      ) : r.delta.kind === 'cross' ? (
                        <span className={r.delta.amount > 0 ? 'chip chip--err' : 'chip chip--ok'}>
                          {r.delta.amount > 0 ? '+' : '−'}{formatINRSymbol(Math.abs(r.delta.amount))} {r.delta.note ? `(${r.delta.note})` : ''}
                        </span>
                      ) : (
                        <span className={r.delta.amount > 0 ? 'chip chip--err' : 'chip chip--ok'}>
                          {r.delta.amount > 0 ? '+' : '−'}{formatINRSymbol(Math.abs(r.delta.amount))}
                          {r.delta.pct != null ? ` (${r.delta.amount > 0 ? '+' : ''}${r.delta.pct.toFixed(1)}%)` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
 *   Filter dropdown — minimal styled <select> matching mockup chips
 * ========================================================================= */

function FilterSelect({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        padding: '6px 10px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--b-1)',
        background: 'var(--s-0)',
        color: 'var(--t-2)',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        minWidth: 140,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

/* =========================================================================
 *   Helpers
 * ========================================================================= */

function rateOf(r: InvoiceRow): number {
  const er = parseAmount(r.effective_rate)
  if (er != null && er > 0) return er
  const pr = parseAmount(r.po_rate)
  return pr ?? 0
}

function computeKpis(rows: InvoiceRow[]): KpiBundle {
  if (rows.length === 0) {
    return { latest: null, avg: null, lowest: null, highest: null, deltaPctVsAvg: null }
  }
  // rows arrive newest-first from the API (ORDER BY invoice_date DESC); after
  // filter we preserve that order. Sort defensively.
  const sorted = [...rows].sort((a, b) => {
    const da = a.invoice_date ? new Date(a.invoice_date).getTime() : 0
    const db = b.invoice_date ? new Date(b.invoice_date).getTime() : 0
    return db - da
  })
  const top = sorted[0]
  const latest = { rate: rateOf(top), date: top.invoice_date, supplier: top.supplier_name }

  let lo: { rate: number; date: string | null; supplier: string | null } | null = null
  let hi: { rate: number; date: string | null; supplier: string | null } | null = null
  let sum = 0
  let n = 0
  for (const r of sorted) {
    const rate = rateOf(r)
    if (rate <= 0) continue
    sum += rate
    n++
    if (lo == null || rate < lo.rate) lo = { rate, date: r.invoice_date, supplier: r.supplier_name }
    if (hi == null || rate > hi.rate) hi = { rate, date: r.invoice_date, supplier: r.supplier_name }
  }
  const avg = n > 0 ? sum / n : null
  const deltaPctVsAvg = avg != null && avg > 0 ? ((latest.rate - avg) / avg) * 100 : null

  return { latest, avg, lowest: lo, highest: hi, deltaPctVsAvg }
}

function buildSupplierSeries(rowsAsc: InvoiceRow[], suppliers: string[]): { supplier: string; points: { t: number; rate: number }[] }[] {
  return suppliers.map((sup) => {
    const points = rowsAsc
      .filter((r) => (r.supplier_name || 'Unknown') === sup && r.invoice_date)
      .map((r) => ({ t: new Date(r.invoice_date as string).getTime(), rate: rateOf(r) }))
      .filter((p) => p.rate > 0 && Number.isFinite(p.t))
    return { supplier: sup, points }
  })
}

function highlightMatch(value: string, query: string) {
  const q = query.trim()
  if (!q) return value
  const idx = value.toUpperCase().indexOf(q.toUpperCase())
  if (idx < 0) return value
  return (
    <>
      {value.slice(0, idx)}
      <mark style={{ background: 'color-mix(in srgb, var(--brand-600) 22%, transparent)', color: 'inherit', padding: 0, fontWeight: 800 }}>
        {value.slice(idx, idx + q.length)}
      </mark>
      {value.slice(idx + q.length)}
    </>
  )
}
