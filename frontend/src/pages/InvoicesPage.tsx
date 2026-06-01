import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import SlideOver from '../components/SlideOver'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'
import { formatINRSymbol, formatDate, formatInt } from '../utils/format'
import { downloadCsv } from '../utils/exportCsv'

/**
 * Invoices list — translated from Frontend_Redesign_Mockups/portal.html
 * (VIEWS.invoices) verbatim. Same hero / kpis / saved-view chips /
 * toolbar / table / pagination structure as the mockup; static demo
 * values replaced with real React state.
 *
 * Compatibility CSS classes (.hero, .kpis, .kpi, .view-chip, .toolbar,
 * .tb__sr, .tb__c, .card, .tbl, .chip, .btn) come from
 * design-system/mockup-compat.css.
 */

interface Invoice {
  invoice_id: number
  invoice_number: string
  supplier_name: string | null
  invoice_date: string | null
  po_number: string | null
  total_amount: string | number | null
  status: string | null
  source?: 'excel' | 'ocr' | 'both' | null
}

interface InvoiceStats {
  total: number
  validated: number
  waiting: number
  re_validation: number
  ready_for_payment: number
  paid: number
  exception_approval: number
  debit_note_approval: number
}

type ViewKey = 'all' | 'ready' | 'hival' | 'blockers' | 'reval'

const PAGE_SIZE = 25

function statusChipFor(s: string | null) {
  const status = (s || '').toLowerCase()
  if (status === 'validated' || status === 'ready_for_payment' || status === 'paid')
    return { variant: 'ok' as const, label: 'Validated' }
  if (status === 'waiting_for_validation')
    return { variant: 'warn' as const, label: 'Waiting for validation' }
  if (status === 'waiting_for_re_validation')
    return { variant: 'err' as const, label: 'Waiting for re-validation' }
  if (status === 'debit_note_approval')
    return { variant: 'vio' as const, label: 'Debit note' }
  if (status === 'exception_approval')
    return { variant: 'info' as const, label: 'Exception' }
  return { variant: 'mute' as const, label: s || '—' }
}

function InvoicesPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [stats, setStats] = useState<InvoiceStats>({
    total: 0, validated: 0, waiting: 0, re_validation: 0,
    ready_for_payment: 0, paid: 0, exception_approval: 0, debit_note_approval: 0
  })
  const [rows, setRows] = useState<Invoice[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [openInv, setOpenInv] = useState<Invoice | null>(null)
  // Reviewer role is scoped to the re-validation queue — read-only, no
  // KPI tiles for other statuses, no toolbar status toggle, no actions.
  const { user } = useAuth()
  const isReviewer = (user?.role || '').toLowerCase() === 'reviewer'

  /* Toolbar filter state */
  const [searchParams] = useSearchParams()
  const [search,   setSearch]   = useState('')
  const [statusFl, setStatusFl] = useState<'all' | 'validated' | 'awaiting' | 'reconcile' | 'queue' | 'debit_note' | 'exception'>(isReviewer ? 'reconcile' : 'all')
  const [sourceFl, setSourceFl] = useState<'all' | 'excel' | 'ocr'>('all')
  const [supplierFl, setSupplierFl] = useState<string>('all')
  const [activeView, setActiveView] = useState<ViewKey>('all')

  /* Saved views — populated from /api/saved-views?scope=invoices.
     Each row is a snapshot of statusFl/sourceFl/supplierFl that the user
     captured with "Save current". Stored server-side per-user. */
  interface SavedView {
    view_id: number
    name: string
    filters: { statusFl?: string; sourceFl?: string; supplierFl?: string; search?: string }
  }
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null)

  // Load saved views once; missing table just returns [].
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('saved-views?scope=invoices')
        if (!res.ok) return
        const body = await res.json()
        if (alive) setSavedViews(Array.isArray(body.items) ? body.items : [])
      } catch { /* swallow */ }
    })()
    return () => { alive = false }
  }, [])

  const hasActiveFilters =
    statusFl !== 'all' || sourceFl !== 'all' || supplierFl !== 'all' || search.trim() !== ''

  async function handleSaveCurrent() {
    if (!hasActiveFilters) {
      toast.warn('Nothing to save', 'Apply a filter first, then save the combo.')
      return
    }
    const name = window.prompt('Name this view (e.g. "Tata > ₹5L awaiting"):')
    if (!name || !name.trim()) return
    try {
      const res = await apiFetch('saved-views', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'invoices',
          name: name.trim(),
          filters: { statusFl, sourceFl, supplierFl, search }
        })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Save failed'))
      const created = await res.json()
      setSavedViews((prev) => [...prev, created])
      toast.success('View saved', `"${name.trim()}" is now in your saved list.`)
    } catch (err) {
      toast.danger('Save failed', String(err))
    }
  }

  async function handleDeleteView(view: SavedView) {
    if (!confirm(`Delete saved view "${view.name}"?`)) return
    try {
      const res = await apiFetch(`saved-views/${view.view_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
      setSavedViews((prev) => prev.filter((v) => v.view_id !== view.view_id))
      if (activeSavedId === view.view_id) setActiveSavedId(null)
    } catch (err) {
      toast.danger('Delete failed', String(err))
    }
  }

  function applySavedView(view: SavedView) {
    const f = view.filters || {}
    setStatusFl((f.statusFl as typeof statusFl) || 'all')
    setSourceFl((f.sourceFl as typeof sourceFl) || 'all')
    setSupplierFl(f.supplierFl || 'all')
    setSearch(f.search || '')
    setActiveSavedId(view.view_id)
  }

  /* KPI strip — fetched once from /api/invoices/stats. */
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('invoices/stats')
        if (res.ok && alive) setStats(await res.json())
      } catch { /* fall back to zeros */ }
    })()
    return () => { alive = false }
  }, [])

  /* Deep-link support: ?status=… (raw DB status, comma-separated allowed)
     lets other pages — e.g. the Needs Attention KPI cards — route straight
     to a filtered invoice list. Maps the raw status(es) onto the toolbar's
     statusFl key so the chip + query stay in sync. Runs on mount and when
     the param changes. */
  useEffect(() => {
    const raw = (searchParams.get('status') || '').trim().toLowerCase()
    if (!raw) return
    const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    const key: typeof statusFl =
      set.has('waiting_for_validation') && set.has('waiting_for_re_validation') ? 'queue' :
      set.has('waiting_for_validation')    ? 'awaiting' :
      set.has('waiting_for_re_validation') ? 'reconcile' :
      set.has('validated')                 ? 'validated' :
      set.has('debit_note_approval')       ? 'debit_note' :
      set.has('exception_approval')        ? 'exception' :
      'all'
    setStatusFl(key)
    setActiveView('all')
    setPage(1)
  }, [searchParams])

  /* Map active view + toolbar filters into a single querystring for the
     /api/invoices endpoint. Saved views translate to status / source
     scopes; toolbar filters narrow inside that scope. */
  const buildParams = useCallback(() => {
    const qs = new URLSearchParams()
    qs.set('limit',  String(PAGE_SIZE))
    qs.set('offset', String((page - 1) * PAGE_SIZE))
    if (search) qs.set('q', search)

    /* Saved view → status filter (or the special "hival" / "blockers" subsets
       handled client-side after the page comes back). */
    let viewStatus: string | null = null
    if (activeView === 'ready') viewStatus = 'validated'
    /* blockers maps to re-validation; hival has no server filter. */
    if (activeView === 'blockers' || activeView === 'reval') viewStatus = 'waiting_for_re_validation'

    /* Toolbar status filter wins over saved view if both set. */
    const status =
      statusFl === 'validated'  ? 'validated' :
      statusFl === 'awaiting'   ? 'waiting_for_validation' :
      statusFl === 'reconcile'  ? 'waiting_for_re_validation' :
      statusFl === 'queue'      ? 'waiting_for_validation,waiting_for_re_validation' :
      statusFl === 'debit_note' ? 'debit_note_approval' :
      statusFl === 'exception'  ? 'exception_approval' :
      viewStatus
    if (status) qs.set('status', status)

    const source = sourceFl !== 'all' ? sourceFl : null
    if (source) qs.set('source', source)

    return qs.toString()
  }, [page, search, statusFl, sourceFl, activeView])

  /* Fetch rows whenever filters / page change. */
  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const res = await apiFetch(`invoices?${buildParams()}`)
        if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load invoices'))
        const body = await res.json()
        if (!alive) return
        let items: Invoice[] = Array.isArray(body) ? body : (body.items || [])

        /* Client-side narrowing for views the API doesn't natively support. */
        if (activeView === 'hival') {
          items = items.filter((r) => (Number(r.total_amount) || 0) >= 500_000)
        }
        if (supplierFl !== 'all') {
          items = items.filter((r) => (r.supplier_name || '').toLowerCase().includes(supplierFl))
        }

        setRows(items)
        setTotal(typeof body.total === 'number' ? body.total : items.length)
      } catch (err) {
        if (alive) toast.danger('Failed to load invoices', String(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [buildParams, activeView, supplierFl, toast])

  /* Drift the page when filters change so we don't ask for page 9 of a
     5-page result set. */
  useEffect(() => { setPage(1) }, [search, statusFl, sourceFl, supplierFl, activeView])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  /* Pagination — show 1, 2, 3 … last, with ellipsis in the middle. */
  const pageList = (() => {
    const out: Array<number | 'gap'> = []
    if (pages <= 5) {
      for (let i = 1; i <= pages; i++) out.push(i)
    } else {
      out.push(1, 2, 3)
      if (page > 4) out.push('gap')
      out.push(pages)
    }
    return out
  })()

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.invoice_id))
  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev)
        rows.forEach((r) => next.delete(r.invoice_id))
        return next
      }
      const next = new Set(prev)
      rows.forEach((r) => next.add(r.invoice_id))
      return next
    })
  }
  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const resetFilters = () => {
    setSearch(''); setStatusFl('all'); setSourceFl('all'); setSupplierFl('all'); setActiveView('all')
  }

  const exportCsv = async () => {
    try {
      const res = await apiFetch('invoices?limit=50000')
      if (!res.ok) return
      const body = await res.json()
      const items = (body.items || body || []) as Record<string, unknown>[]
      downloadCsv(items, 'invoices-export', [
        { key: 'invoice_number', header: 'Invoice #' },
        { key: 'invoice_date',   header: 'Date' },
        { key: 'supplier_name',  header: 'Supplier' },
        { key: 'po_number',      header: 'PO' },
        { key: 'source',         header: 'Source' },
        { key: 'total_amount',   header: 'Amount' },
        { key: 'status',         header: 'Status' }
      ])
    } catch { /* swallow */ }
  }

  const rerunValidation = async () => {
    const ok = await confirmDialog({
      title: 'Re-run validation engine on all pending + validated invoices?',
      body: 'Walks every invoice in waiting_for_validation / waiting_for_re_validation / exception_approval / debit_note_approval / validated and re-runs the engine. ready_for_payment / paid / rejected invoices are skipped (human approval gate already passed).',
      icon: 'pi-refresh',
      kind: 'info',
      okLabel: 'Run'
    })
    if (!ok) return
    try {
      const res = await apiFetch('validation-rules/revalidate-all-pending', { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      const body = await res.json()
      toast.success(
        'Re-validation complete',
        `${body.succeeded} ok · ${body.failed} failed (of ${body.total} processed)`
      )
    } catch (err) {
      toast.danger('Re-validation failed', String((err as Error)?.message || err))
    }
  }

  /* ============== render ============== */
  return (
    <>
      {/* Hero — matches mockup verbatim */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-file" /> Invoices</span>
          <h1>Invoices</h1>
          <p>All supplier invoices loaded from Bill Register and OCR. Click any row to open detail in a side panel — keep your filters and place in the list.</p>
        </div>
        <div className="hero__act">
          {!isReviewer && <button className="btn btn--g" onClick={exportCsv}><i className="pi pi-download" /> Export CSV</button>}
          {!isReviewer && <button className="btn btn--g" onClick={rerunValidation}><i className="pi pi-refresh" /> Re-run validation</button>}
          {!isReviewer && <button className="btn btn--p" onClick={() => navigate('/invoices/upload')}><i className="pi pi-upload" /> Upload PDF</button>}
        </div>
      </section>

      {/* KPI strip — reviewers see only the re-validation tile (their scope);
          everyone else sees the full 4-up. */}
      {isReviewer ? (
        <div className="kpis" style={{ gridTemplateColumns: '1fr', marginBottom: 14 }}>
          <div className="kpi kpi--rs">
            <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-sync" /></div></div>
            <p className="kpi__l">Waiting for re-validation</p>
            <div className="kpi__v">{formatInt(stats.re_validation)}</div>
          </div>
        </div>
      ) : (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
          <div className="kpi kpi--brand" onClick={() => { setActiveView('all'); setStatusFl('all') }}>
            <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-file" /></div></div>
            <p className="kpi__l">All invoices</p>
            <div className="kpi__v">{formatInt(stats.total)}</div>
          </div>
          <div className="kpi kpi--em" onClick={() => setStatusFl('validated')}>
            <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-check" /></div></div>
            <p className="kpi__l">Validated</p>
            <div className="kpi__v">{formatInt(stats.validated)}</div>
          </div>
          <div className="kpi kpi--am" onClick={() => setStatusFl('awaiting')}>
            <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-clock" /></div></div>
            <p className="kpi__l">Waiting for validation</p>
            <div className="kpi__v">{formatInt(stats.waiting)}</div>
          </div>
          <div className="kpi kpi--rs" onClick={() => setStatusFl('reconcile')}>
            <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-sync" /></div></div>
            <p className="kpi__l">Waiting for re-validation</p>
            <div className="kpi__v">{formatInt(stats.re_validation)}</div>
          </div>
        </div>
      )}

      {/* Saved view chips (hidden for reviewer — they only see re-validation) */}
      {!isReviewer && <div className="views" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12, fontWeight: 600, alignSelf: 'center', marginRight: 6 }}>Views:</span>
        <button
          className={`view-chip ${activeView === 'all' ? 'active' : ''}`}
          onClick={() => setActiveView('all')}
        >All <span className="ct">{formatInt(stats.total)}</span></button>
        <button
          className={`view-chip ${activeView === 'ready' ? 'active' : ''}`}
          onClick={() => setActiveView('ready')}
        >Ready to pay <span className="ct">{formatInt(stats.validated)}</span></button>
        <button
          className={`view-chip ${activeView === 'hival' ? 'active' : ''}`}
          onClick={() => setActiveView('hival')}
        >High value (&gt;₹5L) <span className="ct">·</span></button>
        <button
          className={`view-chip ${activeView === 'blockers' ? 'active' : ''}`}
          onClick={() => setActiveView('blockers')}
        >Top blockers <span className="ct">{formatInt(stats.re_validation)}</span></button>
        <button
          className={`view-chip ${activeView === 'reval' ? 'active' : ''}`}
          onClick={() => setActiveView('reval')}
        >Re-validation <span className="ct">{formatInt(stats.re_validation)}</span></button>
        {/* Splitting the legacy "In review" pill into two: a debit-note
            approval queue and an exception-approval queue. Same data,
            different decision context, so they shouldn't share a chip. */}
        <button
          className={`view-chip ${statusFl === 'debit_note' ? 'active' : ''}`}
          onClick={() => { setActiveView('all'); setStatusFl('debit_note') }}
        >Debit-note approval <span className="ct">{formatInt(stats.debit_note_approval)}</span></button>
        <button
          className={`view-chip ${statusFl === 'exception' ? 'active' : ''}`}
          onClick={() => { setActiveView('all'); setStatusFl('exception') }}
        >Exception approval <span className="ct">{formatInt(stats.exception_approval)}</span></button>
        {/* User-saved views — populated from /api/saved-views. Each chip
            applies the saved filter combo on click; right-click / delete
            icon removes the saved row. */}
        {savedViews.map((v) => (
          <span
            key={v.view_id}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <button
              className={`view-chip ${activeSavedId === v.view_id ? 'active' : ''}`}
              onClick={() => applySavedView(v)}
              title={`Apply saved view "${v.name}"`}
            >
              <i className="pi pi-star" /> {v.name}
            </button>
            <button
              onClick={() => handleDeleteView(v)}
              title={`Delete saved view "${v.name}"`}
              style={{
                background: 'transparent', border: 0, padding: '0 4px',
                marginLeft: -4, marginRight: 4, color: 'var(--t-3)',
                cursor: 'pointer', fontSize: 11
              }}
              aria-label={`Delete ${v.name}`}
            >
              <i className="pi pi-times" />
            </button>
          </span>
        ))}
        <button
          className="view-chip"
          style={{ borderStyle: 'dashed', color: 'var(--t-3)' }}
          onClick={handleSaveCurrent}
          disabled={!hasActiveFilters}
          title={hasActiveFilters ? 'Save the current filter combo for one-click reuse' : 'Apply a filter first, then save the combo.'}
        >
          <i className="pi pi-plus" /> Save current
        </button>
      </div>}

      {/* Toolbar */}
      <div className="toolbar">
        <div className="tb__sr">
          <i className="pi pi-search" />
          <input
            placeholder="Search invoice no, supplier, PO ref…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {!isReviewer && <select value={statusFl} onChange={(e) => setStatusFl(e.target.value as typeof statusFl)}>
          <option value="all">All statuses</option>
          <option value="queue">In queue (needs attention)</option>
          <option value="validated">Validated</option>
          <option value="awaiting">Waiting for validation</option>
          <option value="reconcile">Waiting for re-validation</option>
          <option value="debit_note">Debit note approval</option>
          <option value="exception">Exception approval</option>
        </select>}
        <select value={sourceFl} onChange={(e) => setSourceFl(e.target.value as typeof sourceFl)}>
          <option value="all">All sources</option>
          <option value="excel">Excel</option>
          <option value="ocr">OCR</option>
        </select>
        <select value={supplierFl} onChange={(e) => setSupplierFl(e.target.value)}>
          <option value="all">All suppliers</option>
          <option value="plasmatek">PLASMATEK</option>
          <option value="sheel">SHEEL SECTIONS</option>
          <option value="mahadevi">MAHADEVI</option>
          <option value="jaynath">JAYNATH</option>
          <option value="everest">EVEREST</option>
          <option value="raghu">RAGHU PRESS</option>
        </select>
        <select defaultValue="30">
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="ytd">This year</option>
        </select>
        <button className="btn btn--g btn--sm" onClick={resetFilters}>
          <i className="pi pi-times" /> Reset
        </button>
        <span className="tb__c">
          Showing {rows.length} of {formatInt(total)}
        </span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 24 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </th>
              <th>Invoice</th>
              <th>Date</th>
              <th>Supplier</th>
              <th>PO ref</th>
              <th>Source</th>
              <th>Status</th>
              <th className="num">Amount</th>
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
                No invoices match this filter.
              </td></tr>
            )}
            {rows.map((row) => {
              const chip = statusChipFor(row.status)
              const isSel = selected.has(row.invoice_id)
              return (
                <tr key={row.invoice_id} onClick={() => setOpenInv(row)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={isSel} onChange={() => toggleOne(row.invoice_id)} />
                  </td>
                  <td className="bold">{row.invoice_number}</td>
                  <td><span className="muted">{formatDate(row.invoice_date) || '—'}</span></td>
                  <td>{row.supplier_name || <span className="muted">—</span>}</td>
                  <td className="mono">{row.po_number || '—'}</td>
                  <td>
                    {row.source === 'ocr'   ? <span className="chip chip--vio">OCR</span>
                      : row.source === 'excel' ? <span className="chip chip--info">Excel</span>
                      : row.source === 'both'  ? <span className="chip chip--ok">Both</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td><span className={`chip chip--${chip.variant}`}>{chip.label}</span></td>
                  <td className="num bold">{formatINRSymbol(row.total_amount)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--b-1)', background: 'var(--s-1)'
        }}>
          <span className="muted" style={{ fontSize: 12 }}>
            <b>{selected.size} selected</b> · Page {page} of {pages} · {PAGE_SIZE} per page
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

      {/* Row click opens detail in the slide-over (mockup behaviour). */}
      <SlideOver
        open={!!openInv}
        onClose={() => setOpenInv(null)}
        title={openInv ? `Invoice ${openInv.invoice_number}` : 'Invoice'}
        headerActions={
          openInv && (
            <button
              type="button"
              className="btn btn--g btn--sm"
              onClick={() => {
                navigate(`/invoices/validate/${openInv.invoice_id}`)
                setOpenInv(null)
              }}
              title="Open in full page"
            >
              <i className="pi pi-external-link" /> Open full
            </button>
          )
        }
      >
        {openInv && (
          <InvoiceExpansion invoiceId={openInv.invoice_id} poNumber={openInv.po_number} />
        )}
      </SlideOver>
    </>
  )
}

export default InvoicesPage
