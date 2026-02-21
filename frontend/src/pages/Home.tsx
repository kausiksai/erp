import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import Header from '../components/Header'
import { Toast } from 'primereact/toast'
import { getRoleDisplayName, type UserRole } from '../config/menuConfig'
import { apiUrl, getErrorMessageFromResponse } from '../utils/api'
import { ProgressSpinner } from 'primereact/progressspinner'
import styles from './Home.module.css'

interface MenuItem {
  id: string
  title: string
  description: string
  icon: string
  path: string
  color: string
  comingSoon: boolean
  order?: number
}

interface MenuCategory {
  id: string
  title: string
  description: string
  items: MenuItem[]
}

function Home() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const toast = useRef<Toast>(null)
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [loading, setLoading] = useState(true)

  // Get user role, default to 'user' if not available
  const userRole = user?.role?.toLowerCase() || 'user'

  useEffect(() => {
    fetchMenuItems()
  }, [userRole])

  const fetchMenuItems = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl(`menu-items?role=${userRole}`), {
        headers: {
          Authorization: token ? `Bearer ${token}` : '',
        },
      })

      if (!response.ok) {
        const msg = await getErrorMessageFromResponse(response, 'Failed to load menu. Please try again.')
        toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
        setMenuCategories([])
        return
      }

      const data = await response.json()
      const categories = Array.isArray(data) ? data : []

      if (categories.length === 0 && userRole === 'admin') {
        console.warn('Admin user has no menu items. Please ensure menu_items and role_menu_access tables are populated.')
      }

      setMenuCategories(categories)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to load menu. Please try again.'
      toast.current?.show({ severity: 'error', summary: 'Error', detail: msg, life: 5000 })
      setMenuCategories([])
    } finally {
      setLoading(false)
    }
  }

  const handleMenuClick = (item: MenuItem) => {
    if (!item.comingSoon) {
      navigate(item.path)
    }
  }

  const scrollToSection = (categoryId: string) => {
    const el = document.getElementById(`section-${categoryId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (loading) {
    return (
      <div className={styles.homePage}>
        <Header />
        <Toast ref={toast} position="top-right" />
        <div id="main-content" className={styles.container} tabIndex={-1}>
          <div className={styles.loadingWrap}>
            <ProgressSpinner />
          </div>
        </div>
      </div>
    )
  }

  const totalItems = menuCategories.reduce((sum, c) => sum + c.items.length, 0)

  return (
    <div className={styles.homePage}>
      <Header />
      <Toast ref={toast} position="top-right" />
      <div id="main-content" className={styles.container} tabIndex={-1}>
        <header className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerText}>
              <p className={styles.welcomeLine}>
                <span className={styles.welcomeRole}>Signed in as {getRoleDisplayName(userRole as UserRole)}</span>
              </p>
              <h1 className={styles.pageTitle}>Dashboard</h1>
              <p className={styles.pageSubtitle}>Invoice management and payment workflows</p>
              {menuCategories.length > 0 && (
                <p className={styles.menuSummary}>
                  {menuCategories.length} categor{menuCategories.length === 1 ? 'y' : 'ies'} · {totalItems} module{totalItems !== 1 ? 's' : ''} available
                </p>
              )}
            </div>
            {menuCategories.length > 0 && (
              <nav className={styles.statsBar} aria-label="Jump to section">
                {menuCategories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={styles.statItem}
                    onClick={() => scrollToSection(category.id)}
                    style={{ '--category-color': category.items[0]?.color ?? '#2563eb' } as React.CSSProperties}
                  >
                    <i className={category.items[0]?.icon ?? 'pi pi-folder'} />
                    <span>{category.title}</span>
                    <span className={styles.statCount}>{category.items.length}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        </header>

        {menuCategories.length === 0 ? (
          <section className={styles.emptyState} aria-label="No access">
            <div className={styles.emptyIcon}>
              <i className="pi pi-lock" aria-hidden />
            </div>
            <h2 className={styles.emptyTitle}>No access yet</h2>
            <p className={styles.emptyDescription}>
              Your role ({getRoleDisplayName(userRole as UserRole)}) does not have access to any modules.
              Contact your administrator to get the right permissions.
            </p>
          </section>
        ) : (
          <div className={styles.categoriesContainer}>
            {menuCategories.map((category) => (
              <section
                key={category.id}
                id={`section-${category.id}`}
                className={styles.categorySection}
                aria-labelledby={`category-heading-${category.id}`}
              >
                <div
                  className={styles.categoryHeader}
                  style={{ '--category-color': category.items[0]?.color ?? '#2563eb' } as React.CSSProperties}
                >
                  <div className={styles.categoryHeaderInner}>
                    <span className={styles.categoryIcon} aria-hidden>
                      <i className={category.items[0]?.icon ?? 'pi pi-folder'} />
                    </span>
                    <div>
                      <h2 id={`category-heading-${category.id}`} className={styles.categoryTitle}>
                        {category.title}
                      </h2>
                      <p className={styles.categoryDescription}>{category.description}</p>
                    </div>
                  </div>
                </div>
                <div className={styles.menuGrid}>
                  {category.items.map((item: MenuItem) => (
                    <article
                      key={item.id}
                      className={`${styles.menuCard} ${item.comingSoon ? styles.comingSoon : ''}`}
                      onClick={() => handleMenuClick(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleMenuClick(item)
                        }
                      }}
                      role="button"
                      tabIndex={item.comingSoon ? -1 : 0}
                      style={{ '--card-color': item.color } as React.CSSProperties}
                      aria-label={item.comingSoon ? `${item.title} (coming soon)` : `Open ${item.title}`}
                    >
                      <div className={styles.cardHeader}>
                        <div
                          className={styles.cardIconWrapper}
                          style={{ '--icon-color': item.color } as React.CSSProperties}
                        >
                          <div className={styles.cardIconBackground} aria-hidden />
                          <i className={`${item.icon} ${styles.cardIcon}`} aria-hidden />
                          <div className={styles.cardIconGlow} aria-hidden />
                        </div>
                        {!item.comingSoon && (
                          <span className={styles.cardArrow} aria-hidden>
                            <i className="pi pi-arrow-right" />
                          </span>
                        )}
                      </div>
                      <div className={styles.cardContent}>
                        <h3 className={styles.cardTitle}>{item.title}</h3>
                        <p className={styles.cardDescription}>{item.description}</p>
                      </div>
                      {!item.comingSoon ? (
                        <div className={styles.cardFooter}>
                          <span className={styles.cardAction}>Open module</span>
                          <i className="pi pi-arrow-right" aria-hidden />
                        </div>
                      ) : (
                        <div className={styles.comingSoonBadge}>
                          <i className="pi pi-clock" aria-hidden />
                          <span>Coming soon</span>
                        </div>
                      )}
                      <div
                        className={styles.cardGradient}
                        style={{ '--card-color': item.color } as React.CSSProperties}
                        aria-hidden
                      />
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Home
