import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import RowDetailsExpansion from '../components/RowDetailsExpansion'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatQty, formatINRSymbol, formatInt } from '../utils/format'

interface GRN {
  id: number
  grn_no: string | null
  grn_date: string | null
  grn_line: number | string | null
  po_id: number | null
  po_number: string | null
  po_no: string | null
  po_pfx: string | null
  supplier_name: string | null
  supplier: string | null
  dc_no: string | null
  dc_date: string | null
  item: string | null
  description_1: string | null
  uom: string | null
  grn_qty: number | string | null
  accepted_qty: number | string | null
  unit_cost: number | string | null
  header_status: string | null
  line_status: string | null
  gate_entry_no: string | null
  supplier_doc_no: string | null
  supplier_doc_date: string | null
  exchange_rate: number | string | null
  grn_year: string | number | null
  grn_period: string | number | null
  unit: string | null
}

interface GrnStats {
  total_lines: number
  unique_grn: number
  unique_pos: number
  unique_suppliers: number
  recent_count: number
}

function GRNPage() {
  const [stats, setStats] = useState<GrnStats>({
    total_lines: 0, unique_grn: 0, unique_pos: 0, unique_suppliers: 0, recent_count: 0
  })
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    apiFetch('grn/stats').then(async (res) => {
      if (res.ok) setStats(await res.json())
    }).catch(() => {})
  }, [reloadKey])

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<GRN>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('grnNo', p.search)
      const res = await apiFetch(`grn?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load GRN'))
      const body = await res.json()
      const items: GRN[] = body.items || []
      return { items, total: body.total ?? items.length }
    },
    []
  )

  const columns: ListPageColumn<GRN>[] = [
    {
      field: 'grn_no',
      header: 'GRN #',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.grn_no || '—'}</div>
          {r.grn_line != null && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Line {r.grn_line}</div>
          )}
        </div>
      )
    },
    { field: 'grn_date',   header: 'Date',     body: (r) => formatDate(r.grn_date) },
    {
      field: 'po_number',
      header: 'PO',
      body: (r) => {
        const po = r.po_number || r.po_no
        return po ? <code style={{ fontSize: '0.82rem' }}>{po}</code> : <span style={{ color: 'var(--text-muted)' }}>—</span>
      }
    },
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (r) => r.supplier_name || r.supplier || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'item',
      header: 'Item',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.item || '—'}</div>
          {r.description_1 && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.description_1}
            </div>
          )}
        </div>
      )
    },
    {
      field: 'grn_qty',
      header: 'Qty',
      body: (r) => (
        <div style={{ textAlign: 'right', fontWeight: 700 }}>
          {formatQty(r.grn_qty)}
          {r.uom && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '0.25rem', fontSize: '0.78rem' }}>{r.uom}</span>}
        </div>
      ),
      style: { textAlign: 'right' }
    },
    {
      field: 'unit_cost',
      header: 'Rate',
      body: (r) => <div style={{ textAlign: 'right', fontWeight: 600 }}>{formatINRSymbol(r.unit_cost)}</div>,
      style: { textAlign: 'right' }
    }
  ]

  return (
    <ListPage<GRN>
      eyebrow="Documents"
      eyebrowIcon="pi-box"
      title="Goods received notes"
      subtitle="Every GRN line captured against a purchase order. Click the expander for the full line details. Use Upload GRN Excel if email automation missed a batch."
      headerExtras={
        <ExcelUploadButton
          endpoint="grn/upload-excel"
          label="Upload GRN Excel"
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
        { label: 'Total GRN lines', value: formatInt(stats.total_lines),      icon: 'pi-list',       variant: 'brand',   sublabel: 'Across all data' },
        { label: 'Unique GRNs',     value: formatInt(stats.unique_grn),       icon: 'pi-box',        variant: 'emerald', sublabel: 'Distinct GRN numbers' },
        { label: 'POs covered',     value: formatInt(stats.unique_pos),       icon: 'pi-shopping-cart', variant: 'violet', sublabel: 'Distinct POs with GRN' },
        { label: 'Suppliers',       value: formatInt(stats.unique_suppliers), icon: 'pi-users',      variant: 'amber',   sublabel: 'Distinct vendors' },
        { label: 'Last 30 days',    value: formatInt(stats.recent_count),     icon: 'pi-calendar',   variant: 'rose',    sublabel: 'Recent GRN lines' }
      ]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search by GRN number…' }]}
      columns={columns}
      rowKey="id"
      fetchData={fetchData}
      reloadKey={reloadKey}
      rowExpansionTemplate={(r) => (
        <RowDetailsExpansion
          heroIcon="pi-box"
          heroColor="#f59e0b"
          heroEyebrow="Goods received note"
          heroTitle={`${r.grn_no || '—'}${r.grn_line != null ? ` · Line ${r.grn_line}` : ''}`}
          heroSubtitle={
            <>
              {r.supplier_name || r.supplier || '—'}
              {(r.po_number || r.po_no) && <> · PO <code>{r.po_number || r.po_no}</code></>}
              {r.grn_date && <> · {formatDate(r.grn_date)}</>}
            </>
          }
          heroRight={
            <>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
                GRN quantity
              </div>
              <div style={{ fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {formatQty(r.grn_qty)}
                {r.uom && <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginLeft: '0.3rem', fontSize: '0.85rem' }}>{r.uom}</span>}
              </div>
            </>
          }
          sections={[
            {
              icon: 'pi-id-card', color: '#6366f1', title: 'GRN header',
              fields: [
                { label: 'GRN number', value: r.grn_no },
                { label: 'GRN line',   value: r.grn_line },
                { label: 'GRN date',   value: formatDate(r.grn_date) },
                { label: 'Year',       value: r.grn_year },
                { label: 'Period',     value: r.grn_period },
                { label: 'Header status', value: r.header_status },
                { label: 'Line status',   value: r.line_status },
                { label: 'Gate entry #',  value: r.gate_entry_no },
                { label: 'Unit',       value: r.unit }
              ]
            },
            {
              icon: 'pi-shopping-cart', color: '#8b5cf6', title: 'Linked PO',
              fields: [
                { label: 'PO number', value: r.po_number || r.po_no },
                { label: 'PO prefix', value: r.po_pfx },
                { label: 'PO ID',     value: r.po_id }
              ]
            },
            {
              icon: 'pi-users', color: '#10b981', title: 'Supplier',
              fields: [
                { label: 'Supplier',         value: r.supplier_name || r.supplier },
                { label: 'Supplier doc #',   value: r.supplier_doc_no },
                { label: 'Supplier doc date',value: formatDate(r.supplier_doc_date) },
                { label: 'DC number',        value: r.dc_no },
                { label: 'DC date',          value: formatDate(r.dc_date) }
              ]
            },
            {
              icon: 'pi-cube', color: '#f59e0b', title: 'Item & quantities',
              fields: [
                { label: 'Item code',     value: r.item },
                { label: 'Description',   value: r.description_1 },
                { label: 'UOM',           value: r.uom },
                { label: 'GRN qty',       value: formatQty(r.grn_qty) },
                { label: 'Accepted qty',  value: formatQty(r.accepted_qty) },
                { label: 'Unit cost',     value: formatINRSymbol(r.unit_cost) },
                { label: 'Exchange rate', value: r.exchange_rate }
              ]
            }
          ]}
        />
      )}
      emptyTitle="No GRNs yet"
      emptyBody="Drop a GRN Excel into the email mailbox or use the Upload GRN Excel button above."
    />
  )
}

export default GRNPage
