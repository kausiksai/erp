import PageHero from '../components/PageHero'

/**
 * Placeholder for redesign IA routes that haven't been migrated yet.
 *
 * Wired during Phase 1d so the new sidebar links don't 404 while we work
 * through Phase 3. Each route is replaced with its real page as the
 * migration progresses; this file gets deleted at the end of Phase 6.
 */
interface Props {
  title: string
  subtitle?: string
}

function RedesignPlaceholder({ title, subtitle }: Props) {
  return (
    <>
      <PageHero
        eyebrow="Coming in this branch"
        eyebrowIcon="pi-bolt"
        title={title}
        subtitle={subtitle ?? 'Redesigned screen — being built. The data and routes are wired; the page itself lands soon.'}
      />
      <div className="glass-card" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
        <i className="pi pi-cog" style={{ fontSize: '2rem', color: 'var(--text-muted)', marginBottom: '1rem', display: 'block' }} />
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          This screen is being migrated. Old equivalents still work via the legacy routes.
        </div>
      </div>
    </>
  )
}

export default RedesignPlaceholder
