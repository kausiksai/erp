import { useNavigate } from 'react-router-dom'
import { Button } from 'primereact/button'
import styles from './PageNavigation.module.css'

interface PageNavigationProps {
  showBack?: boolean
  showHome?: boolean
  /** When set, Back button navigates to this path instead of history (-1). Use on detail pages for reliable back target. */
  backTo?: string
  /** When set, shows a Refresh button in the same row (same position on every page). */
  onRefresh?: () => void
  /** Pass when refresh is in progress so the Refresh button shows loading state. */
  refreshLoading?: boolean
}

function PageNavigation({ showBack = true, showHome = true, backTo, onRefresh, refreshLoading }: PageNavigationProps) {
  const navigate = useNavigate()

  const handleBack = () => {
    if (backTo) {
      navigate(backTo)
    } else {
      navigate(-1)
    }
  }

  return (
    <div className={styles.navWrapper}>
      <div className={styles.navigationButtons}>
      {showBack && (
        <Button
          icon="pi pi-arrow-left"
          onClick={handleBack}
          className={styles.navButton}
          rounded
          text
          severity="secondary"
          aria-label="Go back"
          tooltip="Go back"
          tooltipOptions={{ position: 'bottom' }}
        />
      )}
      {showHome && (
        <Button
          icon="pi pi-home"
          onClick={() => navigate('/')}
          className={styles.navButton}
          rounded
          text
          severity="secondary"
          aria-label="Go to home"
          tooltip="Go to home"
          tooltipOptions={{ position: 'bottom' }}
        />
      )}
      {onRefresh != null && (
        <Button
          icon="pi pi-refresh"
          onClick={onRefresh}
          loading={refreshLoading}
          className={styles.navButton}
          rounded
          text
          severity="secondary"
          aria-label="Refresh"
          tooltip="Refresh"
          tooltipOptions={{ position: 'bottom' }}
        />
      )}
      </div>
    </div>
  )
}

export default PageNavigation
