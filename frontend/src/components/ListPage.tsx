import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import { DataTable } from 'primereact/datatable'
import type { DataTableExpandedRows } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Toast } from 'primereact/toast'
import { Dropdown } from 'primereact/dropdown'
import PageHero from './PageHero'
import StatTile from './StatTile'
import type { StatVariant } from './StatTile'
import { useDebounce } from '../hooks/useDebounce'

/**
 * Reusable list page template.
 *
 * Every route-level list page in the portal (invoices, POs, GRN, ASN, DC,
 * schedules, suppliers, users, owners, ...) is a thin config over this
 * component. It owns: hero, optional KPI row, filter toolbar, server-side
 * pagination, DataTable with row expansion + row click, loading + empty
 * state, error toast.
 */

// -------------------- shared types --------------------
export interface ListPageColumn<T> {
  field: string
  header: string
  body?: (row: T) => ReactNode
  sortable?: boolean
  style?: CSSProperties
  headerStyle?: CSSProperties
  className?: string
}

export type ListPageFilter =
  | { key: string; type: 'search'; placeholder?: string; width?: string }
  | {
      key: string
      type: 'select'
      placeholder?: string
      options: Array<{ label: string; value: string }>
      width?: string
    }

export interface ListPageKPI {
  label: string
  value: ReactNode
  icon?: string
  variant?: StatVariant
  sublabel?: ReactNode
  onClick?: () => void
}

export interface ListPageAction {
  label: string
  icon: string
  onClick: () => void
  variant?: 'primary' | 'ghost' | 'danger'
}

export interface FetchParams {
  limit: number
  offset: number
  search: string
  filters: Record<string, string>
}

export interface FetchResult<T> {
  items: T[]
  total: number
}

export interface ListPageProps<T> {
  eyebrow?: string
  eyebrowIcon?: string
  title: ReactNode
  subtitle?: ReactNode
  primaryAction?: ListPageAction
  secondaryActions?: ListPageAction[]
  /** Arbitrary extra header actions — rendered in the hero button strip. */
  headerExtras?: ReactNode
  /** Optional banner shown above the toolbar — used for upload success / error. */
  banner?: ReactNode
  kpis?: ListPageKPI[]
  /** Optional chip row rendered between KPIs and the filter toolbar. Used
   *  by Invoices for saved-view chips; can be used by other list pages
   *  for similar quick-filter affordances. */
  chipRow?: ReactNode
  filters?: ListPageFilter[]
  columns: ListPageColumn<T>[]
  rowKey: string
  fetchData: (params: FetchParams) => Promise<FetchResult<T>>
  onRowClick?: (row: T) => void
  rowExpansionTemplate?: (row: T) => ReactNode
  defaultRows?: number
  emptyTitle?: string
  emptyBody?: string
  /** External trigger to reload (bump to force refetch) */
  reloadKey?: number
  /** Enable multi-row selection. Renders a checkbox column on the left
   *  and surfaces the selected rows + a bulk-action footer. */
  selectable?: boolean
  /** Buttons rendered in the selection-aware footer (only shown when
   *  >0 rows are selected). Each gets the current selection passed in. */
  bulkActions?: Array<{
    label: string
    icon: string
    variant?: 'primary' | 'ghost' | 'danger' | 'success'
    onClick: (selected: T[]) => void | Promise<void>
  }>
}

function ListPage<T>(props: ListPageProps<T>) {
  const {
    eyebrow,
    eyebrowIcon,
    title,
    subtitle,
    primaryAction,
    secondaryActions = [],
    headerExtras,
    banner,
    kpis,
    chipRow,
    filters = [],
    columns,
    rowKey,
    fetchData,
    onRowClick,
    rowExpansionTemplate,
    defaultRows = 25,
    emptyTitle = 'Nothing to show yet',
    emptyBody = 'No records match your filters.',
    reloadKey = 0,
    selectable = false,
    bulkActions = []
  } = props

  const toast = useRef<Toast>(null)
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [first, setFirst] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(defaultRows)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<DataTableExpandedRows>({})
  const [selection, setSelection] = useState<T[]>([])

  // Reset selection when the underlying rows change (filters / page change).
  // Prevents "ghost" selections from stale data.
  useEffect(() => { setSelection([]) }, [rows])
  const debouncedSearch = useDebounce(search, 350)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      const res = await fetchData({
        limit: rowsPerPage,
        offset: first,
        search: debouncedSearch.trim(),
        filters: filterValues
      })
      setRows(res.items || [])
      setTotal(Number(res.total) || 0)
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return
      toast.current?.show({
        severity: 'error',
        summary: 'Load failed',
        detail: err instanceof Error ? err.message : 'Could not load data',
        life: 5000
      })
    } finally {
      setLoading(false)
    }
  }, [fetchData, rowsPerPage, first, debouncedSearch, filterValues])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  useEffect(() => {
    setFirst(0)
  }, [debouncedSearch, JSON.stringify(filterValues)])

  const actionsNode = useMemo(() => {
    const pieces: ReactNode[] = []
    secondaryActions.forEach((a, i) => {
      pieces.push(
        <button
          key={`s${i}`}
          type="button"
          className={`action-btn ${a.variant === 'primary' ? '' : 'action-btn--ghost'}`}
          onClick={a.onClick}
        >
          <i className={`pi ${a.icon}`} /> {a.label}
        </button>
      )
    })
    if (headerExtras) {
      pieces.push(<span key="extras">{headerExtras}</span>)
    }
    if (primaryAction) {
      pieces.push(
        <button
          key="primary"
          type="button"
          className="action-btn"
          onClick={primaryAction.onClick}
        >
          <i className={`pi ${primaryAction.icon}`} /> {primaryAction.label}
        </button>
      )
    }
    return pieces.length ? <>{pieces}</> : null
  }, [primaryAction, secondaryActions, headerExtras])

  return (
    <>
      <Toast ref={toast} position="top-right" />

      <PageHero
        eyebrow={eyebrow}
        eyebrowIcon={eyebrowIcon}
        title={title}
        subtitle={subtitle}
        actions={actionsNode}
      />

      {banner}

      {kpis && kpis.length > 0 && (
        <div className="grid-kpis fade-in-up--stagger">
          {kpis.map((k, i) => (
            <StatTile
              key={i}
              label={k.label}
              value={k.value}
              icon={k.icon}
              variant={k.variant}
              sublabel={k.sublabel}
              onClick={k.onClick}
            />
          ))}
        </div>
      )}

      {chipRow}

      {filters.length > 0 && (
        <div className="toolbar">
          {filters.map((f) => {
            if (f.type === 'search') {
              return (
                <div key={f.key} className="toolbar__search" style={{ width: f.width }}>
                  <i className="pi pi-search toolbar__searchIcon" aria-hidden />
                  <input
                    type="search"
                    className="toolbar__searchInput"
                    value={f.key === 'search' ? search : filterValues[f.key] || ''}
                    onChange={(e) => {
                      if (f.key === 'search') setSearch(e.target.value)
                      else setFilterValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }}
                    placeholder={f.placeholder || 'Search…'}
                  />
                </div>
              )
            }
            return (
              <Dropdown
                key={f.key}
                value={filterValues[f.key] || null}
                onChange={(e) =>
                  setFilterValues((v) => {
                    const n = { ...v }
                    if (e.value == null || e.value === '') delete n[f.key]
                    else n[f.key] = e.value
                    return n
                  })
                }
                options={f.options}
                optionLabel="label"
                optionValue="value"
                placeholder={f.placeholder || 'All'}
                showClear
                style={{ minWidth: f.width || '180px' }}
              />
            )
          })}
          {(search || Object.keys(filterValues).length > 0) && (
            <button
              type="button"
              className="action-btn action-btn--ghost"
              onClick={() => {
                setSearch('')
                setFilterValues({})
              }}
              title="Clear filters"
            >
              <i className="pi pi-times" /> Reset
            </button>
          )}
          <div style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>
            {loading ? 'Loading…' : `${total.toLocaleString('en-IN')} total`}
          </div>
        </div>
      )}

      {/* Table card */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading && rows.length === 0 ? (
          <div style={{ padding: '5rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.8rem' }}>
            <ProgressSpinner style={{ width: 48, height: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>Loading…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="emptyState" style={{ border: 0, borderRadius: 0 }}>
            <div className="emptyState__icon">
              <i className="pi pi-inbox" />
            </div>
            <div className="emptyState__title">{emptyTitle}</div>
            <div className="emptyState__body">{emptyBody}</div>
          </div>
        ) : (
          <DataTable
            value={rows as unknown as Record<string, unknown>[]}
            lazy
            paginator
            first={first}
            rows={rowsPerPage}
            totalRecords={total}
            onPage={(e) => {
              setFirst(e.first)
              setRowsPerPage(e.rows)
            }}
            rowsPerPageOptions={[10, 25, 50, 100, 200]}
            stripedRows
            dataKey={rowKey}
            loading={loading}
            expandedRows={expanded}
            onRowToggle={(e) => setExpanded(e.data as DataTableExpandedRows)}
            rowExpansionTemplate={
              rowExpansionTemplate
                ? ((data: unknown) => rowExpansionTemplate(data as T)) as unknown as (data: Record<string, unknown>) => ReactNode
                : undefined
            }
            onRowClick={
              onRowClick
                ? (e) => {
                    const target = e.originalEvent.target as HTMLElement
                    // Don't fire row-click when clicking expander or selection checkbox
                    if (target.closest('.p-row-toggler')) return
                    if (target.closest('.p-checkbox')) return
                    onRowClick(e.data as T)
                  }
                : undefined
            }
            rowHover={!!onRowClick}
            selectionMode={selectable ? 'checkbox' : null}
            selection={selection as unknown as Record<string, unknown>[]}
            onSelectionChange={(e: { value: unknown }) => setSelection(e.value as T[])}
          >
            {selectable && <Column selectionMode="multiple" headerStyle={{ width: '3rem' }} />}
            {rowExpansionTemplate && <Column expander style={{ width: '3rem' }} />}
            {columns.map((col) => (
              <Column
                key={col.field}
                field={col.field}
                header={col.header}
                body={
                  col.body
                    ? ((data: unknown) => col.body!(data as T)) as unknown as (data: Record<string, unknown>) => ReactNode
                    : undefined
                }
                sortable={col.sortable}
                style={col.style}
                headerStyle={col.headerStyle}
                className={col.className}
              />
            ))}
          </DataTable>
        )}

        {/* Bulk-action footer — appears when selectable + at least one
            row is selected. Cleared on filter/page change (selection
            reset on `rows` change above). */}
        {selectable && selection.length > 0 && bulkActions.length > 0 && (
          <div
            style={{
              padding: 'var(--space-3) var(--space-5)',
              background: 'linear-gradient(135deg, rgba(37,99,235,.06), rgba(6,182,212,.06))',
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <i className="pi pi-check-square" style={{ color: 'var(--brand-700)' }} />
              <span style={{ fontWeight: 600 }}>
                {selection.length.toLocaleString('en-IN')} selected
              </span>
              <button
                type="button"
                className="action-btn action-btn--ghost"
                style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}
                onClick={() => setSelection([])}
              >
                Clear
              </button>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {bulkActions.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  className={`action-btn ${a.variant === 'ghost' ? 'action-btn--ghost' : ''}`}
                  style={
                    a.variant === 'danger'
                      ? { background: 'linear-gradient(135deg,#f43f5e,#e11d48)', boxShadow: '0 6px 16px -6px rgba(239,68,68,.5)' }
                      : a.variant === 'success'
                      ? { background: 'linear-gradient(135deg,#10b981,#0d9488)', boxShadow: '0 6px 16px -6px rgba(16,185,129,.5)' }
                      : undefined
                  }
                  onClick={() => a.onClick(selection)}
                >
                  <i className={`pi ${a.icon}`} /> {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export default ListPage
