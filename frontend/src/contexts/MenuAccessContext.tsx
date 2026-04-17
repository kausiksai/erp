import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { apiFetch } from '../utils/api'
import { useAuth } from './AuthContext'

/**
 * Loads the authenticated user's effective menu access once per session
 * and exposes it as a set of allowed paths + menu_ids.
 *
 * Both the sidebar (`AppShell`) and the route guard (`ProtectedRoute`)
 * read from this context so visibility and direct-URL access stay in sync.
 *
 * Two universal paths are always allowed regardless of configuration:
 *   '/'        (Dashboard — landing page after login)
 *   '/profile' (user needs access to change their own password)
 */

interface MenuItem {
  menu_item_id: number
  menu_id: string
  title: string
  path: string
  icon?: string
  category_id?: string
  display_order?: number
}

interface MenuAccessState {
  loading: boolean
  source: 'user' | 'role' | null
  role: string | null
  items: MenuItem[]
  allowedPaths: Set<string>
  allowedMenuIds: Set<string>
  canAccess: (path: string) => boolean
  refresh: () => Promise<void>
}

const ALWAYS_ALLOWED_PATHS = new Set<string>(['/', '/profile'])

const MenuAccessContext = createContext<MenuAccessState>({
  loading: true,
  source: null,
  role: null,
  items: [],
  allowedPaths: new Set<string>(),
  allowedMenuIds: new Set<string>(),
  canAccess: () => false,
  refresh: async () => {}
})

export function MenuAccessProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<'user' | 'role' | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [items, setItems] = useState<MenuItem[]>([])

  const load = async () => {
    if (!isAuthenticated) {
      setLoading(false)
      setItems([])
      setSource(null)
      setRole(null)
      return
    }
    setLoading(true)
    try {
      const res = await apiFetch('auth/me/menu-access')
      if (res.ok) {
        const body: { source?: 'user' | 'role'; role?: string; items?: MenuItem[] } =
          await res.json()
        setSource(body.source === 'user' ? 'user' : 'role')
        setRole(body.role || null)
        setItems(Array.isArray(body.items) ? body.items : [])
      } else {
        // Non-200 → play safe: grant nothing (user only sees Dashboard + Profile).
        setItems([])
      }
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // Re-run when authentication state or role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.userId])

  const value = useMemo<MenuAccessState>(() => {
    const allowedPaths = new Set<string>(ALWAYS_ALLOWED_PATHS)
    const allowedMenuIds = new Set<string>()
    for (const it of items) {
      if (it.path) allowedPaths.add(it.path)
      if (it.menu_id) allowedMenuIds.add(it.menu_id)
    }
    const canAccess = (path: string) => {
      if (!path) return false
      if (ALWAYS_ALLOWED_PATHS.has(path)) return true
      if (allowedPaths.has(path)) return true
      // Allow child paths when the parent is allowed. e.g. /invoices/validate/42
      // should work when /invoices/validate is allowed.
      for (const p of allowedPaths) {
        if (p !== '/' && path.startsWith(p + '/')) return true
      }
      return false
    }
    return {
      loading,
      source,
      role,
      items,
      allowedPaths,
      allowedMenuIds,
      canAccess,
      refresh: load
    }
  }, [loading, source, role, items])

  return <MenuAccessContext.Provider value={value}>{children}</MenuAccessContext.Provider>
}

export function useMenuAccess() {
  return useContext(MenuAccessContext)
}
