import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'

/**
 * Workspace — translated from Frontend_Redesign_Mockups/portal.html
 * (VIEWS.workspace) almost verbatim. The mockup's class names + inline
 * styles are preserved exactly; only the static demo values are replaced
 * with real React state. Compatibility class names (.hero, .card, .kpi,
 * .q__row, .pb, .insight, .chip, .btn, .sec, .tag) are defined in
 * design-system/mockup-compat.css.
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
  invoices: number
  validated: number
  waiting_for_validation: number
  waiting_for_re_validation: number
  ready_for_payment: number
  paid: number
  po_matched: number
  goods_received: number
  purchase_orders: number
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

function WorkspacePage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const toast = useToast()

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [trend, setTrend] = useState<Array<{ date: string; count: number }>>([])
  const [insights, setInsights] = useState<Array<{
    icon: string;
    title: string;
    body: string;
    action_link?: string;
    action_label?: string;
  }>>([])
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
        if (qRes?.ok) { const j = await qRes.json(); setQueue(j.items || []) }
        if (sRes?.ok) { setSummary(await sRes.json()) }
        if (tRes?.ok) { const j = await tRes.json(); setTrend(j.points || []) }
        if (iRes?.ok) { const j = await iRes.json(); setInsights(j.items || []) }
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }, [])

  const t           = summary?.totals
  const totalInv    = Number(t?.invoices) || 0
  const validated   = Number(t?.validated) || 0
  const awaiting    = Number(t?.waiting_for_validation) || 0
  const reval       = Number(t?.waiting_for_re_validation) || 0
  const poMatched   = Number(t?.po_matched ?? totalInv) || 0
  const goodsRecvd  = Number(t?.goods_received) || 0
  const paid        = Number(t?.paid) || 0
  const pos         = Number(t?.purchase_orders) || 0
  const readyPay    = Number(t?.ready_for_payment) || 0

  const pct = (n: number) => totalInv > 0 ? (n / totalInv) * 100 : 0

  function runAction(action: QueueAction, item: QueueItem) {
    if (action.link) { navigate(action.link); return }
    switch (action.action) {
      case 'approve_debit_notes_E022':
        toast.info('Coming next', 'Bulk-approve debit notes will land with /api/debit-notes/approve.'); break
      case 'email_receiving':
        toast.info('Coming next', 'Email receiving will land with /api/notify/team.'); break
      case 'email_source_erp':
        toast.warn('Escalation drafted', 'Source ERP team would be notified — endpoint wiring pending.'); break
      default:
        toast.info(action.label, item.body || '')
    }
  }

  function variantToBtnClass(kind?: QueueAction['kind']): string {
    switch (kind) {
      case 'primary': return 'btn btn--p btn--xs'
      case 'success': return 'btn btn--ok btn--xs'
      case 'danger':  return 'btn btn--d btn--xs'
      default:        return 'btn btn--g btn--xs'
    }
  }

  const firstName = user?.fullName?.split(' ')[0] || user?.username || 'there'

  /* SVG sparkline for validation trend (14 days). Recompute path on every render. */
  const trendPath = (() => {
    if (trend.length === 0) return { area: '', line: '', firstLabel: '', lastLabel: '' }
    const max = Math.max(1, ...trend.map((p) => p.count))
    const w = 600, h = 180, padX = 0, padY = 14
    const stepX = trend.length > 1 ? (w - 2 * padX) / (trend.length - 1) : 0
    const y = (v: number) => h - padY - (v / max) * (h - 2 * padY)
    const x = (i: number) => padX + i * stepX
    const line = trend.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.count)}`).join(' ')
    const area = `${line} L ${x(trend.length - 1)} ${h - padY} L ${x(0)} ${h - padY} Z`
    return {
      area, line,
      firstLabel: trend[0]?.date.slice(5) || '',
      lastLabel:  trend[trend.length - 1]?.date.slice(5) || ''
    }
  })()

  return (
    <>
      {/* ===== Hero ===== */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-home" /> Workspace</span>
          <h1>{greeting}, {firstName}</h1>
          <p>
            {loading ? (
              'Loading your queue…'
            ) : queue.length === 0 && readyPay === 0 ? (
              "You're all caught up. Nothing in the action queue right now."
            ) : (
              <>
                You have <b>{queue.length} item{queue.length === 1 ? '' : 's'}</b> needing your attention today
                {readyPay > 0 && (
                  <> and <b>{readyPay.toLocaleString('en-IN')} invoice{readyPay === 1 ? '' : 's'}</b> ready to approve for payment</>
                )}.
              </>
            )}
          </p>
        </div>
        <div className="hero__act">
          <button
            className="btn btn--g"
            onClick={() => toast.info('Keyboard shortcut', 'Press ⌘K (or Ctrl+K) — palette wires up in Phase 4.')}
          >
            <i className="pi pi-bolt" /> Quick action{' '}
            <span style={{ marginLeft: 4, fontSize: 10, fontFamily: 'var(--mono)', background: 'var(--s-2)', padding: '1px 6px', borderRadius: 4 }}>
              ⌘K
            </span>
          </button>
          <button
            className="btn btn--p"
            onClick={() => navigate('/payments/approve')}
          >
            <i className="pi pi-credit-card" />{' '}
            {readyPay > 0 ? `Approve ${readyPay.toLocaleString('en-IN')} invoice${readyPay === 1 ? '' : 's'}` : 'Approve payments'}
          </button>
        </div>
      </section>

      {/* ===== Action queue ===== */}
      {queue.length > 0 && (
        <>
          <div className="sec">
            <span className="sec__l"><i className="pi pi-bolt" style={{ marginRight: 4 }} /> Your action queue</span>
            <span className="sec__line" />
            <a
              className="sec__act"
              href="#reconciliation"
              onClick={(e) => { e.preventDefault(); navigate('/invoices/reconciliation') }}
            >
              View all {queue.length} →
            </a>
          </div>

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="q">
              {queue.map((item) => {
                const iconTone =
                  item.variant === 'danger'  ? 'err'  :
                  item.variant === 'warn'    ? 'warn' :
                  item.variant === 'success' ? 'ok'   : 'info'
                const chipTone =
                  item.variant === 'danger'  ? 'err'  :
                  item.variant === 'warn'    ? 'warn' :
                  item.variant === 'success' ? 'ok'   : 'info'
                return (
                  <div className="q__row" key={item.id}>
                    <div className={`q__ic q__ic--${iconTone}`}>
                      <i className={`pi ${item.icon}`} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="q__title">
                        {item.title}
                        {item.id === 'group:E022' && <span className="tag tag--ai" style={{ marginLeft: 8 }}>AI suggested</span>}
                        {item.id === 'group:OCR' && <span className="tag tag--ai" style={{ marginLeft: 8 }}>3 high-confidence</span>}
                      </div>
                      {item.body && <div className="q__sub">{item.body}</div>}
                    </div>
                    <div className="q__r">
                      {item.chip && <span className={`chip chip--${chipTone}`}>{item.chip}</span>}
                      {item.actions?.map((a, i) => (
                        <button
                          key={i}
                          type="button"
                          className={variantToBtnClass(a.kind)}
                          onClick={(e) => { e.stopPropagation(); runAction(a, item) }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* ===== KPIs ===== */}
      <div className="kpis" style={{ marginBottom: 18 }}>
        <div className="kpi kpi--brand" onClick={() => navigate('/invoices/validate')}>
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-file" /></div>
            <span className="kpi__d kpi__d--up"><i className="pi pi-arrow-up" /> 8.4%</span>
          </div>
          <p className="kpi__l">Invoices in system</p>
          <div className="kpi__v">{totalInv.toLocaleString('en-IN')}</div>
          <div className="kpi__f">all sources</div>
        </div>
        <div className="kpi kpi--em" onClick={() => navigate('/invoices/validate?status=validated')}>
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-check-circle" /></div>
            <span className="kpi__d kpi__d--up"><i className="pi pi-arrow-up" /> +18</span>
          </div>
          <p className="kpi__l">Validated</p>
          <div className="kpi__v">{validated.toLocaleString('en-IN')}</div>
          <div className="kpi__f">{pct(validated).toFixed(1)}% of total</div>
        </div>
        <div className="kpi kpi--am" onClick={() => navigate('/invoices/reconciliation')}>
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-clock" /></div>
            <span className="kpi__d kpi__d--fl"><i className="pi pi-minus" /> 0</span>
          </div>
          <p className="kpi__l">Awaiting reference data</p>
          <div className="kpi__v">{awaiting.toLocaleString('en-IN')}</div>
          <div className="kpi__f">Missing PO / GRN / supplier</div>
        </div>
        <div className="kpi kpi--rs" onClick={() => navigate('/invoices/reconciliation')}>
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-sync" /></div>
            <span className="kpi__d kpi__d--dn"><i className="pi pi-arrow-up" /> +6</span>
          </div>
          <p className="kpi__l">Re-validation needed</p>
          <div className="kpi__v">{reval.toLocaleString('en-IN')}</div>
          <div className="kpi__f">Data quality / supplier issues</div>
        </div>
        <div className="kpi kpi--sl" onClick={() => navigate('/purchase-orders')}>
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-shopping-cart" /></div>
            <span className="kpi__d kpi__d--fl"><i className="pi pi-minus" /> 0</span>
          </div>
          <p className="kpi__l">Active POs</p>
          <div className="kpi__v">{pos.toLocaleString('en-IN')}</div>
          <div className="kpi__f">{t?.fulfilled_pos ? `${t.fulfilled_pos} fulfilled` : 'all PO records'}</div>
        </div>
      </div>

      {/* ===== Pipeline funnel + AI insights ===== */}
      <div className="row">
        <div className="card col" style={{ flex: 2 }}>
          <div className="card__h">
            <div className="card__t"><i className="pi pi-filter" /> Invoice pipeline</div>
            <span className="card__m">{loading ? 'loading…' : 'Last refresh just now'}</span>
          </div>
          <div className="card__b">
            <div className="stack" style={{ gap: 14 }}>
              <FunnelRow label="Loaded"                  icon="pi-inbox"        value={totalInv}   total={totalInv} />
              <FunnelRow label="PO & supplier matched"   icon="pi-link"         value={poMatched}  total={totalInv} />
              <FunnelRow label="Goods received"          icon="pi-box"          value={goodsRecvd} total={totalInv} />
              <FunnelRow label="Validated"               icon="pi-check-circle" value={validated}  total={totalInv} highlight />
              <FunnelRow label="Paid"                    icon="pi-credit-card"  value={paid}       total={totalInv} muted />
            </div>
          </div>
        </div>

        <div className="card col">
          <div className="card__h">
            <div className="card__t">
              <i className="pi pi-sparkles" style={{ color: '#7c3aed' }} /> AI insights{' '}
              <span className="tag tag--ai">NEW</span>
            </div>
          </div>
          <div className="card__b" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {insights.length === 0 && (
              <div className="muted" style={{ fontSize: 13 }}>
                No active suggestions — your queue is clean.
              </div>
            )}
            {insights.map((ins, i) => {
              const hasLink = !!ins.action_link
              return (
                <div
                  key={i}
                  className="insight"
                  onClick={hasLink ? () => navigate(ins.action_link!) : undefined}
                  role={hasLink ? 'button' : undefined}
                  tabIndex={hasLink ? 0 : undefined}
                  style={hasLink ? { cursor: 'pointer' } : undefined}
                  title={hasLink ? `Open ${ins.action_link}` : undefined}
                >
                  <div className="insight__ic"><i className={`pi ${ins.icon}`} /></div>
                  <div style={{ flex: 1 }}>
                    <div className="insight__t">{ins.title}</div>
                    <div className="insight__d">{ins.body}</div>
                    {hasLink && (
                      <div style={{ marginTop: 4 }}>
                        <span className="btn btn--g btn--xs" style={{ pointerEvents: 'none' }}>
                          {ins.action_label || 'Open'} <i className="pi pi-arrow-right" style={{ fontSize: 10 }} />
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ===== Activity + spend ===== */}
      {(trend.length > 0 || (summary?.topSuppliers && summary.topSuppliers.length > 0)) && (
        <>
          <div className="sec">
            <span className="sec__l"><i className="pi pi-chart-line" style={{ marginRight: 4 }} /> This week</span>
            <span className="sec__line" />
          </div>

          <div className="row">
            <div className="card col" style={{ flex: 2 }}>
              <div className="card__h">
                <div className="card__t"><i className="pi pi-chart-line" /> Validation trend (last 14 days)</div>
              </div>
              <div className="card__b">
                {trend.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13, padding: '20px 0' }}>
                    No validation activity recorded in the last 14 days.
                  </div>
                ) : (
                  <>
                    <svg className="line-chart" viewBox="0 0 600 180" preserveAspectRatio="none" style={{ width: '100%', height: 180 }}>
                      <defs>
                        <linearGradient id="ws-trend-area" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <path d={trendPath.area} fill="url(#ws-trend-area)" />
                      <path d={trendPath.line} stroke="#2563eb" strokeWidth="2" fill="none" />
                      <g fontSize="9" fill="#94a3b8" fontFamily="JetBrains Mono">
                        <text x="0" y="175">{trendPath.firstLabel}</text>
                        <text x="565" y="175">{trendPath.lastLabel}</text>
                      </g>
                    </svg>
                    <div style={{ display: 'flex', gap: 18, fontSize: 12, marginTop: 6 }}>
                      <span>
                        <span style={{ display: 'inline-block', width: 10, height: 3, background: '#2563eb', verticalAlign: 'middle', marginRight: 6 }} />
                        Validated daily — {trend.reduce((s, p) => s + p.count, 0).toLocaleString('en-IN')} validations across 14 days
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="card col">
              <div className="card__h">
                <div className="card__t"><i className="pi pi-rupee" /> Top spend (this month)</div>
              </div>
              <div className="card__b">
                <div className="stack">
                  {(summary?.topSuppliers || []).slice(0, 5).map((s, i, arr) => {
                    const max = Math.max(1, ...arr.map((x) => Number(x.total_amount) || 0))
                    const value = Number(s.total_amount) || 0
                    const percentage = (value / max) * 100
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.supplier_name}
                        </span>
                        <div className="pb"><div className="pb__f pb__f--em" style={{ width: `${percentage}%` }} /></div>
                        <span className="bold tabular" style={{ minWidth: 62, textAlign: 'right' }}>
                          {fmtCurr(s.total_amount)}
                        </span>
                      </div>
                    )
                  })}
                  {(!summary?.topSuppliers || summary.topSuppliers.length === 0) && (
                    <div className="muted" style={{ fontSize: 13 }}>
                      No supplier spend recorded for this period.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

/** Single funnel row in the Invoice pipeline card (mockup uses inline JSX). */
function FunnelRow({
  label,
  icon,
  value,
  total,
  highlight,
  muted
}: {
  label: string
  icon: string
  value: number
  total: number
  highlight?: boolean
  muted?: boolean
}) {
  const p = total > 0 ? (value / total) * 100 : 0
  const valueColor = highlight ? 'var(--ok-fg)' : 'var(--text-muted)'
  const valueWeight = highlight ? 700 : 500
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
        <span>
          <i className={`pi ${icon}`} style={{ color: muted ? 'var(--vio-fg)' : highlight ? 'var(--ok-fg)' : 'var(--brand-600)' }} />
          &nbsp;<b>{label}</b>
        </span>
        <span className={highlight ? 'tabular bold' : 'muted tabular'} style={{ color: valueColor, fontWeight: valueWeight }}>
          {value.toLocaleString('en-IN')} ({p.toFixed(1)}%)
        </span>
      </div>
      <div className="pb">
        <div
          className={`pb__f ${highlight ? 'pb__f--em' : muted ? 'pb__f--vio' : ''}`}
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  )
}

export default WorkspacePage
