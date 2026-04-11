import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface Supplier {
  supplier_id: number
  supplier_name: string
  supplier_code: string | null
  gstin: string | null
  state: string | null
  contact_person: string | null
  contact_phone: string | null
  email: string | null
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('') || 'S'
}

function SuppliersPage() {
  const navigate = useNavigate()
  const [total, setTotal] = useState(0)

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<Supplier>> => {
      const res = await apiFetch('suppliers')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load suppliers'))
      const body = await res.json()
      let items: Supplier[] = body.items || body.suppliers || body || []
      if (p.search) {
        const q = p.search.toLowerCase()
        items = items.filter(
          (s) =>
            s.supplier_name.toLowerCase().includes(q) ||
            (s.supplier_code || '').toLowerCase().includes(q) ||
            (s.gstin || '').toLowerCase().includes(q)
        )
      }
      const t = items.length
      setTotal(t)
      const slice = items.slice(p.offset, p.offset + p.limit)
      return { items: slice, total: t }
    },
    []
  )

  const columns: ListPageColumn<Supplier>[] = [
    {
      field: 'supplier_name',
      header: 'Supplier',
      body: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
              color: '#fff',
              fontWeight: 800,
              fontSize: '0.78rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {initials(r.supplier_name)}
          </div>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.supplier_name}</div>
            {r.supplier_code && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{r.supplier_code}</div>}
          </div>
        </div>
      )
    },
    { field: 'gstin', header: 'GSTIN', body: (r) => <code style={{ fontSize: '0.82rem' }}>{r.gstin || '—'}</code> },
    { field: 'state', header: 'State', body: (r) => r.state || '—' },
    {
      field: 'contact_person',
      header: 'Contact',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.contact_person || '—'}</div>
          {r.contact_phone && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{r.contact_phone}</div>}
        </div>
      )
    },
    { field: 'email', header: 'Email', body: (r) => r.email || '—' }
  ]

  return (
    <ListPage<Supplier>
      eyebrow="Masters"
      eyebrowIcon="pi-users"
      title="Suppliers"
      subtitle="The single source of truth for vendor master data — GSTIN, address, bank details and contacts."
      primaryAction={{
        label: 'Add supplier',
        icon: 'pi-plus',
        onClick: () => navigate('/suppliers/registration')
      }}
      kpis={[{ label: 'Suppliers on file', value: total.toLocaleString('en-IN'), icon: 'pi-users', variant: 'emerald' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search name, code or GSTIN…' }]}
      columns={columns}
      rowKey="supplier_id"
      fetchData={fetchData}
      onRowClick={() => navigate('/suppliers/registration')}
      emptyTitle="No suppliers yet"
      emptyBody="Add your first supplier to start receiving POs against them."
    />
  )
}

export default SuppliersPage
