import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Modal confirmation dialog.
 *
 *   const confirm = useConfirm()
 *   const ok = await confirm({
 *     title: 'Approve invoice for payment?',
 *     body: 'This will move it to the next payment batch.',
 *     kind: 'success',
 *     okLabel: 'Approve'
 *   })
 *   if (ok) doIt()
 *
 * `body` accepts ReactNode so callers can embed forms, tables, etc.
 */

export type ConfirmKind = 'info' | 'warn' | 'danger' | 'success'

interface ConfirmOptions {
  title: string
  body?: ReactNode
  okLabel?: string
  cancelLabel?: string
  /** Tints the icon and the OK button. */
  kind?: ConfirmKind
  /** PrimeIcons class for the leading icon. */
  icon?: string
}

const DEFAULT_ICONS: Record<ConfirmKind, string> = {
  info:    'pi-question-circle',
  warn:    'pi-exclamation-triangle',
  danger:  'pi-exclamation-circle',
  success: 'pi-check-circle'
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    setOpts(options)
    return new Promise<boolean>(resolve => {
      resolveRef.current = resolve
    })
  }, [])

  const finish = useCallback((value: boolean) => {
    resolveRef.current?.(value)
    resolveRef.current = null
    setOpts(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && <Dialog opts={opts} onResolve={finish} />}
    </ConfirmContext.Provider>
  )
}

function Dialog({ opts, onResolve }: { opts: ConfirmOptions; onResolve: (v: boolean) => void }) {
  const kind = opts.kind ?? 'info'
  const icon = opts.icon ?? DEFAULT_ICONS[kind]

  return (
    <div
      className="confirm-backdrop is-open"
      onClick={(e) => { if (e.target === e.currentTarget) onResolve(false) }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div className="confirm">
        <div className="confirm__head">
          <div className={`confirm__icon confirm__icon--${kind}`}>
            <i className={`pi ${icon}`} aria-hidden />
          </div>
          <div style={{ flex: 1 }}>
            <h3 id="confirm-title" className="confirm__title">{opts.title}</h3>
            {opts.body && <div className="confirm__body">{opts.body}</div>}
          </div>
        </div>
        <div className="confirm__actions">
          <button type="button" className="action-btn action-btn--ghost" onClick={() => onResolve(false)} autoFocus>
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className="action-btn"
            style={kind === 'danger' ? { background: 'linear-gradient(135deg, #f43f5e, #e11d48)', boxShadow: '0 6px 16px -6px rgba(239,68,68,.5)' } : undefined}
            onClick={() => onResolve(true)}
          >
            {opts.okLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>')
  return ctx
}
