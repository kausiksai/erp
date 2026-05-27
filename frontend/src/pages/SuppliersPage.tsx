import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Supplier360 from '../components/Supplier360'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'
import { useDebounce } from '../hooks/useDebounce'

/**
 * Suppliers — translated from Frontend_Redesign_Mockups/portal.html
 * (VIEWS.suppliers) verbatim. Hero + 4-up KPIs + 2-column body:
 *   1fr list of suppliers (clickable) on the left
 *   2fr Supplier 360 panel on the right showing the current selection
 *
 * Replaces the prior ListPage + SlideOver flow; the 2-column layout is
 * the mockup's design and lets the user scan the list without losing the
 * detail panel.
 */

interface Supplier {
  supplier_id: number
  supplier_name: string
  suplr_id: string | null
  gst_number: string | null
  pan_number: string | null
  state_name: string | null
  contact_person: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  city: string | null
}

interface SupplierStats {
  active: number
  multi_state_gstin: number
  issue_free_month: number
  open_issues: number
}

function SuppliersPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  // Paginated server-side. PAGE_SIZE chosen so the list panel renders
  // within one viewport scroll on a typical 1080p monitor.
  const PAGE_SIZE = 50
  const [filtered, setFiltered] = useState<Supplier[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const debouncedSearch = useDebounce(search, 300)
  const [selected, setSelected] = useState<Supplier | null>(null)
  const [stats, setStats] = useState<SupplierStats | null>(null)

  // Reset to page 1 whenever the search changes.
  useEffect(() => { setOffset(0) }, [debouncedSearch])

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const qs = new URLSearchParams()
        qs.set('limit', String(PAGE_SIZE))
        qs.set('offset', String(offset))
        if (debouncedSearch.trim()) qs.set('q', debouncedSearch.trim())
        const [sRes, statsRes] = await Promise.all([
          apiFetch(`suppliers?${qs.toString()}`),
          // Stats only on first page load (it's independent of pagination).
          offset === 0 ? apiFetch('suppliers/stats').catch(() => null) : Promise.resolve(null)
        ])
        if (sRes.ok && alive) {
          const body = await sRes.json()
          // Backend returns { items, total, limit, offset } for paginated
          // requests; legacy array shape still handled for safety.
          const items: Supplier[] = Array.isArray(body) ? body : (body.items || body.suppliers || [])
          setFiltered(items)
          setTotal(typeof body.total === 'number' ? body.total : items.length)
          // Auto-select first row on initial load only.
          setSelected((prev) => prev || items[0] || null)
        }
        if (statsRes?.ok && alive) {
          setStats(await statsRes.json())
        }
      } catch (err) {
        if (alive) toast.danger('Failed to load suppliers', getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [debouncedSearch, offset, toast])

  async function handleDeleteSupplier(row: Supplier) {
    const ok = await confirmDialog({
      title: `Delete supplier "${row.supplier_name}"?`,
      body: "This is permanent. Any historical POs and invoices linked to this supplier will keep their reference but you won't be able to add new ones.",
      icon: 'pi-trash',
      kind: 'danger',
      okLabel: 'Delete'
    })
    if (!ok) return
    try {
      const res = await apiFetch(`suppliers/${row.supplier_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Delete failed'))
      toast.success('Supplier deleted', `"${row.supplier_name}" was removed from the master.`)
      setFiltered((prev) => prev.filter((s) => s.supplier_id !== row.supplier_id))
      setTotal((t) => Math.max(0, t - 1))
      if (selected?.supplier_id === row.supplier_id) {
        const next = filtered.find((s) => s.supplier_id !== row.supplier_id) || null
        setSelected(next)
      }
    } catch (err) {
      toast.danger('Delete failed', getDisplayError(err))
    }
  }

  /* ============== render ============== */
  return (
    <>
      {/* Hero — verbatim from mockup VIEWS.suppliers */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-users" /> Masters</span>
          <h1>Suppliers</h1>
          <p>Supplier master with health bars, multi-state GSTIN handling, recent volume — and a 360° supplier view (open one to see).</p>
        </div>
        <div className="hero__act">
          <button className="btn btn--g" onClick={() => toast.info('Export queued', 'Supplier export will land with /api/suppliers/export.')}>
            <i className="pi pi-download" /> Export
          </button>
          <button className="btn btn--p" onClick={() => navigate('/suppliers/registration')}>
            <i className="pi pi-plus" /> New supplier
          </button>
        </div>
      </section>

      {/* 4-up KPI strip from /suppliers/stats */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--brand">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-users" /></div></div>
          <p className="kpi__l">Active suppliers</p>
          <div className="kpi__v">{stats ? stats.active.toLocaleString('en-IN') : total.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--vio">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-id-card" /></div></div>
          <p className="kpi__l">Multi-state GSTIN</p>
          <div className="kpi__v">{stats ? stats.multi_state_gstin.toLocaleString('en-IN') : '—'}</div>
        </div>
        <div className="kpi kpi--em">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-check" /></div></div>
          <p className="kpi__l">Issue-free this month</p>
          <div className="kpi__v">{stats ? stats.issue_free_month.toLocaleString('en-IN') : '—'}</div>
        </div>
        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-flag" /></div></div>
          <p className="kpi__l">Open issues</p>
          <div className="kpi__v">{stats ? stats.open_issues.toLocaleString('en-IN') : '—'}</div>
        </div>
      </div>

      {/* 2-column body: list (1fr) + 360 panel (2fr) */}
      <div className="g3" style={{ gridTemplateColumns: '1fr 2fr', gap: 14, alignItems: 'flex-start' }}>

        {/* Supplier list (left) */}
        <div className="card" style={{ padding: 0 }}>
          <div className="card__h">
            <div className="card__t"><i className="pi pi-users" /> Suppliers</div>
            <span className="card__m">
              {total > 0
                ? `${offset + 1}–${Math.min(offset + filtered.length, total)} of ${total.toLocaleString('en-IN')}`
                : filtered.length.toLocaleString('en-IN')}
            </span>
          </div>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--b-1)' }}>
            <div className="tb__sr">
              <i className="pi pi-search" />
              <input
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div style={{ maxHeight: 620, overflowY: 'auto' }}>
            {loading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t-3)', fontSize: 13 }}>
                <i className="pi pi-spin pi-spinner" /> Loading…
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t-3)', fontSize: 13 }}>
                <i className="pi pi-inbox" style={{ marginRight: 6 }} />
                No suppliers match.
              </div>
            )}
            {filtered.map((s) => {
              const isActive = selected?.supplier_id === s.supplier_id
              return (
                <div
                  key={s.supplier_id}
                  onClick={() => setSelected(s)}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--b-1)',
                    background: isActive ? 'var(--brand-50)' : undefined,
                    cursor: 'pointer'
                  }}
                >
                  <div className="bold" style={{ color: isActive ? 'var(--brand-700)' : 'var(--t-1)' }}>
                    {s.supplier_name}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {[s.city, s.state_name].filter(Boolean).join(' · ') || s.gst_number || '—'}
                  </div>
                </div>
              )
            })}
          </div>
          {/* Pagination — prev/next pair. Hidden when result set fits one page. */}
          {total > PAGE_SIZE && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderTop: '1px solid var(--b-1)',
              fontSize: 12
            }}>
              <button
                className="action-btn action-btn--ghost"
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                disabled={offset === 0 || loading}
                style={{ padding: '4px 10px' }}
              >
                <i className="pi pi-angle-left" /> Prev
              </button>
              <span className="muted">
                Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
              </span>
              <button
                className="action-btn action-btn--ghost"
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total || loading}
                style={{ padding: '4px 10px' }}
              >
                Next <i className="pi pi-angle-right" />
              </button>
            </div>
          )}
        </div>

        {/* Supplier 360 panel (right) */}
        <div className="stack">
          {selected ? (
            <>
              {/* Action bar above the 360 — matches mockup Edit / Flag */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  className="btn btn--g btn--xs"
                  onClick={() => navigate('/suppliers/registration', { state: { supplier: selected } })}
                >
                  <i className="pi pi-pencil" /> Edit
                </button>
                <button
                  className="btn btn--g btn--xs"
                  onClick={() => toast.info('Flagged', `Supplier ${selected.supplier_name} flagged for review.`)}
                >
                  <i className="pi pi-flag" /> Flag
                </button>
                <button
                  className="btn btn--d btn--xs"
                  onClick={() => handleDeleteSupplier(selected)}
                >
                  <i className="pi pi-trash" /> Delete
                </button>
              </div>
              <Supplier360 supplierId={selected.supplier_id} />
            </>
          ) : (
            <div className="card">
              <div className="ph">
                <i className="pi pi-users" />
                Pick a supplier on the left to see their 360° view.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default SuppliersPage
