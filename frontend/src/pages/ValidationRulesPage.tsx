import { useEffect, useMemo, useState } from 'react'
import PageHero from '../components/PageHero'
import KPICard from '../components/KPICard'
import StatusChip from '../components/StatusChip'
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

const SEVERITY_VARIANT: Record<Severity, 'danger' | 'warn' | 'info'> = {
  error:   'danger',
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

  return (
    <>
      <PageHero
        eyebrow="Validation rules"
        eyebrowIcon="pi-shield"
        title="Validation rules"
        subtitle="Every check the engine runs against incoming invoices, with current count, owner, and severity. Mute a rule temporarily by toggling it off."
      />

      <div className="grid-kpis" style={{ marginBottom: 'var(--space-6)' }}>
        <KPICard label="Active rules"      value={counts.total - counts.muted} icon="pi-shield"           variant="brand" />
        <KPICard label="Blockers"          value={counts.blockers}             icon="pi-exclamation-triangle" variant="rose" />
        <KPICard label="Warnings"          value={counts.warnings}             icon="pi-exclamation-circle"   variant="amber" />
        <KPICard label="Info"              value={counts.info}                 icon="pi-info-circle"          variant="violet" />
        <KPICard label="Muted"             value={counts.muted}                icon="pi-eye-slash"            variant="slate" />
      </div>

      <div className="toolbar">
        <div className="toolbar__search">
          <i className="pi pi-search toolbar__searchIcon" />
          <input
            className="toolbar__searchInput"
            type="search"
            placeholder="Search code, name, description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as Severity | 'all')}
          style={{ padding: '8px 12px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)' }}
        >
          <option value="all">All severities</option>
          <option value="error">Blocker</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)' }}
        >
          <option value="all">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <div style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>
          {loading ? 'Loading…' : `Showing ${filtered.length} of ${rules.length} rules`}
        </div>
      </div>

      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="pi pi-spin pi-spinner" /> Loading rule catalog…
          </div>
        ) : filtered.length === 0 ? (
          <div className="emptyState" style={{ border: 0, borderRadius: 0 }}>
            <div className="emptyState__icon"><i className="pi pi-search" /></div>
            <div className="emptyState__title">No rules match your filter</div>
            <div className="emptyState__body">Clear the search above or pick a different severity / category.</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--surface-1)', borderBottom: '1px solid var(--border-subtle)' }}>
                  <Th>Code</Th>
                  <Th>Rule</Th>
                  <Th>Severity</Th>
                  <Th>Category</Th>
                  <Th>Owner</Th>
                  <Th align="right">Affected</Th>
                  <Th align="right">Active</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.code} style={{ borderBottom: '1px solid var(--border-subtle)', opacity: r.active ? 1 : 0.55 }}>
                    <Td mono bold>{r.code}</Td>
                    <Td>
                      <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.name}</div>
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{r.description}</div>
                    </Td>
                    <Td>
                      <StatusChip
                        status={r.severity}
                        variant={SEVERITY_VARIANT[r.severity]}
                        label={SEVERITY_LABEL[r.severity]}
                      />
                    </Td>
                    <Td muted>{r.category}</Td>
                    <Td muted>{r.owner}</Td>
                    <Td align="right" mono>{r.count.toLocaleString('en-IN')}</Td>
                    <Td align="right">
                      <button
                        type="button"
                        onClick={() => toggleRule(r)}
                        title={r.active ? 'Mute this rule' : 'Re-enable this rule'}
                        className={`action-btn ${r.active ? '' : 'action-btn--ghost'}`}
                        style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}
                      >
                        <i className={`pi ${r.active ? 'pi-check' : 'pi-eye-slash'}`} /> {r.active ? 'Active' : 'Muted'}
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return (
    <th style={{
      padding: '10px 14px', fontSize: 'var(--fs-xs)', fontWeight: 600,
      color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
      textAlign: align === 'right' ? 'right' : 'left', whiteSpace: 'nowrap'
    }}>{children}</th>
  )
}
function Td({ children, bold, muted, align, mono }: {
  children?: React.ReactNode; bold?: boolean; muted?: boolean; align?: 'right'; mono?: boolean
}) {
  return (
    <td style={{
      padding: '12px 14px', fontSize: 'var(--fs-sm)',
      color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
      fontWeight: bold ? 600 : 400,
      textAlign: align === 'right' ? 'right' : 'left',
      fontFamily: mono ? 'var(--font-mono)' : undefined,
      fontVariantNumeric: mono ? 'tabular-nums' : undefined,
      verticalAlign: 'top'
    }}>{children}</td>
  )
}

export default ValidationRulesPage
