import { Link } from 'react-router-dom'
import styles from './Breadcrumb.module.css'

export interface BreadcrumbItem {
  label: string
  path?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

function Breadcrumb({ items }: BreadcrumbProps) {
  if (!items.length) return null
  return (
    <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
      {items.map((item, i) => (
        <span key={i} className={styles.item}>
          {i > 0 && <span className={styles.sep} aria-hidden>/</span>}
          {item.path != null ? (
            <Link to={item.path} className={styles.link}>{item.label}</Link>
          ) : (
            <span className={styles.current} aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

export default Breadcrumb
