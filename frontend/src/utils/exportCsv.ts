/**
 * Build and download a CSV file from an array of objects.
 * Keys of the first object (or columns) define headers; values are escaped for CSV.
 */
export function downloadCsv(
  rows: Record<string, unknown>[],
  filename: string,
  columns?: { key: string; header: string }[]
) {
  if (rows.length === 0 && !columns?.length) return
  const headers = columns
    ? columns.map((c) => c.header)
    : Object.keys(rows[0] as Record<string, unknown>)
  const keys = columns ? columns.map((c) => c.key) : headers
  const escape = (v: unknown): string => {
    if (v == null) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const headerRow = headers.map(escape).join(',')
  const dataRows = rows.map((row) =>
    keys.map((k) => escape((row as Record<string, unknown>)[k])).join(',')
  )
  const csv = [headerRow, ...dataRows].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  link.click()
  URL.revokeObjectURL(link.href)
}
