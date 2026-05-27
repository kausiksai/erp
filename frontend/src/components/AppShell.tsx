import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../contexts/ThemeContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'

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

/**
 * Sidebar navigation — redesign IA.
 *
 * 4 groups / 14 items, down from 5 / 19. The shrinkage happens by:
 *   - Receipts merges GRN, ASN, Delivery Challans and Schedules into one
 *   - Settings absorbs Profile, Users, Owners and Open PO prefixes
 *   - Incomplete POs is now a tab inside Purchase orders
 *   - Old "Dashboard" / "Analytics" / "Needs reconciliation" labels become
 *     "Workspace" / "Insights" / "Reconciliation"
 *
 * Routes that no longer have a sidebar entry (e.g. /grn) keep working —
 * App.tsx still defines them and they redirect to their consolidated home.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { to: '/',                          label: 'Workspace',      icon: 'pi-home' },
      { to: '/invoices/validate',         label: 'Invoices',       icon: 'pi-file' },
      { to: '/invoices/upload',           label: 'Upload invoice', icon: 'pi-upload' },
      { to: '/invoices/reconciliation',   label: 'Needs attention', icon: 'pi-sync' },
      { to: '/payments/approve',          label: 'Payments',       icon: 'pi-wallet' }
    ]
  },
  {
    label: 'Documents',
    items: [
      { to: '/purchase-orders', label: 'Purchase orders', icon: 'pi-shopping-cart' },
      { to: '/receipts',        label: 'Receipts',        icon: 'pi-box' },
      { to: '/suppliers',       label: 'Suppliers',       icon: 'pi-users', roles: ['admin', 'manager'] }
    ]
  },
  {
    label: 'Insights',
    items: [
      { to: '/insights',            label: 'Insights',           icon: 'pi-chart-line' },
      { to: '/items/price-history', label: 'Item price history', icon: 'pi-history' },
      { to: '/reports',             label: 'Reports',            icon: 'pi-chart-bar' }
    ]
  },
  {
    label: 'System',
    items: [
      { to: '/rules',      label: 'Validation rules', icon: 'pi-shield' },
      { to: '/audit',      label: 'Audit log',        icon: 'pi-history' },
      { to: '/automation', label: 'Automation',       icon: 'pi-server', roles: ['admin'] },
      { to: '/settings',   label: 'Settings',         icon: 'pi-cog' }
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
  const { allowedPaths, loading: menuLoading } = useMenuAccess()

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

  // Escape closes the user menu overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && userMenuOpen) setUserMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
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
              // Visibility = role gate (legacy) AND per-user allowlist
              // (from MenuAccessContext). While the allowlist is loading we
              // show nothing except role-gated defaults to avoid flashing
              // restricted items.
              const visibleItems = group.items.filter((it) => {
                if (it.roles && !it.roles.includes(role)) return false
                if (menuLoading) return false
                return allowedPaths.has(it.to)
              })
              if (visibleItems.length === 0) return null
              return (
                <div className="sidebar__group" key={group.label}>
                  <div className="sidebar__groupLabel">{group.label}</div>
                  {visibleItems.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      // `end` forces exact-match so a child route like
                      // /purchase-orders/incomplete doesn't also light up the
                      // parent /purchase-orders NavLink.
                      end
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

          <div style={{ flex: 1 }} />

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
