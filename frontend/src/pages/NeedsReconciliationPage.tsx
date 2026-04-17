import { useCallback } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatINRSymbol } from '../utils/format'

interface NeedsReconciliationRow {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  supplier_name: string | null
  total_amount: string | number | null
  tax_amount: string | number | null
  status: string | null
  source: string | null
  reconciliation_status: string | null
  mismatches: Array<{ field: string; severity?: string }> | null
  excel_received_at: string | null
  ocr_received_at: string | null
}

function NeedsReconciliationPage() {
  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<NeedsReconciliationRow>> => {
      const res = await apiFetch('invoices/needs-reconciliation')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load'))
      const body = await res.json()
      const all: NeedsReconciliationRow[] = body.invoices || []
      const filtered = p.search
        ? all.filter((r) =>
            r.invoice_number?.toLowerCase().includes(p.search!.toLowerCase()) ||
            (r.supplier_name ?? '').toLowerCase().includes(p.search!.toLowerCase())
          )
        : all
      const windowed = filtered.slice(p.offset, p.offset + p.limit)
      return { items: windowed, total: filtered.length }
    },
    []
  )

  const columns: ListPageColumn<NeedsReconciliationRow>[] = [
    {
      field: 'invoice_number',
      header: 'Invoice #',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.invoice_number}</div>
          {r.invoice_date && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{formatDate(r.invoice_date)}</div>
          )}
        </div>
      )
    },
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (r) => r.supplier_name || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'total_amount',
      header: 'Total',
      body: (r) => formatINRSymbol(r.total_amount)
    },
    {
      field: 'mismatches',
      header: 'Mismatches',
      body: (r) => {
        const list = Array.isArray(r.mismatches) ? r.mismatches : []
        if (list.length === 0) {
          return <span style={{ color: 'var(--status-success-fg)', fontWeight: 600 }}>Up to date</span>
        }
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {list.map((m, i) => (
              <span
                key={i}
                style={{
                  padding: '0.12rem 0.5rem',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  borderRadius: 9999,
                  background: m.severity === 'high' ? 'var(--status-danger-bg)' : 'var(--status-warning-bg)',
                  color:      m.severity === 'high' ? 'var(--status-danger-fg)' : 'var(--status-warning-fg)'
                }}
              >
                {m.field}
              </span>
            ))}
          </div>
        )
      }
    },
    {
      field: 'excel_received_at',
      header: 'Sources',
      body: (r) => (
        <div style={{ fontSize: '0.78rem' }}>
          <div>Excel: {r.excel_received_at ? formatDate(r.excel_received_at) : '—'}</div>
          <div>OCR: {r.ocr_received_at ? formatDate(r.ocr_received_at) : '—'}</div>
        </div>
      )
    }
  ]

  return (
    <ListPage<NeedsReconciliationRow>
      eyebrow="Workflow"
      eyebrowIcon="pi-sync"
      title="Needs reconciliation"
      subtitle="Invoices where the Excel Bill Register and the Portal OCR disagree. Expand a row to review both sources side by side and approve the authoritative values."
      kpis={[
        {
          label: 'Pending review',
          value: '—',
          icon: 'pi-sync',
          variant: 'rose' as const,
          sublabel: 'Updated live on expand'
        }
      ]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search invoice # or supplier…' }]}
      columns={columns}
      rowKey="invoice_id"
      fetchData={fetchData}
      rowExpansionTemplate={(row) => (
        <InvoiceExpansion invoiceId={row.invoice_id} poNumber={null} />
      )}
      emptyTitle="Nothing to reconcile"
      emptyBody="Every invoice with both Excel and OCR sources agrees within tolerance."
    />
  )
}

export default NeedsReconciliationPage
