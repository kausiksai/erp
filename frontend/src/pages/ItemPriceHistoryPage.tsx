import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatINRSymbol, formatQty, parseAmount } from '../utils/format'

/* =========================================================================
 *   Types
 * ========================================================================= */

interface POHistoryRow {
  po_id: number | string
  po_number: string | null
  pfx: string | null
  po_date: string | null
  amd_no: number | string | null
  po_status: string | null
  supplier_id: number | string | null
  supplier_name: string | null
  gst_number: string | null
  qty: number | string | null
  unit_cost: number | string | null
  disc_pct: number | string | null
  description1: string | null
  item_id: string | null
  line_value: number | string | null
}

interface POHistorySummary {
  latest: number | null
  previous: number | null
  min: number | null
  max: number | null
  delta_vs_previous: number | null
  delta_pct_vs_previous: number | null
}

interface POHistoryResponse {
  item_code: string
  count: number
  summary: POHistorySummary | null
  rows: POHistoryRow[]
}

interface SuggestionItem {
  item_id: string
  description: string | null
  po_count: number
  latest_unit_cost: number | string | null
  latest_po_date: string | null
}

const SLOT_LABELS = ['Latest', 'Previous', 'Earliest']

/* =========================================================================
 *   Local style overrides — injected once to kill any browser/global focus
 *   ring on the search form. Cannot be done with React inline styles since
 *   they don't accept :focus pseudo-classes.
 * ========================================================================= */
const PAGE_STYLES = `
  .iph-form {
    transition: border-color .12s ease, box-shadow .12s ease;
  }
  .iph-form:focus-within {
    border-color: var(--border-subtle) !important;
    box-shadow: var(--shadow-sm) !important;
  }
  .iph-input,
  .iph-input:focus,
  .iph-input:focus-visible {
    outline: none !important;
    box-shadow: none !important;
    -webkit-box-shadow: none !important;
    -webkit-tap-highlight-color: transparent;
  }
  .iph-row:hover { background: var(--surface-1); }
  .iph-fade-in {
    animation: iph-fade-in .25s ease-out both;
  }
  @keyframes iph-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`

/* =========================================================================
 *   Page
 * ========================================================================= */

export default function ItemPriceHistoryPage() {
  const [itemCode, setItemCode] = useState('')
  const [searched, setSearched] = useState('')
  const [data, setData] = useState<POHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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

  const search = async (code: string) => {
    setError('')
    setData(null)
    const trimmed = code.trim()
    if (!trimmed) return
    setSuggestionsOpen(false)
    setSearched(trimmed)
    setLoading(true)
    try {
      const res = await apiFetch(`items/${encodeURIComponent(trimmed)}/po-history?limit=3`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to fetch PO history'))
      const body: POHistoryResponse = await res.json()
      setData(body)
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    search(itemCode)
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
        search(pick.item_id)
      }
    } else if (e.key === 'Escape') {
      setSuggestionsOpen(false)
    }
  }

  /* ---------- derived ---------- */
  const rows = data?.rows ?? []
  const sortedAsc = useMemo(() => [...rows].reverse(), [rows])
  const prices = rows.map((r) => parseAmount(r.unit_cost) ?? 0)
  const minP = prices.length ? Math.min(...prices) : 0
  const maxP = prices.length ? Math.max(...prices) : 0
  const stable = prices.length > 0 && Math.abs(maxP - minP) < 0.005
  const minIdxOriginal = prices.indexOf(minP)
  const maxIdxOriginal = prices.indexOf(maxP)
  const trendDirection: 'up' | 'down' | 'flat' =
    !data?.summary?.delta_vs_previous
      ? 'flat'
      : (data.summary.delta_vs_previous ?? 0) > 0
      ? 'up'
      : (data.summary.delta_vs_previous ?? 0) < 0
      ? 'down'
      : 'flat'

  return (
    <div style={{ padding: '1.5rem 2rem 3rem', maxWidth: 1180, margin: '0 auto' }}>
      <style>{PAGE_STYLES}</style>

      <header style={{ marginBottom: '1.4rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.65rem', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Item price history
        </h1>
        <p style={{ margin: '0.3rem 0 0', color: 'var(--text-muted)', fontSize: '0.95rem' }}>
          Type any item code to compare unit cost across the last 3 distinct POs. Spot price drift before approving a new PO.
        </p>
      </header>

      {/* Search bar */}
      <div ref={wrapperRef} style={{ position: 'relative', marginBottom: '1.2rem' }}>
        <form
          onSubmit={handleSubmit}
          className="iph-form"
          style={{
            display: 'flex',
            gap: '0.55rem',
            alignItems: 'center',
            padding: '0.7rem 0.85rem',
            background: 'var(--surface-0)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <i className="pi pi-search" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            className="iph-input"
            value={itemCode}
            onChange={(e) => setItemCode(e.target.value)}
            onFocus={() => itemCode.trim() && setSuggestionsOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="Start typing… e.g. CS001 or CT036"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: '0.95rem',
              background: 'transparent',
              color: 'var(--text-primary)',
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
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.2rem 0.4rem', fontSize: '0.9rem' }}
            >
              <i className="pi pi-times-circle" />
            </button>
          )}
          <button
            type="submit"
            disabled={loading || !itemCode.trim()}
            style={{
              border: 'none',
              cursor: loading || !itemCode.trim() ? 'not-allowed' : 'pointer',
              padding: '0.55rem 1.1rem',
              borderRadius: 'var(--radius-md)',
              background: loading || !itemCode.trim() ? 'var(--surface-2)' : 'var(--brand-600)',
              color: loading || !itemCode.trim() ? 'var(--text-muted)' : '#fff',
              fontSize: '0.88rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            {loading ? <><i className="pi pi-spin pi-spinner" /> Searching…</> : <>Search</>}
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
              background: 'var(--surface-0)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-lg, 0 10px 30px rgba(15,23,42,0.12))',
              maxHeight: 360,
              overflowY: 'auto',
              zIndex: 50,
            }}
          >
            {suggestionsLoading && suggestions.length === 0 && (
              <div style={{ padding: '0.8rem 1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                <i className="pi pi-spin pi-spinner" /> Looking up matching items…
              </div>
            )}
            {suggestions.map((s, i) => (
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
                  search(s.item_id)
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(120px, max-content) 1fr auto auto',
                  alignItems: 'center',
                  gap: '0.85rem',
                  padding: '0.55rem 0.85rem',
                  border: 'none',
                  background: i === highlight ? 'var(--surface-1)' : 'transparent',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <code style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 800, color: 'var(--brand-600)', fontSize: '0.84rem' }}>
                  {highlightMatch(s.item_id, itemCode)}
                </code>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description || ''}>
                  {s.description || '—'}
                </span>
                <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                  {s.po_count} PO{s.po_count === 1 ? '' : 's'}
                </span>
                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                  {s.latest_unit_cost != null ? formatINRSymbol(s.latest_unit_cost) : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error / loading / empty */}
      {error && (
        <div style={{ padding: '0.75rem 0.9rem', background: 'var(--status-danger-bg)', color: 'var(--status-danger-fg)', border: '1px solid var(--status-danger-ring)', borderRadius: 'var(--radius-md)', fontSize: '0.86rem', marginBottom: '1rem' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}
      {loading && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--surface-0)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
          <i className="pi pi-spin pi-spinner" style={{ fontSize: '1.4rem', color: 'var(--brand-600)' }} />
          <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>Looking up PO history for {searched}…</div>
        </div>
      )}
      {!loading && !error && data && data.count === 0 && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--surface-1)', borderRadius: 'var(--radius-lg)', border: '1px dashed var(--border-default)', fontSize: '0.92rem' }}>
          <i className="pi pi-inbox" style={{ fontSize: '1.4rem', display: 'block', marginBottom: '0.4rem' }} />
          No purchase orders found containing item code{' '}
          <code style={{ background: 'var(--surface-2)', padding: '0.05rem 0.35rem', borderRadius: 4 }}>{searched}</code>.
        </div>
      )}

      {/* Results */}
      {!loading && !error && data && data.count > 0 && (
        <div className="iph-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Hero
            data={data}
            stable={stable}
            minP={minP}
            maxP={maxP}
            trendDirection={trendDirection}
          />

          {!stable && rows.length > 1 && (
            <Sparkline rows={sortedAsc} minP={minP} maxP={maxP} />
          )}

          <ComparisonTable
            rows={rows}
            latestPrice={data.summary?.latest ?? 0}
            minIdxOriginal={minIdxOriginal}
            maxIdxOriginal={maxIdxOriginal}
            stable={stable}
          />
        </div>
      )}
    </div>
  )
}

/* =========================================================================
 *   Hero — big colourful summary at the top
 * ========================================================================= */

function Hero({
  data,
  stable,
  minP,
  maxP,
  trendDirection,
}: {
  data: POHistoryResponse
  stable: boolean
  minP: number
  maxP: number
  trendDirection: 'up' | 'down' | 'flat'
}) {
  const top = data.rows[0]
  const heroBg =
    trendDirection === 'up'
      ? 'linear-gradient(135deg, rgba(244,63,94,0.10), rgba(245,158,11,0.06))'
      : trendDirection === 'down'
      ? 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(14,165,233,0.06))'
      : 'linear-gradient(135deg, rgba(99,102,241,0.10), rgba(14,165,233,0.06))'

  const trendBadge = (() => {
    if (stable) return { label: 'Stable', icon: 'pi-check', tone: 'var(--status-success-fg)' }
    if (trendDirection === 'up') return { label: 'Increasing', icon: 'pi-arrow-up', tone: 'var(--status-danger-fg)' }
    if (trendDirection === 'down') return { label: 'Decreasing', icon: 'pi-arrow-down', tone: 'var(--status-success-fg)' }
    return { label: 'Mixed', icon: 'pi-minus', tone: 'var(--text-muted)' }
  })()

  return (
    <div
      style={{
        padding: '1.2rem 1.4rem',
        background: heroBg,
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-sm)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: '1.5rem',
        alignItems: 'center',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.62rem',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'var(--text-muted)',
            fontWeight: 800,
          }}
        >
          Item code
        </div>
        <div
          style={{
            fontSize: '1.55rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono, monospace)',
            letterSpacing: '-0.01em',
            marginTop: '0.1rem',
          }}
        >
          {top?.item_id || data.item_code}
        </div>
        {top?.description1 && (
          <div style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
            {top.description1}
          </div>
        )}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            marginTop: '0.7rem',
            padding: '0.25rem 0.7rem',
            borderRadius: 9999,
            background: 'var(--surface-0)',
            color: trendBadge.tone,
            fontSize: '0.75rem',
            fontWeight: 800,
            border: `1px solid color-mix(in srgb, ${trendBadge.tone} 30%, transparent)`,
          }}
        >
          <i className={`pi ${trendBadge.icon}`} />
          {trendBadge.label}
        </div>
      </div>

      <div style={{ textAlign: 'right' }}>
        <div
          style={{
            fontSize: '0.62rem',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'var(--text-muted)',
            fontWeight: 800,
          }}
        >
          Latest unit cost
        </div>
        <div
          style={{
            fontSize: '2.4rem',
            fontWeight: 900,
            color: 'var(--brand-600)',
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            marginTop: '0.1rem',
          }}
        >
          {formatINRSymbol(data.summary?.latest ?? 0)}
        </div>

        {/* Mini stats row */}
        <div
          style={{
            display: 'flex',
            gap: '1.1rem',
            justifyContent: 'flex-end',
            marginTop: '0.55rem',
            color: 'var(--text-secondary)',
            fontSize: '0.78rem',
          }}
        >
          {!stable && data.summary?.delta_vs_previous != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                vs prev
              </span>
              <strong style={{ color: trendTone(data.summary.delta_vs_previous), fontSize: '0.85rem' }}>
                {data.summary.delta_vs_previous >= 0 ? '+' : ''}
                {formatINRSymbol(data.summary.delta_vs_previous)}
              </strong>
              <small style={{ color: trendTone(data.summary.delta_pct_vs_previous ?? null) }}>
                ({data.summary.delta_pct_vs_previous! >= 0 ? '+' : ''}
                {data.summary.delta_pct_vs_previous?.toFixed(2)}%)
              </small>
            </span>
          )}
          {!stable && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                range
              </span>
              <strong style={{ fontSize: '0.85rem' }}>
                {formatINRSymbol(minP)} – {formatINRSymbol(maxP)}
              </strong>
            </span>
          )}
          {stable && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--status-success-fg)' }}>
              <i className="pi pi-check-circle" />
              <strong style={{ fontSize: '0.85rem' }}>No price change across all {data.count} POs</strong>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
 *   Comparison table
 * ========================================================================= */

function ComparisonTable({
  rows,
  latestPrice,
  minIdxOriginal,
  maxIdxOriginal,
  stable,
}: {
  rows: POHistoryRow[]
  latestPrice: number
  minIdxOriginal: number
  maxIdxOriginal: number
  stable: boolean
}) {
  const ordered = [...rows].reverse()
  const slotIndex = (i: number) => rows.length - 1 - i
  const cols = ordered.length

  return (
    <div
      style={{
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '0.85rem 1.15rem',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          color: 'var(--text-secondary)',
          fontSize: '0.86rem',
          fontWeight: 700,
        }}
      >
        <i className="pi pi-table" /> Side-by-side comparison
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
          <thead>
            <tr style={{ background: 'var(--surface-1)' }}>
              <th
                style={{
                  width: 168,
                  padding: '0.85rem 1rem',
                  textAlign: 'left',
                  fontSize: '0.66rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                  fontWeight: 700,
                }}
              />
              {ordered.map((r, i) => {
                const orig = slotIndex(i)
                const isLatest = orig === 0
                const slotLabel = SLOT_LABELS[orig] || `#${orig + 1}`
                return (
                  <th
                    key={`${r.po_id}-h`}
                    style={{
                      padding: '0.85rem 1rem',
                      textAlign: 'left',
                      verticalAlign: 'top',
                      borderLeft: '1px solid var(--border-subtle)',
                      background: isLatest ? 'color-mix(in srgb, var(--brand-600) 9%, var(--surface-1))' : undefined,
                      borderTop: isLatest ? '3px solid var(--brand-600)' : undefined,
                    }}
                  >
                    <div
                      style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.6rem',
                        borderRadius: 9999,
                        fontSize: '0.62rem',
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        background: isLatest ? 'var(--brand-600)' : 'var(--surface-2)',
                        color: isLatest ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      {slotLabel}
                    </div>
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-secondary)',
                        marginTop: '0.4rem',
                        fontWeight: 700,
                      }}
                    >
                      {formatDate(r.po_date)}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            <Row
              label={<><i className="pi pi-money-bill" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Unit cost</>}
              cols={cols}
              renderer={(i) => {
                const r = ordered[i]
                const orig = slotIndex(i)
                const isLatest = orig === 0
                const isMin = !stable && orig === minIdxOriginal
                const isMax = !stable && orig === maxIdxOriginal
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                      style={{
                        fontSize: '1.4rem',
                        fontWeight: 800,
                        color: isLatest ? 'var(--brand-600)' : 'var(--text-primary)',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {formatINRSymbol(r.unit_cost)}
                    </span>
                    {isMin && !isLatest && (
                      <span
                        style={{
                          fontSize: '0.62rem',
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          padding: '0.12rem 0.4rem',
                          borderRadius: 9999,
                          background: 'color-mix(in srgb, var(--status-success-fg) 14%, transparent)',
                          color: 'var(--status-success-fg)',
                        }}
                        title="Lowest in this comparison"
                      >
                        ↓ Min
                      </span>
                    )}
                    {isMax && !isLatest && (
                      <span
                        style={{
                          fontSize: '0.62rem',
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          padding: '0.12rem 0.4rem',
                          borderRadius: 9999,
                          background: 'color-mix(in srgb, var(--status-danger-fg) 14%, transparent)',
                          color: 'var(--status-danger-fg)',
                        }}
                        title="Highest in this comparison"
                      >
                        ↑ Max
                      </span>
                    )}
                  </div>
                )
              }}
              latestIdx={cols - 1}
            />
            <Row
              label={<><i className="pi pi-chart-line" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Δ vs latest</>}
              cols={cols}
              renderer={(i) => {
                const r = ordered[i]
                const orig = slotIndex(i)
                if (orig === 0) {
                  return (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.18rem 0.55rem',
                        borderRadius: 9999,
                        background: 'var(--brand-600)',
                        color: '#fff',
                        fontSize: '0.7rem',
                        fontWeight: 800,
                        letterSpacing: '0.04em',
                      }}
                    >
                      <i className="pi pi-star-fill" style={{ fontSize: '0.7rem' }} /> CURRENT
                    </span>
                  )
                }
                const unit = parseAmount(r.unit_cost) ?? 0
                const delta = unit - latestPrice
                if (Math.abs(delta) < 0.005) {
                  return <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>— no change</span>
                }
                const tone = trendTone(delta)
                return (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.18rem 0.55rem',
                      borderRadius: 9999,
                      background: `color-mix(in srgb, ${tone} 12%, transparent)`,
                      color: tone,
                      fontSize: '0.78rem',
                      fontWeight: 700,
                    }}
                  >
                    <i className={`pi ${trendIcon(delta)}`} style={{ fontSize: '0.74rem' }} />
                    {delta >= 0 ? '+' : ''}{formatINRSymbol(delta)}
                  </span>
                )
              }}
              latestIdx={cols - 1}
            />
            <SectionDivider cols={cols} />
            <Row
              label={<><i className="pi pi-shopping-cart" style={{ marginRight: 6, color: 'var(--text-muted)' }} />PO #</>}
              cols={cols}
              renderer={(i) => <Mono>{ordered[i].po_number || '—'}</Mono>}
              latestIdx={cols - 1}
            />
            <Row
              label={<><i className="pi pi-building" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Supplier</>}
              cols={cols}
              renderer={(i) => (
                <span
                  style={{
                    color: 'var(--text-primary)',
                    fontWeight: 600,
                    fontSize: '0.85rem',
                  }}
                >
                  {ordered[i].supplier_name || '—'}
                </span>
              )}
              latestIdx={cols - 1}
            />
            <Row
              label={<><i className="pi pi-th-large" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Quantity</>}
              cols={cols}
              renderer={(i) => formatQty(ordered[i].qty)}
              latestIdx={cols - 1}
            />
            <Row
              label={<><i className="pi pi-percentage" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Discount</>}
              cols={cols}
              renderer={(i) => (ordered[i].disc_pct != null ? `${ordered[i].disc_pct}%` : '—')}
              latestIdx={cols - 1}
            />
            <Row
              label={<><i className="pi pi-wallet" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Line value</>}
              cols={cols}
              renderer={(i) => (
                <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatINRSymbol(ordered[i].line_value)}</span>
              )}
              latestIdx={cols - 1}
            />
            <Row
              label={<><i className="pi pi-bookmark" style={{ marginRight: 6, color: 'var(--text-muted)' }} />Status</>}
              cols={cols}
              renderer={(i) => (
                <span
                  style={{
                    display: 'inline-block',
                    padding: '0.15rem 0.6rem',
                    borderRadius: 9999,
                    fontSize: '0.74rem',
                    fontWeight: 700,
                    background: 'var(--surface-2)',
                    color: 'var(--text-secondary)',
                    textTransform: 'capitalize',
                  }}
                >
                  {ordered[i].po_status || '—'}
                </span>
              )}
              latestIdx={cols - 1}
            />
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Row({
  label,
  cols,
  renderer,
  latestIdx,
}: {
  label: React.ReactNode
  cols: number
  renderer: (i: number) => React.ReactNode
  latestIdx: number
}) {
  return (
    <tr className="iph-row" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <td
        style={{
          padding: '0.75rem 1rem',
          fontSize: '0.74rem',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-muted)',
          fontWeight: 700,
          background: 'var(--surface-1)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </td>
      {Array.from({ length: cols }).map((_, i) => (
        <td
          key={i}
          style={{
            padding: '0.75rem 1rem',
            color: 'var(--text-primary)',
            verticalAlign: 'middle',
            borderLeft: '1px solid var(--border-subtle)',
            background: i === latestIdx ? 'color-mix(in srgb, var(--brand-600) 4%, transparent)' : undefined,
          }}
        >
          {renderer(i)}
        </td>
      ))}
    </tr>
  )
}

function SectionDivider({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols + 1} style={{ padding: 0, borderTop: '2px solid var(--border-default)', height: 0 }} />
    </tr>
  )
}

/* =========================================================================
 *   Sparkline — only when prices vary
 * ========================================================================= */

function Sparkline({ rows, minP, maxP }: { rows: POHistoryRow[]; minP: number; maxP: number }) {
  const n = rows.length
  const W = 800
  const H = 160
  const padX = 60
  const padTop = 38
  const padBottom = 42
  const range = Math.max(maxP - minP, 0.0001)
  const step = (W - padX * 2) / Math.max(n - 1, 1)

  const points = rows.map((r, i) => {
    const x = padX + i * step
    const v = parseAmount(r.unit_cost) ?? 0
    const y = padTop + (1 - (v - minP) / range) * (H - padTop - padBottom)
    return { x, y, v, r }
  })

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const areaPath = `${path} L${points[points.length - 1].x.toFixed(2)},${(H - padBottom).toFixed(2)} L${points[0].x.toFixed(2)},${(H - padBottom).toFixed(2)} Z`

  // Y-axis reference labels (min, max)
  const yMax = padTop
  const yMin = H - padBottom

  return (
    <div
      style={{
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: '0.95rem 1.2rem 0.7rem',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.84rem', fontWeight: 700 }}>
          <i className="pi pi-chart-line" style={{ color: 'var(--brand-600)' }} /> Price trend
          <span style={{ color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.78rem' }}>(oldest → newest)</span>
        </div>
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          range: {formatINRSymbol(minP)} – {formatINRSymbol(maxP)}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet">
        {/* Y reference lines */}
        <line x1={padX - 8} x2={W - padX + 8} y1={yMax} y2={yMax} stroke="var(--border-subtle)" strokeDasharray="3 4" />
        <line x1={padX - 8} x2={W - padX + 8} y1={yMin} y2={yMin} stroke="var(--border-subtle)" strokeDasharray="3 4" />
        <text x={padX - 12} y={yMax + 4} fill="var(--text-muted)" fontSize={10} textAnchor="end">{formatINRSymbol(maxP)}</text>
        <text x={padX - 12} y={yMin + 4} fill="var(--text-muted)" fontSize={10} textAnchor="end">{formatINRSymbol(minP)}</text>

        {/* Area + line */}
        <path d={areaPath} fill="color-mix(in srgb, var(--brand-600) 14%, transparent)" />
        <path d={path} fill="none" stroke="var(--brand-600)" strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" />

        {points.map((p, i) => {
          const isLast = i === points.length - 1
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={isLast ? 6 : 5} fill={isLast ? 'var(--brand-600)' : '#fff'} stroke="var(--brand-600)" strokeWidth={2.4} />
              <text x={p.x} y={p.y - 12} fill="var(--text-primary)" fontSize={12} fontWeight={800} textAnchor="middle">
                {formatINRSymbol(p.v)}
              </text>
              <text x={p.x} y={H - 12} fill="var(--text-muted)" fontSize={11} textAnchor="middle">
                {formatDate(p.r.po_date)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* =========================================================================
 *   Tiny helpers
 * ========================================================================= */

function Mono({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 700 }}>{children}</span>
}

function trendTone(delta: number | null): string {
  if (delta == null) return 'var(--text-muted)'
  if (delta > 0) return 'var(--status-danger-fg)'
  if (delta < 0) return 'var(--status-success-fg)'
  return 'var(--text-muted)'
}

function trendIcon(delta: number | null): string {
  if (delta == null) return 'pi-minus'
  if (delta > 0) return 'pi-arrow-up'
  if (delta < 0) return 'pi-arrow-down'
  return 'pi-minus'
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
