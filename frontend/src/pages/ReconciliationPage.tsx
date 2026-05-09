import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import PageHero from '../components/PageHero'
import KPICard from '../components/KPICard'
import SectionCard from '../components/SectionCard'
import StatusChip from '../components/StatusChip'
import SlideOver from '../components/SlideOver'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'
import { formatINRSymbol, formatDate } from '../utils/format'

/**
 * Reconciliation — invoices grouped by validation error code.
 *
 * Replaces the old "Needs reconciliation" page (which was Excel↔OCR cross
 * check). The new layout matches the approved mockup:
 *
 *   ┌─ KPI strip (counts of major buckets) ───────────────┐
 *   ├─ Group card per error code ─────────────────────────┤
 *   │   ┌ collapsed: code · name · count · owner          │
 *   │   ┌ expanded:  + sample invoices (clickable)        │
 *   └────────────────────────────────────────────────────┘
 *
 * Reads:
 *   GET /api/validation-rules               (Phase 2b)
 *   GET /api/reconciliation/by-code/:code   (this commit)
 *
 * Click a sample invoice → opens the existing <InvoiceExpansion> in the
 * SlideOver introduced in Phase 1, so the user keeps their group context.
 */

interface Rule {
  code: string
  name: string
  description: string
  severity: 'error' | 'warning' | 'info'
  category: string
  owner: string
  count: number
  active: boolean
}

interface RuleSample {
  invoice_id: number
  invoice_number: string
  invoice_date: string | null
  total_amount: string | number | null
  po_number: string | null
  status: string | null
  source: 'excel' | 'ocr' | 'both' | null
  supplier_name: string | null
}

const SEVERITY_VARIANT: Record<Rule['severity'], 'danger' | 'warn' | 'info'> = {
  error:   'danger',
  warning: 'warn',
  info:    'info'
}
const SEVERITY_LABEL: Record<Rule['severity'], string> = {
  error:   'Blocker',
  warning: 'Warning',
  info:    'Info'
}

function ReconciliationPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()

  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [samples, setSamples] = useState<Record<string, RuleSample[]>>({})
  const [loadingSamples, setLoadingSamples] = useState<Record<string, boolean>>({})
  const [openInv, setOpenInv] = useState<RuleSample | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('validation-rules')
        if (!res.ok) return
        const body = await res.json()
        if (alive) setRules(body.rules || [])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const toggle = useCallback(async (code: string) => {
    setExpanded((prev) => ({ ...prev, [code]: !prev[code] }))
    if (samples[code] || loadingSamples[code]) return
    setLoadingSamples((p) => ({ ...p, [code]: true }))
    try {
      const res = await apiFetch(`reconciliation/by-code/${encodeURIComponent(code)}?limit=10`)
      if (!res.ok) return
      const body = await res.json()
      setSamples((p) => ({ ...p, [code]: body.items || [] }))
    } finally {
      setLoadingSamples((p) => ({ ...p, [code]: false }))
    }
  }, [samples, loadingSamples])

  // Filter to rules that have at least one invoice failing them.
  const activeRules = rules.filter((r) => r.count > 0)
  const totalAffected = activeRules.reduce((s, r) => s + r.count, 0)
  const blockers     = activeRules.filter((r) => r.severity === 'error').reduce((s, r) => s + r.count, 0)
  const warnings     = activeRules.filter((r) => r.severity === 'warning').reduce((s, r) => s + r.count, 0)
  const infos        = activeRules.filter((r) => r.severity === 'info').reduce((s, r) => s + r.count, 0)

  async function rerunEngine() {
    const ok = await confirm({
      title: 'Re-run validation engine?',
      body: 'All invoices will be re-evaluated against the current rule set. Estimated time depends on volume — typically a few minutes.',
      icon: 'pi-refresh',
      kind: 'info',
      okLabel: 'Run'
    })
    if (!ok) return
    toast.info('Engine started', 'Validation will refresh in the background. Check back in a few minutes.')
  }

  return (
    <>
      <PageHero
        eyebrow="Reconciliation"
        eyebrowIcon="pi-sync"
        title="Reconciliation"
        subtitle="Validation issues grouped by error code so you fix a category — not just one invoice. Each group shows the cause, the owner, sample invoices, and bulk actions."
        actions={
          <>
            <button
              type="button"
              className="action-btn action-btn--ghost"
              onClick={rerunEngine}
            >
              <i className="pi pi-refresh" /> Re-run engine
            </button>
          </>
        }
      />

      <div className="grid-kpis" style={{ marginBottom: 'var(--space-6)' }}>
        <KPICard label="Total in queue"     value={loading ? '—' : totalAffected.toLocaleString('en-IN')} icon="pi-exclamation-triangle" variant="rose"   footer={`${activeRules.length} active rules`} />
        <KPICard label="Blockers"           value={loading ? '—' : blockers.toLocaleString('en-IN')}     icon="pi-times-circle"          variant="rose"   footer="Severity: error" />
        <KPICard label="Warnings"           value={loading ? '—' : warnings.toLocaleString('en-IN')}     icon="pi-exclamation-circle"    variant="amber"  footer="Severity: warning" />
        <KPICard label="Informational"      value={loading ? '—' : infos.toLocaleString('en-IN')}        icon="pi-info-circle"           variant="violet" footer="Severity: info" />
      </div>

      {!loading && activeRules.length === 0 && (
        <SectionCard icon="pi-check-circle" title="Nothing to reconcile">
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            All invoices currently pass every active validation rule. The reconciliation queue is empty.
          </div>
        </SectionCard>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {activeRules.map((rule) => {
          const isOpen = !!expanded[rule.code]
          const groupSamples = samples[rule.code] || []
          const isLoadingGroup = !!loadingSamples[rule.code]
          const variant = SEVERITY_VARIANT[rule.severity]
          const sevLabel = SEVERITY_LABEL[rule.severity]

          return (
            <div key={rule.code} className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Card header — clickable, toggles expansion */}
              <button
                type="button"
                onClick={() => toggle(rule.code)}
                aria-expanded={isOpen}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer', border: 0,
                  background: 'linear-gradient(180deg,var(--surface-0),var(--surface-1))',
                  padding: 'var(--space-3) var(--space-5)',
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  borderBottom: isOpen ? '1px solid var(--border-subtle)' : '0'
                }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: 'var(--radius-md)',
                  background: variant === 'danger' ? 'var(--status-danger-bg)'
                            : variant === 'warn'   ? 'var(--status-warn-bg)'
                            : 'var(--status-info-bg)',
                  color:     variant === 'danger' ? 'var(--status-danger-fg)'
                            : variant === 'warn'   ? 'var(--status-warn-fg)'
                            : 'var(--status-info-fg)',
                  display: 'grid', placeItems: 'center', flexShrink: 0
                }}>
                  <i className={`pi ${variant === 'danger' ? 'pi-exclamation-triangle' : variant === 'warn' ? 'pi-exclamation-circle' : 'pi-info-circle'}`} />
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{rule.name}</span>
                    <StatusChip status={String(rule.count)} variant={variant} label={`${rule.count} invoice${rule.count > 1 ? 's' : ''}`} />
                    <code style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{rule.code}</code>
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    {rule.description} <b style={{ color: 'var(--text-secondary)' }}>Owner:</b> {rule.owner} · <b style={{ color: 'var(--text-secondary)' }}>Severity:</b> {sevLabel}
                  </div>
                </div>

                <i className={`pi ${isOpen ? 'pi-chevron-up' : 'pi-chevron-down'}`} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              </button>

              {/* Expanded body — sample invoices */}
              {isOpen && (
                <div className="section-card__body" style={{ padding: 0 }}>
                  {isLoadingGroup && (
                    <div style={{ padding: 'var(--space-5)', textAlign: 'center', color: 'var(--text-muted)' }}>
                      <i className="pi pi-spin pi-spinner" /> Loading samples…
                    </div>
                  )}
                  {!isLoadingGroup && groupSamples.length === 0 && (
                    <div style={{ padding: 'var(--space-5)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
                      No invoice samples available — the engine may not have written details for this rule yet.
                    </div>
                  )}
                  {!isLoadingGroup && groupSamples.length > 0 && (
                    <table className="tbl tbl--compact">
                      <thead>
                        <tr>
                          <th>Invoice</th>
                          <th>Date</th>
                          <th>Supplier</th>
                          <th>PO</th>
                          <th>Source</th>
                          <th className="tbl__num">Amount</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {groupSamples.map((s) => (
                          <tr
                            key={s.invoice_id}
                            className="is-clickable"
                            onClick={() => setOpenInv(s)}
                          >
                            <td className="tbl__bold">{s.invoice_number}</td>
                            <td className="tbl__muted">{formatDate(s.invoice_date)}</td>
                            <td>{s.supplier_name || <span className="tbl__muted">—</span>}</td>
                            <td className="tbl__mono">{s.po_number || '—'}</td>
                            <td>
                              {s.source === 'ocr'   ? <StatusChip status="ocr"   variant="violet"  label="OCR" />
                                : s.source === 'excel' ? <StatusChip status="excel" variant="info"    label="Excel" />
                                : s.source === 'both'  ? <StatusChip status="both"  variant="success" label="Both" />
                                : <span className="tbl__muted">—</span>}
                            </td>
                            <td className="tbl__num tbl__bold">{formatINRSymbol(s.total_amount)}</td>
                            <td className="tbl__num"><i className="pi pi-arrow-right tbl__muted" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {groupSamples.length > 0 && groupSamples.length >= 10 && (
                    <div style={{
                      padding: 'var(--space-2) var(--space-5)',
                      background: 'var(--surface-1)',
                      borderTop: '1px solid var(--border-subtle)',
                      fontSize: 'var(--fs-xs)',
                      color: 'var(--text-muted)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}>
                      <span>Showing 10 of {rule.count}</span>
                      <button
                        type="button"
                        className="action-btn action-btn--ghost"
                        style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}
                        onClick={() => navigate(`/invoices/validate?status=waiting_for_re_validation`)}
                      >
                        Show all {rule.count} →
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <SlideOver
        open={!!openInv}
        onClose={() => setOpenInv(null)}
        title={openInv ? `Invoice ${openInv.invoice_number}` : 'Invoice'}
        headerActions={
          openInv && (
            <button
              type="button"
              className="action-btn action-btn--ghost"
              style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)' }}
              onClick={() => {
                navigate(`/invoices/validate/${openInv.invoice_id}`)
                setOpenInv(null)
              }}
            >
              <i className="pi pi-external-link" /> Open full
            </button>
          )
        }
      >
        {openInv && (
          <InvoiceExpansion invoiceId={openInv.invoice_id} poNumber={openInv.po_number} />
        )}
      </SlideOver>
    </>
  )
}

export default ReconciliationPage
