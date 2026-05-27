import React, { useEffect, useMemo, useState } from 'react'
import { apiFetch, getDisplayError } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useDebounce } from '../hooks/useDebounce'
import { formatDateTime } from '../utils/format'

/**
 * Audit log — chronological record of every meaningful action across the
 * portal. Reads from GET /api/audit (Phase 2c).
 *
 * Filters supported:
 *   q           — free-text search across summary / entity_label / action
 *   actor_kind  — user / automation / system
 *   action      — exact match
 *   entity_kind — invoice / po / grn / supplier / rule / batch
 *   since/until — ISO date range
 */

type ActorKind = 'user' | 'automation' | 'system'

interface AuditEvent {
  audit_id: number | string
  ts: string
  actor_kind: ActorKind
  actor_id: number | null
  actor_label: string | null
  action: string
  entity_kind: string | null
  entity_id: string | null
  entity_label: string | null
  summary: string | null
  meta: Record<string, unknown> | null
}

const ACTOR_VARIANT: Record<ActorKind, 'info' | 'violet' | 'muted'> = {
  user:       'info',
  automation: 'violet',
  system:     'muted'
}
const ACTOR_LABEL: Record<ActorKind, string> = {
  user:       'User',
  automation: 'Automation',
  system:     'System'
}

function AuditLogPage() {
  const toast = useToast()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [actorKind, setActorKind] = useState<'all' | ActorKind>('all')
  const [entityKind, setEntityKind] = useState<string>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const debouncedSearch = useDebounce(search, 350)
  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const hasTriggerRows = useMemo(
    () => events.some((e) => e.meta && (e.meta as { source?: string }).source === 'trigger'),
    [events]
  )

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const qs = new URLSearchParams()
        qs.set('limit', '100')
        if (debouncedSearch) qs.set('q', debouncedSearch)
        if (actorKind !== 'all') qs.set('actor_kind', actorKind)
        if (entityKind !== 'all') qs.set('entity_kind', entityKind)
        const res = await apiFetch(`audit?${qs.toString()}`)
        if (!res.ok) throw new Error('Failed to load audit log')
        const body = await res.json()
        if (!alive) return
        setEvents(body.items || [])
        setTotal(body.total || 0)
      } catch (err) {
        if (alive) toast.danger('Couldn\'t load audit log', getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [debouncedSearch, actorKind, entityKind, toast])

  return (
    <>
      {/* Hero — verbatim from mockup VIEWS.audit */}
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-history" /> System</span>
          <h1>Audit log</h1>
          <p>Chronological record of every change in the system: invoice loads, validations, approvals, payments, master edits, integration runs.</p>
        </div>
        <div className="hero__act">
          <button
            type="button"
            className="btn btn--g"
            onClick={() => {
              const rows = events.map((e) => ({
                ts: e.ts,
                actor: e.actor_label,
                action: e.action,
                entity: `${e.entity_kind || ''} ${e.entity_id || ''}`.trim(),
                details: e.summary
              }))
              if (rows.length === 0) return
              const csv = [
                Object.keys(rows[0]).join(','),
                ...rows.map((row) => Object.values(row).map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
              ].join('\n')
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
              const url  = URL.createObjectURL(blob)
              const a    = document.createElement('a')
              a.href = url
              a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            <i className="pi pi-download" /> Export
          </button>
        </div>
      </section>

      <div className="toolbar">
        <div className="tb__sr">
          <i className="pi pi-search" />
          <input
            placeholder="Search by entity id, user, action…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={actorKind} onChange={(e) => setActorKind(e.target.value as ActorKind | 'all')}>
          <option value="all">All actors</option>
          <option value="user">User</option>
          <option value="automation">Automation</option>
          <option value="system">System</option>
        </select>
        <select value={entityKind} onChange={(e) => setEntityKind(e.target.value)}>
          <option value="all">All entities</option>
          <option value="invoice">Invoice</option>
          <option value="po">Purchase order</option>
          <option value="grn">GRN</option>
          <option value="supplier">Supplier</option>
          <option value="rule">Rule</option>
          <option value="batch">Payment batch</option>
        </select>
        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
          DB-level invoice status changes are merged in from the
          <code style={{ margin: '0 4px' }}>invoice_status_audit</code>
          trigger.
        </span>
        <span className="tb__c">
          {loading ? 'Loading…' : `${events.length.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} events`}
        </span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading && events.length === 0 ? (
          <div className="ph"><i className="pi pi-spin pi-spinner" /> Loading…</div>
        ) : events.length === 0 ? (
          <div className="ph">
            <i className="pi pi-history" />
            No matching events. Audit log starts populating once services emit events.
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
                {hasTriggerRows && <th>Source</th>}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const variant =
                  ACTOR_VARIANT[e.actor_kind] === 'violet' ? 'vio' :
                  ACTOR_VARIANT[e.actor_kind] === 'info'   ? 'info' : 'mute'
                const id = String(e.audit_id)
                const isOpen = expanded.has(id)
                const hasMeta = e.meta && Object.keys(e.meta).length > 0
                const meta = (e.meta || {}) as {
                  source?: string
                  db_user?: string
                  app_name?: string
                  client_addr?: string
                  old_status?: string
                  new_status?: string
                }
                const isTrigger = meta.source === 'trigger'
                return (
                  <React.Fragment key={id}>
                    <tr
                      style={{ cursor: hasMeta ? 'pointer' : 'default' }}
                      onClick={() => hasMeta && toggleRow(id)}
                    >
                      <td className="muted" style={{ textAlign: 'center' }}>
                        {hasMeta
                          ? <i className={`pi ${isOpen ? 'pi-chevron-down' : 'pi-chevron-right'}`} style={{ fontSize: 11 }} />
                          : ''}
                      </td>
                      <td><span className="muted">{formatDateTime(e.ts)}</span></td>
                      <td>
                        <span className={`chip chip--${variant}`}>
                          {e.actor_label || ACTOR_LABEL[e.actor_kind]}
                        </span>
                      </td>
                      <td><span className="mono">{e.action}</span></td>
                      <td>
                        {e.entity_kind && (
                          <>
                            <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                              {e.entity_kind}
                            </span>{' '}
                            <b>{e.entity_label || e.entity_id || '—'}</b>
                          </>
                        )}
                      </td>
                      <td className="muted">{e.summary || '—'}</td>
                      {hasTriggerRows && (
                        <td>
                          {isTrigger
                            ? <span className="chip chip--mute" title={`db_user=${meta.db_user || '—'}\napp_name=${meta.app_name || '—'}\nclient_addr=${meta.client_addr || '—'}`}>
                                <i className="pi pi-database" /> trigger
                              </span>
                            : <span className="muted" style={{ fontSize: 11 }}>app</span>}
                        </td>
                      )}
                    </tr>
                    {isOpen && hasMeta && (
                      <tr>
                        <td></td>
                        <td colSpan={(hasTriggerRows ? 6 : 5)}>
                          <MetaPanel meta={meta as Record<string, unknown>} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/**
 * Pretty-prints the meta JSONB. For trigger rows it surfaces the
 * status-audit specifics (old/new status, db_user, app_name, client_addr)
 * as a definition list, then dumps any remaining keys as JSON.
 */
function MetaPanel({ meta }: { meta: Record<string, unknown> }) {
  const known = ['source', 'db_user', 'app_name', 'client_addr', 'old_status', 'new_status']
  const remaining: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!known.includes(k)) remaining[k] = v
  }
  const m = meta as {
    db_user?: string; app_name?: string; client_addr?: string
    old_status?: string; new_status?: string; source?: string
  }
  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: '0.75rem 1rem',
      margin: '0.4rem 0'
    }}>
      {(m.old_status || m.new_status) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
          <span className="muted">Status</span>
          <code>{m.old_status || '—'}</code>
          <i className="pi pi-arrow-right" style={{ fontSize: 10, color: 'var(--text-muted)' }} />
          <code>{m.new_status || '—'}</code>
        </div>
      )}
      {(m.db_user || m.app_name || m.client_addr) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, fontSize: 12 }}>
          {m.db_user && <div><span className="muted">DB user · </span><code>{m.db_user}</code></div>}
          {m.app_name && <div><span className="muted">App · </span><code>{m.app_name}</code></div>}
          {m.client_addr && <div><span className="muted">Client · </span><code>{String(m.client_addr)}</code></div>}
        </div>
      )}
      {Object.keys(remaining).length > 0 && (
        <pre style={{
          fontSize: 11.5,
          margin: '0.5rem 0 0',
          padding: '0.5rem',
          background: 'var(--surface-0)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          overflowX: 'auto',
          maxHeight: 240
        }}>
          {JSON.stringify(remaining, null, 2)}
        </pre>
      )}
    </div>
  )
}

export default AuditLogPage
