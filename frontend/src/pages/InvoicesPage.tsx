import { useNavigate } from 'react-router-dom'
import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface Invoice {
  invoice_id: number
  invoice_number: string
  supplier_name: string
  invoice_date: string | null
  po_number: string | null
  total_amount: number | null
  status: string | null
  priority?: string | null
}

const INR = (n: number | null | undefined) =>
  typeof n === 'number'
    ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—'

function InvoicesPage() {
  const navigate = useNavigate()
  const [kpis, setKpis] = useState<{
    total: number
    validated: number
    waiting: number
    ready: number
  }>({ total: 0, validated: 0, waiting: 0, ready: 0 })

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<Invoice>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      if (p.filters.status) qs.set('status', p.filters.status)
      const res = await apiFetch(`invoices?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load invoices'))
      const body = await res.json()
      const items: Invoice[] = body.items || body.invoices || body || []
      const total = body.total ?? items.length
      // derive KPIs from response if available
      setKpis({
        total,
        validated: body.stats?.validated ?? items.filter((i) => i.status === 'validated').length,
        waiting:   body.stats?.waiting   ?? items.filter((i) => i.status === 'waiting_for_validation').length,
        ready:     body.stats?.ready     ?? items.filter((i) => i.status === 'ready_for_payment').length
      })
      return { items, total }
    },
    []
  )

  const columns: ListPageColumn<Invoice>[] = [
    {
      field: 'invoice_number',
      header: 'Invoice #',
      body: (row) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{row.invoice_number}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {row.invoice_date ? new Date(row.invoice_date).toLocaleDateString('en-IN') : '—'}
          </div>
        </div>
      )
    },
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (row) => (
        <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          {row.supplier_name || <span style={{ color: 'var(--text-muted)' }}>—</span>}
        </div>
      )
    },
    {
      field: 'po_number',
      header: 'PO',
      body: (row) => (row.po_number ? <code style={{ fontSize: '0.82rem' }}>{row.po_number}</code> : <span style={{ color: 'var(--text-muted)' }}>—</span>)
    },
    {
      field: 'total_amount',
      header: 'Amount',
      body: (row) => (
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', textAlign: 'right' }}>
          ₹{INR(row.total_amount)}
        </div>
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
    <ListPage<Invoice>
      eyebrow="Workflow"
      eyebrowIcon="pi-file"
      title="Invoices"
      subtitle="Every bill flowing through the portal — validated, pending, paid. Click any row for full details."
      primaryAction={{ label: 'Upload invoice', icon: 'pi-upload', onClick: () => navigate('/invoices/upload') }}
      kpis={[
        { label: 'Total invoices',        value: kpis.total.toLocaleString('en-IN'),     icon: 'pi-file',         variant: 'brand'   },
        { label: 'Validated',             value: kpis.validated.toLocaleString('en-IN'), icon: 'pi-check-circle', variant: 'emerald' },
        { label: 'Waiting for validation',value: kpis.waiting.toLocaleString('en-IN'),   icon: 'pi-clock',        variant: 'amber'   },
        { label: 'Ready for payment',     value: kpis.ready.toLocaleString('en-IN'),     icon: 'pi-wallet',       variant: 'violet'  }
      ]}
      filters={[
        { key: 'search', type: 'search', placeholder: 'Search invoice #, supplier, PO…' },
        {
          key: 'status',
          type: 'select',
          placeholder: 'All statuses',
          options: [
            { label: 'Waiting for validation', value: 'waiting_for_validation' },
            { label: 'Validated',              value: 'validated' },
            { label: 'Re-validation',          value: 'waiting_for_re_validation' },
            { label: 'Exception approval',     value: 'exception_approval' },
            { label: 'Debit note approval',    value: 'debit_note_approval' },
            { label: 'Ready for payment',      value: 'ready_for_payment' },
            { label: 'Paid',                   value: 'paid' }
          ]
        }
      ]}
      columns={columns}
      rowKey="invoice_id"
      fetchData={fetchData}
      onRowClick={(row) => navigate(`/invoices/validate/${row.invoice_id}`)}
      emptyTitle="No invoices yet"
      emptyBody="Upload your first invoice to start populating this view."
    />
  )
}

export default InvoicesPage
