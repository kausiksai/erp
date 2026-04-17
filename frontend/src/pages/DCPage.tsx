import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import RowDetailsExpansion from '../components/RowDetailsExpansion'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatQty, formatInt } from '../utils/format'

interface DC {
  id: number
  dc_no: string | null
  dc_date: string | null
  dc_line: number | string | null
  po_id: number | null
  po_number: string | null
  ord_no: string | null
  ord_pfx: string | null
  ord_type: string | null
  supplier: string | null
  supplier_display_name: string | null
  item: string | null
  description: string | null
  uom: string | null
  dc_qty: number | string | null
  received_qty: number | string | null
  temp_qty: number | string | null
  unit: string | null
  unit_description: string | null
  rev: string | null
  revision: string | null
  sf_code: string | null
  dc_pfx: string | null
  source: string | null
  grn_pfx: string | null
  grn_no: string | null
  open_order_pfx: string | null
  open_order_no: string | null
  line_no: number | string | null
  suplr_dc_no: string | null
  suplr_dc_date: string | null
  material_type: string | null
  received_item: string | null
  received_item_rev: string | null
  received_item_uom: string | null
}

interface DcStats {
  total_lines: number
  unique_dc: number
  unique_pos: number
  unique_suppliers: number
  recent_count: number
}

function DCPage() {
  const [stats, setStats] = useState<DcStats>({
    total_lines: 0, unique_dc: 0, unique_pos: 0, unique_suppliers: 0, recent_count: 0
  })
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    apiFetch('delivery-challans/stats').then(async (res) => {
      if (res.ok) setStats(await res.json())
    }).catch(() => {})
  }, [reloadKey])

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<DC>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('dcNo', p.search)
      const res = await apiFetch(`delivery-challans?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load DCs'))
      const body = await res.json()
      const items: DC[] = body.items || []
      return { items, total: body.total ?? items.length }
    },
    []
  )

  const columns: ListPageColumn<DC>[] = [
    {
      field: 'dc_no',
      header: 'DC #',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.dc_no || '—'}</div>
          {r.dc_line != null && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Line {r.dc_line}</div>}
        </div>
      )
    },
    { field: 'dc_date', header: 'Date', body: (r) => formatDate(r.dc_date) },
    {
      field: 'po_number',
      header: 'PO',
      body: (r) => {
        const po = r.po_number || r.ord_no
        return po ? <code style={{ fontSize: '0.82rem' }}>{po}</code> : <span style={{ color: 'var(--text-muted)' }}>—</span>
      }
    },
    {
      field: 'supplier',
      header: 'Supplier',
      body: (r) => r.supplier_display_name || r.supplier || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'item',
      header: 'Item',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.item || '—'}</div>
          {r.description && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.description}
            </div>
          )}
        </div>
      )
    },
    {
      field: 'dc_qty',
      header: 'Qty',
      body: (r) => (
        <div style={{ textAlign: 'right', fontWeight: 700 }}>
          {formatQty(r.dc_qty)}
          {r.uom && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '0.25rem', fontSize: '0.78rem' }}>{r.uom}</span>}
        </div>
      ),
      style: { textAlign: 'right' }
    }
  ]

  return (
    <ListPage<DC>
      eyebrow="Documents"
      eyebrowIcon="pi-file-edit"
      title="Delivery challans"
      subtitle="Proof-of-dispatch documents handed over when goods leave the supplier. Click the expander for the full line details. Use Upload DC Excel if email automation missed a batch."
      headerExtras={
        <ExcelUploadButton
          endpoint="delivery-challans/upload-excel"
          label="Upload DC Excel"
          onSuccess={(message) => {
            setBanner({ tone: 'success', text: message })
            setReloadKey((k) => k + 1)
          }}
          onError={(message) => setBanner({ tone: 'danger', text: message })}
        />
      }
      banner={
        banner ? (
          <div className="glass-card" style={{ borderColor: `var(--status-${banner.tone}-ring)`, color: `var(--status-${banner.tone}-fg)` }}>
            <i className={`pi ${banner.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} /> {banner.text}
          </div>
        ) : null
      }
      kpis={[
        { label: 'Total DC lines', value: formatInt(stats.total_lines),      icon: 'pi-list',          variant: 'brand',   sublabel: 'Across all data' },
        { label: 'Unique DCs',     value: formatInt(stats.unique_dc),        icon: 'pi-file-edit',     variant: 'amber',   sublabel: 'Distinct DC numbers' },
        { label: 'POs covered',    value: formatInt(stats.unique_pos),       icon: 'pi-shopping-cart', variant: 'violet',  sublabel: 'Distinct POs with DC' },
        { label: 'Suppliers',      value: formatInt(stats.unique_suppliers), icon: 'pi-users',         variant: 'emerald', sublabel: 'Distinct vendors' },
        { label: 'Last 30 days',   value: formatInt(stats.recent_count),     icon: 'pi-calendar',      variant: 'rose',    sublabel: 'Recent DC lines' }
      ]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search by DC number…' }]}
      columns={columns}
      rowKey="id"
      fetchData={fetchData}
      reloadKey={reloadKey}
      rowExpansionTemplate={(r) => (
        <RowDetailsExpansion
          heroIcon="pi-file-edit"
          heroColor="#f59e0b"
          heroEyebrow="Delivery challan"
          heroTitle={`${r.dc_no || '—'}${r.dc_line != null ? ` · Line ${r.dc_line}` : ''}`}
          heroSubtitle={
            <>
              {r.supplier_display_name || r.supplier || '—'}
              {(r.po_number || r.ord_no) && <> · PO <code>{r.po_number || r.ord_no}</code></>}
              {r.dc_date && <> · {formatDate(r.dc_date)}</>}
            </>
          }
          heroRight={
            <>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
                DC quantity
              </div>
              <div style={{ fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {formatQty(r.dc_qty)}
                {r.uom && <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginLeft: '0.3rem', fontSize: '0.85rem' }}>{r.uom}</span>}
              </div>
            </>
          }
          sections={[
            {
              icon: 'pi-id-card', color: '#6366f1', title: 'DC header',
              fields: [
                { label: 'DC number',   value: r.dc_no },
                { label: 'DC prefix',   value: r.dc_pfx },
                { label: 'DC line',     value: r.dc_line },
                { label: 'DC date',     value: formatDate(r.dc_date) },
                { label: 'Source',      value: r.source },
                { label: 'Material type', value: r.material_type },
                { label: 'Unit',        value: r.unit },
                { label: 'Unit desc',   value: r.unit_description }
              ]
            },
            {
              icon: 'pi-shopping-cart', color: '#8b5cf6', title: 'Linked PO / order',
              fields: [
                { label: 'PO number',      value: r.po_number },
                { label: 'Order number',   value: r.ord_no },
                { label: 'Order prefix',   value: r.ord_pfx },
                { label: 'Order type',     value: r.ord_type },
                { label: 'Line number',    value: r.line_no },
                { label: 'Open order pfx', value: r.open_order_pfx },
                { label: 'Open order #',   value: r.open_order_no },
                { label: 'GRN prefix',     value: r.grn_pfx },
                { label: 'GRN number',     value: r.grn_no }
              ]
            },
            {
              icon: 'pi-users', color: '#10b981', title: 'Supplier',
              fields: [
                { label: 'Supplier',          value: r.supplier_display_name || r.supplier },
                { label: 'Supplier DC #',     value: r.suplr_dc_no },
                { label: 'Supplier DC date',  value: formatDate(r.suplr_dc_date) }
              ]
            },
            {
              icon: 'pi-cube', color: '#f43f5e', title: 'Item & quantities',
              fields: [
                { label: 'Item',           value: r.item },
                { label: 'Description',    value: r.description },
                { label: 'Revision',       value: r.rev || r.revision },
                { label: 'SF code',        value: r.sf_code },
                { label: 'UOM',            value: r.uom },
                { label: 'DC qty',         value: formatQty(r.dc_qty) },
                { label: 'Received qty',   value: formatQty(r.received_qty) },
                { label: 'Temp qty',       value: formatQty(r.temp_qty) },
                { label: 'Received item',  value: r.received_item },
                { label: 'Recv item rev',  value: r.received_item_rev },
                { label: 'Recv item UOM',  value: r.received_item_uom }
              ]
            }
          ]}
        />
      )}
      emptyTitle="No DCs yet"
      emptyBody="Drop a DC Excel into the email mailbox or use the Upload DC Excel button above."
    />
  )
}

export default DCPage
