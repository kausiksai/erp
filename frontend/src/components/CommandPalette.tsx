import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * ⌘K command palette.
 *
 * The shell + keyboard wiring lives here; the actual search results are
 * supplied by the consumer via the `sections` prop, so wiring to
 * /api/search (Phase 2g) lives outside this component.
 *
 * Keyboard: ↑/↓ to move, Enter to select, Esc to close. Ctrl/⌘+K to open
 * is wired by the consumer (App).
 */

export interface CmdItem {
  id: string
  label: ReactNode
  icon?: string                // PrimeIcons class
  meta?: ReactNode             // right-aligned secondary text
  /** Run when the item is picked. Palette closes automatically. */
  onSelect: () => void
}

export interface CmdSection {
  label: string
  items: CmdItem[]
}

interface Props {
  open: boolean
  onClose: () => void
  /** Bound to the input value — palette is controlled. */
  query: string
  onQueryChange: (q: string) => void
  sections: CmdSection[]
  placeholder?: string
}

function CommandPalette({ open, onClose, query, onQueryChange, sections, placeholder }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const flat = sections.flatMap(s => s.items)
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (open) {
      // Focus the input after the modal animates in
      setTimeout(() => inputRef.current?.focus(), 50)
      setActive(0)
    }
  }, [open])

  // Reset highlight when results change
  useEffect(() => { setActive(0) }, [query, sections.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(0, a - 1)); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const it = flat[active]
        if (it) { it.onSelect(); onClose() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, flat, active])

  const isEmpty = sections.every(s => s.items.length === 0)

  return (
    <div
      className={`cmdk-backdrop ${open ? 'is-open' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
    >
      <div className="cmdk">
        <div className="cmdk__input">
          <i className="pi pi-search" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder={placeholder ?? 'Search invoices, POs, suppliers, run an action…'}
            aria-label="Search the portal"
          />
          <span className="cmdk__esc">ESC</span>
        </div>
        <div className="cmdk__list">
          {isEmpty && (
            <div className="cmdk__empty">No matches for "{query}"</div>
          )}
          {sections.map(section => section.items.length > 0 && (
            <div key={section.label}>
              <div className="cmdk__section">{section.label}</div>
              {section.items.map(item => {
                const idx = flat.findIndex(f => f.id === item.id)
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`cmdk__item ${idx === active ? 'is-active' : ''}`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => { item.onSelect(); onClose() }}
                  >
                    {item.icon && <i className={`pi ${item.icon}`} aria-hidden />}
                    <span>{item.label}</span>
                    {item.meta && <span className="cmdk__meta">{item.meta}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default CommandPalette
