import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SlideOver from '../components/SlideOver'
import PoExpansion from '../components/PoExpansion'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatInt, formatINRSymbol, parseAmount } from '../utils/format'
import { useToast } from '../contexts/ToastContext'

/**
 * Purchase orders — translated from Frontend_Redesign_Mockups/portal.html
 * (VIEWS['purchase-orders']) verbatim. Hero + 5-up KPIs + tabs row +
 * toolbar + table-with-consumption-bar. Row click opens SlideOver
 * <PoExpansion> for the full detail.
 *
 * Compat CSS classes come from design-system/mockup-compat.css.
 */

interface PurchaseOrder {
  po_id: number
  po_number: string
  supplier_name: string | null
  po_date: string | null
  status: string | null
  amd_no: number | string | null
  pfx: string | null
  unit: string | null
  line_item_count: number | string | null
  po_value?: string | number | null
  invoiced_amount?: string | number | null
}

type PoType = 'all' | 'open' | 'standard' | 'subcontract' | 'incomplete'

interface PoStats {
  total: number
  with_amendments: number
  unique_suppliers: number
  open_count: number
  fulfilled_count: number
  partial_count: number
  recent_count: number
}

const PAGE_SIZE = 25

function PurchaseOrdersPage() {
  const navigate = useNavigate()
  const toast    = useToast()

  const [stats, setStats] = useState<PoStats>({
    total: 0, with_amendments: 0, unique_suppliers: 0,
    open_count: 0, fulfilled_count: 0, partial_count: 0, recent_count: 0
  })
  const [rows, setRows]   = useState<PurchaseOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [openPo, setOpenPo] = useState<PurchaseOrder | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  /* Toolbar + tab state */
  const [poType, setPoType]     = useState<PoType>('all')
  const [search, setSearch]     = useState('')
  const [statusFl, setStatusFl] = useState<'all' | 'open' | 'partially_fulfilled' | 'fulfilled' | 'closed'>('all')
  const [page, setPage]         = useState(1)

  /* Stats */
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('purchase-orders/stats')
        if (res.ok && alive) setStats(await res.json())
      } catch { /* silent */ }
    })()
    return () => { alive = false }
  }, [reloadKey])

  /* Build the query string then fetch the page. */
  const buildParams = useCallback(() => {
    const qs = new URLSearchParams()
    qs.set('limit',  String(PAGE_SIZE))
    qs.set('offset', String((page - 1) * PAGE_SIZE))
    if (search) qs.set('q', search)
    if (statusFl !== 'all') qs.set('status', statusFl)

    /* poType tab → server filter where supported. "incomplete" stays
       client-side (filter by missing po_date). */
    if (poType === 'open' || poType === 'standard' || poType === 'subcontract') {
      qs.set('type', poType)
    }
    return qs.toString()
  }, [page, search, statusFl, poType])

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const res = await apiFetch(`purchase-orders?${buildParams()}`)
        if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load POs'))
        const body = await res.json()
        if (!alive) return
        let items: PurchaseOrder[] = Array.isArray(body) ? body : (body.items || [])
        if (poType === 'incomplete') {
          items = items.filter((r) => !r.po_date || !r.po_value)
        }
        setRows(items)
        setTotal(typeof body.total === 'number' ? body.total : items.length)
      } catch (err) {
        if (alive) toast.danger('Failed to load POs', String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [buildParams, poType, reloadKey, toast])

  /* Reset to page 1 when filters change. */
  useEffect(() => { setPage(1) }, [search, statusFl, poType])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  /* Pagination — 1, 2, 3 … last with ellipsis in the middle. */
  const pageList = useMemo(() => {
    const out: Array<number | 'gap'> = []
    if (pages <= 5) for (let i = 1; i <= pages; i++) out.push(i)
    else {
      out.push(1, 2, 3)
      if (page > 4) out.push('gap')
      out.push(pages)
    }
    return out
  }, [pages, page])

  /* ============== render ============== */
  return (
    <>
      {/* Hero — verbatim from mockup VIEWS['purchase-orders'] */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-shopping-cart" /> Documents</span>
          <h1>Purchase orders</h1>
          <p>All purchase orders, with their consumption, state and completeness. Click any row to open detail in a side panel — your filters stay in place.</p>
        </div>
        <div className="hero__act">
          <ExcelUploadButton
            endpoint="purchase-orders/upload-excel"
            label="Re-import"
            onSuccess={(message) => { setBanner({ tone: 'success', text: message }); setReloadKey((k) => k + 1) }}
            onError={(message) => setBanner({ tone: 'danger', text: message })}
          />
        </div>
      </section>

      {banner && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderColor: `var(--${banner.tone === 'success' ? 'ok' : 'err'}-line)`, color: `var(--${banner.tone === 'success' ? 'ok' : 'err'}-fg)` }}>
          <i className={`pi ${banner.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} /> {banner.text}
        </div>
      )}

      {/* 5-up KPI strip from mockup (Active POs / Open / Standard / Open value / Incomplete) */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--brand" onClick={() => setPoType('all')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-shopping-cart" /></div></div>
          <p className="kpi__l">Active POs</p>
          <div className="kpi__v">{formatInt(stats.total)}</div>
        </div>
        <div className="kpi kpi--vio" onClick={() => setPoType('open')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-tag" /></div></div>
          <p className="kpi__l">Open / blanket</p>
          <div className="kpi__v">{formatInt(stats.open_count)}</div>
        </div>
        <div className="kpi kpi--sl" onClick={() => setPoType('standard')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-check-square" /></div></div>
          <p className="kpi__l">Standard</p>
          <div className="kpi__v">{formatInt(stats.fulfilled_count)}</div>
        </div>
        <div className="kpi kpi--em">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-rupee" /></div></div>
          <p className="kpi__l">With amendments</p>
          <div className="kpi__v">{formatInt(stats.with_amendments)}</div>
        </div>
        <div className="kpi kpi--rs" onClick={() => setPoType('incomplete')}>
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-exclamation-circle" /></div></div>
          <p className="kpi__l">Suppliers</p>
          <div className="kpi__v">{formatInt(stats.unique_suppliers)}</div>
        </div>
      </div>

      {/* Tabs row */}
      <div className="tabs" style={{ marginBottom: 12 }}>
        {([
          { k: 'all',         l: 'All' },
          { k: 'open',        l: 'Open / blanket' },
          { k: 'standard',    l: 'Standard' },
          { k: 'subcontract', l: 'Subcontract' },
          { k: 'incomplete',  l: 'Incomplete' }
        ] as Array<{ k: PoType; l: string }>).map(({ k, l }) => (
          <button
            key={k}
            type="button"
            className={`tab ${poType === k ? 'active' : ''}`}
            onClick={() => setPoType(k)}
          >
            {l}
            <span className="muted" style={{ marginLeft: 6 }}>
              ({total > 0 && k === poType ? total.toLocaleString('en-IN') : '·'})
            </span>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="tb__sr">
          <i className="pi pi-search" />
          <input
            placeholder="Search PO no, supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={statusFl} onChange={(e) => setStatusFl(e.target.value as typeof statusFl)}>
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="partially_fulfilled">Partially fulfilled</option>
          <option value="fulfilled">Fulfilled</option>
          <option value="closed">Closed</option>
        </select>
        <span className="tb__c">{total.toLocaleString('en-IN')} POs</span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>PO ref</th>
              <th>Date</th>
              <th>Supplier</th>
              <th>Type</th>
              <th>Status</th>
              <th className="num">PO value</th>
              <th>Consumption</th>
              <th className="num">Invoiced</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--t-3)' }}>
                <i className="pi pi-spin pi-spinner" /> Loading…
              </td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--t-3)' }}>
                <i className="pi pi-inbox" style={{ marginRight: 6 }} />
                No POs match this filter.
              </td></tr>
            )}
            {rows.map((r) => {
              const poVal    = parseAmount(r.po_value) ?? 0
              const invoiced = parseAmount(r.invoiced_amount) ?? 0
              const pct      = poVal > 0 ? Math.min(100, Math.round((invoiced / poVal) * 100)) : 0
              const typeChip =
                r.pfx?.startsWith('OP') || r.pfx?.startsWith('BL') ? { variant: 'vio',  label: 'Open' } :
                r.pfx?.startsWith('SC') ? { variant: 'err',  label: 'Subcontract' } :
                                          { variant: 'mute', label: 'Standard' }
              const statusChip =
                (r.status || '').toLowerCase() === 'fulfilled'           ? { variant: 'mute', label: 'Closed' }    :
                (r.status || '').toLowerCase() === 'partially_fulfilled' ? { variant: 'warn', label: 'Awaiting GRN' } :
                                                                            { variant: 'ok',   label: 'Active' }
              const consumptionClass =
                pct >= 100 ? 'pb__f--em' :
                pct >= 30  ? 'pb__f--am' :
                             'pb__f'
              return (
                <tr key={r.po_id} onClick={() => setOpenPo(r)}>
                  <td className="bold mono">{r.po_number}</td>
                  <td><span className="muted">{formatDate(r.po_date) || '—'}</span></td>
                  <td>{r.supplier_name || <span className="muted">—</span>}</td>
                  <td><span className={`chip chip--${typeChip.variant}`}>{typeChip.label}</span></td>
                  <td><span className={`chip chip--${statusChip.variant}`}>{statusChip.label}</span></td>
                  <td className="num">{poVal > 0 ? formatINRSymbol(poVal) : <span className="muted">—</span>}</td>
                  <td>
                    {poVal > 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="pb" style={{ width: 120 }}>
                          <div className={consumptionClass} style={{ width: `${pct}%`, height: '100%' }} />
                        </div>
                        <span className="muted tabular" style={{ fontSize: 12 }}>{pct}%</span>
                      </div>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="num">{formatINRSymbol(r.invoiced_amount)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Pagination */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--b-1)', background: 'var(--s-1)'
        }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Page {page} of {pages} · {PAGE_SIZE} per page
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn--g btn--sm"
              disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={page === 1 ? { opacity: 0.5 } : undefined}
            >
              <i className="pi pi-angle-left" />
            </button>
            {pageList.map((p, i) =>
              p === 'gap' ? (
                <span key={`gap-${i}`} className="muted" style={{ padding: '6px 4px' }}>…</span>
              ) : (
                <button
                  key={p}
                  className={`btn ${p === page ? 'btn--p' : 'btn--g'} btn--sm`}
                  onClick={() => setPage(p)}
                >
                  {p}
                </button>
              )
            )}
            <button
              className="btn btn--g btn--sm"
              disabled={page === pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              style={page === pages ? { opacity: 0.5 } : undefined}
            >
              <i className="pi pi-angle-right" />
            </button>
          </div>
        </div>
      </div>

      <SlideOver
        open={!!openPo}
        onClose={() => setOpenPo(null)}
        title={openPo ? `Purchase order ${openPo.po_number}` : 'Purchase order'}
        headerActions={
          openPo && (
            <button
              type="button"
              className="btn btn--g btn--sm"
              onClick={() => {
                navigate(`/purchase-orders?poNumber=${encodeURIComponent(openPo.po_number)}`)
                setOpenPo(null)
              }}
            >
              <i className="pi pi-external-link" /> Open list
            </button>
          )
        }
      >
        {openPo && <PoExpansion po={openPo} />}
      </SlideOver>
    </>
  )
}

export default PurchaseOrdersPage
