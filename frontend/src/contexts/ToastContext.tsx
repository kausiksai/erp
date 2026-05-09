import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Global toast notifications. Use `const { toast } = useToast()` then
 * `toast.success('Saved', 'Your changes are live')`.
 *
 * Stacks top-right under the topbar. Auto-dismisses after `duration` ms.
 */

export type ToastVariant = 'success' | 'info' | 'warn' | 'danger'

interface ToastEntry {
  id: number
  variant: ToastVariant
  title: string
  body?: string
  leaving?: boolean
}

interface ToastApi {
  show: (variant: ToastVariant, title: string, body?: string, durationMs?: number) => void
  success: (title: string, body?: string, durationMs?: number) => void
  info: (title: string, body?: string, durationMs?: number) => void
  warn: (title: string, body?: string, durationMs?: number) => void
  danger: (title: string, body?: string, durationMs?: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const VARIANT_ICON: Record<ToastVariant, string> = {
  success: 'pi-check-circle',
  info:    'pi-info-circle',
  warn:    'pi-exclamation-triangle',
  danger:  'pi-times-circle'
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([])

  const remove = useCallback((id: number) => {
    setItems(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t))
    setTimeout(() => {
      setItems(prev => prev.filter(t => t.id !== id))
    }, 200)
  }, [])

  const show = useCallback((variant: ToastVariant, title: string, body?: string, durationMs = 3500) => {
    const id = Date.now() + Math.random()
    setItems(prev => [...prev, { id, variant, title, body }])
    setTimeout(() => remove(id), durationMs)
  }, [remove])

  const api: ToastApi = {
    show,
    success: (t, b, d) => show('success', t, b, d),
    info:    (t, b, d) => show('info',    t, b, d),
    warn:    (t, b, d) => show('warn',    t, b, d),
    danger:  (t, b, d) => show('danger',  t, b, d)
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="region" aria-live="polite" aria-label="Notifications">
        {items.map(t => (
          <div key={t.id} className={`toast toast--${t.variant} ${t.leaving ? 'is-leaving' : ''}`}>
            <div className="toast__icon"><i className={`pi ${VARIANT_ICON[t.variant]}`} aria-hidden /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast__title">{t.title}</div>
              {t.body && <div className="toast__body">{t.body}</div>}
            </div>
            <button type="button" className="toast__close" onClick={() => remove(t.id)} aria-label="Dismiss">
              <i className="pi pi-times" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
