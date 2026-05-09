import { useEffect } from 'react'
import type { ReactNode } from 'react'

/**
 * Right-edge slide-over panel.
 *
 * Used for invoice / PO drill-down detail and for registration forms
 * (supplier, user, owner, profile). The list view stays put behind so the
 * user keeps their filters and place.
 *
 * Closes on backdrop click, Escape key, or the × button. Body scroll is
 * locked while open.
 */
interface SlideOverProps {
  open: boolean
  title: ReactNode
  onClose: () => void
  /** Right-side action button strip rendered in the header (Open full, etc). */
  headerActions?: ReactNode
  children: ReactNode
}

function SlideOver({ open, title, onClose, headerActions, children }: SlideOverProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  return (
    <>
      <div
        className={`slideover-backdrop ${open ? 'is-open' : ''}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`slideover ${open ? 'is-open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
      >
        <header className="slideover__header">
          <button type="button" className="slideover__close" onClick={onClose} aria-label="Close">
            <i className="pi pi-times" />
          </button>
          <h2 className="slideover__title">{title}</h2>
          {headerActions}
        </header>
        <div className="slideover__body">{open && children}</div>
      </aside>
    </>
  )
}

export default SlideOver
