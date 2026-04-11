import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

interface Owner {
  owner_id?: number
  owner_name: string
  gstin: string
  pan: string
  cin: string
  address_line1: string
  address_line2: string
  city: string
  state: string
  pincode: string
  phone: string
  email: string
  website: string
  bank_name: string
  account_number: string
  ifsc_code: string
  branch: string
}

const EMPTY: Owner = {
  owner_name: '',
  gstin: '',
  pan: '',
  cin: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  pincode: '',
  phone: '',
  email: '',
  website: '',
  bank_name: '',
  account_number: '',
  ifsc_code: '',
  branch: ''
}

function OwnerPage() {
  const navigate = useNavigate()
  const [owner, setOwner] = useState<Owner>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('owners')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load company details'))
      const body = await res.json()
      const o = body.owner || (Array.isArray(body) ? body[0] : body)
      if (o) setOwner({ ...EMPTY, ...o })
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const onChange = (k: keyof Owner, v: string) => setOwner((o) => ({ ...o, [k]: v }))

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (!owner.owner_id) {
      setError('No company record exists — seed it first.')
      return
    }
    try {
      setSaving(true)
      const res = await apiFetch(`owners/${owner.owner_id}`, {
        method: 'PUT',
        body: JSON.stringify(owner)
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Save failed'))
      setSuccess('Company details updated.')
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHero
        eyebrow="Company"
        eyebrowIcon="pi-id-card"
        title="Operating entity"
        subtitle="The legal entity that raises POs and receives invoices. This data appears on every generated document."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/settings')}>
            <i className="pi pi-arrow-left" /> Settings
          </button>
        }
      />

      {error   && <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}><i className="pi pi-exclamation-triangle" /> {error}</div>}
      {success && <div className="glass-card" style={{ borderColor: 'var(--status-success-ring)', color: 'var(--status-success-fg)' }}><i className="pi pi-check-circle" /> {success}</div>}

      {loading ? (
        <div className="glass-card"><i className="pi pi-spin pi-spinner" /> Loading…</div>
      ) : (
        <form className="glass-card" onSubmit={handleSave}>
          <h3 className="glass-card__title"><i className="pi pi-building" style={{ color: 'var(--brand-600)' }} /> Identity</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
            <Input label="Company name"  value={owner.owner_name} onChange={(v) => onChange('owner_name', v)} />
            <Input label="GSTIN"          value={owner.gstin}      onChange={(v) => onChange('gstin', v.toUpperCase())} />
            <Input label="PAN"            value={owner.pan}        onChange={(v) => onChange('pan', v.toUpperCase())} />
            <Input label="CIN"            value={owner.cin}        onChange={(v) => onChange('cin', v.toUpperCase())} />
          </div>

          <h3 className="glass-card__title" style={{ marginTop: '1.5rem' }}><i className="pi pi-map-marker" style={{ color: 'var(--accent-violet)' }} /> Address</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
            <Input label="Address line 1" value={owner.address_line1} onChange={(v) => onChange('address_line1', v)} />
            <Input label="Address line 2" value={owner.address_line2} onChange={(v) => onChange('address_line2', v)} />
            <Input label="City"    value={owner.city}    onChange={(v) => onChange('city', v)} />
            <Input label="State"   value={owner.state}   onChange={(v) => onChange('state', v)} />
            <Input label="Pincode" value={owner.pincode} onChange={(v) => onChange('pincode', v)} />
          </div>

          <h3 className="glass-card__title" style={{ marginTop: '1.5rem' }}><i className="pi pi-phone" style={{ color: 'var(--accent-emerald)' }} /> Contact</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
            <Input label="Phone"   value={owner.phone}   onChange={(v) => onChange('phone', v)} />
            <Input label="Email"   value={owner.email}   onChange={(v) => onChange('email', v)} type="email" />
            <Input label="Website" value={owner.website} onChange={(v) => onChange('website', v)} />
          </div>

          <h3 className="glass-card__title" style={{ marginTop: '1.5rem' }}><i className="pi pi-credit-card" style={{ color: 'var(--accent-amber)' }} /> Banking</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
            <Input label="Bank name"      value={owner.bank_name}      onChange={(v) => onChange('bank_name', v)} />
            <Input label="Account number" value={owner.account_number} onChange={(v) => onChange('account_number', v)} />
            <Input label="IFSC code"      value={owner.ifsc_code}      onChange={(v) => onChange('ifsc_code', v.toUpperCase())} />
            <Input label="Branch"         value={owner.branch}         onChange={(v) => onChange('branch', v)} />
          </div>

          <div style={{ display: 'flex', gap: '0.7rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="action-btn" disabled={saving}>
              {saving ? <><i className="pi pi-spin pi-spinner" /> Saving…</> : <><i className="pi pi-check" /> Save company</>}
            </button>
          </div>
        </form>
      )}
    </>
  )
}

function Input({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</span>
      <input
        type={type}
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

export default OwnerPage
