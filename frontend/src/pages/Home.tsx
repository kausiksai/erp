import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import Header from '../components/Header'
import { getRoleDisplayName, type UserRole } from '../config/menuConfig'
import { apiUrl } from '../utils/api'
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
          'Authorization': `Bearer ${token}`
        }
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.message || 'Failed to fetch menu items')
      }

      const data = await response.json()
      
      // If no menu items returned and user is admin, log a warning
      if (data.length === 0 && userRole === 'admin') {
        console.warn('Admin user has no menu items. Please ensure menu_items and role_menu_access tables are populated.')
      }
      
      setMenuCategories(data)
    } catch (error) {
      console.error('Error fetching menu items:', error)
      // Fallback to empty array if API fails
      setMenuCategories([])
    } finally {
      setLoading(false)
    }
  }

  const handleMenuClick = (item: any) => {
    if (!item.comingSoon) {
      navigate(item.path)
    }
  }

  if (loading) {
    return (
      <div className={styles.homePage}>
        <Header />
        <div className={styles.container}>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
            <ProgressSpinner />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.homePage}>
      <Header />
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div>
              <h1 className={styles.pageTitle}>Billing System Dashboard</h1>
              <p className={styles.pageSubtitle}>End-to-end billing and invoice management solution</p>
            </div>
            <div className={styles.statsBar}>
              <div className={styles.statItem}>
                <i className="pi pi-file"></i>
                <span>Invoices</span>
              </div>
              <div className={styles.statItem}>
                <i className="pi pi-shopping-cart"></i>
                <span>Purchase Orders</span>
              </div>
              <div className={styles.statItem}>
                <i className="pi pi-building"></i>
                <span>Suppliers</span>
              </div>
            </div>
          </div>
        </div>

        {menuCategories.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <i className="pi pi-lock"></i>
            </div>
            <h2 className={styles.emptyTitle}>No Access Available</h2>
            <p className={styles.emptyDescription}>
              Your current role ({getRoleDisplayName(userRole as UserRole)}) does not have access to any menu items.
              Please contact your administrator for access.
            </p>
          </div>
        ) : (
          <div className={styles.categoriesContainer}>
            {menuCategories.map((category) => (
            <div key={category.id} className={styles.categorySection}>
              <div className={styles.categoryHeader}>
                <h2 className={styles.categoryTitle}>{category.title}</h2>
                <p className={styles.categoryDescription}>{category.description}</p>
              </div>
              <div className={styles.menuGrid}>
                {category.items.map((item: any) => (
                  <div
                    key={item.id}
                    className={`${styles.menuCard} ${item.comingSoon ? styles.comingSoon : ''}`}
                    onClick={() => handleMenuClick(item)}
                    style={{ '--card-color': item.color } as React.CSSProperties}
                  >
                    <div className={styles.cardHeader}>
                      <div className={styles.cardIconWrapper} style={{ '--icon-color': item.color } as React.CSSProperties}>
                        <div className={styles.cardIconBackground}></div>
                        <i className={`${item.icon} ${styles.cardIcon}`}></i>
                        <div className={styles.cardIconGlow}></div>
                      </div>
                      {!item.comingSoon && (
                        <div className={styles.cardArrow}>
                          <i className="pi pi-arrow-right"></i>
                        </div>
                      )}
                    </div>
                    <div className={styles.cardContent}>
                      <h3 className={styles.cardTitle}>{item.title}</h3>
                      <p className={styles.cardDescription}>{item.description}</p>
                    </div>
                    {!item.comingSoon && (
                      <div className={styles.cardFooter}>
                        <span className={styles.cardAction}>Access</span>
                        <i className="pi pi-arrow-right"></i>
                      </div>
                    )}
                    {item.comingSoon && (
                      <div className={styles.comingSoonBadge}>
                        <i className="pi pi-clock"></i>
                        <span>Coming Soon</span>
                      </div>
                    )}
                    <div className={styles.cardGradient} style={{ '--card-color': item.color } as React.CSSProperties}></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Home
