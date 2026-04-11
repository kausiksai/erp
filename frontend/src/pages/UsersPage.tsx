import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

interface User {
  user_id: number
  username: string
  email: string
  full_name: string | null
  role: string
  is_active: boolean
  created_at: string | null
}

interface UserForm {
  username: string
  email: string
  full_name: string
  role: string
  password: string
}

const EMPTY: UserForm = { username: '', email: '', full_name: '', role: 'user', password: '' }

const ROLE_COLORS: Record<string, { bg: string; fg: string }> = {
  admin:    { bg: 'var(--status-danger-bg)',  fg: 'var(--status-danger-fg)'  },
  manager:  { bg: 'var(--status-warn-bg)',    fg: 'var(--status-warn-fg)'    },
  finance:  { bg: 'var(--status-info-bg)',    fg: 'var(--status-info-fg)'    },
  user:     { bg: 'var(--status-muted-bg)',   fg: 'var(--status-muted-fg)'   }
}

function UsersPage() {
  const navigate = useNavigate()
  const [list, setList] = useState<User[]>([])
  const [form, setForm] = useState<UserForm>(EMPTY)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const load = async () => {
    try {
      setLoading(true)
      const res = await apiFetch('users')
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load users'))
      const body = await res.json()
      setList(body.items || body.users || body || [])
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (!form.username.trim() || !form.email.trim()) {
      setError('Username and email are required')
      return
    }
    if (!editingId && !form.password) {
      setError('Password is required for new users')
      return
    }
    try {
      setSaving(true)
      const url = editingId ? `users/${editingId}` : 'users'
      const payload: Partial<UserForm> = { ...form }
      if (editingId && !payload.password) delete payload.password
      const res = await apiFetch(url, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Save failed'))
      setSuccess(editingId ? 'User updated.' : 'User created.')
      setForm(EMPTY)
      setEditingId(null)
      await load()
    } catch (err) {
      setError(getDisplayError(err))
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (u: User) => {
    setEditingId(u.user_id)
    setForm({
      username: u.username,
      email: u.email,
      full_name: u.full_name || '',
      role: u.role,
      password: ''
    })
    setError('')
    setSuccess('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleDelete = async (u: User) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
    try {
      const res = await apiFetch(`users/${u.user_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Delete failed'))
      await load()
    } catch (err) {
      setError(getDisplayError(err))
    }
  }

  const cancel = () => {
    setForm(EMPTY)
    setEditingId(null)
  }

  return (
    <>
      <PageHero
        eyebrow="Masters"
        eyebrowIcon="pi-user"
        title={editingId ? 'Edit user' : 'Create user'}
        subtitle="Portal users, roles and access. Roles drive which menus and approval queues a user can see."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/')}>
            <i className="pi pi-home" /> Dashboard
          </button>
        }
      />

      {error   && <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}><i className="pi pi-exclamation-triangle" /> {error}</div>}
      {success && <div className="glass-card" style={{ borderColor: 'var(--status-success-ring)', color: 'var(--status-success-fg)' }}><i className="pi pi-check-circle" /> {success}</div>}

      <form className="glass-card" onSubmit={handleSave}>
        <h3 className="glass-card__title"><i className="pi pi-user-plus" style={{ color: 'var(--brand-600)' }} /> {editingId ? 'Edit user' : 'New user'}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
          <Input label="Username *" value={form.username}  onChange={(v) => setForm({ ...form, username: v })} />
          <Input label="Full name"  value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} />
          <Input label="Email *"    value={form.email}     onChange={(v) => setForm({ ...form, email: v })} type="email" />
          <Input
            label={editingId ? 'Password (leave blank to keep)' : 'Password *'}
            value={form.password}
            onChange={(v) => setForm({ ...form, password: v })}
            type="password"
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Role</span>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              style={{
                padding: '0.7rem 0.85rem',
                borderRadius: 'var(--radius-md)',
                border: '1.5px solid var(--border-subtle)',
                background: 'var(--surface-0)',
                color: 'var(--text-primary)',
                fontSize: '0.92rem',
                fontFamily: 'inherit'
              }}
            >
              <option value="user">User</option>
              <option value="finance">Finance</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.7rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
          <button type="submit" className="action-btn" disabled={saving}>
            {saving ? <><i className="pi pi-spin pi-spinner" /> Saving…</> : <><i className="pi pi-check" /> {editingId ? 'Update user' : 'Create user'}</>}
          </button>
          {editingId && (
            <button type="button" className="action-btn action-btn--ghost" onClick={cancel}>
              <i className="pi pi-times" /> Cancel edit
            </button>
          )}
        </div>
      </form>

      <section className="glass-card">
        <h3 className="glass-card__title"><i className="pi pi-users" style={{ color: 'var(--accent-violet)' }} /> Existing users ({list.length})</h3>
        {loading ? (
          <div style={{ padding: '1rem', color: 'var(--text-muted)' }}><i className="pi pi-spin pi-spinner" /> Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-muted)' }}>No users yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {list.map((u) => {
              const roleC = ROLE_COLORS[u.role] || ROLE_COLORS.user
              return (
                <div key={u.user_id} style={{
                  display: 'flex', alignItems: 'center', gap: '0.85rem',
                  padding: '0.75rem 0.9rem',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-1)'
                }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: '50%',
                    background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
                    color: '#fff', fontWeight: 800, fontSize: '0.85rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    {(u.full_name || u.username).split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{u.full_name || u.username}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {u.email} · {u.username}
                    </div>
                  </div>
                  <span style={{
                    padding: '0.2rem 0.6rem',
                    borderRadius: 9999,
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    background: roleC.bg,
                    color: roleC.fg
                  }}>
                    {u.role}
                  </span>
                  <button className="action-btn action-btn--ghost" onClick={() => handleEdit(u)}>
                    <i className="pi pi-pencil" /> Edit
                  </button>
                  <button className="action-btn action-btn--ghost" onClick={() => handleDelete(u)} style={{ color: 'var(--status-danger-fg)' }}>
                    <i className="pi pi-trash" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>
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

export default UsersPage
