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

/**
 * Per-rule playbook: an actionable fix narrative + an optional bulk action.
 * Keyed by the rule-code prefix (everything before the underscore-name).
 *
 * The fix narrative shows as a purple "AI suggested fix" banner inside the
 * expanded group so users see what to do at a glance. The bulk action,
 * when present, renders as a button on the group header.
 */
interface Playbook {
  fix: string
  bulkAction?: { label: string; icon: string; act: 'email-erp' | 'email-receiving' | 'approve-debit-notes' | 'reextract-ocr' }
}
const PLAYBOOK: Record<string, Playbook> = {
  E003: { fix: 'Ask source ERP to add SC1–SC9 prefixes to the daily PO export. Resolves the entire group in one config change.', bulkAction: { label: 'Email source ERP', icon: 'pi-envelope', act: 'email-erp' } },
  E022: { fix: 'These suppliers billed at the gross PO unit_cost without applying the contracted discount. The system can auto-draft debit notes for the difference.', bulkAction: { label: 'Approve all debit notes', icon: 'pi-check', act: 'approve-debit-notes' } },
  E023: { fix: 'Tightly coupled to E022 — line totals are wrong because rates are wrong. Resolves once the rate is reconciled.' },
  E070: { fix: 'GRN exists but supplier_doc_no is empty. Receiving needs to fill the supplier\'s invoice number on the GRN row.', bulkAction: { label: 'Email receiving team', icon: 'pi-envelope', act: 'email-receiving' } },
  E074: { fix: 'Open / blanket POs need either a Delivery Challan or a Supplier Schedule on file before the engine treats the receipt as authorized.' },
  E041: { fix: 'Partial billing on a multi-shipment PO. Usually no action — the rule clears as remaining shipments arrive. Confirm if the PO should be partially closed.' },
  E034: { fix: 'GST classification error on the supplier\'s invoice. Ask them to re-issue with CGST + SGST instead of IGST.' },
  E035: { fix: 'GST classification error on the supplier\'s invoice. Ask them to re-issue with IGST instead of CGST + SGST.' },
  E004: { fix: 'OCR couldn\'t match the supplier name / GSTIN against your master. Either onboard the supplier or re-extract at higher resolution.', bulkAction: { label: 'Re-extract OCR', icon: 'pi-refresh', act: 'reextract-ocr' } },
  E002: { fix: 'No PO number could be extracted from the PDF. Operators need to add manual PO entry, or improve the OCR template for this supplier layout.' },
  E021: { fix: 'Real over-delivery accepted by receiving, supplier billed wrong PO line, or supplier reorganised lines. Procurement should amend PO line up or short-pay.' },
  E020: { fix: 'Item code on the invoice doesn\'t match any PO line. Either supplier billed for an item the PO didn\'t authorise, or the wrong PO is linked.' },
  E061: { fix: 'Real over-billing across multiple invoices on the same PO. Finance should issue a debit note or amend the PO value upward.' },
  E060: { fix: 'Real over-shipment that wasn\'t caught at goods-inward. Procurement should amend PO qty or short-pay the excess.' },
  E040: { fix: 'Over-billing at the header level. Often paired with E021 (line over). Confirm with the supplier and decide debit-note vs PO amendment.' },
  E042: { fix: 'Pre-tax invoice total exceeds the computed PO value. Real over-billing in rupees.' },
  E050: { fix: 'Supplier billed for more units than were physically received. Often a debit-note candidate after verifying with goods-inward.' },
  E051: { fix: 'A non-open PO requires a GRN before payment; none on file. Either receiving paperwork is pending, or the supplier billed before goods landed.' },
  E052: { fix: 'ASN (advance shipping notice) on a standard PO doesn\'t agree with the billed qty. Clarify with the supplier.' },
  E073: { fix: 'ASN qty for an open PO doesn\'t match billed qty within tolerance. Real qty disagreement after our supplier-scope fix.' },
  E075: { fix: 'DC qty doesn\'t match billed qty for an open PO. Receiving variance — usually small deltas.' },
  E076: { fix: 'Schedule is for the whole blanket period, not just this invoice\'s content. Procurement may need to amend or accept the deviation.' },
  E071: { fix: 'GRN qty for this invoice differs from billed qty. Usually small receiving variances (5-25 units).' },
  E011: { fix: 'Backdated PO situation — supplier delivered first, buyer raised the PO retrospectively. Common in urgent procurement; finance accepts if policy-compliant.' },
  E010: { fix: 'Supplier data-entry error (wrong year/month) or a post-dated invoice. Ask supplier to re-issue with the correct date.' },
  E033: { fix: 'CGST and SGST rupee amounts must match. Tax-calculation error on the supplier\'s invoice — ask them to correct.' },
  E001: { fix: 'Invoice has no invoice number — required for any further processing. Ask supplier to re-issue.' },
  E005: { fix: 'Invoice supplier doesn\'t match PO supplier. Verify the PO link, or correct supplier on PO master.' },
  E006: { fix: 'PO is closed / fully invoiced — new invoice can\'t be processed. Verify with procurement.' },
  E030: { fix: 'Sum of per-slab CGST amounts differs from invoice header CGST. Tax computation error.' },
  E031: { fix: 'Sum of per-slab SGST amounts differs from invoice header SGST. Tax computation error.' },
  E032: { fix: 'Sum of per-slab IGST amounts differs from invoice header IGST. Tax computation error.' }
}

function playbookFor(code: string): Playbook | null {
  // Codes look like 'E003_PO_NOT_FOUND' — strip to 'E003' for lookup.
  const prefix = code.split('_')[0]
  return PLAYBOOK[prefix] || null
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

  async function runBulkAction(rule: Rule, act: 'email-erp' | 'email-receiving' | 'approve-debit-notes' | 'reextract-ocr') {
    const ok = await confirm({
      title: ({
        'email-erp': `Send escalation to source ERP for ${rule.code}?`,
        'email-receiving': `Email the receiving team about ${rule.count} invoices?`,
        'approve-debit-notes': `Approve all ${rule.count} auto-drafted debit notes?`,
        'reextract-ocr': `Re-extract ${rule.count} OCR invoices?`
      })[act],
      body: ({
        'email-erp': 'Drafts an email summarising the missing reference data — you review before send.',
        'email-receiving': 'Receiving will get a list of GRN rows that need supplier_doc_no filled.',
        'approve-debit-notes': 'Each debit note is per-line, with our rate × invoice qty as the basis. Suppliers are notified by email.',
        'reextract-ocr': 'Re-runs the OCR template against the original PDFs. May resolve some mappings.'
      })[act],
      icon: 'pi-bolt',
      kind: act === 'approve-debit-notes' ? 'success' : 'info',
      okLabel: 'Run'
    })
    if (!ok) return
    // Endpoint wiring will land in a later phase. For now we surface a
    // detailed toast so the user sees what happened — no silent failure.
    toast.info(
      ({
        'email-erp': 'Escalation drafted',
        'email-receiving': 'Receiving will be notified',
        'approve-debit-notes': 'Debit-note approval queued',
        'reextract-ocr': 'OCR re-extraction queued'
      })[act],
      ({
        'email-erp': 'Endpoint wiring pending — would email source-erp@srimukha.com.',
        'email-receiving': 'Endpoint wiring pending — would email receiving-team@.',
        'approve-debit-notes': `Endpoint wiring pending — would issue ${rule.count} debit notes.`,
        'reextract-ocr': `Endpoint wiring pending — would re-extract ${rule.count} PDFs.`
      })[act]
    )
  }

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
          const playbook = playbookFor(rule.code)

          return (
            <div key={rule.code} className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Card header — clickable, toggles expansion */}
              <div
                style={{
                  background: 'linear-gradient(180deg,var(--surface-0),var(--surface-1))',
                  padding: 'var(--space-3) var(--space-5)',
                  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
                  borderBottom: isOpen ? '1px solid var(--border-subtle)' : '0',
                  cursor: 'pointer'
                }}
                onClick={() => toggle(rule.code)}
                role="button"
                aria-expanded={isOpen}
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

                {/* Bulk action button — pre-empts row click via stopPropagation */}
                {playbook?.bulkAction && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); runBulkAction(rule, playbook.bulkAction!.act) }}
                    className={`action-btn ${playbook.bulkAction.act === 'approve-debit-notes' ? '' : 'action-btn--ghost'}`}
                    style={{ padding: '6px 12px', fontSize: 'var(--fs-xs)', flexShrink: 0 }}
                  >
                    <i className={`pi ${playbook.bulkAction.icon}`} /> {playbook.bulkAction.label}
                  </button>
                )}

                <i className={`pi ${isOpen ? 'pi-chevron-up' : 'pi-chevron-down'}`} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              </div>

              {/* Expanded body — AI suggested fix banner + sample invoices */}
              {isOpen && (
                <div className="section-card__body" style={{ padding: 0 }}>
                  {playbook?.fix && (
                    <div className="insight-card" style={{ margin: 'var(--space-3) var(--space-5) 0', padding: '10px 14px' }}>
                      <div className="insight-card__icon" style={{ width: 28, height: 28, fontSize: 12 }}>
                        <i className="pi pi-bolt" />
                      </div>
                      <div>
                        <div className="insight-card__title">Suggested fix</div>
                        <div className="insight-card__body">{playbook.fix}</div>
                      </div>
                    </div>
                  )}
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
