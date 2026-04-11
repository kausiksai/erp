import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

interface Supplier {
  supplier_id?: number
  supplier_name: string
  supplier_code: string
  suplr_id: string
  gstin: string
  pan: string
  state: string
  address: string
  contact_person: string
  contact_phone: string
  email: string
  bank_name: string
  account_number: string
  ifsc_code: string
}

const EMPTY: Supplier = {
  supplier_name: '',
  supplier_code: '',
  suplr_id: '',
  gstin: '',
  pan: '',
  state: '',
  address: '',
  contact_person: '',
  contact_phone: '',
  email: '',
  bank_name: '',
  account_number: '',
  ifsc_code: ''
}

function SupplierFormPage() {
  const navigate = useNavigate()
  const [list, setList] = useState<Supplier[]>([])
  const [form, setForm] = useState<Supplier>(EMPTY)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('suppliers')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load suppliers'))
      const body = await res.json()
      setList(body.items || body.suppliers || body || [])
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const onChange = (k: keyof Supplier, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (!form.supplier_name.trim()) {
      setError('Supplier name is required')
      return
    }
    try {
      setSaving(true)
      const url = editingId ? `suppliers/${editingId}` : 'suppliers'
      const res = await apiFetch(url, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(form)
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Save failed'))
      setSuccess(editingId ? 'Supplier updated.' : 'Supplier created.')
      setForm(EMPTY)
      setEditingId(null)
      await load()
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = async (row: Supplier) => {
    setEditingId(row.supplier_id || null)
    setForm({ ...EMPTY, ...row })
    setError('')
    setSuccess('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async (row: Supplier) => {
    if (!row.supplier_id) return
    if (!confirm(`Delete supplier "${row.supplier_name}"? This cannot be undone.`)) return
    try {
      const res = await apiFetch(`suppliers/${row.supplier_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Delete failed'))
      await load()
    } catch (err) {
      setError(getDisplayError(err))
    }
  }

  const cancel = () => {
    setForm(EMPTY)
    setEditingId(null)
    setError('')
    setSuccess('')
  }

  return (
    <>
      <PageHero
        eyebrow="Masters"
        eyebrowIcon="pi-users"
        title={editingId ? 'Edit supplier' : 'Add supplier'}
        subtitle="Vendor master data — GSTIN, state, contact and bank details. Validations match against this record."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/suppliers')}>
            <i className="pi pi-arrow-left" /> All suppliers
          </button>
        }
      />

      {error   && <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}><i className="pi pi-exclamation-triangle" /> {error}</div>}
      {success && <div className="glass-card" style={{ borderColor: 'var(--status-success-ring)', color: 'var(--status-success-fg)' }}><i className="pi pi-check-circle" /> {success}</div>}

      <form className="glass-card" onSubmit={handleSave}>
        <h3 className="glass-card__title"><i className="pi pi-id-card" style={{ color: 'var(--brand-600)' }} /> Identity</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
          <Input label="Supplier name *"  value={form.supplier_name}  onChange={(v) => onChange('supplier_name', v)} />
          <Input label="Supplier code"    value={form.supplier_code}  onChange={(v) => onChange('supplier_code', v)} />
          <Input label="Supplier ID"      value={form.suplr_id}       onChange={(v) => onChange('suplr_id', v)} />
          <Input label="GSTIN"            value={form.gstin}          onChange={(v) => onChange('gstin', v.toUpperCase())} />
          <Input label="PAN"              value={form.pan}            onChange={(v) => onChange('pan', v.toUpperCase())} />
          <Input label="State"            value={form.state}          onChange={(v) => onChange('state', v)} />
        </div>

        <h3 className="glass-card__title" style={{ marginTop: '1.5rem' }}><i className="pi pi-phone" style={{ color: 'var(--accent-violet)' }} /> Contact</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
          <Input label="Contact person"  value={form.contact_person} onChange={(v) => onChange('contact_person', v)} />
          <Input label="Phone"           value={form.contact_phone}  onChange={(v) => onChange('contact_phone', v)} />
          <Input label="Email"           value={form.email}          onChange={(v) => onChange('email', v)} />
          <Input label="Address"         value={form.address}        onChange={(v) => onChange('address', v)} />
        </div>

        <h3 className="glass-card__title" style={{ marginTop: '1.5rem' }}><i className="pi pi-credit-card" style={{ color: 'var(--accent-emerald)' }} /> Banking</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
          <Input label="Bank name"       value={form.bank_name}      onChange={(v) => onChange('bank_name', v)} />
          <Input label="Account number"  value={form.account_number} onChange={(v) => onChange('account_number', v)} />
          <Input label="IFSC code"       value={form.ifsc_code}      onChange={(v) => onChange('ifsc_code', v.toUpperCase())} />
        </div>

        <div style={{ display: 'flex', gap: '0.7rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <button type="submit" className="action-btn" disabled={saving}>
            {saving ? <><i className="pi pi-spin pi-spinner" /> Saving…</> : <><i className="pi pi-check" /> {editingId ? 'Update supplier' : 'Create supplier'}</>}
          </button>
          {editingId && (
            <button type="button" className="action-btn action-btn--ghost" onClick={cancel}>
              <i className="pi pi-times" /> Cancel edit
            </button>
          )}
        </div>
      </form>

      <section className="glass-card">
        <h3 className="glass-card__title"><i className="pi pi-list" style={{ color: 'var(--brand-600)' }} /> Existing suppliers ({list.length})</h3>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-muted)' }}><i className="pi pi-spin pi-spinner" /> Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-muted)' }}>No suppliers yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {list.map((s) => (
              <div key={s.supplier_id} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.75rem 0.9rem',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface-1)'
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{s.supplier_name}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {s.gstin || '—'}{s.state ? ` · ${s.state}` : ''}{s.contact_phone ? ` · ${s.contact_phone}` : ''}
                  </div>
                </div>
                <button className="action-btn action-btn--ghost" onClick={() => handleEdit(s)}>
                  <i className="pi pi-pencil" /> Edit
                </button>
                <button className="action-btn action-btn--ghost" onClick={() => handleDelete(s)} style={{ color: 'var(--status-danger-fg)' }}>
                  <i className="pi pi-trash" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '0.7rem 0.85rem',
          borderRadius: 'var(--radius-md)',
          border: '1.5px solid var(--border-subtle)',
          background: 'var(--surface-0)',
          color: 'var(--text-primary)',
          fontSize: '0.92rem',
          fontFamily: 'inherit',
          outline: 'none'
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      />
    </label>
  )
}

export default SupplierFormPage
