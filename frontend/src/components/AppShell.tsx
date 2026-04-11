import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'

interface NavItem {
  to: string
  label: string
  icon: string
  badge?: string
  roles?: string[]
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/',          label: 'Dashboard',  icon: 'pi-th-large' },
      { to: '/analytics', label: 'Analytics',  icon: 'pi-chart-line' },
      { to: '/reports',   label: 'Reports',    icon: 'pi-chart-bar' }
    ]
  },
  {
    label: 'Workflow',
    items: [
      { to: '/invoices/validate',          label: 'Invoices',       icon: 'pi-file' },
      { to: '/invoices/upload',            label: 'Upload invoice', icon: 'pi-upload' },
      { to: '/payments/approve',           label: 'Payments',       icon: 'pi-wallet' },
      { to: '/purchase-orders/incomplete', label: 'Incomplete POs', icon: 'pi-exclamation-circle' }
    ]
  },
  {
    label: 'Documents',
    items: [
      { to: '/purchase-orders',            label: 'Purchase orders',   icon: 'pi-shopping-cart' },
      { to: '/grn',                        label: 'GRN',               icon: 'pi-box' },
      { to: '/asn',                        label: 'ASN',               icon: 'pi-truck' },
      { to: '/delivery-challans',          label: 'Delivery challans', icon: 'pi-file-edit' },
      { to: '/po-schedules',               label: 'Schedules',         icon: 'pi-calendar' },
      { to: '/open-po-prefixes',           label: 'Open PO prefixes',  icon: 'pi-tag' }
    ]
  },
  {
    label: 'Masters',
    items: [
      { to: '/suppliers',              label: 'Suppliers', icon: 'pi-users',   roles: ['admin', 'manager'] },
      { to: '/users/registration',     label: 'Users',     icon: 'pi-user',    roles: ['admin', 'manager'] },
      { to: '/owners/details',         label: 'Owners',    icon: 'pi-id-card', roles: ['admin'] }
    ]
  },
  {
    label: 'System',
    items: [
      { to: '/profile',  label: 'Profile',  icon: 'pi-user-edit' },
      { to: '/settings', label: 'Settings', icon: 'pi-cog' },
      { to: '/modules',  label: 'All modules', icon: 'pi-th-large' }
    ]
  }
]

function initialsOf(user: { fullName?: string | null; username?: string | null } | null): string {
  const source = user?.fullName || user?.username || 'U'
  return source.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || 'U'
}

interface AppShellProps {
  children: ReactNode
}

function AppShell({ children }: AppShellProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('sidebarCollapsed') === '1'
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    setMobileOpen(false)
    setUserMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!userMenuOpen) return
    const handle = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [userMenuOpen])

  const role = (user?.role || 'user').toLowerCase()
  const initials = initialsOf(user)

  const shellClass = [
    'shell',
    collapsed ? 'shell--collapsed' : '',
    mobileOpen ? 'shell--mobile-open' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={shellClass}>
      <div className="shell__mobile-overlay" onClick={() => setMobileOpen(false)} aria-hidden />

      {/* ===== Sidebar ===== */}
      <aside className="shell__sidebar" aria-label="Primary navigation">
        <nav className="sidebar">
          <Link to="/" className="sidebar__brand">
            <div className="sidebar__mark">
              <i className="pi pi-bolt" aria-hidden />
            </div>
            <div className="sidebar__brandText">
              <span className="sidebar__brandCompany">Srimukha Precision</span>
              <span className="sidebar__brandProduct">Billing &amp; Payments</span>
            </div>
          </Link>

          <div className="sidebar__nav">
            {NAV_GROUPS.map((group) => {
              const visibleItems = group.items.filter(
                (it) => !it.roles || it.roles.includes(role)
              )
              if (visibleItems.length === 0) return null
              return (
                <div className="sidebar__group" key={group.label}>
                  <div className="sidebar__groupLabel">{group.label}</div>
                  {visibleItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) =>
                        `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
                      }
                      title={item.label}
                    >
                      <i className={`pi ${item.icon} sidebar__linkIcon`} aria-hidden />
                      <span className="sidebar__linkLabel">{item.label}</span>
                      {item.badge && <span className="sidebar__linkBadge">{item.badge}</span>}
                    </NavLink>
                  ))}
                </div>
              )
            })}
          </div>

          <div className="sidebar__footer">
            <button
              type="button"
              className="sidebar__footerBtn"
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <i className={`pi ${collapsed ? 'pi-angle-double-right' : 'pi-angle-double-left'}`} />
            </button>
            <button
              type="button"
              className="sidebar__footerBtn"
              onClick={toggleTheme}
              title={theme === 'light' ? 'Switch to dark' : 'Switch to light'}
              aria-label="Toggle theme"
            >
              <i className={`pi ${theme === 'light' ? 'pi-moon' : 'pi-sun'}`} />
            </button>
          </div>
        </nav>
      </aside>

      {/* ===== Topbar ===== */}
      <header className="shell__topbar">
        <div className="shellTopbar">
          <button
            type="button"
            className="shellTopbar__burger"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <i className="pi pi-bars" />
          </button>

          <div className="shellTopbar__search">
            <i className="pi pi-search shellTopbar__searchIcon" aria-hidden />
            <input
              type="search"
              className="shellTopbar__searchInput"
              placeholder="Search invoices, POs, suppliers…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                  const q = (e.target as HTMLInputElement).value.trim()
                  navigate(`/invoices/validate?q=${encodeURIComponent(q)}`)
                }
              }}
            />
            <kbd className="shellTopbar__kbd">⌘K</kbd>
          </div>

          <div className="shellTopbar__actions">
            <button
              type="button"
              className="shellTopbar__iconBtn"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              title={theme === 'light' ? 'Dark mode' : 'Light mode'}
            >
              <i className={`pi ${theme === 'light' ? 'pi-moon' : 'pi-sun'}`} />
            </button>
            <button
              type="button"
              className="shellTopbar__iconBtn"
              aria-label="Notifications"
              title="Notifications"
            >
              <i className="pi pi-bell" />
              <span className="shellTopbar__dot" aria-hidden />
            </button>

            <div className="shellTopbar__user" ref={userMenuRef}>
              <button
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                aria-expanded={userMenuOpen}
                aria-haspopup="menu"
                style={{ background: 'transparent', border: 0, padding: 0, display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer' }}
              >
                <div className="shellTopbar__avatar">{initials}</div>
                <div className="shellTopbar__userText">
                  <span className="shellTopbar__userName">{user?.fullName || user?.username || 'User'}</span>
                  <span className="shellTopbar__userRole">{role}</span>
                </div>
                <i className={`pi ${userMenuOpen ? 'pi-chevron-up' : 'pi-chevron-down'}`} style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }} />
              </button>
              {userMenuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 10px)',
                    right: 0,
                    minWidth: 240,
                    background: 'var(--surface-0)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-xl)',
                    boxShadow: 'var(--shadow-xl)',
                    padding: '0.5rem',
                    zIndex: 70,
                    animation: 'fadeInUp 180ms var(--ease-out) both'
                  }}
                >
                  <div style={{ padding: '0.5rem 0.75rem' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 'var(--fs-sm)' }}>
                      {user?.fullName || user?.username}
                    </div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                      {user?.email}
                    </div>
                  </div>
                  <div style={{ height: 1, background: 'var(--border-subtle)', margin: '0.35rem 0' }} />
                  <button
                    type="button"
                    onClick={() => {
                      setUserMenuOpen(false)
                      logout()
                      navigate('/login')
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.65rem',
                      padding: '0.6rem 0.8rem',
                      background: 'transparent',
                      border: 0,
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--status-danger-fg)',
                      cursor: 'pointer',
                      fontSize: 'var(--fs-sm)'
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--status-danger-bg)' }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent' }}
                  >
                    <i className="pi pi-sign-out" /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ===== Main ===== */}
      <main className="shell__main">
        <div className="shellMain">{children}</div>
      </main>
    </div>
  )
}

export default AppShell
