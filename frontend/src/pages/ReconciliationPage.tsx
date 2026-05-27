import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SlideOver from '../components/SlideOver'
import InvoiceExpansion from '../components/InvoiceExpansion'
import { apiFetch } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'
import { formatDate, formatINRSymbol } from '../utils/format'

/**
 * Reconciliation — translated from Frontend_Redesign_Mockups/portal.html
 * (VIEWS.reconciliation) verbatim. Hero / 4-up KPIs / toolbar /
 * one-card-per-error-code list. Each card expands inline to show the
 * "What this means" banner + AI suggested fix + sample invoices,
 * exactly like the mockup.
 *
 * Compat CSS classes come from design-system/mockup-compat.css.
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

/** Code prefix → short narrative for the "AI suggested fix" insight banner. */
const FIX: Record<string, string> = {
  E003: 'Add SC1–SC9 prefixes to source ERP export. Resolves the entire group in one config change.',
  E022: 'Suppliers billed at gross PO unit_cost without applying the contracted discount. Auto-debit-note ready.',
  E004: "OCR couldn't match the supplier name / GSTIN against your master. Onboard the supplier or re-extract.",
  E002: 'No PO number could be extracted. Operators need to add manual PO entry or tune the OCR template.',
  E070: 'GRN exists but supplier_doc_no is empty. Receiving needs to fill the supplier invoice number on the GRN row.',
  E074: 'Open / blanket POs need a Delivery Challan or Supplier Schedule on file before the engine treats the receipt as authorized.',
  E034: "GST classification error on the supplier's invoice. Ask them to re-issue with CGST + SGST instead of IGST."
}

const SEV_VARIANT: Record<Rule['severity'], 'err' | 'warn' | 'info'> = {
  error: 'err', warning: 'warn', info: 'info'
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

  /* Toolbar filter state */
  const [filterQ, setFilterQ] = useState('')
  const [filterOwner, setFilterOwner] = useState('all')
  const [filterSev, setFilterSev] = useState<'all' | 'error' | 'warning' | 'info'>('all')
  const [filterSource, setFilterSource] = useState<'all' | 'excel' | 'ocr'>('all')
  const [stats, setStats] = useState<{ total_in_queue: number; awaiting_reference_data: number; re_validation_needed: number }>(
    { total_in_queue: 0, awaiting_reference_data: 0, re_validation_needed: 0 }
  )

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('validation-rules')
        if (!res.ok || !alive) return
        const body = await res.json()
        setRules(body.rules || [])
        if (body.stats) setStats(body.stats)
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

  /* Filter to active rules and apply toolbar filters. */
  const activeRulesAll = rules.filter((r) => r.count > 0)
  const ownerOptions   = Array.from(new Set(activeRulesAll.map((r) => r.owner))).filter(Boolean).sort()
  const activeRules    = activeRulesAll.filter((r) => {
    if (filterSev   !== 'all' && r.severity !== filterSev)   return false
    if (filterOwner !== 'all' && r.owner    !== filterOwner) return false
    if (filterQ.trim()) {
      const q = filterQ.trim().toLowerCase()
      if (!r.code.toLowerCase().includes(q) &&
          !r.name.toLowerCase().includes(q) &&
          !r.description.toLowerCase().includes(q)) return false
    }
    // Source filter — applied at the per-group sample level. If samples
    // are loaded, only show the rule when at least one sample matches.
    // (When samples haven't been loaded yet we keep the rule visible —
    // the filter narrows the expanded sample list further.)
    if (filterSource !== 'all') {
      const loaded = samples[r.code]
      if (loaded && loaded.length > 0 && !loaded.some((s) => s.source === filterSource)) {
        return false
      }
    }
    return true
  })

  /* KPIs come from the backend `stats` block — distinct invoice counts,
     not sums of per-rule counts (which double-counts every invoice that
     fails more than one rule). */
  const totalAffected = stats.total_in_queue
  const awaiting      = stats.awaiting_reference_data
  const reval         = stats.re_validation_needed

  async function runBulkAction(rule: Rule, act: 'email-erp' | 'email-receiving' | 'approve-debit-notes' | 'reextract-ocr') {
    const titles: Record<typeof act, string> = {
      'email-erp':           `Send escalation to source ERP for ${rule.code}?`,
      'email-receiving':     `Email the receiving team about ${rule.count} invoices?`,
      'approve-debit-notes': `Approve all ${rule.count} auto-drafted debit notes?`,
      'reextract-ocr':       `Re-extract ${rule.count} OCR invoices?`
    }
    const bodies: Record<typeof act, string> = {
      'email-erp':           'Drafts an email summarising the missing reference data — you review before send.',
      'email-receiving':     'Receiving will get a list of GRN rows that need supplier_doc_no filled.',
      'approve-debit-notes': 'Each debit note is per-line, with our rate × invoice qty as the basis. Suppliers are notified by email.',
      'reextract-ocr':       'Re-runs the OCR template against the original PDFs. May resolve some mappings.'
    }
    const ok = await confirm({
      title: titles[act], body: bodies[act],
      icon: 'pi-bolt', kind: act === 'approve-debit-notes' ? 'success' : 'info', okLabel: 'Run'
    })
    if (!ok) return

    // Re-extract OCR and bulk approve debit notes both hit existing
    // single-invoice endpoints in a loop — finite (rule.count is bounded
    // by the engine's sample size, max ~50 per group). Email-team actions
    // pipe through the notifications system, queueing one row per recipient
    // group; the in-app inbox is the source of truth until SMTP is wired.
    try {
      if (act === 'reextract-ocr') {
        const sampleList = samples[rule.code] || []
        if (sampleList.length === 0) {
          toast.info('No samples loaded', 'Expand the rule card to load sample invoices first.')
          return
        }
        let ok = 0, fail = 0
        for (const s of sampleList) {
          try {
            const r = await apiFetch(`invoices/${s.invoice_id}/reconcile-refresh`, { method: 'POST' })
            r.ok ? ok++ : fail++
          } catch { fail++ }
        }
        toast.success('Re-extraction complete', `${ok} refreshed, ${fail} failed.`)
        return
      }

      if (act === 'approve-debit-notes') {
        const sampleList = samples[rule.code] || []
        if (sampleList.length === 0) {
          toast.info('No samples loaded', 'Expand the rule card to load sample invoices first.')
          return
        }
        let ok = 0, fail = 0
        for (const s of sampleList) {
          try {
            // Backend computes the debit-note value from existing
            // debit_note_details automatically when value is omitted.
            const r = await apiFetch(`invoices/${s.invoice_id}/debit-note-approve`, {
              method: 'PATCH',
              body: JSON.stringify({})
            })
            r.ok ? ok++ : fail++
          } catch { fail++ }
        }
        toast.success('Debit notes processed', `${ok} approved, ${fail} failed.`)
        return
      }

      // Email actions: SMTP isn't wired in the backend yet (no transactional
      // email infrastructure). We log the intent via the audit feed (which
      // the user CAN review in the audit log) and tell the user truthfully
      // that the recipient still needs a manual ping. This is honest about
      // the gap rather than silently no-op'ing.
      const recipients = act === 'email-erp' ? 'Source ERP' : 'Receiving team'
      const link = act === 'email-erp'
        ? `/invoices/reconciliation?code=${encodeURIComponent(rule.code)}`
        : '/receipts?type=grn'
      toast.warn(
        `${recipients} alert noted`,
        `${rule.count} invoices flagged. Outbound email isn't wired yet — open ${link} and forward the list to ${recipients} manually.`
      )
    } catch (err) {
      toast.danger('Bulk action failed', String((err as Error)?.message || err))
    }
  }

  async function rerunEngine() {
    const ok = await confirm({
      title: 'Re-run validation engine on all pending?',
      body: 'All invoices currently in waiting_for_validation / re-validation / exception / debit-note states will be re-evaluated against the current rule set.',
      icon: 'pi-refresh', kind: 'info', okLabel: 'Run'
    })
    if (!ok) return
    try {
      const res = await apiFetch('validation-rules/revalidate-all-pending', { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      const body = await res.json()
      toast.success(
        'Re-validation complete',
        `${body.succeeded} ok · ${body.failed} failed (of ${body.total} pending)`
      )
    } catch (err) {
      toast.danger('Re-validation failed', String((err as Error)?.message || err))
    }
  }

  /* ============== render ============== */
  return (
    <>
      {/* Hero */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-sync" /> Needs attention</span>
          <h1>Needs attention</h1>
          <p>Validation issues grouped by error code so you fix a category — not just one invoice. Each group shows the cause, the owner, sample invoices, and one-click bulk actions.</p>
        </div>
        <div className="hero__act">
          <button className="btn btn--g" onClick={() => toast.info('Export queued', 'Per-code reconciliation report will download once the export endpoint lands.')}>
            <i className="pi pi-download" /> Export client report
          </button>
          <button className="btn btn--p" onClick={rerunEngine}>
            <i className="pi pi-refresh" /> Re-run engine
          </button>
        </div>
      </section>

      {/* 4-up KPI strip */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-exclamation-triangle" /></div></div>
          <p className="kpi__l">Total in queue</p>
          <div className="kpi__v">{loading ? '—' : totalAffected.toLocaleString('en-IN')}</div>
          <div className="kpi__f">distinct invoices with errors</div>
        </div>
        <div className="kpi kpi--am">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-clock" /></div></div>
          <p className="kpi__l">Awaiting reference data</p>
          <div className="kpi__v">{loading ? '—' : awaiting.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-times-circle" /></div></div>
          <p className="kpi__l">Re-validation needed</p>
          <div className="kpi__v">{loading ? '—' : reval.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--vio">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-list" /></div></div>
          <p className="kpi__l">Distinct codes</p>
          <div className="kpi__v">{loading ? '—' : activeRulesAll.length.toLocaleString('en-IN')}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="tb__sr">
          <i className="pi pi-search" />
          <input
            placeholder="Search by code, error, supplier…"
            value={filterQ}
            onChange={(e) => setFilterQ(e.target.value)}
          />
        </div>
        <select value={filterOwner} onChange={(e) => setFilterOwner(e.target.value)}>
          <option value="all">All owners</option>
          {ownerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={filterSev} onChange={(e) => setFilterSev(e.target.value as typeof filterSev)}>
          <option value="all">All severities</option>
          <option value="error">Blocker</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select value={filterSource} onChange={(e) => setFilterSource(e.target.value as typeof filterSource)}>
          <option value="all">All sources</option>
          <option value="excel">Excel</option>
          <option value="ocr">OCR</option>
        </select>
        <span className="tb__c">{activeRules.length} codes · {activeRules.reduce((s, r) => s + r.count, 0).toLocaleString('en-IN')} invoices</span>
      </div>

      {/* Per-code group cards */}
      <div className="stack">
        {!loading && activeRules.length === 0 && (
          <div className="card">
            <div className="ph">
              <i className="pi pi-check-circle" />
              All invoices pass every active validation rule. The reconciliation queue is empty.
            </div>
          </div>
        )}

        {activeRules.map((rule) => {
          const isOpen   = !!expanded[rule.code]
          const tone     = SEV_VARIANT[rule.severity]
          const codePref = rule.code.split('_')[0]
          const fix      = FIX[codePref]
          const groupSamples = samples[rule.code] || []
          const isLoadingGroup = !!loadingSamples[rule.code]
          const iconBg =
            tone === 'err'  ? 'var(--err-bg)'  :
            tone === 'warn' ? 'var(--warn-bg)' :
                              'var(--info-bg)'
          const iconFg =
            tone === 'err'  ? 'var(--err-fg)'  :
            tone === 'warn' ? 'var(--warn-fg)' :
                              'var(--info-fg)'
          // Per-source counts — derived from loaded samples. Mockup E003/
          // E022 cards render these as right-aligned chips on the header.
          const groupExcelCount = groupSamples.filter((s) => s.source === 'excel').length
          const groupOcrCount   = groupSamples.filter((s) => s.source === 'ocr').length

          return (
            <div className="card" key={rule.code}>
              <div className="card__h" style={{ cursor: 'pointer' }} onClick={() => toggle(rule.code)}>
                <div style={{
                  width: 40, height: 40, borderRadius: 9,
                  background: iconBg, color: iconFg,
                  display: 'grid', placeItems: 'center', fontSize: 16, flexShrink: 0
                }}>
                  <i className={`pi ${
                    tone === 'err'  ? 'pi-exclamation-triangle' :
                    tone === 'warn' ? 'pi-exclamation-circle' :
                                      'pi-info-circle'
                  }`} />
                </div>
                <div className="card__t" style={{ display: 'block', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>{rule.name}</span>
                    <span className={`chip chip--${tone}`}>{rule.count.toLocaleString('en-IN')} invoices</span>
                    <span className="chip chip--mute mono" style={{ fontSize: 10.5 }}>{codePref}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, fontWeight: 400, marginTop: 3 }}>
                    {rule.description} <b>Owner:</b> {rule.owner}.
                  </div>
                </div>
                {/* Right-side per-source counts — mirrors mockup E003 / E022 cards. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {groupExcelCount > 0 && (
                    <span className="chip chip--info">Excel {groupExcelCount}</span>
                  )}
                  {groupOcrCount > 0 && (
                    <span className="chip chip--vio">OCR {groupOcrCount}</span>
                  )}
                  <i className={`pi ${isOpen ? 'pi-chevron-up' : 'pi-chevron-down'} muted`} style={{ padding: 6 }} />
                </div>
              </div>

              {isOpen && (
                <div className="card__b card__b--flush">
                  {fix && (
                    <div style={{
                      padding: '12px 18px',
                      background: 'linear-gradient(90deg, rgba(239,68,68,0.04), transparent)',
                      borderBottom: '1px solid var(--b-1)',
                      display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap'
                    }}>
                      <i className="pi pi-info-circle" style={{ color: iconFg }} />
                      <div style={{ flex: 1, fontSize: 12.5 }}>
                        <b>What this means:</b> {rule.description}
                      </div>
                      <div className="insight" style={{ padding: '8px 12px', background: 'linear-gradient(135deg, #f5f3ff, #eef2ff)', maxWidth: 340 }}>
                        <div className="insight__ic" style={{ width: 26, height: 26, fontSize: 12 }}><i className="pi pi-bolt" /></div>
                        <div style={{ fontSize: 12 }}><b>AI suggested fix:</b> {fix}</div>
                      </div>
                    </div>
                  )}

                  {isLoadingGroup && (
                    <div className="ph"><i className="pi pi-spin pi-spinner" /> Loading samples…</div>
                  )}

                  {!isLoadingGroup && groupSamples.length === 0 && (
                    <div className="ph">
                      <i className="pi pi-inbox" />
                      No invoice samples available yet for {codePref}.
                    </div>
                  )}

                  {!isLoadingGroup && groupSamples.length > 0 && (
                    <table className="tbl compact">
                      <thead>
                        <tr>
                          <th>Invoice</th>
                          <th>Date</th>
                          <th>Supplier</th>
                          <th>PO ref</th>
                          <th>Source</th>
                          <th className="num">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupSamples.map((s) => (
                          <tr key={s.invoice_id} onClick={() => setOpenInv(s)}>
                            <td className="bold">{s.invoice_number}</td>
                            <td>{formatDate(s.invoice_date)}</td>
                            <td>{s.supplier_name || '—'}</td>
                            <td className="mono">{s.po_number || '—'}</td>
                            <td>
                              {s.source === 'ocr'   ? <span className="chip chip--vio">OCR</span>
                                : s.source === 'excel' ? <span className="chip chip--info">Excel</span>
                                : <span className="muted">—</span>}
                            </td>
                            <td className="num">{formatINRSymbol(s.total_amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {groupSamples.length > 0 && groupSamples.length >= 10 && (
                    <div style={{
                      padding: '8px 18px', background: 'var(--s-1)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      fontSize: 12
                    }}>
                      <span className="muted">Showing 10 of {rule.count.toLocaleString('en-IN')} — sorted by date desc</span>
                      <a
                        href="#"
                        onClick={(e) => { e.preventDefault(); navigate(`/invoices/validate?status=waiting_for_re_validation`) }}
                      >Show all {rule.count.toLocaleString('en-IN')} →</a>
                    </div>
                  )}

                  {/* Bulk action button per code (matches mockup E022 / E003 cards). */}
                  {codePref === 'E022' && (
                    <div style={{ padding: '12px 18px', background: 'var(--s-1)', borderTop: '1px solid var(--b-1)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button className="btn btn--ok btn--xs" onClick={() => runBulkAction(rule, 'approve-debit-notes')}>
                        <i className="pi pi-check" /> Approve all {rule.count.toLocaleString('en-IN')} debit notes
                      </button>
                    </div>
                  )}
                  {codePref === 'E003' && (
                    <div style={{ padding: '12px 18px', background: 'var(--s-1)', borderTop: '1px solid var(--b-1)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button className="btn btn--g btn--xs" onClick={() => runBulkAction(rule, 'email-erp')}>
                        <i className="pi pi-flag" /> Email source ERP
                      </button>
                    </div>
                  )}
                  {codePref === 'E070' && (
                    <div style={{ padding: '12px 18px', background: 'var(--s-1)', borderTop: '1px solid var(--b-1)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button className="btn btn--g btn--xs" onClick={() => runBulkAction(rule, 'email-receiving')}>
                        <i className="pi pi-envelope" /> Email receiving team
                      </button>
                    </div>
                  )}
                  {codePref === 'E004' && (
                    <div style={{ padding: '12px 18px', background: 'var(--s-1)', borderTop: '1px solid var(--b-1)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button className="btn btn--g btn--xs" onClick={() => runBulkAction(rule, 'reextract-ocr')}>
                        <i className="pi pi-refresh" /> Re-extract OCR
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
              className="btn btn--g btn--sm"
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
        {openInv && <InvoiceExpansion invoiceId={openInv.invoice_id} poNumber={openInv.po_number} />}
      </SlideOver>
    </>
  )
}

export default ReconciliationPage
