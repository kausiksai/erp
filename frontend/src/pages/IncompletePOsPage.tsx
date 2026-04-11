import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface IncompletePO {
  po_id: number
  po_number: string
  supplier_name: string | null
  po_date: string | null
  po_value: number | null
  missing: {
    grn?: boolean
    asn?: boolean
    dc?: boolean
    schedule?: boolean
  }
}

const INR = (n: number | null | undefined) =>
  typeof n === 'number' ? n.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'

function IncompletePOsPage() {
  const [stats, setStats] = useState({ total: 0, missingGrn: 0, missingAsn: 0, missingDc: 0, missingSched: 0 })

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<IncompletePO>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('q', p.search)
      const res = await apiFetch(`purchase-orders/incomplete?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load incomplete POs'))
      const body = await res.json()
      const items: IncompletePO[] = body.items || body.purchase_orders || body || []
      const totalN = body.total ?? items.length
      setStats({
        total: totalN,
        missingGrn:   items.filter((i) => i.missing?.grn).length,
        missingAsn:   items.filter((i) => i.missing?.asn).length,
        missingDc:    items.filter((i) => i.missing?.dc).length,
        missingSched: items.filter((i) => i.missing?.schedule).length
      })
      return { items, total: totalN }
    },
    []
  )

  const chipFor = (label: string, danger: boolean) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.15rem 0.55rem',
        marginRight: '0.35rem',
        fontSize: '0.72rem',
        fontWeight: 700,
        borderRadius: 9999,
        background: danger ? 'var(--status-danger-bg)' : 'var(--status-success-bg)',
        color:      danger ? 'var(--status-danger-fg)' : 'var(--status-success-fg)'
      }}
    >
      <i className={`pi ${danger ? 'pi-times-circle' : 'pi-check-circle'}`} /> {label}
    </span>
  )

  const columns: ListPageColumn<IncompletePO>[] = [
    {
      field: 'po_number',
      header: 'PO #',
      body: (row) => <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{row.po_number}</div>
    },
    { field: 'supplier_name', header: 'Supplier', body: (r) => r.supplier_name || '—' },
    {
      field: 'po_date',
      header: 'PO date',
      body: (r) => (r.po_date ? new Date(r.po_date).toLocaleDateString('en-IN') : '—')
    },
    {
      field: 'po_value',
      header: 'Value',
      body: (r) => <div style={{ fontWeight: 700, textAlign: 'right' }}>₹{INR(r.po_value)}</div>,
      style: { textAlign: 'right' }
    },
    {
      field: 'missing',
      header: 'Missing',
      body: (r) => (
        <div>
          {chipFor('GRN',      !!r.missing?.grn)}
          {chipFor('ASN',      !!r.missing?.asn)}
          {chipFor('DC',       !!r.missing?.dc)}
          {chipFor('Schedule', !!r.missing?.schedule)}
        </div>
      )
    }
  ]

  return (
    <ListPage<IncompletePO>
      eyebrow="Workflow"
      eyebrowIcon="pi-exclamation-circle"
      title="Incomplete purchase orders"
      subtitle="POs missing one or more supporting documents (GRN, ASN, DC or schedule). Close these loops before invoices are released for payment."
      kpis={[
        { label: 'Incomplete POs', value: stats.total.toLocaleString('en-IN'),       icon: 'pi-exclamation-circle', variant: 'rose'    },
        { label: 'Missing GRN',    value: stats.missingGrn.toLocaleString('en-IN'),  icon: 'pi-box',                variant: 'amber'   },
        { label: 'Missing ASN',    value: stats.missingAsn.toLocaleString('en-IN'),  icon: 'pi-truck',              variant: 'violet'  },
        { label: 'Missing DC',     value: stats.missingDc.toLocaleString('en-IN'),   icon: 'pi-file-edit',          variant: 'brand'   }
      ]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search PO #, supplier…' }]}
      columns={columns}
      rowKey="po_id"
      fetchData={fetchData}
      emptyTitle="Nothing incomplete"
      emptyBody="All active POs have their GRN, ASN, DC and schedule on file. 🎉"
    />
  )
}

export default IncompletePOsPage
