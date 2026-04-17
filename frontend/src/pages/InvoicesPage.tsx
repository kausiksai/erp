import { useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatINRSymbol, formatDate, formatInt } from '../utils/format'
import { downloadCsv } from '../utils/exportCsv'

interface Invoice {
  invoice_id: number
  invoice_number: string
  supplier_name: string | null
  invoice_date: string | null
  po_number: string | null
  total_amount: string | number | null
  status: string | null
}

interface InvoiceStats {
  total: number
  validated: number
  waiting: number
  re_validation: number
  ready_for_payment: number
  paid: number
  exception_approval: number
  debit_note_approval: number
}

function InvoicesPage() {
  const navigate = useNavigate()

  // Overall KPIs — fetched once on mount from /invoices/stats. These numbers
  // reflect the *whole database*, not just the current page.
  const [stats, setStats] = useState<InvoiceStats>({
    total: 0,
    validated: 0,
    waiting: 0,
    re_validation: 0,
    ready_for_payment: 0,
    paid: 0,
    exception_approval: 0,
    debit_note_approval: 0
  })

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('invoices/stats')
        if (!res.ok) return
        const body = await res.json()
        if (alive) setStats(body)
      } catch {
        /* swallow — KPIs fall back to zero, list still works */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

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
      // /invoices now returns { items, total, limit, offset }
      const items: Invoice[] = Array.isArray(body) ? body : (body.items || [])
      const total = typeof body.total === 'number' ? body.total : items.length
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
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{formatDate(row.invoice_date)}</div>
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
      body: (row) =>
        row.po_number
          ? <code style={{ fontSize: '0.82rem' }}>{row.po_number}</code>
          : <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'total_amount',
      header: 'Amount',
      body: (row) => (
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', textAlign: 'right' }}>
          {formatINRSymbol(row.total_amount)}
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
      subtitle="Every bill flowing through the portal. Click the expander on any row to see the full invoice, PO, PO lines, GRN, ASN and validation details inline."
      primaryAction={{ label: 'Upload invoice', icon: 'pi-upload', onClick: () => navigate('/invoices/upload') }}
      secondaryActions={[{
        label: 'Export CSV',
        icon: 'pi-download',
        variant: 'ghost',
        onClick: async () => {
          try {
            const res = await apiFetch('invoices?limit=50000')
            if (!res.ok) return
            const body = await res.json()
            const rows = (body.items || body || []) as Record<string, unknown>[]
            downloadCsv(rows, 'invoices-export', [
              { key: 'invoice_number', header: 'Invoice #' },
              { key: 'invoice_date',   header: 'Date' },
              { key: 'supplier_name',  header: 'Supplier' },
              { key: 'po_number',      header: 'PO' },
              { key: 'total_amount',   header: 'Amount' },
              { key: 'status',         header: 'Status' }
            ])
          } catch { /* swallow */ }
        }
      }]}
      kpis={[
        { label: 'Total invoices',    value: formatInt(stats.total),              icon: 'pi-file',         variant: 'brand'   },
        { label: 'Validated',         value: formatInt(stats.validated),          icon: 'pi-check-circle', variant: 'emerald' },
        { label: 'Waiting',           value: formatInt(stats.waiting),            icon: 'pi-clock',        variant: 'amber'   },
        { label: 'Ready for payment', value: formatInt(stats.ready_for_payment),  icon: 'pi-wallet',       variant: 'violet'  }
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
      rowExpansionTemplate={(row) => (
        <InvoiceExpansion invoiceId={row.invoice_id} poNumber={row.po_number} />
      )}
      emptyTitle="No invoices yet"
      emptyBody="Upload your first invoice to start populating this view."
    />
  )
}

export default InvoicesPage
