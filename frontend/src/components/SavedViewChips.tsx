import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { apiFetch } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { useConfirm } from '../contexts/ConfirmContext'

/**
 * Saved-view chip row.
 *
 * Renders a horizontal pill row above a list table. First slot is "All"
 * (clears filters); the rest are built-in views the page declares plus
 * any user-saved views from /api/saved-views?scope=:scope (Phase 2d).
 *
 *   <SavedViewChips
 *     scope="invoices"
 *     builtInViews={[
 *       { key: 'ready', label: 'Ready to pay', filters: { status: 'validated' } },
 *       { key: 'hival', label: 'High value (>₹5L)', filters: { minAmount: '500000' } }
 *     ]}
 *     activeKey="all"
 *     currentFilters={{ status: 'validated' }}
 *     onPick={(view) => applyFilters(view.filters)}
 *   />
 *
 * If the saved-views table doesn't exist yet (migration not applied),
 * the API returns []. The chip row falls back to built-ins gracefully.
 */

export interface ViewDef {
  /** Unique key for active-state highlighting. */
  key: string
  label: string
  /** Filter combo to apply when clicked. Frontend owns this shape. */
  filters: Record<string, string | number | boolean>
  /** Optional badge count (e.g. "142") shown next to the label. */
  count?: number
  /** True for user-saved views (lets us render a delete affordance). */
  isUser?: boolean
  /** view_id of the saved row — only set on user views. */
  viewId?: number
}

interface Props {
  scope: 'invoices' | 'purchase_orders' | 'receipts' | 'reconciliation' | 'payments'
  builtInViews: ViewDef[]
  /** The view that should render with the active style. */
  activeKey: string
  /** The filter snapshot to persist when "Save current" is clicked. */
  currentFilters: Record<string, string | number | boolean>
  /** Whether the current filter combo is non-default (toggles "Save current" on). */
  hasActiveFilters: boolean
  onPick: (view: ViewDef) => void
}

function SavedViewChips({ scope, builtInViews, activeKey, currentFilters, hasActiveFilters, onPick }: Props) {
  const toast = useToast()
  const confirm = useConfirm()
  const [userViews, setUserViews] = useState<ViewDef[]>([])

  // Load the user's saved views for this scope.
  const reload = async () => {
    try {
      const res = await apiFetch(`saved-views?scope=${scope}`)
      if (!res.ok) return
      const body = await res.json()
      const items = Array.isArray(body.items) ? body.items : []
      setUserViews(items.map((v: { view_id: number; name: string; filters: Record<string, string | number | boolean> }) => ({
        key: `user:${v.view_id}`,
        viewId: v.view_id,
        label: v.name,
        filters: v.filters || {},
        isUser: true
      })))
    } catch { /* table missing → empty */ }
  }
  useEffect(() => { reload() }, [scope]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSaveCurrent() {
    if (!hasActiveFilters) {
      toast.warn('Nothing to save', 'Apply a filter first, then save the combo.')
      return
    }
    const name = window.prompt('Name this view:')   // tiny prompt is fine here — not destructive
    if (!name || !name.trim()) return
    try {
      const res = await apiFetch('saved-views', {
        method: 'POST',
        body: JSON.stringify({ scope, name: name.trim(), filters: currentFilters })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || 'Save failed')
      }
      toast.success('View saved', `"${name.trim()}" is now in your chip row.`)
      reload()
    } catch (err) {
      toast.danger('Save failed', err instanceof Error ? err.message : 'Try a different name.')
    }
  }

  async function handleDelete(view: ViewDef, e: React.MouseEvent) {
    e.stopPropagation()
    if (!view.viewId) return
    const ok = await confirm({
      title: `Delete "${view.label}" view?`,
      body: 'You can re-create it later by saving the filter combo again.',
      icon: 'pi-trash',
      kind: 'danger',
      okLabel: 'Delete'
    })
    if (!ok) return
    try {
      const res = await apiFetch(`saved-views/${view.viewId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      toast.success('View removed', '')
      reload()
    } catch {
      toast.danger('Delete failed', 'Try again in a moment.')
    }
  }

  return (
    <div className="view-chips">
      <span className="view-chips__label">Views:</span>
      <Chip
        active={activeKey === 'all'}
        onClick={() => onPick({ key: 'all', label: 'All', filters: {} })}
      >
        All
      </Chip>
      {builtInViews.map((v) => (
        <Chip
          key={v.key}
          active={activeKey === v.key}
          count={v.count}
          onClick={() => onPick(v)}
        >
          {v.label}
        </Chip>
      ))}
      {userViews.map((v) => (
        <Chip
          key={v.key}
          active={activeKey === v.key}
          onClick={() => onPick(v)}
          onDelete={(e) => handleDelete(v, e)}
        >
          {v.label}
        </Chip>
      ))}
      <button
        type="button"
        className="view-chip view-chip--add"
        onClick={handleSaveCurrent}
        title="Save the current filter combination as a quick-pick chip"
      >
        <i className="pi pi-plus" /> Save current
      </button>
    </div>
  )
}

function Chip({ children, active, count, onClick, onDelete }: {
  children: ReactNode
  active?: boolean
  count?: number
  onClick: () => void
  onDelete?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      className={`view-chip ${active ? 'view-chip--active' : ''}`}
      onClick={onClick}
    >
      <span>{children}</span>
      {count !== undefined && <span className="view-chip__count">{count.toLocaleString('en-IN')}</span>}
      {onDelete && (
        <span
          className="view-chip__del"
          onClick={onDelete}
          title="Delete this saved view"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') onDelete(e as unknown as React.MouseEvent) }}
        >
          <i className="pi pi-times" />
        </span>
      )}
    </button>
  )
}

export default SavedViewChips
