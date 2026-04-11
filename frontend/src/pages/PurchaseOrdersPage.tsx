import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface PurchaseOrder {
  po_id: number
  po_number: string
  supplier_name: string | null
  po_date: string | null
  po_value: number | null
  status: string | null
  amendment_no: number | null
  is_latest_amendment?: boolean
}

const INR = (n: number | null | undefined) =>
  typeof n === 'number' ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'

function PurchaseOrdersPage() {
  const [total, setTotal] = useState(0)
  const [withAmend, setWithAmend] = useState(0)
  const [totalValue, setTotalValue] = useState(0)

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<PurchaseOrder>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      if (p.filters.status) qs.set('status', p.filters.status)
      const res = await apiFetch(`purchase-orders?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load POs'))
      const body = await res.json()
      const items: PurchaseOrder[] = body.items || body.purchase_orders || body || []
      const totalN = body.total ?? items.length
      setTotal(totalN)
      setWithAmend(items.filter((i) => (i.amendment_no ?? 0) > 0).length)
      setTotalValue(items.reduce((s, i) => s + (i.po_value || 0), 0))
      return { items, total: totalN }
    },
    []
  )

  const columns: ListPageColumn<PurchaseOrder>[] = [
    {
      field: 'po_number',
      header: 'PO #',
      body: (row) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{row.po_number}</div>
          {(row.amendment_no ?? 0) > 0 && (
            <span style={{
              display: 'inline-block', marginTop: '0.2rem',
              padding: '0.1rem 0.5rem', fontSize: '0.7rem', fontWeight: 700,
              borderRadius: 9999,
              background: 'var(--status-info-bg)', color: 'var(--status-info-fg)'
            }}>
              AMD {row.amendment_no}
            </span>
          )}
        </div>
      )
    },
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (row) => row.supplier_name || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'po_date',
      header: 'PO date',
      body: (row) => (row.po_date ? new Date(row.po_date).toLocaleDateString('en-IN') : '—')
    },
    {
      field: 'po_value',
      header: 'Value',
      body: (row) => (
        <div style={{ fontWeight: 700, textAlign: 'right' }}>₹{INR(row.po_value)}</div>
      ),
      style: { textAlign: 'right' }
    },
    {
      field: 'status',
      header: 'Status',
      body: (row) => <StatusChip status={row.status} />
    }
  ]

  return (
    <ListPage<PurchaseOrder>
      eyebrow="Documents"
      eyebrowIcon="pi-shopping-cart"
      title="Purchase orders"
      subtitle="Every PO we've ingested — including amended versions. The latest amendment of each base PO drives validation."
      kpis={[
        { label: 'Total POs',        value: total.toLocaleString('en-IN'),     icon: 'pi-shopping-cart', variant: 'brand'   },
        { label: 'With amendments',  value: withAmend.toLocaleString('en-IN'), icon: 'pi-refresh',       variant: 'amber'   },
        { label: 'Value on screen',  value: `₹${INR(totalValue)}`,             icon: 'pi-indian-rupee',  variant: 'emerald' }
      ]}
      filters={[
        { key: 'search', type: 'search', placeholder: 'Search PO #, supplier…' },
        {
          key: 'status', type: 'select', placeholder: 'All statuses',
          options: [
            { label: 'Open', value: 'open' },
            { label: 'Partially fulfilled', value: 'partially_fulfilled' },
            { label: 'Fulfilled', value: 'fulfilled' },
            { label: 'Closed', value: 'closed' }
          ]
        }
      ]}
      columns={columns}
      rowKey="po_id"
      fetchData={fetchData}
      emptyTitle="No POs ingested yet"
      emptyBody="Once you drop POs into the email mailbox or upload them via Excel, they'll appear here."
    />
  )
}

export default PurchaseOrdersPage
