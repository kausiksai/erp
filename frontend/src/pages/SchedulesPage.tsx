import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface ScheduleRow {
  schedule_id: number
  po_number: string
  supplier_name: string | null
  scheduled_date: string | null
  scheduled_quantity: number | null
  line_item: string | null
}

function SchedulesPage() {
  const [total, setTotal] = useState(0)
  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<ScheduleRow>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      const res = await apiFetch(`po-schedules?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load schedules'))
      const body = await res.json()
      const items: ScheduleRow[] = body.items || body.schedules || body || []
      const t = body.total ?? items.length
      setTotal(t)
      return { items, total: t }
    },
    []
  )

  const columns: ListPageColumn<ScheduleRow>[] = [
    { field: 'po_number', header: 'PO', body: (r) => <code style={{ fontSize: '0.82rem' }}>{r.po_number}</code> },
    { field: 'supplier_name', header: 'Supplier', body: (r) => r.supplier_name || '—' },
    { field: 'line_item', header: 'Item', body: (r) => r.line_item || '—' },
    {
      field: 'scheduled_date',
      header: 'Scheduled date',
      body: (r) => (r.scheduled_date ? new Date(r.scheduled_date).toLocaleDateString('en-IN') : '—')
    },
    {
      field: 'scheduled_quantity',
      header: 'Qty',
      body: (r) => <div style={{ textAlign: 'right', fontWeight: 600 }}>{r.scheduled_quantity ?? '—'}</div>,
      style: { textAlign: 'right' }
    }
  ]

  return (
    <ListPage<ScheduleRow>
      eyebrow="Documents"
      eyebrowIcon="pi-calendar"
      title="PO delivery schedules"
      subtitle="Planned delivery windows against each purchase order — used to flag late or off-schedule deliveries."
      kpis={[{ label: 'Schedule lines', value: total.toLocaleString('en-IN'), icon: 'pi-calendar', variant: 'emerald' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search PO, supplier, item…' }]}
      columns={columns}
      rowKey="schedule_id"
      fetchData={fetchData}
      emptyTitle="No schedules loaded"
      emptyBody="Drop a schedule Excel into the mailbox or upload via the PO upload page."
    />
  )
}

export default SchedulesPage
