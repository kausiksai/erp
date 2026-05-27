import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'

/**
 * Validation Rules library — every check the engine runs.
 *
 * Catalog comes from GET /api/validation-rules (Phase 2b). Admins can
 * mute / un-mute or change severity via PATCH /api/validation-rules/:code.
 *
 * Layout:
 *   1. Hero
 *   2. KPI strip — total / blockers / warnings / info / muted
 *   3. Filter row — search + severity + category
 *   4. Table — code · name · severity · category · owner · count · active
 */

type Severity = 'error' | 'warning' | 'info'

interface Rule {
  code: string
  name: string
  description: string
  severity: Severity
  category: string
  owner: string
  count: number
  active: boolean
}

const SEVERITY_CHIP: Record<Severity, 'err' | 'warn' | 'info'> = {
  error:   'err',
  warning: 'warn',
  info:    'info'
}
const SEVERITY_LABEL: Record<Severity, string> = {
  error:   'Blocker',
  warning: 'Warning',
  info:    'Info'
}

function ValidationRulesPage() {
  const toast = useToast()
  const confirmDialog = useConfirm()

  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [severityFilter, setSeverityFilter] = useState<Severity | 'all'>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [revalidating, setRevalidating] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await apiFetch('validation-rules')
        if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load rules'))
        const body = await res.json()
        if (alive) setRules(body.rules || [])
      } catch (err) {
        if (alive) toast.danger('Couldn\'t load rules', getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [toast])

  // Distinct categories for the filter dropdown.
  const categories = useMemo(() => {
    const set = new Set(rules.map(r => r.category))
    return Array.from(set).sort()
  }, [rules])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rules.filter(r => {
      if (severityFilter !== 'all' && r.severity !== severityFilter) return false
      if (categoryFilter !== 'all' && r.category !== categoryFilter) return false
      if (!q) return true
      return r.code.toLowerCase().includes(q)
        || r.name.toLowerCase().includes(q)
        || r.description.toLowerCase().includes(q)
    })
  }, [rules, search, severityFilter, categoryFilter])

  // KPI counts (full set, not filtered)
  const counts = useMemo(() => ({
    total:    rules.length,
    blockers: rules.filter(r => r.severity === 'error').length,
    warnings: rules.filter(r => r.severity === 'warning').length,
    info:     rules.filter(r => r.severity === 'info').length,
    muted:    rules.filter(r => !r.active).length
  }), [rules])

  async function toggleRule(rule: Rule) {
    const turningOff = rule.active
    if (turningOff) {
      const ok = await confirmDialog({
        title: `Mute rule ${rule.code}?`,
        body: `The validation engine will stop emitting "${rule.name}" until you re-enable it. Currently ${rule.count.toLocaleString('en-IN')} invoice${rule.count === 1 ? ' is' : 's are'} flagged by this rule.`,
        icon: 'pi-eye-slash',
        kind: 'warn',
        okLabel: 'Mute rule'
      })
      if (!ok) return
    }
    try {
      const res = await apiFetch(`validation-rules/${encodeURIComponent(rule.code)}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !rule.active })
      })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Toggle failed'))
      setRules(prev => prev.map(r => r.code === rule.code ? { ...r, active: !rule.active } : r))
      toast.success(turningOff ? 'Rule muted' : 'Rule enabled', `${rule.code} — ${rule.name}`)
    } catch (err) {
      toast.danger('Toggle failed', getDisplayError(err))
    }
  }

  async function revalidateAllPending() {
    const ok = await confirmDialog({
      title: 'Re-run validation on all pending invoices?',
      body: 'After a rule change, existing pending invoices keep their cached mismatches. This re-runs the engine against every invoice currently in waiting_for_validation, waiting_for_re_validation, exception_approval, or debit_note_approval. Can take a minute on large datasets.',
      icon: 'pi-refresh',
      kind: 'warn',
      okLabel: 'Re-validate all'
    })
    if (!ok) return
    setRevalidating(true)
    try {
      const res = await apiFetch('validation-rules/revalidate-all-pending', { method: 'POST' })
      if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Re-validation failed'))
      const body = await res.json()
      toast.success(
        'Re-validation complete',
        `${body.succeeded.toLocaleString('en-IN')} ok · ${body.failed.toLocaleString('en-IN')} failed (of ${body.total.toLocaleString('en-IN')} pending)`
      )
    } catch (err) {
      toast.danger('Re-validation failed', getDisplayError(err))
    } finally {
      setRevalidating(false)
    }
  }

  function exportCsv() {
    const rows = rules.map((r) => ({
      code: r.code, name: r.name, severity: SEVERITY_LABEL[r.severity],
      category: r.category, owner: r.owner, count: r.count,
      active: r.active ? 'yes' : 'muted'
    }))
    if (rows.length === 0) return
    const csv = [
      Object.keys(rows[0]).join(','),
      ...rows.map((row) => Object.values(row).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `validation-rules-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      {/* Hero — verbatim from mockup VIEWS.rules */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-shield" /> System</span>
          <h1>Validation rules</h1>
          <p>Every check the engine runs, with what it does, why it fires, who owns the fix, and current count. Adjust severity or temporarily mute a rule from here.</p>
        </div>
        <div className="hero__act">
          <button className="btn btn--g" onClick={exportCsv}>
            <i className="pi pi-download" /> Export catalogue
          </button>
          <button
            className="btn btn--g"
            onClick={revalidateAllPending}
            disabled={revalidating}
            title="Re-run the validation engine on every currently-pending invoice. Use this after toggling a rule."
          >
            {revalidating
              ? <><i className="pi pi-spin pi-spinner" /> Re-validating…</>
              : <><i className="pi pi-refresh" /> Re-validate pending</>}
          </button>
          <button
            className="btn btn--p"
            onClick={() => toast.info('Coming next', 'Custom rules will land with /api/validation-rules POST.')}
          >
            <i className="pi pi-plus" /> New rule
          </button>
        </div>
      </section>

      {/* 4-up KPI strip */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--brand">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-shield" /></div></div>
          <p className="kpi__l">Active rules</p>
          <div className="kpi__v">{loading ? '—' : (counts.total - counts.muted).toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-flag" /></div></div>
          <p className="kpi__l">Blocker</p>
          <div className="kpi__v">{loading ? '—' : counts.blockers.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--am">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-exclamation-triangle" /></div></div>
          <p className="kpi__l">Warning</p>
          <div className="kpi__v">{loading ? '—' : counts.warnings.toLocaleString('en-IN')}</div>
        </div>
        <div className="kpi kpi--sl">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-eye" /></div></div>
          <p className="kpi__l">Info</p>
          <div className="kpi__v">{loading ? '—' : counts.info.toLocaleString('en-IN')}</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="tb__sr">
          <i className="pi pi-search" />
          <input
            placeholder="Search rule code, name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as Severity | 'all')}>
          <option value="all">All severities</option>
          <option value="error">Blocker</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="tb__c">
          {loading ? 'Loading…' : `${filtered.length.toLocaleString('en-IN')} rules`}
        </span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div className="ph"><i className="pi pi-spin pi-spinner" /> Loading rule catalog…</div>
        ) : filtered.length === 0 ? (
          <div className="ph">
            <i className="pi pi-search" />
            No rules match your filter.
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th>
                <th>Rule</th>
                <th>Severity</th>
                <th>Category</th>
                <th>Owner</th>
                <th className="num">Current count</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.code} style={{ opacity: r.active ? 1 : 0.55, cursor: 'default' }}>
                  <td className="bold mono">{r.code}</td>
                  <td>
                    <div className="bold">{r.name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{r.description}</div>
                  </td>
                  <td><span className={`chip chip--${SEVERITY_CHIP[r.severity]}`}>{SEVERITY_LABEL[r.severity]}</span></td>
                  <td>{r.category}</td>
                  <td>{r.owner}</td>
                  <td className="num">{r.count.toLocaleString('en-IN')}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => toggleRule(r)}
                      title={r.active ? 'Mute this rule' : 'Re-enable this rule'}
                      className={`btn ${r.active ? 'btn--ok' : 'btn--g'} btn--xs`}
                    >
                      <i className={`pi ${r.active ? 'pi-check' : 'pi-eye-slash'}`} /> {r.active ? 'Active' : 'Muted'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

export default ValidationRulesPage
