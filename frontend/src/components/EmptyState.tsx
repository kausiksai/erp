import { ReactNode } from 'react'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

function EmptyState({ icon = 'pi pi-inbox', title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`${styles.emptyState} ${className}`.trim()} role="status" aria-live="polite">
      <div className={styles.iconWrap}>
        <i className={`pi ${icon}`} aria-hidden />
      </div>
      <h2 className={styles.title}>{title}</h2>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  )
}

export default EmptyState
