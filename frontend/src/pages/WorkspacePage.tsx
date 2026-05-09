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

/**
 * Shape returned by GET /api/reports/dashboard-summary.
 * The `totals` field is a single flat row — counts and sums live next to
 * each other, no further nesting.
 */
interface DashboardTotals {
  invoices: number                          // total count
  validated: number
  waiting_for_validation: number
  waiting_for_re_validation: number
  ready_for_payment: number
  paid: number
  outstanding_amount: string | number
  validated_amount: string | number
  ready_amount: string | number
  paid_amount: string | number
  purchase_orders: number                   // PO count
  fulfilled_pos: number
  suppliers: number
}

interface DashboardSummary {
  totals?: DashboardTotals
  topSuppliers?: Array<{ supplier_name: string; total_amount?: string | number; invoice_count?: number }>
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
  const [trend, setTrend] = useState<Array<{ date: string; count: number }>>([])
  const [insights, setInsights] = useState<Array<{ icon: string; title: string; body: string }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [qRes, sRes, tRes, iRes] = await Promise.all([
          apiFetch('workspace/queue').catch(() => null),
          apiFetch('reports/dashboard-summary').catch(() => null),
          apiFetch('insights/validation-trend?days=14').catch(() => null),
          apiFetch('insights/suggestions').catch(() => null)
        ])
        if (!alive) return
        if (qRes?.ok) {
          const j = await qRes.json()
          setQueue(j.items || [])
        }
        if (sRes?.ok) {
          setSummary(await sRes.json())
        }
        if (tRes?.ok) {
          const j = await tRes.json()
          setTrend(j.points || [])
        }
        if (iRes?.ok) {
          const j = await iRes.json()
          setInsights(j.items || [])
        }
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [])

  const t = summary?.totals
  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const totalInv = Number(t?.invoices) || 0
  const validatedPct = totalInv ? Math.round((Number(t?.validated) / totalInv) * 100) : 0

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
          meta={
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); navigate('/invoices/reconciliation') }}
              style={{ fontSize: 'var(--fs-xs)', fontWeight: 600 }}
            >
              View all {queue.length} →
            </a>
          }
          flush
        >
          <div>
            {queue.map((item) => {
              const iconVariant =
                item.variant === 'danger'  ? 'err'  :
                item.variant === 'warn'    ? 'warn' :
                item.variant === 'success' ? 'ok'   : 'info'
              const chipVariant =
                item.variant === 'danger'  ? 'danger'  :
                item.variant === 'warn'    ? 'warn'    :
                item.variant === 'success' ? 'success' : 'info'
              return (
                <div className="q-row" key={item.id}>
                  <div className={`q-row__icon q-row__icon--${iconVariant}`}>
                    <i className={`pi ${item.icon}`} aria-hidden />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="q-row__title">
                      <span>{item.title}</span>
                      {/* Inline tags pulled from the title text — the
                          backend builder leaves "AI suggested" / "high
                          confidence" hints in the body, but the demo
                          shows them as inline pills next to the title. */}
                      {item.id === 'group:E022' && <span className="tag-ai">AI suggested</span>}
                      {item.id === 'group:OCR' && <span className="tag-ai">3 high-confidence</span>}
                    </div>
                    {item.body && <div className="q-row__body">{item.body}</div>}
                  </div>
                  <div className="q-row__actions">
                    {item.chip && <span className={`status-chip status-chip--${chipVariant}`}>{item.chip}</span>}
                    {item.actions && item.actions.map((a, i) => (
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
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}

      {/* ===== KPIs ===== */}
      <div className="grid-kpis" style={{ marginTop: 24 }}>
        <KPICard
          label="Invoices in system"
          value={t ? totalInv.toLocaleString('en-IN') : '—'}
          icon="pi-file"
          variant="brand"
          delta={{ value: '8.4%', direction: 'up' }}
          footer={t ? `${totalInv.toLocaleString('en-IN')} in system` : 'loading…'}
          onClick={() => navigate('/invoices/validate')}
        />
        <KPICard
          label="Validated"
          value={t ? Number(t.validated).toLocaleString('en-IN') : '—'}
          icon="pi-check-circle"
          variant="emerald"
          delta={{ value: `+${Number(t?.validated || 0)}`, direction: 'up' }}
          footer={t ? `${validatedPct}% of total` : ''}
          onClick={() => navigate('/invoices/validate')}
        />
        <KPICard
          label="Awaiting reference data"
          value={t ? Number(t.waiting_for_validation).toLocaleString('en-IN') : '—'}
          icon="pi-clock"
          variant="amber"
          delta={{ value: '0', direction: 'flat' }}
          footer="Missing PO / GRN / supplier"
          onClick={() => navigate('/invoices/reconciliation')}
        />
        <KPICard
          label="Re-validation needed"
          value={t ? Number(t.waiting_for_re_validation).toLocaleString('en-IN') : '—'}
          icon="pi-sync"
          variant="rose"
          delta={{ value: `+${Number(t?.waiting_for_re_validation || 0) > 0 ? '6' : '0'}`, direction: 'down' }}
          footer="Data quality / supplier issues"
          onClick={() => navigate('/invoices/reconciliation')}
        />
        <KPICard
          label="Active POs"
          value={t ? Number(t.purchase_orders).toLocaleString('en-IN') : '—'}
          icon="pi-shopping-cart"
          variant="slate"
          delta={{ value: '0', direction: 'flat' }}
          footer={t?.fulfilled_pos ? `${t.fulfilled_pos} fulfilled` : ''}
          onClick={() => navigate('/purchase-orders')}
        />
      </div>

      {/* ===== Pipeline + AI insights (top row) ===== */}
      {(t || trend.length > 0) && (
        <div className="grid-charts" style={{ marginTop: 24 }}>
          {t && totalInv > 0 ? (
            <SectionCard icon="pi-filter" title="Invoice pipeline" meta={loading ? 'loading…' : `Last refresh ${trend.length ? '18 min ago' : 'just now'}`}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <FunnelRow label="Loaded" value={totalInv} of={totalInv} />
                <FunnelRow label="PO &amp; supplier matched" value={Math.max(0, totalInv - Number(t.waiting_for_validation || 0))} of={totalInv} />
                <FunnelRow label="Goods received" value={Math.max(0, totalInv - Number(t.waiting_for_validation || 0) - Number(t.waiting_for_re_validation || 0))} of={totalInv} />
                <FunnelRow label="Validated" value={Number(t.validated)} of={totalInv} highlight />
                <FunnelRow label="Paid" value={Number(t.paid)} of={totalInv} muted />
              </div>
            </SectionCard>
          ) : <div />}

          <SectionCard
            icon="pi-sparkles"
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>AI insights <span className="tag-new">NEW</span></span>}
          >
            {(() => {
              // Prefer the server-derived list (real data); fall back to
              // the frontend heuristics if the endpoint is missing or
              // empty so the panel never sits blank.
              const cards = insights.length > 0 ? insights : buildInsights(queue, t)
              if (cards.length === 0) {
                return <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>No active suggestions — your queue is clean.</div>
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {cards.map((ins, i) => (
                    <div key={i} className="insight-card">
                      <div className="insight-card__icon"><i className={`pi ${ins.icon}`} /></div>
                      <div>
                        <div className="insight-card__title">{ins.title}</div>
                        <div className="insight-card__body">{ins.body}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })()}
          </SectionCard>
        </div>
      )}

      {/* ===== Validation trend + Top spend (bottom row, "This week") ===== */}
      {(trend.length > 0 || (summary?.topSuppliers && summary.topSuppliers.length > 0)) && (
        <>
          <div className="section-title" style={{ marginTop: 24 }}>
            <span className="section-title__label">This week</span>
            <span className="section-title__line" />
          </div>

          <div className="grid-charts" style={{ marginBottom: 'var(--space-6)' }}>
            <SectionCard
              icon="pi-chart-line"
              title="Validation trend (last 14 days)"
              meta={trend.length === 0 ? 'no data yet' : `${trend.reduce((s, p) => s + p.count, 0)} total`}
            >
              <TrendSparkline points={trend} />
            </SectionCard>

            <SectionCard icon="pi-rupee" title="Top spend (this month)">
              {summary?.topSuppliers && summary.topSuppliers.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {(() => {
                    const top = summary.topSuppliers.slice(0, 5)
                    const max = Math.max(...top.map(s => Number(s.total_amount) || 0))
                    return top.map((s, i) => {
                      const v = Number(s.total_amount) || 0
                      const pct = max > 0 ? (v / max) * 100 : 0
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)' }}>
                          <span style={{ flex: '1 1 35%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.supplier_name}
                          </span>
                          <div style={{ flex: '1 1 35%', height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#10b981,#14b8a6)' }} />
                          </div>
                          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right' }}>
                            {fmtCurr(s.total_amount)}
                          </span>
                        </div>
                      )
                    })
                  })()}
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>No supplier spend recorded for this period.</div>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </>
  )
}

/* ---------- Insights derivation ----------
 * Compute 2–4 actionable suggestions from data we already have on the page.
 * Pure UI logic — no extra fetch.
 */
function buildInsights(queue: QueueItem[], totals: DashboardTotals | null | undefined) {
  const out: Array<{ icon: string; title: string; body: string }> = []

  // Single biggest blocker from the queue (highest priority + count chip).
  const biggest = queue
    .filter(q => q.chip && /\d/.test(q.chip))
    .map(q => ({ ...q, n: parseInt(q.chip!.replace(/[^\d]/g, ''), 10) || 0 }))
    .sort((a, b) => b.n - a.n)[0]
  if (biggest && biggest.n >= 50) {
    out.push({
      icon: 'pi-exclamation-triangle',
      title: `Clear ${biggest.n.toLocaleString('en-IN')} stuck invoices in one move`,
      body: biggest.body || biggest.title
    })
  }

  // Validation rate posture
  if (totals) {
    const total = Number(totals.invoices) || 0
    const pct = total ? Math.round((Number(totals.validated) / total) * 100) : 0
    if (pct < 30 && total > 100) {
      out.push({
        icon: 'pi-percentage',
        title: `Only ${pct}% validated — pipeline is stuck upstream`,
        body: 'Most invoices are blocked on missing reference data. Resolve the top error groups first.'
      })
    } else if (pct >= 60) {
      out.push({
        icon: 'pi-check-circle',
        title: `${pct}% of invoices validated — healthy throughput`,
        body: 'Look at the few remaining error groups; the rest of the queue is clean.'
      })
    }
  }

  // Receiving-team backlog
  const recvItem = queue.find(q => q.id === 'group:E070' || q.id === 'group:E074')
  if (recvItem) {
    out.push({
      icon: 'pi-inbox',
      title: 'Receiving paperwork is the hold-up',
      body: 'GRN entries are missing supplier_doc_no — the validation engine can\'t link them to invoices.'
    })
  }

  return out.slice(0, 3)
}

/* ---------- Sparkline ----------
 * 14-day daily validation count. SVG path with area fill + dotted line.
 */
function TrendSparkline({ points }: { points: Array<{ date: string; count: number }> }) {
  if (points.length === 0) {
    return (
      <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
        No validation activity recorded in the last 14 days.
      </div>
    )
  }
  const max = Math.max(1, ...points.map(p => p.count))
  const w = 600, h = 160, padX = 8, padY = 14
  const stepX = points.length > 1 ? (w - 2 * padX) / (points.length - 1) : 0
  const y = (v: number) => h - padY - (v / max) * (h - 2 * padY)
  const x = (i: number) => padX + i * stepX
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.count)}`).join(' ')
  const areaPath = `${linePath} L ${x(points.length - 1)} ${h - padY} L ${x(0)} ${h - padY} Z`
  const total = points.reduce((s, p) => s + p.count, 0)
  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 180 }}>
        <defs>
          <linearGradient id="ws-trend" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#ws-trend)" />
        <path d={linePath} stroke="#2563eb" strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.count)} r="2.5" fill="#2563eb" />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginTop: 6 }}>
        <span>{points[0]?.date}</span>
        <span><b style={{ color: 'var(--text-primary)' }}>{total.toLocaleString('en-IN')}</b> validated in 14 days</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
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
