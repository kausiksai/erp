import type { ReactNode } from 'react'

export type StatVariant = 'brand' | 'violet' | 'emerald' | 'amber' | 'rose' | 'slate'

interface StatTileProps {
  label: string
  value: ReactNode
  icon?: string
  variant?: StatVariant
  sublabel?: ReactNode
  onClick?: () => void
}

function StatTile({ label, value, icon = 'pi-chart-line', variant = 'brand', sublabel, onClick }: StatTileProps) {
  const content = (
    <>
      <div className="stat-card__icon">
        <i className={`pi ${icon}`} aria-hidden />
      </div>
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {sublabel && <div className="stat-card__footer">{sublabel}</div>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        className={`stat-card stat-card--${variant}`}
        style={{ border: 0, textAlign: 'left', cursor: 'pointer' }}
        onClick={onClick}
      >
        {content}
      </button>
    )
  }

  return <div className={`stat-card stat-card--${variant}`}>{content}</div>
}

export default StatTile
