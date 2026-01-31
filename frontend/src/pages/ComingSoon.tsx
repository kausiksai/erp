import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { Button } from 'primereact/button'
import styles from './ComingSoon.module.css'

function ComingSoon() {
  const navigate = useNavigate()

  return (
    <div className={styles.comingSoonPage}>
      <Header />
        <div id="main-content" className={styles.container} tabIndex={-1}>
        <div className={styles.navRow}>
          <PageNavigation />
        </div>
        <div className={styles.content}>
          <div className={styles.iconWrapper}>
            <i className="pi pi-clock"></i>
          </div>
          <h1 className={styles.title}>Coming Soon</h1>
          <p className={styles.description}>
            This feature is currently under development and will be available soon.
          </p>
          <Button
            label="Go Back to Dashboard"
            icon="pi pi-arrow-left"
            onClick={() => navigate('/')}
            className={styles.backButton}
          />
        </div>
      </div>
    </div>
  )
}

export default ComingSoon
