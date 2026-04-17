import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'

interface ProtectedRouteProps {
  children: React.ReactNode
  requiredRole?: string[]
}

export default function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const { isAuthenticated, user, loading } = useAuth()
  const { loading: menuLoading, canAccess } = useMenuAccess()
  const location = useLocation()

  if (loading || menuLoading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh'
      }}>
        <i className="pi pi-spin pi-spinner" style={{ fontSize: '2rem' }}></i>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (requiredRole && user && !requiredRole.includes(user.role)) {
    return <AccessDenied reason="role" />
  }

  // Per-user menu access gate. If the user's allowlist forbids this path
  // deny here even though the role check passed. Matches strip dynamic
  // segments so /invoices/validate/42 resolves against /invoices/validate.
  if (!canAccess(location.pathname)) {
    return <AccessDenied reason="menu" />
  }

  return <>{children}</>
}

function AccessDenied({ reason }: { reason: 'role' | 'menu' }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      gap: '1rem',
      padding: '2rem',
      textAlign: 'center'
    }}>
      <i className="pi pi-lock" style={{ fontSize: '3rem', color: '#dc2626' }}></i>
      <h2>Access denied</h2>
      <p style={{ color: 'var(--text-muted)', maxWidth: 480 }}>
        {reason === 'role'
          ? "Your role doesn't permit this page."
          : "This page isn't part of your menu access. Ask an admin to grant it from Users \u2192 Access."}
      </p>
    </div>
  )
}
