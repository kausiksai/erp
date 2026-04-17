import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import StatTile from '../components/StatTile'
import StatusChip from '../components/StatusChip'
import { apiFetch, getDisplayError } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'
import {
  formatINRCompact,
  formatINRSymbol,
  formatInt,
  formatDate,
  parseAmount
} from '../utils/format'

interface DashboardTotals {
  invoices?: number | string
  validated?: number | string
  waiting_for_validation?: number | string
  waiting_for_re_validation?: number | string
  ready_for_payment?: number | string
  paid?: number | string
  outstanding_amount?: number | string
  validated_amount?: number | string
  ready_amount?: number | string
  paid_amount?: number | string
  purchase_orders?: number | string
  fulfilled_pos?: number | string
  suppliers?: number | string
}

interface UpcomingPayment {
  invoice_id: number
  invoice_number: string
  supplier_name: string | null
  total_amount: number | string | null
  payment_due_date: string | null
  status: string | null
}

interface DashboardResponse {
  totals?: DashboardTotals
  upcomingPayments?: UpcomingPayment[]
}

interface DocTypeStats {
  total: number
  loaded: number
  validated: number
  failed: number
  skipped_duplicate: number
  skipped_unclassified: number
}

const blankStats = (): DocTypeStats => ({
  total: 0,
  loaded: 0,
  validated: 0,
  failed: 0,
  skipped_duplicate: 0,
  skipped_unclassified: 0
})

interface EmailAutomationToday {
  last_sync_at: string | null
  last_sync_status: string | null
  last_sync_error: string | null
  headline: {
    emails_received: number
    files_received: number
    files_loaded_cleanly: number
    files_needing_attention: number
    files_skipped: number
    invoices_validated: number
    invoices_pending_review: number
  }
  by_doc_type: Record<string, DocTypeStats>
}

function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [automation, setAutomation] = useState<EmailAutomationToday | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        const [r1, r2] = await Promise.all([
          apiFetch('reports/dashboard-summary'),
          apiFetch('reports/email-automation/today').catch(() => null)
        ])
        if (!r1.ok) throw new Error('Dashboard fetch failed')
        const body: DashboardResponse = await r1.json()
        if (alive) setData(body)
        if (r2 && r2.ok) {
          const abody: EmailAutomationToday = await r2.json()
          if (alive) setAutomation(abody)
        }
      } catch (err) {
        if (alive) setError(getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const totals = data?.totals ?? {}
  const upcoming = data?.upcomingPayments ?? []

  // Sort upcoming payments by due date, asc — already from backend but defensive
  const sortedUpcoming = useMemo(() => {
    const rows = [...upcoming]
    rows.sort((a, b) => {
      const da = a.payment_due_date ? new Date(a.payment_due_date).getTime() : Infinity
      const db = b.payment_due_date ? new Date(b.payment_due_date).getTime() : Infinity
      return da - db
    })
    return rows
  }, [upcoming])

  const now = Date.now()
  const overdue = sortedUpcoming.filter((r) => {
    if (!r.payment_due_date) return false
    return new Date(r.payment_due_date).getTime() < now
  })
  const dueSoon = sortedUpcoming.filter((r) => {
    if (!r.payment_due_date) return false
    const t = new Date(r.payment_due_date).getTime()
    return t >= now && t <= now + 7 * 24 * 3600 * 1000
  })

  return (
    <>
      <PageHero
        eyebrow={`${greeting}${user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}`}
        eyebrowIcon="pi-sun"
        title="Today's operations"
        subtitle="Everything that needs your attention — queues, overdue payments and shortcuts. Jump into what matters."
        actions={
          <>
            <button className="action-btn action-btn--ghost" onClick={() => navigate('/invoices/validate')}>
              <i className="pi pi-list" /> Invoices
            </button>
            <button className="action-btn" onClick={() => navigate('/invoices/upload')}>
              <i className="pi pi-upload" /> Upload invoice
            </button>
          </>
        }
      />

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--status-danger-ring)', color: 'var(--status-danger-fg)' }}>
          <i className="pi pi-exclamation-triangle" /> {error}
        </div>
      )}

      {/* Your queue — what needs attention right now */}
      <div className="section-title">
        <span className="section-title__label">Your queue</span>
        <span className="section-title__line" />
      </div>
      <div className="grid-kpis fade-in-up--stagger">
        <StatTile
          label="Waiting for validation"
          value={loading ? '—' : formatInt(totals.waiting_for_validation)}
          icon="pi-clock"
          variant="amber"
          sublabel="New invoices needing review"
          onClick={() => navigate('/invoices/validate?status=waiting_for_validation')}
        />
        <StatTile
          label="Re-validation"
          value={loading ? '—' : formatInt(totals.waiting_for_re_validation)}
          icon="pi-refresh"
          variant="rose"
          sublabel="Invoices held for a fix"
          onClick={() => navigate('/invoices/validate?status=waiting_for_re_validation')}
        />
        <StatTile
          label="Pending approval"
          value={loading ? '—' : formatInt(totals.validated)}
          icon="pi-shield"
          variant="violet"
          sublabel="Ready to approve → pay"
          onClick={() => navigate('/payments/approve')}
        />
        <StatTile
          label="Ready for payment"
          value={loading ? '—' : formatInt(totals.ready_for_payment)}
          icon="pi-wallet"
          variant="brand"
          sublabel={loading ? '' : formatINRSymbol(totals.ready_amount)}
          onClick={() => navigate('/payments/ready')}
        />
      </div>

      {/* Headline numbers */}
      <div className="section-title">
        <span className="section-title__label">At a glance</span>
        <span className="section-title__line" />
      </div>
      <div className="grid-kpis fade-in-up--stagger">
        <StatTile
          label="Outstanding"
          value={loading ? '—' : formatINRCompact(totals.outstanding_amount)}
          icon="pi-indian-rupee"
          variant="rose"
          sublabel="All unpaid invoices"
        />
        <StatTile
          label="Paid (lifetime)"
          value={loading ? '—' : formatINRCompact(totals.paid_amount)}
          icon="pi-check-circle"
          variant="emerald"
          sublabel={`${formatInt(totals.paid)} invoices`}
        />
        <StatTile
          label="Invoices"
          value={loading ? '—' : formatInt(totals.invoices)}
          icon="pi-file"
          variant="slate"
          sublabel="Across the pipeline"
          onClick={() => navigate('/invoices/validate')}
        />
        <StatTile
          label="Purchase orders"
          value={loading ? '—' : formatInt(totals.purchase_orders)}
          icon="pi-shopping-cart"
          variant="slate"
          sublabel={`${formatInt(totals.fulfilled_pos)} fulfilled`}
          onClick={() => navigate('/purchase-orders')}
        />
        <StatTile
          label="Suppliers"
          value={loading ? '—' : formatInt(totals.suppliers)}
          icon="pi-users"
          variant="slate"
          sublabel="In master"
          onClick={() => navigate('/suppliers')}
        />
      </div>

      {/* Split: upcoming payments + quick actions */}
      <div className="grid-charts">
        <section className="glass-card">
          <h3 className="glass-card__title">
            <i className="pi pi-calendar-clock" style={{ color: 'var(--accent-rose)' }} /> Payment timeline
          </h3>
          <div className="glass-card__subtitle">
            {overdue.length > 0 && (
              <span style={{ color: 'var(--status-danger-fg)', fontWeight: 700, marginRight: '0.75rem' }}>
                {overdue.length} overdue
              </span>
            )}
            {dueSoon.length > 0 && (
              <span style={{ color: 'var(--status-warn-fg)', fontWeight: 700 }}>
                {dueSoon.length} due this week
              </span>
            )}
            {overdue.length === 0 && dueSoon.length === 0 && <span>All clear for the next 7 days.</span>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
            {loading && (
              <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                <i className="pi pi-spin pi-spinner" /> Loading…
              </div>
            )}
            {!loading && sortedUpcoming.slice(0, 10).map((r) => {
              const isOverdue = r.payment_due_date && new Date(r.payment_due_date).getTime() < now
              return (
                <button
                  key={r.invoice_id}
                  type="button"
                  onClick={() => navigate(`/invoices/validate/${r.invoice_id}`)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.85rem',
                    padding: '0.75rem 0.9rem',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 160ms var(--ease-out), transform 160ms var(--ease-out)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--surface-1)'
                    e.currentTarget.style.transform = 'translateX(2px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.transform = 'translateX(0)'
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 10,
                      background: isOverdue ? 'var(--status-danger-bg)' : 'var(--status-info-bg)',
                      color: isOverdue ? 'var(--status-danger-fg)' : 'var(--status-info-fg)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '1rem'
                    }}
                  >
                    <i className={`pi ${isOverdue ? 'pi-exclamation-triangle' : 'pi-calendar'}`} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.invoice_number}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.supplier_name || '—'} · Due {formatDate(r.payment_due_date)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                      {formatINRSymbol(r.total_amount)}
                    </div>
                    <div style={{ marginTop: '0.25rem' }}>
                      <StatusChip status={r.status} />
                    </div>
                  </div>
                </button>
              )
            })}
            {!loading && sortedUpcoming.length === 0 && (
              <div style={{ padding: '1.75rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                <i className="pi pi-inbox" style={{ fontSize: '1.6rem', marginBottom: '0.5rem', display: 'block', color: 'var(--brand-400)' }} />
                No upcoming payments in the window.
              </div>
            )}
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* Compact Quick Actions — denser grid, smaller tiles */}
          <section className="glass-card" style={{ padding: '1.1rem 1.2rem' }}>
            <h3 className="glass-card__title" style={{ marginBottom: '0.6rem' }}>
              <i className="pi pi-bolt" style={{ color: 'var(--accent-amber)' }} /> Quick actions
            </h3>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '0.55rem'
              }}
            >
              {[
                { icon: 'pi-upload', label: 'Upload invoice', path: '/invoices/upload' },
                { icon: 'pi-check-square', label: 'Approve payments', path: '/payments/approve' },
                { icon: 'pi-exclamation-circle', label: 'Incomplete POs', path: '/purchase-orders/incomplete' },
                { icon: 'pi-users', label: 'Suppliers', path: '/suppliers' },
                { icon: 'pi-shopping-cart', label: 'Purchase orders', path: '/purchase-orders' },
                { icon: 'pi-chart-line', label: 'Analytics hub', path: '/analytics' }
              ].map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => navigate(q.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.65rem 0.75rem',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-1)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    transition: 'background 160ms var(--ease-out), border-color 160ms var(--ease-out), transform 160ms var(--ease-out)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--brand-50)'
                    e.currentTarget.style.borderColor = 'var(--brand-300)'
                    e.currentTarget.style.transform = 'translateY(-1px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--surface-1)'
                    e.currentTarget.style.borderColor = 'var(--border-subtle)'
                    e.currentTarget.style.transform = 'translateY(0)'
                  }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: 'linear-gradient(135deg, var(--brand-600), var(--accent-violet))',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.92rem',
                      flexShrink: 0
                    }}
                  >
                    <i className={`pi ${q.icon}`} />
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {q.label}
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* Email automation · today */}
          <section className="glass-card" style={{ padding: '1.1rem 1.2rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            {(() => {
              // Pull everything we need up-front so the JSX stays readable.
              const h = automation?.headline
              const by = automation?.by_doc_type || {}
              const synced = automation?.last_sync_at
                ? new Date(automation.last_sync_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                : null
              const syncStatus = automation?.last_sync_status
              const healthy = (h?.files_needing_attention ?? 0) === 0 && syncStatus !== 'failed'
              const filesReceived = h?.files_received ?? 0

              // Ordered doc-type rows — always all six, even when zero.
              const rows: Array<{
                key: string
                label: string
                icon: string
                accent: string
                stats: DocTypeStats
                summaryText: string
              }> = [
                { key: 'invoice',  label: 'Invoices',          icon: 'pi-file',          accent: '#6366f1', stats: by.invoice  || blankStats(), summaryText: '' },
                { key: 'po',       label: 'Purchase orders',   icon: 'pi-shopping-cart', accent: '#8b5cf6', stats: by.po       || blankStats(), summaryText: '' },
                { key: 'grn',      label: 'GRN (receipts)',    icon: 'pi-box',           accent: '#10b981', stats: by.grn      || blankStats(), summaryText: '' },
                { key: 'asn',      label: 'ASN (in-transit)',  icon: 'pi-truck',         accent: '#f59e0b', stats: by.asn      || blankStats(), summaryText: '' },
                { key: 'dc',       label: 'Delivery challans', icon: 'pi-file-edit',     accent: '#f43f5e', stats: by.dc       || blankStats(), summaryText: '' },
                { key: 'schedule', label: 'PO schedules',      icon: 'pi-calendar',      accent: '#06b6d4', stats: by.schedule || blankStats(), summaryText: '' }
              ]
              // Fill a plain-English sub-caption for each row.
              for (const r of rows) {
                const s = r.stats
                if (s.total === 0) {
                  r.summaryText = 'None received today'
                } else if (r.key === 'invoice') {
                  const parts: string[] = []
                  if (s.validated > 0) parts.push(`${s.validated} validated`)
                  const pending = s.total - s.validated - s.failed - s.skipped_duplicate - s.skipped_unclassified
                  if (pending > 0) parts.push(`${pending} awaiting review`)
                  if (s.failed > 0) parts.push(`${s.failed} failed`)
                  if (s.skipped_duplicate > 0) parts.push(`${s.skipped_duplicate} duplicate`)
                  r.summaryText = parts.length > 0 ? parts.join(' · ') : 'Processing…'
                } else {
                  const parts: string[] = []
                  if (s.loaded > 0) parts.push(`${s.loaded} saved to database`)
                  if (s.failed > 0) parts.push(`${s.failed} failed`)
                  if (s.skipped_duplicate > 0) parts.push(`${s.skipped_duplicate} duplicate`)
                  r.summaryText = parts.length > 0 ? parts.join(' · ') : 'Processing…'
                }
              }

              return (
                <>
                  {/* Header + one-line health */}
                  <div>
                    <h3 className="glass-card__title" style={{ marginBottom: '0.3rem' }}>
                      <i className="pi pi-envelope" style={{ color: 'var(--accent-emerald)' }} /> Email automation · today
                    </h3>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <i
                        className={`pi ${healthy ? 'pi-check-circle' : 'pi-exclamation-triangle'}`}
                        style={{ color: healthy ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}
                      />
                      <span>
                        {healthy
                          ? <>Everything is running cleanly{synced ? <> · last checked {synced}</> : ''}.</>
                          : <><strong>{h?.files_needing_attention ?? 0}</strong> file(s) need attention{synced ? <> · last checked {synced}</> : ''}.</>}
                      </span>
                    </div>
                  </div>

                  {/* Plain-English prose summary */}
                  <div
                    style={{
                      padding: '0.85rem 1rem',
                      borderRadius: 'var(--radius-md)',
                      background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(16,185,129,0.08))',
                      border: '1px solid var(--border-subtle)',
                      fontSize: '0.9rem',
                      color: 'var(--text-primary)',
                      lineHeight: 1.5
                    }}
                  >
                    {filesReceived > 0 ? (
                      <>
                        Today the mailbox brought in{' '}
                        <strong>{formatInt(filesReceived)}</strong> document{filesReceived === 1 ? '' : 's'} from{' '}
                        <strong>{formatInt(h?.emails_received ?? 0)}</strong> email{(h?.emails_received ?? 0) === 1 ? '' : 's'}.
                        {' '}
                        <strong style={{ color: 'var(--status-success-fg)' }}>{formatInt(h?.files_loaded_cleanly ?? 0)}</strong> saved cleanly
                        {(h?.invoices_validated ?? 0) > 0 && (
                          <>, including <strong>{formatInt(h?.invoices_validated)}</strong> invoice{(h?.invoices_validated ?? 0) === 1 ? '' : 's'} that passed all validation rules</>
                        )}.
                      </>
                    ) : (
                      <>No documents have arrived in the mailbox yet today.{' '}
                        <span style={{ color: 'var(--text-muted)' }}>
                          {synced ? `Last checked at ${synced}.` : 'Waiting for the next scheduled sync.'}
                        </span>
                      </>
                    )}
                  </div>

                  {/* Per-doc-type rows */}
                  <div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                      What arrived today
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {rows.map((r) => {
                        const s = r.stats
                        const hasIssue = s.failed > 0
                        return (
                          <div
                            key={r.key}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.7rem',
                              padding: '0.55rem 0.7rem',
                              borderRadius: 'var(--radius-md)',
                              background: 'var(--surface-1)',
                              border: `1px solid ${hasIssue ? 'var(--status-danger-ring)' : 'var(--border-subtle)'}`
                            }}
                          >
                            <div
                              style={{
                                width: 30,
                                height: 30,
                                borderRadius: 8,
                                background: `linear-gradient(135deg, ${r.accent}, ${r.accent}cc)`,
                                color: '#fff',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.82rem',
                                flexShrink: 0
                              }}
                            >
                              <i className={`pi ${r.icon}`} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                {r.label}
                              </div>
                              <div style={{ fontSize: '0.72rem', color: hasIssue ? 'var(--status-danger-fg)' : 'var(--text-muted)', marginTop: '0.15rem' }}>
                                {r.summaryText}
                              </div>
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
                                {formatInt(s.total)}
                              </div>
                              <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', fontWeight: 600, marginTop: '0.15rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                received
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Health summary banner */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                      gap: '0.5rem'
                    }}
                  >
                    {[
                      { icon: 'pi-check-circle',       label: 'Saved cleanly',    value: h?.files_loaded_cleanly    ?? 0, tone: 'success' },
                      { icon: 'pi-exclamation-triangle', label: 'Need attention', value: h?.files_needing_attention ?? 0, tone: 'danger'  },
                      { icon: 'pi-forward',            label: 'Ignored',          value: h?.files_skipped           ?? 0, tone: 'muted'   }
                    ].map((c) => (
                      <div
                        key={c.label}
                        style={{
                          padding: '0.6rem 0.7rem',
                          borderRadius: 'var(--radius-md)',
                          background: `var(--status-${c.tone}-bg)`,
                          color: `var(--status-${c.tone}-fg)`,
                          border: `1px solid var(--status-${c.tone}-ring)`,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.2rem'
                        }}
                      >
                        <i className={`pi ${c.icon}`} style={{ fontSize: '0.85rem' }} />
                        <div style={{ fontSize: '1.15rem', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
                          {formatInt(c.value)}
                        </div>
                        <div style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.85 }}>
                          {c.label}
                        </div>
                      </div>
                    ))}
                  </div>

                  {automation?.last_sync_error && (
                    <div
                      style={{
                        padding: '0.6rem 0.75rem',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--status-danger-bg)',
                        color: 'var(--status-danger-fg)',
                        border: '1px solid var(--status-danger-ring)',
                        fontSize: '0.78rem'
                      }}
                    >
                      <i className="pi pi-exclamation-triangle" /> Sync reported an error: {automation.last_sync_error}
                    </div>
                  )}

                  {!automation && !loading && (
                    <div style={{ padding: '0.5rem 0', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                      Email automation metrics are unavailable right now.
                    </div>
                  )}
                </>
              )
            })()}
          </section>
        </div>
      </div>

      {/* Footer meta */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '1rem 0.25rem', color: 'var(--text-muted)', fontSize: '0.78rem'
      }}>
        <span>Last refresh {new Date().toLocaleTimeString('en-IN')}</span>
        <span>
          {(() => {
            const outstanding = parseAmount(totals.outstanding_amount)
            const paid = parseAmount(totals.paid_amount)
            if (outstanding == null || paid == null) return ''
            const total = outstanding + paid
            if (total === 0) return ''
            const pct = Math.round((paid / total) * 100)
            return `Payment progress: ${pct}% cleared`
          })()}
        </span>
      </div>
    </>
  )
}

export default Dashboard
