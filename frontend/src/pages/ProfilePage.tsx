import { useState } from 'react'
import PageHero from '../components/PageHero'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'

interface ProfilePageProps { embedded?: boolean }

function ProfilePage({ embedded = false }: ProfilePageProps = {}) {
  const { user } = useAuth()
  const { theme, toggleTheme } = useTheme()

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

  /* Pulled from mockup Settings profile pane:
       – Gradient banner header (90px) with overlapping 96×96 avatar
       – Chip row: Role · Online · Member since
       – Sign out + Edit profile actions
       – Two-column row: Personal information + Activity (4 stat tiles)
       – Change password card with a 3-input form
     "Activity" numbers are placeholders that match the mockup until the
     /api/auth/me/activity endpoint is wired. */
  const memberSinceLabel = (() => {
    const u = user as typeof user & { createdAt?: string | null }
    if (!u?.createdAt) return 'Member'
    const d = new Date(u.createdAt)
    return `Member since ${d.toLocaleString('en-IN', { month: 'short', year: 'numeric' })}`
  })()

  return (
    <>
      {!embedded && (
        <PageHero
          eyebrow="System"
          eyebrowIcon="pi-user"
          title="Profile"
          subtitle="Manage your profile, password, and appearance."
        />
      )}

      {/* ====== Profile header card (gradient banner + overlapping avatar) ====== */}
      <section
        className="glass-card"
        style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}
      >
        <div
          style={{
            height: 90,
            background: 'linear-gradient(135deg, #2563eb 0%, #06b6d4 50%, #8b5cf6 100%)',
            position: 'relative'
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(400px 180px at 80% 100%, rgba(255,255,255,0.18) 0%, transparent 60%)'
            }}
          />
        </div>
        <div
          style={{
            padding: '0 26px 22px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            alignItems: 'flex-end',
            marginTop: -40,
            position: 'relative'
          }}
        >
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 24,
              background: 'linear-gradient(135deg, var(--brand-600), var(--accent-cyan))',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 700,
              fontSize: 36,
              letterSpacing: '-0.02em',
              border: '5px solid var(--surface-0)',
              boxShadow: 'var(--shadow-md)',
              flexShrink: 0
            }}
          >
            {initials}
          </div>
          <div style={{ flex: 1, minWidth: 240, paddingBottom: 6 }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              {user?.fullName || user?.username}
            </div>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {user?.email}
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="status-chip status-chip--violet" style={{ textTransform: 'capitalize' }}>
                {user?.role || 'user'}
              </span>
              <span className="status-chip status-chip--success">Online</span>
              <span className="status-chip status-chip--muted">{memberSinceLabel}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, paddingBottom: 6 }}>
            <button
              type="button"
              className="action-btn action-btn--ghost"
              style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)' }}
              onClick={toggleTheme}
              title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            >
              <i className={`pi ${theme === 'light' ? 'pi-moon' : 'pi-sun'}`} /> {theme === 'light' ? 'Dark' : 'Light'}
            </button>
          </div>
        </div>
      </section>

      {/* ====== Personal info + Activity ====== */}
      <div className="grid-charts" style={{ marginBottom: 16 }}>
        <section className="glass-card" style={{ padding: 0 }}>
          <div className="section-card__header">
            <div className="section-card__title"><i className="pi pi-id-card" /> Personal information</div>
          </div>
          <div className="section-card__body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 22px' }}>
              <Field label="Full name"  value={user?.fullName || '—'} />
              <Field label="Username"   value={user?.username || '—'} />
              <Field label="Email"      value={user?.email || '—'} />
              <Field label="Role"       value={user?.role || '—'} />
              <Field label="User ID"    value={String(user?.userId || '—')} />
              <Field label="Last login" value={user?.lastLogin ? new Date(user.lastLogin).toLocaleString('en-IN') : '—'} />
            </div>
          </div>
        </section>

        <section className="glass-card" style={{ padding: 0 }}>
          <div className="section-card__header">
            <div className="section-card__title"><i className="pi pi-chart-bar" /> Your activity</div>
          </div>
          <div className="section-card__body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ActivityTile label="Invoices reviewed" value="—"  hint="last 30 days" tint="brand" />
              <ActivityTile label="Approvals issued" value="—"  hint="last 30 days" tint="emerald" />
              <ActivityTile label="Last login"        value={user?.lastLogin ? 'Today' : '—'} hint="from this account" tint="violet" />
              <ActivityTile label="Active sessions"   value="1" hint="this device" tint="amber" />
            </div>
          </div>
        </section>
      </div>

      {/* ============ Change password ============ */}
      <section className="glass-card" style={{ padding: 0 }}>
        <div className="section-card__header">
          <div className="section-card__title"><i className="pi pi-lock" /> Change password</div>
          <span className="section-card__meta">Use 12+ characters with a mix of letters, numbers, and symbols</span>
        </div>
        <div className="section-card__body">
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
                : <><i className="pi pi-lock" /> Update password</>}
            </button>
          </div>
        </form>
        </div>
      </section>
    </>
  )
}

/* Single tile in the "Your activity" 2×2 grid on the Profile pane. */
function ActivityTile({
  label,
  value,
  hint,
  tint
}: {
  label: string
  value: string
  hint?: string
  tint: 'brand' | 'emerald' | 'violet' | 'amber'
}) {
  const tintBg =
    tint === 'brand'   ? 'linear-gradient(135deg, rgba(37,99,235,0.06), rgba(6,182,212,0.06))' :
    tint === 'emerald' ? 'linear-gradient(135deg, rgba(16,185,129,0.06), rgba(20,184,166,0.08))' :
    tint === 'violet'  ? 'linear-gradient(135deg, rgba(139,92,246,0.06), rgba(99,102,241,0.06))' :
                         'linear-gradient(135deg, rgba(245,158,11,0.06), rgba(251,191,36,0.08))'
  return (
    <div style={{
      padding: 14,
      borderRadius: 'var(--radius-md)',
      background: tintBg,
      border: '1px solid var(--border-subtle)'
    }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
        {value}
      </div>
      {hint && <div className="muted" style={{ fontSize: 11 }}>{hint}</div>}
    </div>
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
