import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface ASN {
  asn_id: number
  asn_number: string
  asn_date: string | null
  po_number: string | null
  supplier_name: string | null
  dispatch_quantity: number | null
  transporter: string | null
  vehicle_no: string | null
}

function ASNPage() {
  const [total, setTotal] = useState(0)
  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<ASN>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      const res = await apiFetch(`asn?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load ASN'))
      const body = await res.json()
      const items: ASN[] = body.items || body.asn || body || []
      const t = body.total ?? items.length
      setTotal(t)
      return { items, total: t }
    },
    []
  )

  const columns: ListPageColumn<ASN>[] = [
    { field: 'asn_number', header: 'ASN #', body: (r) => <strong>{r.asn_number}</strong> },
    { field: 'asn_date',   header: 'Date',  body: (r) => (r.asn_date ? new Date(r.asn_date).toLocaleDateString('en-IN') : '—') },
    { field: 'po_number',  header: 'PO',    body: (r) => (r.po_number ? <code style={{ fontSize: '0.82rem' }}>{r.po_number}</code> : '—') },
    { field: 'supplier_name', header: 'Supplier', body: (r) => r.supplier_name || '—' },
    { field: 'transporter', header: 'Transporter', body: (r) => r.transporter || '—' },
    { field: 'vehicle_no', header: 'Vehicle', body: (r) => r.vehicle_no || '—' },
    {
      field: 'dispatch_quantity',
      header: 'Qty',
      body: (r) => <div style={{ textAlign: 'right', fontWeight: 600 }}>{r.dispatch_quantity ?? '—'}</div>,
      style: { textAlign: 'right' }
    }
  ]

  return (
    <ListPage<ASN>
      eyebrow="Documents"
      eyebrowIcon="pi-truck"
      title="Advance shipment notices"
      subtitle="ASNs tell you what's in transit — the bridge between dispatch and goods receipt."
      kpis={[{ label: 'Total ASNs', value: total.toLocaleString('en-IN'), icon: 'pi-truck', variant: 'violet' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search ASN #, PO, supplier, vehicle…' }]}
      columns={columns}
      rowKey="asn_id"
      fetchData={fetchData}
      emptyTitle="No ASNs yet"
      emptyBody="ASNs arrive automatically from the email mailbox or can be uploaded via Excel."
    />
  )
}

export default ASNPage
