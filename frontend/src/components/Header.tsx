import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from 'primereact/button'
import { useAuth } from '../contexts/AuthContext'
import styles from './Header.module.css'

const COMPANY_NAME = 'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED'

function formatLastLogin(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

function Header() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [isScrolled, setIsScrolled] = useState(false)
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  const SCROLL_THRESHOLD = 50

  // Primary: window/document scroll – when user scrolls the page, minimize header
  useEffect(() => {
    let ticking = false
    let cancelled = false
    const updateScrolled = () => {
      if (cancelled) return
      const scrollY = window.scrollY ?? document.documentElement.scrollTop ?? 0
      setIsScrolled(scrollY > SCROLL_THRESHOLD)
      ticking = false
    }
    const handleScroll = () => {
      if (!ticking) {
        ticking = true
        window.requestAnimationFrame(updateScrolled)
      }
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    updateScrolled()
    return () => {
      cancelled = true
      window.removeEventListener('scroll', handleScroll)
    }
  }, [])

  // Backup: Intersection Observer on sentinel below header (catches inner scroll containers)
  useEffect(() => {
    const sentinel = scrollSentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setIsScrolled(!entry.isIntersecting)
      },
      { root: null, rootMargin: '-50px 0px 0px 0px', threshold: 0 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])


  const handleHomeClick = () => {
    navigate('/')
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <>
      <header className={`${styles.header} ${isScrolled ? styles.scrolled : ''}`}>
        <a href="#main-content" className="skipLink">
          Skip to main content
        </a>
        <div className={styles.headerBackground}></div>
        <div className={styles.container}>
        <div
          className={styles.logoSection}
          onClick={handleHomeClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleHomeClick() } }}
          role="button"
          tabIndex={0}
          aria-label="Go to home"
        >
          <div className={styles.logoWrapper}>
            <div className={styles.logoBadge}>
              <div className={styles.logoInner}>
                <span className={styles.logoLetter}>S</span>
              </div>
              <div className={styles.logoGlow}></div>
            </div>
          </div>
          <div className={styles.companyInfo}>
            <div className={styles.companyNameWrapper}>
              <h1 className={styles.companyName}>{COMPANY_NAME}</h1>
              <div className={styles.companyAccent}></div>
            </div>
            <div className={styles.companyTagline}>
              <span className={styles.taglineIcon}>⚡</span>
              <span>Precision Engineering Excellence</span>
            </div>
          </div>
        </div>
        <div className={styles.headerActions}>
          {user && (
            <div className={styles.userInfo}>
              <div className={styles.userDetails} title={user.lastLogin ? `Last login: ${new Date(user.lastLogin).toLocaleString()}` : undefined}>
                <span className={styles.userName}>{user.fullName || user.username}</span>
                <span className={styles.userRole}>{user.role}{user.lastLogin ? ` · Last login ${formatLastLogin(user.lastLogin)}` : ''}</span>
              </div>
              <Button
                icon="pi pi-sign-out"
                label="Logout"
                onClick={handleLogout}
                className={styles.logoutButton}
                text
                severity="secondary"
              />
            </div>
          )}
        </div>
        <div className={styles.headerDivider}></div>
      </div>
    </header>
      <div className={styles.headerSpacer} aria-hidden="true" />
      <div ref={scrollSentinelRef} className={styles.scrollSentinel} aria-hidden="true" />
    </>
  )
}

export default Header
