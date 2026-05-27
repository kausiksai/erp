import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import ProfilePage from './ProfilePage'
import UsersPage from './UsersPage'
import OwnerPage from './OwnerPage'
import OpenPoPrefixesPage from './OpenPoPrefixesPage'

/**
 * Settings — consolidated landing for Profile, Users, Owners and
 * Open PO Prefixes. Replaces four standalone routes that the legacy IA
 * exposed in the sidebar.
 *
 *   /profile                 → Profile tab
 *   /users/registration      → Users tab        (admin/manager)
 *   /owners/details          → Owners tab       (admin)
 *   /open-po-prefixes        → Prefixes tab     (admin)
 *
 * The legacy routes still resolve and render their pages standalone.
 * From the new sidebar there's only "Settings" → this page → tabs.
 *
 * Each sub-page accepts an `embedded` prop that suppresses its own
 * <PageHero> when shown inside Settings (so we don't end up with two
 * stacked heroes per tab). OpenPoPrefixesPage uses ListPage with a
 * built-in hero — that hero stays, since suppressing it would require
 * a deeper refactor of ListPage.
 */

type Tab = 'profile' | 'users' | 'owners' | 'prefixes'

interface TabDef {
  key: Tab
  label: string
  icon: string
  /** Roles allowed to see this tab. Empty = everyone. */
  roles?: string[]
}

const TABS: TabDef[] = [
  { key: 'profile',  label: 'Profile',           icon: 'pi-user' },
  { key: 'users',    label: 'Users',             icon: 'pi-users',   roles: ['admin', 'manager'] },
  { key: 'owners',   label: 'Owners',            icon: 'pi-id-card', roles: ['admin'] },
  { key: 'prefixes', label: 'Open PO prefixes',  icon: 'pi-tag',     roles: ['admin'] }
]

function SettingsPage() {
  const { user } = useAuth()
  const role = (user?.role || 'user').toLowerCase()

  const visibleTabs = TABS.filter(t => !t.roles || t.roles.includes(role))
  const [tab, setTab] = useState<Tab>(visibleTabs[0]?.key ?? 'profile')

  return (
    <>
      {/* Hero — verbatim from mockup VIEWS.settings */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-cog" /> System</span>
          <h1>Settings</h1>
          <p>Manage your profile, users, and owners.</p>
        </div>
      </section>

      {/* Mockup-style pill tabs */}
      <div className="tabs" style={{ marginBottom: 16 }}>
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <i className={`pi ${t.icon}`} style={{ marginRight: 5 }} />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content. Each sub-page renders its own data + handlers. */}
      <div>
        {tab === 'profile'  && <ProfilePage embedded />}
        {tab === 'users'    && <UsersPage embedded />}
        {tab === 'owners'   && <OwnerPage embedded />}
        {tab === 'prefixes' && <OpenPoPrefixesPage />}
      </div>
    </>
  )
}

export default SettingsPage
