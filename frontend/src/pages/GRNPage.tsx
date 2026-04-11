import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface GRN {
  grn_id: number
  grn_number: string
  grn_date: string | null
  po_number: string | null
  supplier_name: string | null
  received_quantity: number | null
  remarks: string | null
}

function GRNPage() {
  const [total, setTotal] = useState(0)
  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<GRN>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      const res = await apiFetch(`grn?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load GRN'))
      const body = await res.json()
      const items: GRN[] = body.items || body.grn || body || []
      const t = body.total ?? items.length
      setTotal(t)
      return { items, total: t }
    },
    []
  )

  const columns: ListPageColumn<GRN>[] = [
    { field: 'grn_number', header: 'GRN #', body: (r) => <strong>{r.grn_number}</strong> },
    { field: 'grn_date',   header: 'Date',  body: (r) => (r.grn_date ? new Date(r.grn_date).toLocaleDateString('en-IN') : '—') },
    { field: 'po_number',  header: 'PO',    body: (r) => (r.po_number ? <code style={{ fontSize: '0.82rem' }}>{r.po_number}</code> : '—') },
    { field: 'supplier_name', header: 'Supplier', body: (r) => r.supplier_name || '—' },
    {
      field: 'received_quantity',
      header: 'Qty received',
      body: (r) => <div style={{ textAlign: 'right', fontWeight: 600 }}>{r.received_quantity ?? '—'}</div>,
      style: { textAlign: 'right' }
    }
  ]

  return (
    <ListPage<GRN>
      eyebrow="Documents"
      eyebrowIcon="pi-box"
      title="Goods received notes"
      subtitle="Every GRN captured against a purchase order. GRN closes the receipt side of the PO loop."
      kpis={[{ label: 'Total GRNs', value: total.toLocaleString('en-IN'), icon: 'pi-box', variant: 'brand' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search GRN #, PO, supplier…' }]}
      columns={columns}
      rowKey="grn_id"
      fetchData={fetchData}
      emptyTitle="No GRNs yet"
      emptyBody="Upload GRN via Excel or the email mailbox to start tracking receipts."
    />
  )
}

export default GRNPage
