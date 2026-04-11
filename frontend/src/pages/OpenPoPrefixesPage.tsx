import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'

interface OpenPoPrefix {
  id: number
  prefix: string
  description: string | null
  active: boolean | null
  created_at: string | null
}

function OpenPoPrefixesPage() {
  const [total, setTotal] = useState(0)

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<OpenPoPrefix>> => {
      const res = await apiFetch('open-po-prefixes')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load prefixes'))
      const body = await res.json()
      let items: OpenPoPrefix[] = body.items || body.prefixes || body || []
      // client-side filter/paginate since backend returns all
      if (p.search) {
        const q = p.search.toLowerCase()
        items = items.filter((i) => i.prefix.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
      }
      const t = items.length
      setTotal(t)
      const slice = items.slice(p.offset, p.offset + p.limit)
      return { items: slice, total: t }
    },
    []
  )

  const columns: ListPageColumn<OpenPoPrefix>[] = [
    { field: 'prefix', header: 'Prefix', body: (r) => <code style={{ fontSize: '0.88rem', fontWeight: 700 }}>{r.prefix}</code> },
    { field: 'description', header: 'Description', body: (r) => r.description || <span style={{ color: 'var(--text-muted)' }}>—</span> },
    {
      field: 'active',
      header: 'Status',
      body: (r) => (
        <span className={`status-chip ${r.active ? 'status-chip--success' : 'status-chip--muted'}`}>
          {r.active ? 'Active' : 'Disabled'}
        </span>
      )
    },
    {
      field: 'created_at',
      header: 'Created',
      body: (r) => (r.created_at ? new Date(r.created_at).toLocaleDateString('en-IN') : '—')
    }
  ]

  return (
    <ListPage<OpenPoPrefix>
      eyebrow="Configuration"
      eyebrowIcon="pi-tag"
      title="Open PO prefixes"
      subtitle="PO numbers whose prefix matches this list are validated under the Open PO branch (cumulative against a pool instead of line-by-line)."
      kpis={[{ label: 'Total prefixes', value: total.toLocaleString('en-IN'), icon: 'pi-tag', variant: 'amber' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search prefix…' }]}
      columns={columns}
      rowKey="id"
      fetchData={fetchData}
      emptyTitle="No prefixes configured"
      emptyBody="Upload an Excel via the settings page to configure Open PO prefixes."
    />
  )
}

export default OpenPoPrefixesPage
