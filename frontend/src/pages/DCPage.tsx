import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface DC {
  dc_id: number
  dc_number: string
  dc_date: string | null
  po_number: string | null
  supplier_name: string | null
  quantity: number | null
  remarks: string | null
}

function DCPage() {
  const [total, setTotal] = useState(0)
  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<DC>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      const res = await apiFetch(`delivery-challans?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load DCs'))
      const body = await res.json()
      const items: DC[] = body.items || body.delivery_challans || body || []
      const t = body.total ?? items.length
      setTotal(t)
      return { items, total: t }
    },
    []
  )

  const columns: ListPageColumn<DC>[] = [
    { field: 'dc_number', header: 'DC #', body: (r) => <strong>{r.dc_number}</strong> },
    { field: 'dc_date',   header: 'Date', body: (r) => (r.dc_date ? new Date(r.dc_date).toLocaleDateString('en-IN') : '—') },
    { field: 'po_number', header: 'PO',   body: (r) => (r.po_number ? <code style={{ fontSize: '0.82rem' }}>{r.po_number}</code> : '—') },
    { field: 'supplier_name', header: 'Supplier', body: (r) => r.supplier_name || '—' },
    {
      field: 'quantity',
      header: 'Qty',
      body: (r) => <div style={{ textAlign: 'right', fontWeight: 600 }}>{r.quantity ?? '—'}</div>,
      style: { textAlign: 'right' }
    },
    { field: 'remarks', header: 'Remarks', body: (r) => r.remarks || '—' }
  ]

  return (
    <ListPage<DC>
      eyebrow="Documents"
      eyebrowIcon="pi-file-edit"
      title="Delivery challans"
      subtitle="Proof-of-dispatch documents handed over when goods leave the supplier."
      kpis={[{ label: 'Total DCs', value: total.toLocaleString('en-IN'), icon: 'pi-file-edit', variant: 'amber' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search DC #, PO, supplier…' }]}
      columns={columns}
      rowKey="dc_id"
      fetchData={fetchData}
      emptyTitle="No DCs yet"
      emptyBody="Delivery challans are ingested from the email mailbox or uploaded via Excel."
    />
  )
}

export default DCPage
