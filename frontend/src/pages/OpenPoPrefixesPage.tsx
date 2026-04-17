import { useCallback, useState } from 'react'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getErrorMessageFromResponse } from '../utils/api'
import { formatDate } from '../utils/format'

interface OpenPoPrefix {
  id: number
  prefix: string
  description: string | null
  created_at: string | null
  updated_at: string | null
}

function OpenPoPrefixesPage() {
  const [total, setTotal] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<OpenPoPrefix>> => {
      const res = await apiFetch('open-po-prefixes')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load prefixes'))
      const body = await res.json()
      let items: OpenPoPrefix[] = Array.isArray(body) ? body : (body.items || body.prefixes || [])
      if (p.search) {
        const q = p.search.toLowerCase()
        items = items.filter(
          (i) =>
            i.prefix.toLowerCase().includes(q) ||
            (i.description || '').toLowerCase().includes(q)
        )
      }
      const t = items.length
      setTotal(t)
      const slice = items.slice(p.offset, p.offset + p.limit)
      return { items: slice, total: t }
    },
    []
  )

  const columns: ListPageColumn<OpenPoPrefix>[] = [
    {
      field: 'prefix',
      header: 'Prefix',
      body: (r) => <code style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>{r.prefix}</code>
    },
    {
      field: 'description',
      header: 'Description',
      body: (r) => r.description || <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'created_at',
      header: 'Created',
      body: (r) => formatDate(r.created_at)
    },
    {
      field: 'updated_at',
      header: 'Updated',
      body: (r) => formatDate(r.updated_at)
    }
  ]

  return (
    <ListPage<OpenPoPrefix>
      eyebrow="Configuration"
      eyebrowIcon="pi-tag"
      title="Open PO prefixes"
      subtitle="PO numbers whose prefix matches this list are validated under the Open PO branch (cumulative against a pool instead of line-by-line). Upload replaces the whole list."
      headerExtras={
        <ExcelUploadButton
          endpoint="open-po-prefixes/upload-excel"
          label="Upload prefixes Excel"
          onSuccess={(message) => {
            setBanner({ tone: 'success', text: message })
            setReloadKey((k) => k + 1)
          }}
          onError={(message) => setBanner({ tone: 'danger', text: message })}
        />
      }
      banner={
        banner ? (
          <div
            className="glass-card"
            style={{
              borderColor: `var(--status-${banner.tone}-ring)`,
              color: `var(--status-${banner.tone}-fg)`
            }}
          >
            <i className={`pi ${banner.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} /> {banner.text}
          </div>
        ) : null
      }
      kpis={[{ label: 'Total prefixes', value: total.toLocaleString('en-IN'), icon: 'pi-tag', variant: 'amber' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search prefix or description…' }]}
      columns={columns}
      rowKey="id"
      fetchData={fetchData}
      reloadKey={reloadKey}
      emptyTitle="No prefixes configured"
      emptyBody="Upload an Excel via the button above to seed Open PO prefixes."
    />
  )
}

export default OpenPoPrefixesPage
