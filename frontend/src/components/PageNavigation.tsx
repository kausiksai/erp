import { useNavigate } from 'react-router-dom'
import { Button } from 'primereact/button'
import styles from './PageNavigation.module.css'

interface PageNavigationProps {
  showBack?: boolean
  showHome?: boolean
}

function PageNavigation({ showBack = true, showHome = true }: PageNavigationProps) {
  const navigate = useNavigate()

  return (
    <div className={styles.navigationButtons}>
      {showBack && (
        <Button
          icon="pi pi-arrow-left"
          onClick={() => navigate(-1)}
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
