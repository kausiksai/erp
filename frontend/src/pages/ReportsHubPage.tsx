import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'

interface ReportCard {
  icon: string
  title: string
  description: string
  to: string
  accent: string
}

const REPORTS: ReportCard[] = [
  {
    icon: 'pi-chart-line',
    title: 'Analytics hub',
    description: 'Unified view — status mix, monthly volume, cashflow, top suppliers and data quality signals.',
    to: '/analytics',
    accent: '#6366f1'
  },
  {
    icon: 'pi-shopping-cart',
    title: 'Purchase orders',
    description: 'Every active PO, amendments, and cumulative spend against each supplier.',
    to: '/purchase-orders',
    accent: '#8b5cf6'
  },
  {
    icon: 'pi-exclamation-circle',
    title: 'Incomplete POs',
    description: 'POs missing supporting documents (GRN, ASN, DC, schedule) that need follow-up.',
    to: '/purchase-orders/incomplete',
    accent: '#f43f5e'
  },
  {
    icon: 'pi-wallet',
    title: 'Payments history',
    description: 'Every payment released, grouped by supplier, mode and date.',
    to: '/payments/history',
    accent: '#10b981'
  },
  {
    icon: 'pi-users',
    title: 'Supplier directory',
    description: 'Master view of vendors with concentration and performance signals.',
    to: '/suppliers',
    accent: '#06b6d4'
  },
  {
    icon: 'pi-box',
    title: 'GRN ledger',
    description: 'All goods-receipt notes captured, chronologically and by PO.',
    to: '/grn',
    accent: '#f59e0b'
  }
]

function ReportsHubPage() {
  const navigate = useNavigate()
  return (
    <>
      <PageHero
        eyebrow="Reports"
        eyebrowIcon="pi-chart-bar"
        title="Reports & insights"
        subtitle="Cross-cutting views of your invoice pipeline, supplier concentration, cashflow and compliance — all in one place."
        actions={
          <button className="action-btn" onClick={() => navigate('/analytics')}>
            <i className="pi pi-chart-line" /> Open analytics
          </button>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 'var(--space-4)'
        }}
      >
        {REPORTS.map((r) => (
          <button
            key={r.to}
            type="button"
            onClick={() => navigate(r.to)}
            className="glass-card fade-in-up"
            style={{
              textAlign: 'left',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.85rem',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 'var(--radius-md)',
                background: `linear-gradient(135deg, ${r.accent}, ${r.accent}cc)`,
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.3rem',
                boxShadow: `0 12px 24px -12px ${r.accent}99`
              }}
            >
              <i className={`pi ${r.icon}`} />
            </div>
            <div>
              <div
                style={{
                  fontSize: 'var(--fs-lg)',
                  fontWeight: 800,
                  color: 'var(--text-primary)',
                  marginBottom: '0.3rem',
                  letterSpacing: '-0.01em'
                }}
              >
                {r.title}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                {r.description}
              </div>
            </div>
            <div
              style={{
                marginTop: 'auto',
                color: 'var(--brand-700)',
                fontWeight: 700,
                fontSize: 'var(--fs-sm)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem'
              }}
            >
              Open <i className="pi pi-arrow-right" />
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

export default ReportsHubPage
