import { useNavigate } from 'react-router-dom'
import { Button } from 'primereact/button'
import styles from './PageNavigation.module.css'

interface PageNavigationProps {
  showBack?: boolean
  showHome?: boolean
  /** When set, Back button navigates to this path instead of history (-1). Use on detail pages for reliable back target. */
  backTo?: string
}

function PageNavigation({ showBack = true, showHome = true, backTo }: PageNavigationProps) {
  const navigate = useNavigate()

  const handleBack = () => {
    if (backTo) {
      navigate(backTo)
    } else {
      navigate(-1)
    }
  }

  return (
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
    </div>
  )
}

export default PageNavigation
