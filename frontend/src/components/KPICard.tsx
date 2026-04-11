import type { ReactNode } from 'react'

export type KPIVariant = 'brand' | 'violet' | 'emerald' | 'amber' | 'rose' | 'slate'

interface KPICardProps {
  label: string
  value: ReactNode
  icon?: string               // PrimeIcons class (e.g. 'pi-file')
  variant?: KPIVariant
  delta?: { value: string; direction: 'up' | 'down' | 'flat' }
  footer?: ReactNode
  onClick?: () => void
}

function KPICard({ label, value, icon = 'pi-chart-line', variant = 'brand', delta, footer, onClick }: KPICardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`stat-card stat-card--${variant}`}
      style={{ border: 0, textAlign: 'left', cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="stat-card__icon">
        <i className={`pi ${icon}`} aria-hidden />
      </div>
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {delta && (
        <div className={`stat-card__delta stat-card__delta--${delta.direction}`}>
          <i className={`pi ${delta.direction === 'up' ? 'pi-arrow-up-right' : delta.direction === 'down' ? 'pi-arrow-down-right' : 'pi-minus'}`} />
          {delta.value}
        </div>
      )}
      {footer && <div className="stat-card__footer">{footer}</div>}
    </button>
  )
}

export default KPICard
