import type { ReactNode, CSSProperties } from 'react'

/**
 * Standard content card with a header (icon + title + optional meta /
 * actions) and a body.
 *
 *   <SectionCard
 *     icon="pi-file"
 *     title="Header"
 *     meta="last refreshed 2 min ago"
 *     actions={<button className="action-btn action-btn--ghost">Export</button>}
 *   >
 *     ... content ...
 *   </SectionCard>
 *
 * Use `flush` to drop the body padding (for tables that should run edge-to-
 * edge inside the card).
 */
interface SectionCardProps {
  icon?: string                // PrimeIcons class, e.g. 'pi-file'
  title: ReactNode
  meta?: ReactNode             // Right-aligned meta line in the header
  actions?: ReactNode          // Right-side button strip
  flush?: boolean              // No body padding
  bodyStyle?: CSSProperties
  className?: string
  children: ReactNode
}

function SectionCard({ icon, title, meta, actions, flush, bodyStyle, className, children }: SectionCardProps) {
  return (
    <section className={`glass-card section-card ${className ?? ''}`} style={{ padding: 0, overflow: 'hidden' }}>
      <header className="section-card__header">
        <h3 className="section-card__title">
          {icon && <i className={`pi ${icon}`} aria-hidden />}
          <span>{title}</span>
        </h3>
        {meta && <span className="section-card__meta">{meta}</span>}
        {actions && <div className="section-card__actions">{actions}</div>}
      </header>
      <div
        className="section-card__body"
        style={flush ? { padding: 0, ...bodyStyle } : bodyStyle}
      >
        {children}
      </div>
    </section>
  )
}

export default SectionCard
