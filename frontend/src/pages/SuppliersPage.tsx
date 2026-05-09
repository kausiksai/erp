import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ListPage from '../components/ListPage'
import type { ListPageColumn, FetchParams, FetchResult } from '../components/ListPage'
import ExcelUploadButton from '../components/ExcelUploadButton'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'

interface Supplier {
  supplier_id: number
  supplier_name: string
  suplr_id: string | null
  gst_number: string | null
  pan_number: string | null
  state_name: string | null
  contact_person: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  city: string | null
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('') || 'S'
  )
}

function SuppliersPage() {
  const navigate = useNavigate()
  const [total, setTotal] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const toast = useToast()
  const confirmDialog = useConfirm()

  const handleDeleteSupplier = async (row: Supplier) => {
    const ok = await confirmDialog({
      title: `Delete supplier "${row.supplier_name}"?`,
      body: 'This is permanent. Any historical POs and invoices linked to this supplier will keep their reference but you won\'t be able to add new ones.',
      icon: 'pi-trash',
      kind: 'danger',
      okLabel: 'Delete'
    })
    if (!ok) return
    try {
      const res = await apiFetch(`suppliers/${row.supplier_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Delete failed'))
      toast.success('Supplier deleted', `"${row.supplier_name}" was removed from the master.`)
      setReloadKey((k) => k + 1)
    } catch (err) {
      toast.danger('Delete failed', getDisplayError(err))
    }
  }

  const fetchData = useCallback(
    async (p: FetchParams): Promise<FetchResult<Supplier>> => {
      const res = await apiFetch('suppliers')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load suppliers'))
      const body = await res.json()
      // /suppliers returns a bare array
      let items: Supplier[] = Array.isArray(body) ? body : (body.items || body.suppliers || [])
      if (p.search) {
        const q = p.search.toLowerCase()
        items = items.filter(
          (s) =>
            s.supplier_name?.toLowerCase().includes(q) ||
            (s.suplr_id || '').toLowerCase().includes(q) ||
            (s.gst_number || '').toLowerCase().includes(q) ||
            (s.city || '').toLowerCase().includes(q) ||
            (s.state_name || '').toLowerCase().includes(q)
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
              width: 40,
              height: 40,
              borderRadius: 10,
              background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
              color: '#fff',
              fontWeight: 800,
              fontSize: '0.78rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            {initials(r.supplier_name || '?')}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.supplier_name || '—'}
            </div>
            {r.suplr_id && (
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>ID {r.suplr_id}</div>
            )}
          </div>
        </div>
      )
    },
    {
      field: 'gst_number',
      header: 'GSTIN',
      body: (r) =>
        r.gst_number
          ? <code style={{ fontSize: '0.82rem' }}>{r.gst_number}</code>
          : <span style={{ color: 'var(--text-muted)' }}>—</span>
    },
    {
      field: 'state_name',
      header: 'Location',
      body: (r) => {
        const loc = [r.city, r.state_name].filter(Boolean).join(', ')
        return loc || <span style={{ color: 'var(--text-muted)' }}>—</span>
      }
    },
    {
      field: 'contact_person',
      header: 'Contact',
      body: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.contact_person || '—'}</div>
          {(r.phone || r.mobile) && (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{r.phone || r.mobile}</div>
          )}
        </div>
      )
    },
    { field: 'email', header: 'Email', body: (r) => r.email || <span style={{ color: 'var(--text-muted)' }}>—</span> },
    {
      field: 'supplier_id',
      header: '',
      style: { width: 44, padding: '0 0.4rem' },
      body: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            handleDeleteSupplier(r)
          }}
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--status-danger-fg)',
            cursor: 'pointer',
            padding: '0.3rem 0.5rem',
            borderRadius: 6
          }}
          title={`Delete ${r.supplier_name}`}
        >
          <i className="pi pi-trash" />
        </button>
      )
    }
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
      headerExtras={
        <ExcelUploadButton
          endpoint="suppliers/upload-excel"
          label="Upload supplier Excel"
          onSuccess={(message) => {
            toast.success('Suppliers imported', message)
            setReloadKey((k) => k + 1)
          }}
          onError={(message) => toast.danger('Upload failed', message)}
        />
      }
      kpis={[{ label: 'Suppliers on file', value: total.toLocaleString('en-IN'), icon: 'pi-users', variant: 'emerald' }]}
      filters={[{ key: 'search', type: 'search', placeholder: 'Search name, ID, GSTIN, city…' }]}
      columns={columns}
      rowKey="supplier_id"
      fetchData={fetchData}
      reloadKey={reloadKey}
      onRowClick={(row) => navigate('/suppliers/registration', { state: { supplier: row } })}
      emptyTitle="No suppliers yet"
      emptyBody="Add your first supplier to start receiving POs against them, or upload an Excel master using the button above."
    />
  )
}

export default SuppliersPage
