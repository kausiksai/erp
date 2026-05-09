import { useEffect, useState } from 'react'
import PageHero from '../components/PageHero'
import StatusChip from '../components/StatusChip'
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
  audit_id: number
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
  const debouncedSearch = useDebounce(search, 350)

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
      <PageHero
        eyebrow="Audit log"
        eyebrowIcon="pi-history"
        title="Audit log"
        subtitle="Chronological record of every meaningful action across the portal — automated or human. Use it for compliance, root-cause and incident review."
      />

      <div className="toolbar">
        <div className="toolbar__search">
          <i className="pi pi-search toolbar__searchIcon" />
          <input
            className="toolbar__searchInput"
            type="search"
            placeholder="Search summary, entity, action…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select
          value={actorKind}
          onChange={(e) => setActorKind(e.target.value as ActorKind | 'all')}
          style={{ padding: '8px 12px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)' }}
        >
          <option value="all">All actors</option>
          <option value="user">User</option>
          <option value="automation">Automation</option>
          <option value="system">System</option>
        </select>

        <select
          value={entityKind}
          onChange={(e) => setEntityKind(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)' }}
        >
          <option value="all">All entities</option>
          <option value="invoice">Invoice</option>
          <option value="po">Purchase order</option>
          <option value="grn">GRN</option>
          <option value="supplier">Supplier</option>
          <option value="rule">Rule</option>
          <option value="batch">Payment batch</option>
        </select>

        <div style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>
          {loading ? 'Loading…' : `${events.length} of ${total.toLocaleString('en-IN')}`}
        </div>
      </div>

      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading && events.length === 0 ? (
          <div style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="pi pi-spin pi-spinner" /> Loading…
          </div>
        ) : events.length === 0 ? (
          <div className="emptyState" style={{ border: 0, borderRadius: 0 }}>
            <div className="emptyState__icon"><i className="pi pi-history" /></div>
            <div className="emptyState__title">No matching events</div>
            <div className="emptyState__body">
              Try clearing the filters above. The audit log starts populating after Phase 2 services begin emitting events.
            </div>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--surface-1)', borderBottom: '1px solid var(--border-subtle)' }}>
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Entity</Th>
                <Th>Summary</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.audit_id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <Td muted nowrap>{formatDateTime(e.ts)}</Td>
                  <Td>
                    <StatusChip
                      status={e.actor_kind}
                      variant={ACTOR_VARIANT[e.actor_kind]}
                      label={e.actor_label || ACTOR_LABEL[e.actor_kind]}
                    />
                  </Td>
                  <Td><code style={{ fontSize: 'var(--fs-xs)' }}>{e.action}</code></Td>
                  <Td>
                    {e.entity_kind && (
                      <>
                        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          {e.entity_kind}
                        </span>{' '}
                        <span style={{ fontWeight: 600 }}>{e.entity_label || e.entity_id || '—'}</span>
                      </>
                    )}
                  </Td>
                  <Td muted>{e.summary || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th style={{
      padding: '10px 14px', fontSize: 'var(--fs-xs)', fontWeight: 600,
      color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
      textAlign: 'left', whiteSpace: 'nowrap'
    }}>{children}</th>
  )
}
function Td({ children, muted, nowrap }: { children?: React.ReactNode; muted?: boolean; nowrap?: boolean }) {
  return (
    <td style={{
      padding: '12px 14px', fontSize: 'var(--fs-sm)',
      color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
      whiteSpace: nowrap ? 'nowrap' : undefined,
      verticalAlign: 'top'
    }}>{children}</td>
  )
}

export default AuditLogPage
