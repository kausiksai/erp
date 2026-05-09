import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import KPICard from '../components/KPICard'
import SectionCard from '../components/SectionCard'
import { apiFetch } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'

/**
 * Workspace — the new home page (replaces Dashboard).
 *
 * Two reads on mount:
 *   GET /api/workspace/queue          → priority-ordered action items
 *   GET /api/reports/dashboard-summary → KPIs / funnel / spend (existing endpoint)
 *
 * The action queue is THE differentiator vs the old Dashboard — it answers
 * "what needs me right now" before the user has to scan KPIs.
 */

interface QueueAction {
  label: string
  link?: string
  action?: string
  kind?: 'primary' | 'success' | 'info' | 'danger'
}
interface QueueItem {
  id: string
  priority: number
  variant: 'success' | 'info' | 'warn' | 'danger'
  icon: string
  title: string
  body?: string
  chip?: string
  actions?: QueueAction[]
}

interface DashboardTotals {
  validated: number
  waiting_for_validation: number
  waiting_for_re_validation: number
  ready_for_payment: number
  paid: number
  total: number
  outstanding_amount: string | number
  validated_amount: string | number
  ready_amount: string | number
}

interface DashboardSummary {
  totals?: { invoices?: DashboardTotals; po?: { total: number; fulfilled: number } }
  topSuppliers?: Array<{ supplier_name: string; total: string | number }>
}

function fmtCurr(n: string | number | null | undefined): string {
  const v = Number(n) || 0
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)} Cr`
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)} L`
  return `₹${v.toLocaleString('en-IN')}`
}

function variantToButton(kind: QueueAction['kind']): string {
  switch (kind) {
    case 'primary': return 'action-btn'
    case 'success': return 'action-btn'
    case 'danger':  return 'action-btn action-btn--ghost'
    default:        return 'action-btn action-btn--ghost'
  }
}

function WorkspacePage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const toast = useToast()

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [qRes, sRes] = await Promise.all([
          apiFetch('workspace/queue').catch(() => null),
          apiFetch('reports/dashboard-summary').catch(() => null)
        ])
        if (!alive) return
        if (qRes?.ok) {
          const j = await qRes.json()
          setQueue(j.items || [])
        }
        if (sRes?.ok) {
          setSummary(await sRes.json())
        }
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [])

  const inv = summary?.totals?.invoices
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const validatedPct = inv && inv.total ? Math.round((Number(inv.validated) / inv.total) * 100) : 0

  function runAction(action: QueueAction, item: QueueItem) {
    if (action.link) {
      navigate(action.link)
      return
    }
    // server-action handlers — wired one-by-one as endpoints exist.
    // For now, we surface the intent via toast so users see something
    // happen and can come back when the action endpoint is wired.
    switch (action.action) {
      case 'approve_debit_notes_E022':
        toast.info('Coming next', 'Bulk-approve debit notes will land with /api/debit-notes/approve.')
        break
      case 'email_receiving':
        toast.info('Coming next', 'Email receiving will land with /api/notify/team.')
        break
      case 'email_source_erp':
        toast.warn('Escalation drafted', 'Source ERP team would be notified — endpoint wiring pending.')
        break
      default:
        toast.info(action.label, item.body || '')
    }
  }

  return (
    <>
      <PageHero
        eyebrow="Workspace"
        eyebrowIcon="pi-home"
        title={`${greeting}, ${user?.fullName?.split(' ')[0] || user?.username || 'there'}`}
        subtitle={
          loading
            ? 'Loading your queue…'
            : queue.length === 0
            ? 'You\'re all caught up. Nothing in the action queue right now.'
            : `You have ${queue.length} item${queue.length > 1 ? 's' : ''} needing your attention today.`
        }
        actions={
          <>
            <button
              type="button"
              className="action-btn action-btn--ghost"
              onClick={() => {
                // The ⌘K shortcut is wired in Phase 4. For now, surface a hint.
                toast.info('Keyboard shortcut', 'Press ⌘K (or Ctrl+K) — palette wires up in Phase 4.')
              }}
            >
              <i className="pi pi-bolt" /> Quick action
            </button>
            <button
              type="button"
              className="action-btn"
              onClick={() => navigate('/payments/approve')}
            >
              <i className="pi pi-credit-card" /> Approve payments
            </button>
          </>
        }
      />

      {/* ===== Action queue ===== */}
      {queue.length > 0 && (
        <SectionCard
          icon="pi-bolt"
          title="Your action queue"
          meta={`${queue.length} item${queue.length > 1 ? 's' : ''}`}
          flush
        >
          <div className="activity">
            {queue.map((item) => (
              <div className="activity__item" key={item.id} style={{ padding: '14px 18px' }}>
                <div
                  className={`activity__dot ${
                    item.variant === 'danger' ? 'activity__dot--danger' :
                    item.variant === 'warn'   ? 'activity__dot--warn'   :
                    item.variant === 'success' ? 'activity__dot--success' : ''
                  }`}
                  style={{ marginTop: 0 }}
                  aria-hidden
                />
                <div className="activity__body">
                  <div className="activity__title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span>{item.title}</span>
                    {item.chip && <span className={`status-chip status-chip--${item.variant === 'danger' ? 'danger' : item.variant === 'warn' ? 'warn' : item.variant === 'success' ? 'success' : 'info'}`}>{item.chip}</span>}
                  </div>
                  {item.body && <div className="activity__meta">{item.body}</div>}
                </div>
                {item.actions && item.actions.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {item.actions.map((a, i) => (
                      <button
                        key={i}
                        type="button"
                        className={variantToButton(a.kind)}
                        style={{ padding: '5px 12px', fontSize: 'var(--fs-xs)' }}
                        onClick={() => runAction(a, item)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* ===== KPIs ===== */}
      <div className="section-title" style={{ marginTop: 24 }}>
        <span className="section-title__label">Pipeline overview</span>
        <span className="section-title__line" />
      </div>

      <div className="grid-kpis">
        <KPICard
          label="Total invoices"
          value={inv ? inv.total.toLocaleString('en-IN') : '—'}
          icon="pi-file"
          variant="brand"
          footer={loading ? 'loading…' : `${inv?.total || 0} in system`}
          onClick={() => navigate('/invoices/validate')}
        />
        <KPICard
          label="Validated"
          value={inv ? Number(inv.validated).toLocaleString('en-IN') : '—'}
          icon="pi-check-circle"
          variant="emerald"
          footer={`${validatedPct}% of total`}
          onClick={() => navigate('/invoices/validate')}
        />
        <KPICard
          label="Awaiting validation"
          value={inv ? Number(inv.waiting_for_validation).toLocaleString('en-IN') : '—'}
          icon="pi-clock"
          variant="amber"
          footer="missing reference data"
          onClick={() => navigate('/invoices/reconciliation')}
        />
        <KPICard
          label="Re-validation needed"
          value={inv ? Number(inv.waiting_for_re_validation).toLocaleString('en-IN') : '—'}
          icon="pi-sync"
          variant="rose"
          footer="data quality / supplier"
          onClick={() => navigate('/invoices/reconciliation')}
        />
        <KPICard
          label="Ready for payment"
          value={inv ? fmtCurr(inv.validated_amount) : '—'}
          icon="pi-wallet"
          variant="violet"
          footer={`${inv?.validated || 0} invoices`}
          onClick={() => navigate('/payments/approve')}
        />
        <KPICard
          label="Active POs"
          value={summary?.totals?.po?.total ? Number(summary.totals.po.total).toLocaleString('en-IN') : '—'}
          icon="pi-shopping-cart"
          variant="slate"
          footer={summary?.totals?.po?.fulfilled ? `${summary.totals.po.fulfilled} fulfilled` : ''}
          onClick={() => navigate('/purchase-orders')}
        />
      </div>

      {/* ===== Funnel + top spend ===== */}
      {inv && (
        <div className="grid-charts" style={{ marginTop: 24 }}>
          <SectionCard icon="pi-filter" title="Invoice pipeline" meta={loading ? 'loading…' : 'all sources'}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <FunnelRow label="Loaded" value={inv.total} of={inv.total} />
              <FunnelRow label="Awaiting validation" value={inv.waiting_for_validation} of={inv.total} />
              <FunnelRow label="Re-validation needed" value={inv.waiting_for_re_validation} of={inv.total} />
              <FunnelRow label="Validated" value={inv.validated} of={inv.total} highlight />
              <FunnelRow label="Paid" value={inv.paid} of={inv.total} muted />
            </div>
          </SectionCard>

          <SectionCard icon="pi-rupee" title="Top suppliers (this period)">
            {summary?.topSuppliers && summary.topSuppliers.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {summary.topSuppliers.slice(0, 5).map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.supplier_name}
                    </span>
                    <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtCurr(s.total)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>No supplier spend recorded for this period.</div>
            )}
          </SectionCard>
        </div>
      )}
    </>
  )
}

/* Single funnel row — bar + label + value */
function FunnelRow({ label, value, of, highlight, muted }: { label: string; value: number; of: number; highlight?: boolean; muted?: boolean }) {
  const pct = of > 0 ? (value / of) * 100 : 0
  const color = highlight ? 'linear-gradient(90deg,#10b981,#14b8a6)'
              : muted     ? 'linear-gradient(90deg,#94a3b8,#64748b)'
              :             'linear-gradient(90deg,#3b82f6,#06b6d4)'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)', marginBottom: 5 }}>
        <span style={{ fontWeight: 600, color: highlight ? 'var(--status-success-fg)' : 'var(--text-secondary)' }}>{label}</span>
        <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {value.toLocaleString('en-IN')} ({pct.toFixed(1)}%)
        </span>
      </div>
      <div style={{ height: 10, background: 'var(--surface-2)', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
    </div>
  )
}

export default WorkspacePage
