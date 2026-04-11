import type { ReactNode } from 'react'

interface PageHeroProps {
  eyebrow?: string
  eyebrowIcon?: string
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

function PageHero({ eyebrow, eyebrowIcon = 'pi-star', title, subtitle, actions }: PageHeroProps) {
  return (
    <section className="pageHero fade-in-up">
      <div className="pageHero__left">
        {eyebrow && (
          <span className="pageHero__eyebrow">
            <i className={`pi ${eyebrowIcon}`} aria-hidden />
            {eyebrow}
          </span>
        )}
        <h1 className="pageHero__title">{title}</h1>
        {subtitle && <p className="pageHero__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="pageHero__actions">{actions}</div>}
    </section>
  )
}

export default PageHero
