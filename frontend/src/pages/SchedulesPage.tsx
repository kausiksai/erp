import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import RowDetailsExpansion from '../components/RowDetailsExpansion'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatQty, formatInt } from '../utils/format'

interface ScheduleRow {
  id: number
  po_number: string | null
  linked_po_number: string | null
  ord_no: string | null
  ord_pfx: string | null
  schedule_ref: string | null
  ss_pfx: string | null
  ss_no: string | null
  line_no: number | string | null
  item_id: string | null
  item_rev: string | null
  description: string | null
  supplier_name: string | null
  supplier: string | null
  sched_qty: number | string | null
  sched_date: string | null
  promise_date: string | null
  required_date: string | null
  date_from: string | null
  date_to: string | null
  status: string | null
  uom: string | null
  unit: string | null
  firm: string | null
  tentative: string | null
  closeshort: string | null
  doc_pfx: string | null
  doc_no: string | null
}

interface ScheduleStats {
  total_lines: number
  unique_pos: number
  unique_suppliers: number
  upcoming_count: number
  past_due_count: number
}

function SchedulesPage() {
  const [stats, setStats] = useState<ScheduleStats>({
    total_lines: 0, unique_pos: 0, unique_suppliers: 0, upcoming_count: 0, past_due_count: 0
  })
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    apiFetch('po-schedules/stats').then(async (res) => {
      if (res.ok) setStats(await res.json())
    }).catch(() => {})
  }, [reloadKey])

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<ScheduleRow>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('poNumber', p.search)
      const res = await apiFetch(`po-schedules?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load schedules'))
      const body = await res.json()
      const items: ScheduleRow[] = body.items || []
      return { items, total: body.total ?? items.length }
    },
    []
  )

  const columns: ListPageColumn<ScheduleRow>[] = [
    {
      field: 'po_number',
      header: 'PO',
      body: (r) => {
        const po = r.linked_po_number || r.po_number || r.ord_no
        return po ? <code style={{ fontSize: '0.82rem' }}>{po}</code> : <span style={{ color: 'var(--text-muted)' }}>—</span>
      }
    },
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (r) => r.supplier_name || r.supplier || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'item_id',
      header: 'Item',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.item_id || '—'}</div>
          {r.description && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.description}
            </div>
          )}
        </div>
      )
    },
    {
      field: 'sched_date',
      header: 'Schedule',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{formatDate(r.sched_date || r.promise_date || r.required_date)}</div>
          {(r.date_from || r.date_to) && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {formatDate(r.date_from)} → {formatDate(r.date_to)}
            </div>
          )}
        </div>
      )
    },
    {
      field: 'sched_qty',
      header: 'Qty',
      body: (r) => (
        <div style={{ textAlign: 'right', fontWeight: 700 }}>
          {formatQty(r.sched_qty)}
          {r.uom && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '0.25rem', fontSize: '0.78rem' }}>{r.uom}</span>}
        </div>
      ),
      style: { textAlign: 'right' }
    },
    { field: 'status', header: 'Status', body: (r) => <StatusChip status={r.status} /> }
  ]

  return (
    <ListPage<ScheduleRow>
      eyebrow="Documents"
      eyebrowIcon="pi-calendar"
      title="PO delivery schedules"
      subtitle="Planned delivery windows against each PO — click the expander for the full details. Use Upload Schedule Excel if email automation missed a batch."
      headerExtras={
        <ExcelUploadButton
          endpoint="po-schedules/upload-excel"
          label="Upload Schedule Excel"
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
        { label: 'Schedule lines',  value: formatInt(stats.total_lines),      icon: 'pi-list',          variant: 'brand',   sublabel: 'Across all data' },
        { label: 'POs covered',     value: formatInt(stats.unique_pos),       icon: 'pi-shopping-cart', variant: 'emerald', sublabel: 'Distinct POs scheduled' },
        { label: 'Suppliers',       value: formatInt(stats.unique_suppliers), icon: 'pi-users',         variant: 'violet',  sublabel: 'Distinct vendors' },
        { label: 'Upcoming',        value: formatInt(stats.upcoming_count),   icon: 'pi-calendar-plus', variant: 'amber',   sublabel: 'Future scheduled lines' },
        { label: 'Past due',        value: formatInt(stats.past_due_count),   icon: 'pi-clock',         variant: 'rose',    sublabel: 'Due date in the past' }
      ]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search by PO number…' }]}
      columns={columns}
      rowKey="id"
      fetchData={fetchData}
      reloadKey={reloadKey}
      rowExpansionTemplate={(r) => (
        <RowDetailsExpansion
          heroIcon="pi-calendar"
          heroColor="#06b6d4"
          heroEyebrow="PO schedule line"
          heroTitle={`${r.linked_po_number || r.po_number || r.ord_no || '—'}${r.line_no != null ? ` · Line ${r.line_no}` : ''}`}
          heroSubtitle={
            <>
              {r.supplier_name || r.supplier || '—'}
              {r.item_id && <> · Item <code>{r.item_id}</code></>}
            </>
          }
          heroRight={
            <>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
                Scheduled qty
              </div>
              <div style={{ fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {formatQty(r.sched_qty)}
                {r.uom && <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginLeft: '0.3rem', fontSize: '0.85rem' }}>{r.uom}</span>}
              </div>
              {r.status && <div style={{ marginTop: '0.2rem' }}><StatusChip status={r.status} /></div>}
            </>
          }
          sections={[
            {
              icon: 'pi-id-card', color: '#6366f1', title: 'Schedule header',
              fields: [
                { label: 'Schedule ref', value: r.schedule_ref },
                { label: 'SS prefix',    value: r.ss_pfx },
                { label: 'SS number',    value: r.ss_no },
                { label: 'Line number',  value: r.line_no },
                { label: 'Doc prefix',   value: r.doc_pfx },
                { label: 'Doc number',   value: r.doc_no },
                { label: 'Unit',         value: r.unit },
                { label: 'Status',       value: r.status }
              ]
            },
            {
              icon: 'pi-shopping-cart', color: '#8b5cf6', title: 'Linked PO',
              fields: [
                { label: 'Linked PO',       value: r.linked_po_number },
                { label: 'PO number',       value: r.po_number },
                { label: 'Order number',    value: r.ord_no },
                { label: 'Order prefix',    value: r.ord_pfx }
              ]
            },
            {
              icon: 'pi-users', color: '#10b981', title: 'Supplier',
              fields: [
                { label: 'Supplier', value: r.supplier_name || r.supplier }
              ]
            },
            {
              icon: 'pi-cube', color: '#f59e0b', title: 'Item & quantity',
              fields: [
                { label: 'Item ID',      value: r.item_id },
                { label: 'Item revision',value: r.item_rev },
                { label: 'Description',  value: r.description },
                { label: 'UOM',          value: r.uom },
                { label: 'Scheduled qty',value: formatQty(r.sched_qty) }
              ]
            },
            {
              icon: 'pi-calendar', color: '#f43f5e', title: 'Dates & flags',
              fields: [
                { label: 'Schedule date', value: formatDate(r.sched_date) },
                { label: 'Promise date',  value: formatDate(r.promise_date) },
                { label: 'Required date', value: formatDate(r.required_date) },
                { label: 'Date from',     value: formatDate(r.date_from) },
                { label: 'Date to',       value: formatDate(r.date_to) },
                { label: 'Firm',          value: r.firm },
                { label: 'Tentative',     value: r.tentative },
                { label: 'Close short',   value: r.closeshort }
              ]
            }
          ]}
        />
      )}
      emptyTitle="No schedules loaded"
      emptyBody="Drop a schedule Excel into the email mailbox or use the Upload Schedule Excel button above."
    />
  )
}

export default SchedulesPage
