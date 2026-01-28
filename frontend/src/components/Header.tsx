import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from 'primereact/button'
import { useAuth } from '../contexts/AuthContext'
import styles from './Header.module.css'

const COMPANY_NAME = 'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED'

function Header() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const [isScrolled, setIsScrolled] = useState(false)

  useEffect(() => {
    let lastScrollY = window.scrollY
    let ticking = false

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentScrollY = window.scrollY
          
          // Minimize header when scrolling down past threshold, expand when at top
          if (currentScrollY > 50) {
            setIsScrolled(true)
          } else {
            setIsScrolled(false)
          }
          
          lastScrollY = currentScrollY
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const handleHomeClick = () => {
    navigate('/')
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <header className={`${styles.header} ${isScrolled ? styles.scrolled : ''}`}>
      <div className={styles.headerBackground}></div>
      <div className={styles.container}>
        <div className={styles.logoSection} onClick={handleHomeClick}>
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
              <div className={styles.userDetails}>
                <span className={styles.userName}>{user.fullName || user.username}</span>
                <span className={styles.userRole}>{user.role}</span>
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
  )
}

export default Header
