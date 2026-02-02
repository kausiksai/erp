import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

/**
 * Listens for auth:session-expired (dispatched by api.ts on 401/403).
 * Clears auth state and redirects to login.
 */
export default function SessionExpiredHandler() {
  const navigate = useNavigate()
  const { logout } = useAuth()

  useEffect(() => {
    const handleSessionExpired = () => {
      logout()
      navigate('/login', { replace: true })
    }
    window.addEventListener('auth:session-expired', handleSessionExpired)
    return () => window.removeEventListener('auth:session-expired', handleSessionExpired)
  }, [logout, navigate])

  return null
}
