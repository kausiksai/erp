import PageHero from '../components/PageHero'
import { useNavigate } from 'react-router-dom'

interface SettingCard {
  icon: string
  title: string
  description: string
  action: { label: string; path: string }
  color: string
}

const CARDS: SettingCard[] = [
  {
    icon: 'pi-users',
    title: 'Suppliers',
    description: 'Vendor master — codes, GSTIN, addresses, contacts, banking.',
    action: { label: 'Open suppliers', path: '/suppliers/registration' },
    color: '#3b82f6'
  },
  {
    icon: 'pi-user',
    title: 'Users & roles',
    description: 'Create portal users, assign roles (admin / manager / finance / user) and menu access.',
    action: { label: 'Manage users', path: '/users/registration' },
    color: '#8b5cf6'
  },
  {
    icon: 'pi-id-card',
    title: 'Company (Owner)',
    description: 'Edit the operating entity — name, GSTIN, PAN, bank, address — used on documents.',
    action: { label: 'Edit company', path: '/owners/details' },
    color: '#10b981'
  },
  {
    icon: 'pi-tag',
    title: 'Open PO prefixes',
    description: 'PO prefixes that trigger the Open PO validation branch.',
    action: { label: 'Manage prefixes', path: '/open-po-prefixes' },
    color: '#f59e0b'
  },
  {
    icon: 'pi-user',
    title: 'My profile',
    description: 'Personal preferences — appearance, notifications, security.',
    action: { label: 'Open profile', path: '/profile' },
    color: '#f43f5e'
  },
  {
    icon: 'pi-chart-bar',
    title: 'Reports hub',
    description: 'Jump into any report — analytics, cashflow, supplier scorecard.',
    action: { label: 'Open reports', path: '/reports' },
    color: '#06b6d4'
  }
]

function SettingsPage() {
  const navigate = useNavigate()
  return (
    <>
      <PageHero
        eyebrow="Administration"
        eyebrowIcon="pi-cog"
        title="Settings"
        subtitle="Configuration, masters, users and preferences."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 'var(--space-4)'
        }}
      >
        {CARDS.map((c) => (
          <button
            key={c.title}
            type="button"
            onClick={() => navigate(c.action.path)}
            className="glass-card fade-in-up"
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem'
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 'var(--radius-md)',
                background: `linear-gradient(135deg, ${c.color}, ${c.color}cc)`,
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.2rem',
                boxShadow: `0 12px 24px -12px ${c.color}99`
              }}
            >
              <i className={`pi ${c.icon}`} />
            </div>
            <div>
              <div
                style={{
                  fontSize: 'var(--fs-lg)',
                  fontWeight: 800,
                  color: 'var(--text-primary)',
                  marginBottom: '0.3rem',
                  letterSpacing: '-0.01em'
                }}
              >
                {c.title}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                {c.description}
              </div>
            </div>
            <div
              style={{
                marginTop: 'auto',
                color: 'var(--brand-700)',
                fontWeight: 700,
                fontSize: 'var(--fs-sm)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem'
              }}
            >
              {c.action.label} <i className="pi pi-arrow-right" />
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

export default SettingsPage
