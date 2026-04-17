/**
 * Shared formatting helpers.
 *
 * Critical: the `pg` Node driver returns Postgres `numeric`/`decimal`
 * columns as JavaScript strings (to preserve precision). A naive
 * `typeof n === 'number'` check therefore fails for every amount
 * coming from the API. `parseAmount` normalises to a number (or null),
 * and `formatINR` / `formatNumber` use it so the UI never shows "—"
 * just because the value is a string.
 */

export function parseAmount(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    // Strip rupee symbol, commas, whitespace
    const cleaned = trimmed.replace(/[₹,\s]/g, '')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function formatINR(value: unknown, options?: { decimals?: number }): string {
  const n = parseAmount(value)
  if (n == null) return '—'
  const decimals = options?.decimals ?? 2
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

/** INR with explicit ₹ prefix (or em-dash if unset) */
export function formatINRSymbol(value: unknown, options?: { decimals?: number }): string {
  const n = parseAmount(value)
  if (n == null) return '—'
  return `₹${formatINR(n, options)}`
}

/** Shorter "compact" variant for tiles/KPIs: 12.4L, 3.2Cr etc */
export function formatINRCompact(value: unknown): string {
  const n = parseAmount(value)
  if (n == null) return '—'
  const abs = Math.abs(n)
  if (abs >= 10000000)   return `₹${(n / 10000000).toFixed(2)}Cr`
  if (abs >= 100000)     return `₹${(n / 100000).toFixed(2)}L`
  if (abs >= 1000)       return `₹${(n / 1000).toFixed(1)}K`
  return `₹${n.toFixed(0)}`
}

export function formatInt(value: unknown): string {
  const n = parseAmount(value)
  if (n == null) return '—'
  return Math.round(n).toLocaleString('en-IN')
}

export function formatDate(value: unknown): string {
  if (value == null || value === '') return '—'
  const d = new Date(value as string | number | Date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN')
}

export function formatDateTime(value: unknown): string {
  if (value == null || value === '') return '—'
  const d = new Date(value as string | number | Date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN')
}

export function formatQty(value: unknown): string {
  const n = parseAmount(value)
  if (n == null) return '—'
  // Show up to 3 decimals, drop trailing zeros
  return Number(n.toFixed(3)).toLocaleString('en-IN')
}
