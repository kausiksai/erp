import { useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import StatusChip from '../components/StatusChip'
import SlideOver from '../components/SlideOver'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatINRSymbol, formatDate, formatInt } from '../utils/format'
import { downloadCsv } from '../utils/exportCsv'

/**
 * Invoices list — every bill flowing through the portal.
 *
 * Redesign change: clicking a row opens detail in a right-side slide-over,
 * so the user keeps their filter context and place in the list. The legacy
 * <InvoiceExpansion> renders inside the slide-over unchanged — the rich
 * 6-tab detail (Overview / Lines / PO / GRN+ASN / Validation / Attachments)
 * is preserved while the surrounding UX moves to the new pattern.
 */

interface Invoice {
  invoice_id: number
  invoice_number: string
  supplier_name: string | null
  invoice_date: string | null
  po_number: string | null
  total_amount: string | number | null
  status: string | null
  source?: 'excel' | 'ocr' | 'both' | null
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

  // KPIs reflect the whole DB, not the current page.
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

  // The slide-over panel. We keep the row data so the title and meta can
  // render without a second fetch — InvoiceExpansion handles its own load.
  const [openInv, setOpenInv] = useState<Invoice | null>(null)

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
    return () => { alive = false }
  }, [])

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<Invoice>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      if (p.filters.status) qs.set('status', p.filters.status)
      if (p.filters.source) qs.set('source', p.filters.source)
      const res = await apiFetch(`invoices?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load invoices'))
      const body = await res.json()
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
      field: 'source',
      header: 'Source',
      body: (row) => {
        if (row.source === 'ocr')   return <StatusChip status="ocr"   variant="violet" label="OCR" />
        if (row.source === 'excel') return <StatusChip status="excel" variant="info"   label="Excel" />
        if (row.source === 'both')  return <StatusChip status="both"  variant="success" label="Excel + OCR" />
        return <span style={{ color: 'var(--text-muted)' }}>—</span>
      }
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
    <>
      <ListPage<Invoice>
        eyebrow="Workflow"
        eyebrowIcon="pi-file"
        title="Invoices"
        subtitle="Every bill flowing through the portal. Click any row to open detail in a side panel — your filters stay in place."
        primaryAction={{
          label: 'Upload invoice',
          icon: 'pi-upload',
          onClick: () => navigate('/invoices/upload')
        }}
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
                { key: 'source',         header: 'Source' },
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
          },
          {
            key: 'source',
            type: 'select',
            placeholder: 'All sources',
            options: [
              { label: 'Excel (Bill Register)', value: 'excel' },
              { label: 'OCR (PDF)',             value: 'ocr' },
              { label: 'Both',                  value: 'both' }
            ]
          }
        ]}
        columns={columns}
        rowKey="invoice_id"
        fetchData={fetchData}
        // Row click opens the slide-over. Note: ListPage.onRowClick already
        // ignores clicks on the row-toggler (irrelevant now since we pass
        // no rowExpansionTemplate); the whole row is clickable.
        onRowClick={(row) => setOpenInv(row)}
        emptyTitle="No invoices yet"
        emptyBody="Upload your first invoice to start populating this view."
      />

      <SlideOver
        open={!!openInv}
        onClose={() => setOpenInv(null)}
        title={openInv ? `Invoice ${openInv.invoice_number}` : 'Invoice'}
        headerActions={
          openInv && (
            <button
              type="button"
              className="action-btn action-btn--ghost"
              style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)' }}
              onClick={() => {
                navigate(`/invoices/validate/${openInv.invoice_id}`)
                setOpenInv(null)
              }}
              title="Open in full page"
            >
              <i className="pi pi-external-link" /> Open full
            </button>
          )
        }
      >
        {openInv && (
          <InvoiceExpansion
            invoiceId={openInv.invoice_id}
            poNumber={openInv.po_number}
          />
        )}
      </SlideOver>
    </>
  )
}

export default InvoicesPage
