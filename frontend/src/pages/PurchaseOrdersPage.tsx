import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import SlideOver from '../components/SlideOver'
import PoExpansion from '../components/PoExpansion'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatInt, formatINRSymbol, parseAmount } from '../utils/format'

/**
 * Purchase orders list — every PO ingested.
 *
 * Redesign: row click opens detail in the SlideOver introduced in Phase 1
 * (mirrors the Invoices list change). The full <PoExpansion> renders
 * unchanged inside the panel, so the rich header + line-items + linked
 * invoices content is preserved while the surrounding chrome moves to
 * the new pattern.
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
  /** PO total = sum(qty × unit_cost × (1 − disc%)). Added in Phase 4b4. */
  po_value?: string | number | null
  /** Sum of total_amount across invoices linked to this PO. */
  invoiced_amount?: string | number | null
}

type PoType = 'all' | 'open' | 'standard' | 'subcontract'

interface PoStats {
  total: number
  with_amendments: number
  unique_suppliers: number
  open_count: number
  fulfilled_count: number
  partial_count: number
  recent_count: number
}

function PurchaseOrdersPage() {
  const navigate = useNavigate()

  const [stats, setStats] = useState<PoStats>({
    total: 0,
    with_amendments: 0,
    unique_suppliers: 0,
    open_count: 0,
    fulfilled_count: 0,
    partial_count: 0,
    recent_count: 0
  })
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [openPo, setOpenPo] = useState<PurchaseOrder | null>(null)
  const [poType, setPoType] = useState<PoType>('all')

  const loadStats = useCallback(async () => {
    try {
      const res = await apiFetch('purchase-orders/stats')
      if (!res.ok) return
      const body = await res.json()
      setStats(body)
    } catch {
      /* silent — list still works */
    }
  }, [])

  useEffect(() => { loadStats() }, [loadStats, reloadKey])

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<PurchaseOrder>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('poNumber', p.search)
      if (p.filters.status) qs.set('status', p.filters.status)
      if (poType !== 'all') qs.set('type', poType)
      const res = await apiFetch(`purchase-orders?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load POs'))
      const body = await res.json()
      const items: PurchaseOrder[] = body.items || []
      const totalN = body.total ?? items.length
      return { items, total: totalN }
    },
    [poType]
  )

  const columns: ListPageColumn<PurchaseOrder>[] = [
    {
      field: 'po_number',
      header: 'PO #',
      body: (row) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{row.po_number}</div>
          <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.2rem', flexWrap: 'wrap' }}>
            {Number(row.amd_no || 0) > 0 && (
              <span style={{
                padding: '0.1rem 0.5rem', fontSize: '0.7rem', fontWeight: 700,
                borderRadius: 9999,
                background: 'var(--status-info-bg)', color: 'var(--status-info-fg)'
              }}>
                AMD {row.amd_no}
              </span>
            )}
            {row.pfx && (
              <span style={{
                padding: '0.1rem 0.5rem', fontSize: '0.68rem', fontWeight: 700,
                borderRadius: 9999,
                background: 'var(--status-muted-bg)', color: 'var(--status-muted-fg)'
              }}>
                {row.pfx}
              </span>
            )}
          </div>
        </div>
      )
    },
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (row) => row.supplier_name || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    { field: 'po_date', header: 'PO date', body: (row) => formatDate(row.po_date) },
    {
      field: 'unit',
      header: 'Unit',
      body: (row) => row.unit || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'line_item_count',
      header: 'Lines',
      body: (row) => (
        <div style={{ textAlign: 'right', fontWeight: 700 }}>
          {formatInt(row.line_item_count)}
        </div>
      ),
      style: { textAlign: 'right' }
    },
    {
      field: 'po_value',
      header: 'Consumption',
      body: (row) => {
        const value = parseAmount(row.po_value) ?? 0
        const invoiced = parseAmount(row.invoiced_amount) ?? 0
        if (value <= 0) {
          return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)' }}>—</div>
        }
        const pct = Math.min(100, Math.round((invoiced / value) * 100))
        // Color band: green when fully consumed, amber 30–99, blue otherwise.
        const color =
          pct >= 100 ? 'linear-gradient(90deg,#10b981,#14b8a6)' :
          pct >= 30  ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' :
                       'linear-gradient(90deg,#3b82f6,#06b6d4)'
        return (
          <div style={{ minWidth: 160 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{formatINRSymbol(invoiced)}</span>
              <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
            </div>
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: color }} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
              of {formatINRSymbol(value)}
            </div>
          </div>
        )
      },
      style: { minWidth: 180 }
    },
    {
      field: 'status',
      header: 'Status',
      body: (row) => <StatusChip status={row.status} />
    }
  ]

  return (
    <>
      <ListPage<PurchaseOrder>
        eyebrow="Documents"
        eyebrowIcon="pi-shopping-cart"
        title="Purchase orders"
        subtitle="Every PO ingested. Click any row to open detail in a side panel — your filters stay in place."
        headerExtras={
          <ExcelUploadButton
            endpoint="purchase-orders/upload-excel"
            label="Upload PO Excel"
            onSuccess={(message) => {
              setBanner({ tone: 'success', text: message })
              setReloadKey((k) => k + 1)
            }}
            onError={(message) => setBanner({ tone: 'danger', text: message })}
          />
        }
        banner={
          banner ? (
            <div
              className="glass-card"
              style={{
                borderColor: `var(--status-${banner.tone}-ring)`,
                color: `var(--status-${banner.tone}-fg)`
              }}
            >
              <i className={`pi ${banner.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} /> {banner.text}
            </div>
          ) : null
        }
        kpis={[
          { label: 'Total POs',       value: formatInt(stats.total),            icon: 'pi-shopping-cart', variant: 'brand',   sublabel: 'Across all data' },
          { label: 'With amendments', value: formatInt(stats.with_amendments),  icon: 'pi-refresh',       variant: 'amber',   sublabel: 'Amended at least once' },
          { label: 'Suppliers',       value: formatInt(stats.unique_suppliers), icon: 'pi-users',         variant: 'violet',  sublabel: 'Distinct vendors' },
          { label: 'Open',            value: formatInt(stats.open_count),       icon: 'pi-clock',         variant: 'slate',   sublabel: 'Active / not closed' },
          { label: 'Fulfilled',       value: formatInt(stats.fulfilled_count),  icon: 'pi-check-circle',  variant: 'emerald', sublabel: 'Completed' }
        ]}
        chipRow={
          <div className="view-chips" style={{ marginBottom: 'var(--space-3)' }}>
            <span className="view-chips__label">Type:</span>
            {([
              { k: 'all',         l: 'All' },
              { k: 'open',        l: 'Open / blanket' },
              { k: 'standard',    l: 'Standard' },
              { k: 'subcontract', l: 'Subcontract' }
            ] as Array<{ k: PoType; l: string }>).map(({ k, l }) => (
              <button
                key={k}
                type="button"
                className={`view-chip ${poType === k ? 'view-chip--active' : ''}`}
                onClick={() => setPoType(k)}
              >
                <span>{l}</span>
              </button>
            ))}
          </div>
        }
        filters={[
          { key: 'search', type: 'search', placeholder: 'Search by PO number…' },
          {
            key: 'status', type: 'select', placeholder: 'All statuses',
            options: [
              { label: 'Open',                value: 'open' },
              { label: 'Partially fulfilled', value: 'partially_fulfilled' },
              { label: 'Fulfilled',           value: 'fulfilled' },
              { label: 'Closed',              value: 'closed' }
            ]
          }
        ]}
        columns={columns}
        rowKey="po_id"
        fetchData={fetchData}
        reloadKey={reloadKey}
        onRowClick={(row) => setOpenPo(row)}
        emptyTitle="No POs ingested yet"
        emptyBody="Drop POs into the email mailbox or use the Upload PO Excel button above."
      />

      <SlideOver
        open={!!openPo}
        onClose={() => setOpenPo(null)}
        title={openPo ? `Purchase order ${openPo.po_number}` : 'Purchase order'}
        headerActions={
          openPo && (
            <button
              type="button"
              className="action-btn action-btn--ghost"
              style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)' }}
              onClick={() => {
                navigate(`/purchase-orders?poNumber=${encodeURIComponent(openPo.po_number)}`)
                setOpenPo(null)
              }}
              title="View in list with filter"
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
