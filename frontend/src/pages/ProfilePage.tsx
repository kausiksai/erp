import { useState } from 'react'
import PageHero from '../components/PageHero'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'

function ProfilePage() {
  const { user } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [notif, setNotif] = useState({ email: true, inApp: true, dailyDigest: false })

  const initials = (user?.fullName || user?.username || 'U')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('')

  return (
    <>
      <PageHero
        eyebrow="My account"
        eyebrowIcon="pi-user"
        title="Profile & preferences"
        subtitle="Your identity, appearance, notifications and security — all in one place."
      />

      <div className="grid-charts">
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

      <section className="glass-card">
        <h3 className="glass-card__title">
          <i className="pi pi-bell" style={{ color: 'var(--accent-amber)' }} /> Notifications
        </h3>
        <div className="glass-card__subtitle">Choose how you want to be alerted about workflow events.</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Toggle
            label="Email notifications"
            description="Payment approvals, validation alerts, daily digests"
            value={notif.email}
            onChange={(v) => setNotif((n) => ({ ...n, email: v }))}
          />
          <Toggle
            label="In-app notifications"
            description="Real-time bell badge while you're logged in"
            value={notif.inApp}
            onChange={(v) => setNotif((n) => ({ ...n, inApp: v }))}
          />
          <Toggle
            label="Daily digest at 5 pm"
            description="One email summarising invoices pending attention"
            value={notif.dailyDigest}
            onChange={(v) => setNotif((n) => ({ ...n, dailyDigest: v }))}
          />
        </div>
      </section>

      <section className="glass-card">
        <h3 className="glass-card__title">
          <i className="pi pi-shield" style={{ color: 'var(--accent-emerald)' }} /> Security
        </h3>
        <div className="glass-card__subtitle">Sessions and password — keep your access safe.</div>
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <button className="action-btn action-btn--ghost"><i className="pi pi-lock" /> Change password</button>
          <button className="action-btn action-btn--ghost"><i className="pi pi-key" /> Enable 2FA</button>
          <button className="action-btn action-btn--ghost"><i className="pi pi-sign-out" /> Sign out all devices</button>
        </div>
      </section>
    </>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
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

function Toggle({
  label,
  description,
  value,
  onChange
}: {
  label: string
  description: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.85rem 0',
        borderBottom: '1px solid var(--border-subtle)',
        gap: '1rem'
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 'var(--fs-sm)' }}>{label}</div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{description}</div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-pressed={value}
        style={{
          width: 46,
          height: 26,
          borderRadius: 999,
          border: 0,
          background: value ? 'var(--brand-600)' : 'var(--surface-3)',
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 200ms var(--ease-out)'
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: value ? 23 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
            transition: 'left 200ms var(--ease-out)'
          }}
        />
      </button>
    </div>
  )
}

export default ProfilePage
