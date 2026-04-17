import { useEffect, useState } from 'react'
import PageHero from '../components/PageHero'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

function ProfilePage() {
  const { user, login, token } = useAuth()
  const { theme, toggleTheme } = useTheme()

  /* ---------- Edit profile state ---------- */
  const [fullName, setFullName] = useState(user?.fullName || '')
  const [email, setEmail] = useState(user?.email || '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    setFullName(user?.fullName || '')
    setEmail(user?.email || '')
  }, [user?.fullName, user?.email])

  /* ---------- Change password state ---------- */
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  const initials = (user?.fullName || user?.username || 'U')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('')

  /* ---------- handlers ---------- */

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    setProfileMsg(null)
    if (!fullName.trim()) {
      setProfileMsg({ tone: 'danger', text: 'Full name is required.' })
      return
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setProfileMsg({ tone: 'danger', text: 'Enter a valid email address.' })
      return
    }
    setSavingProfile(true)
    try {
      const res = await apiFetch('auth/me', {
        method: 'PUT',
        body: JSON.stringify({ fullName: fullName.trim(), email: email.trim() })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Save failed'))
      const body = await res.json()
      // Update the auth context so the rest of the app sees the new name/email.
      if (body.user && token) {
        login(token, body.user)
      }
      setProfileMsg({ tone: 'success', text: 'Profile updated successfully.' })
    } catch (err) {
      setProfileMsg({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setSavingProfile(false)
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordMsg(null)
    if (!currentPassword) {
      setPasswordMsg({ tone: 'danger', text: 'Enter your current password.' })
      return
    }
    if (!newPassword || newPassword.length < 8) {
      setPasswordMsg({ tone: 'danger', text: 'New password must be at least 8 characters.' })
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ tone: 'danger', text: 'New password and confirmation do not match.' })
      return
    }
    setChangingPassword(true)
    try {
      const res = await apiFetch('auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Password change failed'))
      setPasswordMsg({ tone: 'success', text: 'Password changed successfully.' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setPasswordMsg({ tone: 'danger', text: getDisplayError(err) })
    } finally {
      setChangingPassword(false)
    }
  }

  return (
    <>
      <PageHero
        eyebrow="My account"
        eyebrowIcon="pi-user"
        title="Profile & preferences"
        subtitle="Update your identity, change your password and switch the portal theme."
      />

      {/* ============ Identity + appearance ============ */}
      <div className="grid-charts">
        {/* Identity card */}
        <section className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-id-card" style={{ color: 'var(--brand-600)' }} /> Identity
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '1.65rem',
                boxShadow: 'inset 0 -4px 10px rgba(0,0,0,0.14)'
              }}
            >
              {initials}
            </div>
            <div>
              <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 800, color: 'var(--text-primary)' }}>
                {user?.fullName || user?.username}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{user?.email}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Field label="Username" value={user?.username || '—'} />
            <Field label="Role"     value={user?.role || '—'} />
            <Field label="User ID"  value={String(user?.userId || '—')} />
            <Field
              label="Last login"
              value={user?.lastLogin ? new Date(user.lastLogin).toLocaleString('en-IN') : '—'}
            />
          </div>
        </section>

        {/* Appearance card */}
        <section className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-palette" style={{ color: 'var(--accent-violet)' }} /> Appearance
          </h3>
          <div className="glass-card__subtitle">Change how the portal looks across every page.</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.75rem' }}>
            <ThemeSwatch
              label="Light"
              active={theme === 'light'}
              preview="linear-gradient(135deg, #f8fafc 0%, #e0f2fe 100%)"
              onClick={() => theme !== 'light' && toggleTheme()}
            />
            <ThemeSwatch
              label="Dark"
              active={theme === 'dark'}
              preview="linear-gradient(135deg, #0b1120 0%, #1e293b 100%)"
              onClick={() => theme !== 'dark' && toggleTheme()}
            />
          </div>
        </section>
      </div>

      {/* ============ Edit profile ============ */}
      <section className="glass-card">
        <h3 className="glass-card__title">
          <i className="pi pi-pencil" style={{ color: 'var(--accent-emerald)' }} /> Edit profile
        </h3>
        <div className="glass-card__subtitle">Update your display name and contact email.</div>
        <form onSubmit={handleSaveProfile}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '1rem',
              marginTop: '0.85rem'
            }}
          >
            <TextInput label="Full name *" value={fullName} onChange={setFullName} autoComplete="name" />
            <TextInput label="Email *"     value={email}    onChange={setEmail} type="email" autoComplete="email" />
          </div>

          {profileMsg && (
            <div
              style={{
                marginTop: '0.9rem',
                padding: '0.7rem 0.9rem',
                borderRadius: 'var(--radius-md)',
                border: `1px solid var(--status-${profileMsg.tone}-ring)`,
                background: `var(--status-${profileMsg.tone}-bg)`,
                color: `var(--status-${profileMsg.tone}-fg)`,
                fontSize: '0.86rem',
                fontWeight: 600
              }}
            >
              <i className={`pi ${profileMsg.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} /> {profileMsg.text}
            </div>
          )}

          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <button type="submit" className="action-btn" disabled={savingProfile}>
              {savingProfile
                ? <><i className="pi pi-spin pi-spinner" /> Saving…</>
                : <><i className="pi pi-check" /> Save changes</>}
            </button>
            <button
              type="button"
              className="action-btn action-btn--ghost"
              onClick={() => {
                setFullName(user?.fullName || '')
                setEmail(user?.email || '')
                setProfileMsg(null)
              }}
              disabled={savingProfile}
            >
              <i className="pi pi-replay" /> Reset
            </button>
          </div>
        </form>
      </section>

      {/* ============ Change password ============ */}
      <section className="glass-card">
        <h3 className="glass-card__title">
          <i className="pi pi-key" style={{ color: 'var(--accent-amber)' }} /> Change password
        </h3>
        <div className="glass-card__subtitle">Minimum 8 characters. You'll stay signed in after the change.</div>
        <form onSubmit={handleChangePassword}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '1rem',
              marginTop: '0.85rem'
            }}
          >
            <PasswordInput
              label="Current password *"
              value={currentPassword}
              onChange={setCurrentPassword}
              show={showCurrent}
              onToggleShow={() => setShowCurrent((v) => !v)}
              autoComplete="current-password"
            />
            <PasswordInput
              label="New password *"
              value={newPassword}
              onChange={setNewPassword}
              show={showNew}
              onToggleShow={() => setShowNew((v) => !v)}
              autoComplete="new-password"
            />
            <PasswordInput
              label="Confirm new password *"
              value={confirmPassword}
              onChange={setConfirmPassword}
              show={showNew}
              onToggleShow={() => setShowNew((v) => !v)}
              autoComplete="new-password"
            />
          </div>

          {passwordMsg && (
            <div
              style={{
                marginTop: '0.9rem',
                padding: '0.7rem 0.9rem',
                borderRadius: 'var(--radius-md)',
                border: `1px solid var(--status-${passwordMsg.tone}-ring)`,
                background: `var(--status-${passwordMsg.tone}-bg)`,
                color: `var(--status-${passwordMsg.tone}-fg)`,
                fontSize: '0.86rem',
                fontWeight: 600
              }}
            >
              <i className={`pi ${passwordMsg.tone === 'success' ? 'pi-check-circle' : 'pi-exclamation-triangle'}`} /> {passwordMsg.text}
            </div>
          )}

          <div style={{ marginTop: '1rem' }}>
            <button type="submit" className="action-btn" disabled={changingPassword}>
              {changingPassword
                ? <><i className="pi pi-spin pi-spinner" /> Updating…</>
                : <><i className="pi pi-lock" /> Change password</>}
            </button>
          </div>
        </form>
      </section>
    </>
  )
}

/* ==================== small inputs ==================== */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 'var(--fs-xs)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
          fontWeight: 700
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-primary)', fontWeight: 600, marginTop: '0.2rem' }}>
        {value}
      </div>
    </div>
  )
}

function ThemeSwatch({
  label,
  active,
  preview,
  onClick
}: {
  label: string
  active: boolean
  preview: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
        padding: '0.9rem',
        borderRadius: 'var(--radius-lg)',
        border: `2px solid ${active ? 'var(--brand-500)' : 'var(--border-subtle)'}`,
        background: 'var(--surface-0)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit'
      }}
    >
      <div style={{ height: 72, borderRadius: 'var(--radius-md)', background: preview, border: '1px solid var(--border-subtle)' }} />
      <div style={{ fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        {active && <i className="pi pi-check-circle" style={{ color: 'var(--brand-600)' }} />}
        {label}
      </div>
    </button>
  )
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoComplete?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-muted)'
        }}
      >
        {label}
      </span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
      />
    </label>
  )
}

function PasswordInput({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  autoComplete
}: {
  label: string
  value: string
  onChange: (v: string) => void
  show: boolean
  onToggleShow: () => void
  autoComplete?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-muted)'
        }}
      >
        {label}
      </span>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, paddingRight: '2.4rem' }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--brand-500)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-subtle)')}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
          style={{
            position: 'absolute',
            right: '0.5rem',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 0,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '0.3rem'
          }}
        >
          <i className={`pi ${show ? 'pi-eye-slash' : 'pi-eye'}`} />
        </button>
      </div>
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.7rem 0.85rem',
  borderRadius: 'var(--radius-md)',
  border: '1.5px solid var(--border-subtle)',
  background: 'var(--surface-0)',
  color: 'var(--text-primary)',
  fontSize: '0.92rem',
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 160ms var(--ease-out)'
}

export default ProfilePage
