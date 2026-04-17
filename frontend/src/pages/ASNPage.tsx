import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import RowDetailsExpansion from '../components/RowDetailsExpansion'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatQty, formatInt } from '../utils/format'

interface ASN {
  id: number
  asn_no: string | null
  po_number: string | null
  po_no: string | null
  po_pfx: string | null
  supplier_name: string | null
  supplier: string | null
  dc_no: string | null
  dc_date: string | null
  inv_no: string | null
  inv_date: string | null
  lr_no: string | null
  lr_date: string | null
  transporter: string | null
  transporter_name: string | null
  doc_no_date: string | null
  unit: string | null
  status: string | null
  item_code: string | null
  item_desc: string | null
  quantity: number | string | null
  schedule_pfx: string | null
  schedule_no: string | null
  grn_status: string | null
}

interface AsnStats {
  total_lines: number
  unique_asn: number
  unique_pos: number
  unique_transporters: number
  recent_count: number
}

function ASNPage() {
  const [stats, setStats] = useState<AsnStats>({
    total_lines: 0, unique_asn: 0, unique_pos: 0, unique_transporters: 0, recent_count: 0
  })
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    apiFetch('asn/stats').then(async (res) => {
      if (res.ok) setStats(await res.json())
    }).catch(() => {})
  }, [reloadKey])

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<ASN>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('asnNo', p.search)
      const res = await apiFetch(`asn?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load ASN'))
      const body = await res.json()
      const items: ASN[] = body.items || []
      return { items, total: body.total ?? items.length }
    },
    []
  )

  const columns: ListPageColumn<ASN>[] = [
    {
      field: 'asn_no',
      header: 'ASN #',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.asn_no || '—'}</div>
          {r.inv_no && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Inv {r.inv_no}</div>}
        </div>
      )
    },
    { field: 'dc_date', header: 'DC date', body: (r) => formatDate(r.dc_date) },
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
      field: 'item_code',
      header: 'Item',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.item_code || '—'}</div>
          {r.item_desc && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.item_desc}</div>}
        </div>
      )
    },
    {
      field: 'transporter_name',
      header: 'Transport',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.transporter_name || r.transporter || '—'}</div>
          {r.lr_no && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>LR {r.lr_no}</div>}
        </div>
      )
    },
    {
      field: 'quantity',
      header: 'Qty',
      body: (r) => <div style={{ textAlign: 'right', fontWeight: 700 }}>{formatQty(r.quantity)}</div>,
      style: { textAlign: 'right' }
    },
    { field: 'status', header: 'Status', body: (r) => <StatusChip status={r.status} /> }
  ]

  return (
    <ListPage<ASN>
      eyebrow="Documents"
      eyebrowIcon="pi-truck"
      title="Advance shipment notices"
      subtitle="ASNs tell you what's in transit — click the expander for the full shipment details. Use Upload ASN Excel if email automation missed a batch."
      headerExtras={
        <ExcelUploadButton
          endpoint="asn/upload-excel"
          label="Upload ASN Excel"
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
        { label: 'Total ASN lines', value: formatInt(stats.total_lines),         icon: 'pi-list',          variant: 'brand',   sublabel: 'Across all data' },
        { label: 'Unique ASNs',     value: formatInt(stats.unique_asn),          icon: 'pi-truck',         variant: 'violet',  sublabel: 'Distinct ASN numbers' },
        { label: 'POs covered',     value: formatInt(stats.unique_pos),          icon: 'pi-shopping-cart', variant: 'emerald', sublabel: 'Distinct POs with ASN' },
        { label: 'Transporters',    value: formatInt(stats.unique_transporters), icon: 'pi-users',         variant: 'amber',   sublabel: 'Distinct transporters' },
        { label: 'Last 30 days',    value: formatInt(stats.recent_count),        icon: 'pi-calendar',      variant: 'rose',    sublabel: 'Recent ASN lines' }
      ]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search by ASN number…' }]}
      columns={columns}
      rowKey="id"
      fetchData={fetchData}
      reloadKey={reloadKey}
      rowExpansionTemplate={(r) => (
        <RowDetailsExpansion
          heroIcon="pi-truck"
          heroColor="#8b5cf6"
          heroEyebrow="Advance shipment notice"
          heroTitle={r.asn_no || '—'}
          heroSubtitle={
            <>
              {r.supplier_name || r.supplier || '—'}
              {(r.po_number || r.po_no) && <> · PO <code>{r.po_number || r.po_no}</code></>}
              {r.dc_date && <> · DC {formatDate(r.dc_date)}</>}
            </>
          }
          heroRight={
            <>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
                Quantity
              </div>
              <div style={{ fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {formatQty(r.quantity)}
              </div>
              {r.status && <div style={{ marginTop: '0.2rem' }}><StatusChip status={r.status} /></div>}
            </>
          }
          sections={[
            {
              icon: 'pi-id-card', color: '#6366f1', title: 'ASN header',
              fields: [
                { label: 'ASN number', value: r.asn_no },
                { label: 'Status',     value: r.status },
                { label: 'GRN status', value: r.grn_status },
                { label: 'Unit',       value: r.unit }
              ]
            },
            {
              icon: 'pi-shopping-cart', color: '#10b981', title: 'Linked documents',
              fields: [
                { label: 'PO number',     value: r.po_number || r.po_no },
                { label: 'PO prefix',     value: r.po_pfx },
                { label: 'Schedule #',    value: r.schedule_no },
                { label: 'Schedule pfx',  value: r.schedule_pfx },
                { label: 'DC number',     value: r.dc_no },
                { label: 'DC date',       value: formatDate(r.dc_date) },
                { label: 'Invoice #',     value: r.inv_no },
                { label: 'Invoice date',  value: formatDate(r.inv_date) },
                { label: 'Doc no / date', value: r.doc_no_date }
              ]
            },
            {
              icon: 'pi-truck', color: '#f59e0b', title: 'Transport',
              fields: [
                { label: 'Transporter',     value: r.transporter_name || r.transporter },
                { label: 'LR number',       value: r.lr_no },
                { label: 'LR date',         value: formatDate(r.lr_date) }
              ]
            },
            {
              icon: 'pi-cube', color: '#f43f5e', title: 'Item & quantity',
              fields: [
                { label: 'Item code',   value: r.item_code },
                { label: 'Item desc',   value: r.item_desc },
                { label: 'Quantity',    value: formatQty(r.quantity) }
              ]
            },
            {
              icon: 'pi-users', color: '#06b6d4', title: 'Supplier',
              fields: [
                { label: 'Supplier', value: r.supplier_name || r.supplier }
              ]
            }
          ]}
        />
      )}
      emptyTitle="No ASNs yet"
      emptyBody="Drop an ASN Excel into the email mailbox or use the Upload ASN Excel button above."
    />
  )
}

export default ASNPage
