import { useCallback, useEffect, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatInt } from '../utils/format'

interface IncompletePO {
  po_id: number
  po_number: string
  supplier_name: string | null
  po_date: string | null
  po_status: string | null
  amd_no: number | string | null
  has_invoice: boolean | null
  has_grn: boolean | null
  has_asn: boolean | null
  missing_items: string[] | null
}

interface IncompleteStats {
  total_active_pos: number
  with_invoice: number
  with_grn: number
  with_asn: number
  total_incomplete: number
  missing_invoice: number
  missing_grn: number
  missing_asn: number
  missing_all: number
  recent_active_pos: number
  recent_incomplete: number
}

function IncompletePOsPage() {
  const [stats, setStats] = useState<IncompleteStats>({
    total_active_pos: 0,
    with_invoice: 0,
    with_grn: 0,
    with_asn: 0,
    total_incomplete: 0,
    missing_invoice: 0,
    missing_grn: 0,
    missing_asn: 0,
    missing_all: 0,
    recent_active_pos: 0,
    recent_incomplete: 0
  })

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('purchase-orders/incomplete/stats')
        if (!res.ok) return
        const body: IncompleteStats = await res.json()
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
    async (p: FetchParams): Promise<FetchResult<IncompletePO>> => {
      const qs = new URLSearchParams()
      qs.set('limit', String(p.limit))
      qs.set('offset', String(p.offset))
      if (p.search) qs.set('poNumber', p.search)
      const res = await apiFetch(`purchase-orders/incomplete?${qs.toString()}`)
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load incomplete POs'))
      const body = await res.json()
      const items: IncompletePO[] = body.items || []
      const totalN = body.total ?? items.length
      return { items, total: totalN }
    },
    []
  )

  const chipFor = (label: string, present: boolean | null) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.15rem 0.55rem',
        marginRight: '0.35rem',
        fontSize: '0.7rem',
        fontWeight: 700,
        borderRadius: 9999,
        background: present ? 'var(--status-success-bg)' : 'var(--status-danger-bg)',
        color:      present ? 'var(--status-success-fg)' : 'var(--status-danger-fg)'
      }}
    >
      <i className={`pi ${present ? 'pi-check-circle' : 'pi-times-circle'}`} /> {label}
    </span>
  )

  const columns: ListPageColumn<IncompletePO>[] = [
    {
      field: 'po_number',
      header: 'PO #',
      body: (row) => (
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{row.po_number}</div>
          {Number(row.amd_no || 0) > 0 && (
            <span style={{
              display: 'inline-block', marginTop: '0.15rem',
              padding: '0.1rem 0.45rem', fontSize: '0.68rem', fontWeight: 700,
              borderRadius: 9999,
              background: 'var(--status-info-bg)', color: 'var(--status-info-fg)'
            }}>
              AMD {row.amd_no}
            </span>
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
      field: 'po_date',
      header: 'PO date',
      body: (r) => formatDate(r.po_date)
    },
    {
      field: 'status',
      header: 'Coverage',
      body: (r) => (
        <div>
          {chipFor('Invoice', r.has_invoice)}
          {chipFor('GRN',     r.has_grn)}
          {chipFor('ASN',     r.has_asn)}
        </div>
      )
    },
    {
      field: 'missing_items',
      header: 'Missing',
      body: (r) => {
        const missing = Array.isArray(r.missing_items) ? r.missing_items : []
        if (missing.length === 0) {
          return <span style={{ color: 'var(--status-success-fg)', fontWeight: 600 }}>None</span>
        }
        return (
          <span style={{ color: 'var(--status-danger-fg)', fontWeight: 700, fontSize: '0.85rem' }}>
            {missing.join(' · ')}
          </span>
        )
      }
    }
  ]

  return (
    <ListPage<IncompletePO>
      eyebrow="Workflow"
      eyebrowIcon="pi-exclamation-circle"
      title="Incomplete purchase orders"
      subtitle="Coverage of downstream documents against every active PO. The 'Needs attention' tile is the actionable one — it counts only POs from the last 90 days."
      kpis={(() => {
        const total = stats.total_active_pos || 0
        const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0)
        // Coverage % — share of active POs that DO have each doc. Higher is better.
        const invPct = pct(stats.with_invoice)
        const grnPct = pct(stats.with_grn)
        const asnPct = pct(stats.with_asn)
        return [
          {
            label: 'Active POs',
            value: formatInt(stats.total_active_pos),
            icon: 'pi-shopping-cart',
            variant: 'slate' as const,
            sublabel: `${formatInt(stats.total_incomplete)} incomplete (${pct(stats.total_incomplete)}%)`
          },
          {
            label: 'Invoice coverage',
            value: `${invPct}%`,
            icon: 'pi-file',
            variant: 'brand' as const,
            sublabel: `${formatInt(stats.with_invoice)} of ${formatInt(total)} have invoices`
          },
          {
            label: 'GRN coverage',
            value: `${grnPct}%`,
            icon: 'pi-box',
            variant: 'emerald' as const,
            sublabel: `${formatInt(stats.with_grn)} of ${formatInt(total)} have GRN`
          },
          {
            label: 'ASN coverage',
            value: `${asnPct}%`,
            icon: 'pi-truck',
            variant: 'violet' as const,
            sublabel: `${formatInt(stats.with_asn)} of ${formatInt(total)} have ASN`
          },
          {
            label: 'Needs attention',
            value: formatInt(stats.recent_incomplete),
            icon: 'pi-exclamation-circle',
            variant: 'rose' as const,
            sublabel: `Of ${formatInt(stats.recent_active_pos)} POs in last 90 days`
          }
        ]
      })()}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search by PO number…' }]}
      columns={columns}
      rowKey="po_id"
      fetchData={fetchData}
      emptyTitle="Nothing incomplete"
      emptyBody="All active POs have their invoice, GRN and ASN on file."
    />
  )
}

export default IncompletePOsPage
