import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, getDisplayError } from '../utils/api'
import { useToast } from '../contexts/ToastContext'
import { formatDateTime } from '../utils/format'

/**
 * Admin → Automation observability.
 *
 * Single page that surfaces everything an admin needs to triage the email
 * and OCR pipelines without SSH-ing to the VM:
 *   – top-line KPIs (today, last 7 days, last run status, error counts)
 *   – per-pipeline tab with run history table + last-200 log table
 *   – Drive file inventory tab with the failure / pending queue
 *
 * Data comes from a single call to GET /api/admin/automation.
 */

type Tab = 'email' | 'ocr' | 'drive'

interface EmailSummary {
  runs_today: number
  runs_7d: number
  runs_ok_7d: number
  runs_bad_7d: number
  emails_today: number
  attachments_today: number
  attachments_ok_today: number
  attachments_bad_today: number
  last_started_at: string | null
  last_finished_at: string | null
  last_status: string | null
  last_host: string | null
  last_error: string | null
}
interface OcrSummary {
  runs_today: number
  runs_7d: number
  runs_ok_7d: number
  runs_bad_7d: number
  files_listed_today: number
  files_processed_today: number
  files_ok_today: number
  files_bad_today: number
  invoices_today: number
  last_started_at: string | null
  last_finished_at: string | null
  last_status: string | null
  last_host: string | null
  last_folder: string | null
  last_error: string | null
}
interface DriveSummary {
  total: number
  pending: number
  processed: number
  failed: number
  skipped: number
  total_bytes: number
}
interface RunRow {
  run_id: string
  started_at: string
  finished_at: string | null
  status: string
  host?: string | null
  duration_seconds?: number | null
  error_message?: string | null
  /* email-run */
  emails_fetched?: number
  attachments_processed?: number
  attachments_succeeded?: number
  attachments_failed?: number
  attachments_skipped?: number
  revalidated_invoices?: number
  /* ocr-run */
  drive_folder_id?: string | null
  files_listed?: number
  files_processed?: number
  files_succeeded?: number
  files_failed?: number
  files_skipped?: number
  invoices_created?: number
  invoices_reconciled?: number
}
interface EmailLogRow {
  id: number
  run_id: string
  message_id: string | null
  sender: string | null
  subject: string | null
  received_at: string | null
  attachment_name: string | null
  doc_type: string | null
  status: string
  invoice_id: number | null
  po_id: number | null
  rows_processed: number | null
  rows_inserted: number | null
  rows_updated: number | null
  rows_skipped: number | null
  error_message: string | null
  processed_at: string
}
interface OcrLogRow {
  log_id: number
  run_id: string
  file_id: string
  file_name: string
  status: string
  invoice_id: number | null
  invoice_number: string | null
  reconciliation_status: string | null
  duration_ms: number | null
  error_message: string | null
  logged_at: string
}
interface DriveFailureRow {
  file_id: string
  file_name: string
  mime_type: string
  status: string
  attempts: number
  invoice_id: number | null
  invoice_number: string | null
  error_message: string | null
  first_seen_at: string | null
  processed_at: string | null
  size_bytes: number | null
  modified_time: string | null
}

interface ApiPayload {
  summary: {
    email: EmailSummary | null
    ocr:   OcrSummary | null
    drive: DriveSummary | null
  }
  email_runs: RunRow[]
  email_log:  EmailLogRow[]
  ocr_runs:   RunRow[]
  ocr_log:    OcrLogRow[]
  drive_failures: DriveFailureRow[]
}

function fmtSec(s: number | null | undefined): string {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}
function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024)         return `${n} B`
  if (n < 1024 * 1024)  return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 ** 3)).toFixed(2)} GB`
}

function runStatusVariant(s: string | null | undefined): 'ok' | 'warn' | 'err' | 'mute' {
  if (s === 'success')   return 'ok'
  if (s === 'partial')   return 'warn'
  if (s === 'failed')    return 'err'
  if (s === 'running')   return 'mute'
  return 'mute'
}
function logStatusVariant(s: string): 'ok' | 'warn' | 'err' | 'mute' | 'info' {
  if (s === 'failed') return 'err'
  if (s === 'skipped_duplicate' || s === 'skipped_unclassified' || s === 'skipped') return 'mute'
  if (s === 'validated' || s === 'reconciled' || s === 'saved' || s === 'loaded') return 'ok'
  return 'info'
}

function AutomationAdminPage() {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('email')
  const [data, setData] = useState<ApiPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const res = await apiFetch('admin/automation')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (alive) setData(body)
      } catch (err) {
        if (alive) toast.danger('Failed to load automation data', getDisplayError(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [refreshTick, toast])

  const emailSum = data?.summary.email || null
  const ocrSum   = data?.summary.ocr   || null
  const driveSum = data?.summary.drive || null

  const emailSuccessPct = useMemo(() => {
    if (!emailSum || emailSum.runs_7d === 0) return null
    return Math.round((emailSum.runs_ok_7d / emailSum.runs_7d) * 100)
  }, [emailSum])
  const ocrSuccessPct = useMemo(() => {
    if (!ocrSum || ocrSum.runs_7d === 0) return null
    return Math.round((ocrSum.runs_ok_7d / ocrSum.runs_7d) * 100)
  }, [ocrSum])

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow"><i className="pi pi-server" /> Admin · System</span>
          <h1>Automation health</h1>
          <p>Live observability for the email-ingest and OCR pipelines, plus the Drive file inventory. Everything below is read from the database — no SSH, no log tail.</p>
        </div>
        <div className="hero__act">
          <button
            className="btn btn--g"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={loading}
          >
            <i className={`pi ${loading ? 'pi-spin pi-spinner' : 'pi-refresh'}`} /> Refresh
          </button>
        </div>
      </section>

      {/* 4-up KPI strip — top-line for both pipelines */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--brand">
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-envelope" /></div>
            <span className={`kpi__d kpi__d--${runStatusVariant(emailSum?.last_status) === 'ok' ? 'up' : runStatusVariant(emailSum?.last_status) === 'err' ? 'dn' : 'fl'}`}>
              {emailSum?.last_status || 'no runs'}
            </span>
          </div>
          <p className="kpi__l">Email runs today</p>
          <div className="kpi__v">{loading ? '—' : (emailSum?.runs_today ?? 0)}</div>
          <div className="kpi__f">
            {emailSuccessPct != null ? `${emailSuccessPct}% success (7d)` : 'no runs in 7d'}
          </div>
        </div>

        <div className="kpi kpi--em">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-check" /></div></div>
          <p className="kpi__l">Attachments OK today</p>
          <div className="kpi__v">{loading ? '—' : (emailSum?.attachments_ok_today ?? 0)}</div>
          <div className="kpi__f">{emailSum?.attachments_today ?? 0} processed</div>
        </div>

        <div className="kpi kpi--vio">
          <div className="kpi__row">
            <div className="kpi__ic"><i className="pi pi-image" /></div>
            <span className={`kpi__d kpi__d--${runStatusVariant(ocrSum?.last_status) === 'ok' ? 'up' : runStatusVariant(ocrSum?.last_status) === 'err' ? 'dn' : 'fl'}`}>
              {ocrSum?.last_status || 'no runs'}
            </span>
          </div>
          <p className="kpi__l">OCR files today</p>
          <div className="kpi__v">{loading ? '—' : (ocrSum?.files_processed_today ?? 0)}</div>
          <div className="kpi__f">
            {ocrSuccessPct != null ? `${ocrSuccessPct}% success (7d)` : 'no runs in 7d'}
          </div>
        </div>

        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-exclamation-triangle" /></div></div>
          <p className="kpi__l">Failed / pending Drive files</p>
          <div className="kpi__v">{loading ? '—' : ((driveSum?.failed ?? 0) + (driveSum?.pending ?? 0))}</div>
          <div className="kpi__f">{driveSum?.total ?? 0} total · {fmtBytes(driveSum?.total_bytes)}</div>
        </div>
      </div>

      {/* Last-run banner for whichever pipeline tab is active */}
      {tab === 'email' && emailSum && (emailSum.last_started_at || emailSum.last_error) && (
        <LastRunBanner
          label="Email pipeline · last run"
          startedAt={emailSum.last_started_at}
          finishedAt={emailSum.last_finished_at}
          status={emailSum.last_status}
          host={emailSum.last_host}
          extra={`${emailSum.attachments_ok_today} ok · ${emailSum.attachments_bad_today} failed today`}
          error={emailSum.last_error}
        />
      )}
      {tab === 'ocr' && ocrSum && (ocrSum.last_started_at || ocrSum.last_error) && (
        <LastRunBanner
          label="OCR pipeline · last run"
          startedAt={ocrSum.last_started_at}
          finishedAt={ocrSum.last_finished_at}
          status={ocrSum.last_status}
          host={ocrSum.last_host}
          extra={`${ocrSum.files_ok_today} ok · ${ocrSum.files_bad_today} failed today · Drive folder ${ocrSum.last_folder || '—'}`}
          error={ocrSum.last_error}
        />
      )}

      {/* Tabs */}
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={`tab ${tab === 'email' ? 'active' : ''}`}
          onClick={() => setTab('email')}
        >
          <i className="pi pi-envelope" /> Email automation
          <span className="muted" style={{ marginLeft: 6 }}>({data?.email_runs.length ?? 0} runs)</span>
        </button>
        <button
          type="button"
          className={`tab ${tab === 'ocr' ? 'active' : ''}`}
          onClick={() => setTab('ocr')}
        >
          <i className="pi pi-image" /> OCR automation
          <span className="muted" style={{ marginLeft: 6 }}>({data?.ocr_runs.length ?? 0} runs)</span>
        </button>
        <button
          type="button"
          className={`tab ${tab === 'drive' ? 'active' : ''}`}
          onClick={() => setTab('drive')}
        >
          <i className="pi pi-folder" /> Drive files
          <span className="muted" style={{ marginLeft: 6 }}>({driveSum?.total ?? 0})</span>
        </button>
      </div>

      {tab === 'email' && (
        <>
          <EmailRunsTable rows={data?.email_runs || []} loading={loading} />
          <div style={{ height: 14 }} />
          <EmailLogTable rows={data?.email_log || []} loading={loading} />
        </>
      )}
      {tab === 'ocr' && (
        <>
          <OcrRunsTable rows={data?.ocr_runs || []} loading={loading} />
          <div style={{ height: 14 }} />
          <OcrLogTable rows={data?.ocr_log || []} loading={loading} />
        </>
      )}
      {tab === 'drive' && (
        <DriveTab summary={driveSum} failures={data?.drive_failures || []} loading={loading} />
      )}
    </>
  )
}

/* ====================== shared sub-components ====================== */

function LastRunBanner({
  label, startedAt, finishedAt, status, host, extra, error
}: {
  label: string
  startedAt: string | null
  finishedAt: string | null
  status: string | null
  host: string | null
  extra?: string
  error: string | null
}) {
  const tone = runStatusVariant(status)
  const bg =
    tone === 'ok'   ? 'linear-gradient(90deg, rgba(16,185,129,0.08), transparent)' :
    tone === 'err'  ? 'linear-gradient(90deg, rgba(239,68,68,0.08), transparent)'  :
    tone === 'warn' ? 'linear-gradient(90deg, rgba(245,158,11,0.08), transparent)' :
                      'linear-gradient(90deg, rgba(100,116,139,0.08), transparent)'
  return (
    <div className="card" style={{ padding: 0, marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, background: bg, flexWrap: 'wrap' }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: `var(--${tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : 'mute'}-bg)`,
          color:      `var(--${tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : 'mute'}-fg)`,
          display: 'grid', placeItems: 'center', flexShrink: 0
        }}>
          <i className={`pi ${tone === 'ok' ? 'pi-check-circle' : tone === 'err' ? 'pi-times-circle' : 'pi-clock'}`} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="bold" style={{ fontSize: 13 }}>{label}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            Started {formatDateTime(startedAt)}{finishedAt && ` · finished ${formatDateTime(finishedAt)}`}
            {host && ` · ${host}`}
          </div>
          {extra && (
            <div className="muted" style={{ fontSize: 12 }}>{extra}</div>
          )}
        </div>
        <span className={`chip chip--${tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : 'mute'}`}>
          {status || 'unknown'}
        </span>
      </div>
      {error && (
        <div style={{
          padding: '10px 16px',
          background: 'var(--err-bg)',
          color: 'var(--err-fg)',
          fontSize: 12.5,
          borderTop: '1px solid var(--b-1)',
          fontFamily: 'var(--mono)'
        }}>
          <b>Error:</b> {error}
        </div>
      )}
    </div>
  )
}

function EmailRunsTable({ rows, loading }: { rows: RunRow[]; loading: boolean }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card__h">
        <div className="card__t"><i className="pi pi-history" /> Recent email runs</div>
        <span className="card__m">{rows.length} most recent</span>
      </div>
      <table className="tbl tbl--compact">
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Host</th>
            <th className="num">Emails</th>
            <th className="num">Att. ok / fail / skip</th>
            <th className="num">Revalidated</th>
            <th>Duration</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
              <i className="pi pi-spin pi-spinner" /> Loading…
            </td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
              <i className="pi pi-inbox" style={{ marginRight: 6 }} />
              No email runs recorded yet.
            </td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.run_id} style={{ cursor: 'default' }}>
              <td className="muted">{formatDateTime(r.started_at)}</td>
              <td><span className={`chip chip--${runStatusVariant(r.status)}`}>{r.status}</span></td>
              <td className="muted mono">{r.host || '—'}</td>
              <td className="num">{r.emails_fetched ?? 0}</td>
              <td className="num tabular">
                <span style={{ color: 'var(--ok-fg)' }}>{r.attachments_succeeded ?? 0}</span>
                {' / '}
                <span style={{ color: 'var(--err-fg)' }}>{r.attachments_failed ?? 0}</span>
                {' / '}
                <span className="muted">{r.attachments_skipped ?? 0}</span>
              </td>
              <td className="num">{r.revalidated_invoices ?? 0}</td>
              <td>{fmtSec(r.duration_seconds)}</td>
              <td className="muted" style={{ maxWidth: 280, fontSize: 11.5 }}>{r.error_message || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EmailLogTable({ rows, loading }: { rows: EmailLogRow[]; loading: boolean }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<'all' | 'failed' | 'loaded' | 'validated' | 'skipped'>('all')
  const [docType, setDocType] = useState<string>('all')

  const filtered = rows.filter((r) => {
    if (filter === 'failed'   && r.status !== 'failed') return false
    if (filter === 'loaded'   && r.status !== 'loaded') return false
    if (filter === 'validated'&& r.status !== 'validated') return false
    if (filter === 'skipped'  && !r.status.startsWith('skipped')) return false
    if (docType !== 'all' && (r.doc_type || 'unknown') !== docType) return false
    return true
  })

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card__h">
        <div className="card__t"><i className="pi pi-list" /> Email log (last 200 attachments)</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={selectStyle}>
            <option value="all">All statuses</option>
            <option value="failed">Failed</option>
            <option value="loaded">Loaded</option>
            <option value="validated">Validated</option>
            <option value="skipped">Skipped</option>
          </select>
          <select value={docType} onChange={(e) => setDocType(e.target.value)} style={selectStyle}>
            <option value="all">All doc types</option>
            <option value="po">PO</option>
            <option value="grn">GRN</option>
            <option value="asn">ASN</option>
            <option value="dc">DC</option>
            <option value="schedule">Schedule</option>
            <option value="invoice">Invoice</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
      </div>
      <div style={{ maxHeight: 540, overflowY: 'auto' }}>
        <table className="tbl tbl--compact">
          <thead>
            <tr>
              <th>Processed</th>
              <th>Type</th>
              <th>Status</th>
              <th>Sender · subject</th>
              <th>Attachment</th>
              <th className="num">Rows P/I/U/S</th>
              <th>Linked</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
                <i className="pi pi-spin pi-spinner" /> Loading…
              </td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
                No entries match this filter.
              </td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td className="muted">{formatDateTime(r.processed_at)}</td>
                <td><span className="chip chip--mute">{r.doc_type || 'unknown'}</span></td>
                <td><span className={`chip chip--${logStatusVariant(r.status)}`}>{r.status.replace(/_/g, ' ')}</span></td>
                <td style={{ maxWidth: 260, fontSize: 11.5 }}>
                  <div className="bold">{r.sender || '—'}</div>
                  <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subject || '—'}</div>
                </td>
                <td className="mono" style={{ fontSize: 11.5, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.attachment_name || '—'}
                </td>
                <td className="num tabular" style={{ fontSize: 11.5 }}>
                  {r.rows_processed ?? 0}/{r.rows_inserted ?? 0}/{r.rows_updated ?? 0}/{r.rows_skipped ?? 0}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {r.invoice_id ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/invoices/validate/${r.invoice_id}`)}
                      style={{
                        background: 'transparent', border: 0, padding: 0,
                        color: 'var(--brand-600)', cursor: 'pointer', fontWeight: 700,
                        textDecoration: 'underline dotted'
                      }}
                      title={`Open invoice #${r.invoice_id}`}
                    >
                      {`Inv #${r.invoice_id}`}
                    </button>
                  ) : r.po_id ? (
                    `PO #${r.po_id}`
                  ) : '—'}
                </td>
                <td className="muted" style={{ maxWidth: 200, fontSize: 11.5 }}>{r.error_message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function OcrRunsTable({ rows, loading }: { rows: RunRow[]; loading: boolean }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card__h">
        <div className="card__t"><i className="pi pi-history" /> Recent OCR runs</div>
        <span className="card__m">{rows.length} most recent</span>
      </div>
      <table className="tbl tbl--compact">
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Host · folder</th>
            <th className="num">Listed / Processed</th>
            <th className="num">OK / Fail / Skip</th>
            <th className="num">Invoices</th>
            <th>Duration</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
              <i className="pi pi-spin pi-spinner" /> Loading…
            </td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
              <i className="pi pi-inbox" style={{ marginRight: 6 }} />
              No OCR runs recorded yet.
            </td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.run_id} style={{ cursor: 'default' }}>
              <td className="muted">{formatDateTime(r.started_at)}</td>
              <td><span className={`chip chip--${runStatusVariant(r.status)}`}>{r.status}</span></td>
              <td className="muted" style={{ fontSize: 11.5 }}>
                <div>{r.host || '—'}</div>
                <div className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{r.drive_folder_id || '—'}</div>
              </td>
              <td className="num tabular">{r.files_listed ?? 0} / {r.files_processed ?? 0}</td>
              <td className="num tabular">
                <span style={{ color: 'var(--ok-fg)' }}>{r.files_succeeded ?? 0}</span>
                {' / '}
                <span style={{ color: 'var(--err-fg)' }}>{r.files_failed ?? 0}</span>
                {' / '}
                <span className="muted">{r.files_skipped ?? 0}</span>
              </td>
              <td className="num">{r.invoices_created ?? 0}</td>
              <td>{fmtSec(r.duration_seconds)}</td>
              <td className="muted" style={{ maxWidth: 240, fontSize: 11.5 }}>{r.error_message || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function OcrLogTable({ rows, loading }: { rows: OcrLogRow[]; loading: boolean }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<'all' | 'failed' | 'saved' | 'reconciled' | 'skipped'>('all')
  const filtered = rows.filter((r) => {
    if (filter === 'failed'     && r.status !== 'failed') return false
    if (filter === 'saved'      && r.status !== 'saved') return false
    if (filter === 'reconciled' && r.status !== 'reconciled') return false
    if (filter === 'skipped'    && r.status !== 'skipped_duplicate') return false
    return true
  })
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card__h">
        <div className="card__t"><i className="pi pi-list" /> OCR log (last 200 files)</div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} style={selectStyle}>
          <option value="all">All statuses</option>
          <option value="failed">Failed</option>
          <option value="saved">Saved</option>
          <option value="reconciled">Reconciled</option>
          <option value="skipped">Skipped duplicate</option>
        </select>
      </div>
      <div style={{ maxHeight: 540, overflowY: 'auto' }}>
        <table className="tbl tbl--compact">
          <thead>
            <tr>
              <th>Logged</th>
              <th>Status</th>
              <th>File</th>
              <th>Invoice</th>
              <th>Reconciliation</th>
              <th>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && filtered.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
                <i className="pi pi-spin pi-spinner" /> Loading…
              </td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
                No entries match this filter.
              </td></tr>
            )}
            {filtered.map((r) => (
              <tr key={r.log_id} style={{ cursor: 'default' }}>
                <td className="muted">{formatDateTime(r.logged_at)}</td>
                <td><span className={`chip chip--${logStatusVariant(r.status)}`}>{r.status.replace(/_/g, ' ')}</span></td>
                <td className="mono" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.file_name}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {r.invoice_id ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/invoices/validate/${r.invoice_id}`)}
                      style={{
                        background: 'transparent',
                        border: 0,
                        padding: 0,
                        color: 'var(--brand-600)',
                        cursor: 'pointer',
                        fontWeight: 700,
                        textDecoration: 'underline dotted'
                      }}
                      title={`Open invoice ${r.invoice_number || '#' + r.invoice_id} in the validation panel`}
                    >
                      {r.invoice_number || `#${r.invoice_id}`}
                    </button>
                  ) : '—'}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>{r.reconciliation_status || '—'}</td>
                <td>{fmtMs(r.duration_ms)}</td>
                <td className="muted" style={{ maxWidth: 240, fontSize: 11.5 }}>{r.error_message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DriveTab({
  summary,
  failures,
  loading
}: {
  summary: DriveSummary | null
  failures: DriveFailureRow[]
  loading: boolean
}) {
  const navigate = useNavigate()
  return (
    <>
      {/* 5-tile mini-strip showing Drive status mix */}
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 14 }}>
        <div className="kpi kpi--brand">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-folder" /></div></div>
          <p className="kpi__l">Total files</p>
          <div className="kpi__v">{summary?.total ?? 0}</div>
          <div className="kpi__f">{fmtBytes(summary?.total_bytes)}</div>
        </div>
        <div className="kpi kpi--em">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-check" /></div></div>
          <p className="kpi__l">Processed</p>
          <div className="kpi__v">{summary?.processed ?? 0}</div>
        </div>
        <div className="kpi kpi--am">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-clock" /></div></div>
          <p className="kpi__l">Pending</p>
          <div className="kpi__v">{summary?.pending ?? 0}</div>
        </div>
        <div className="kpi kpi--rs">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-times-circle" /></div></div>
          <p className="kpi__l">Failed</p>
          <div className="kpi__v">{summary?.failed ?? 0}</div>
        </div>
        <div className="kpi kpi--sl">
          <div className="kpi__row"><div className="kpi__ic"><i className="pi pi-eye-slash" /></div></div>
          <p className="kpi__l">Skipped</p>
          <div className="kpi__v">{summary?.skipped ?? 0}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="card__h">
          <div className="card__t"><i className="pi pi-exclamation-triangle" /> Failed &amp; pending files</div>
          <span className="card__m">{failures.length} top-50</span>
        </div>
        <table className="tbl tbl--compact">
          <thead>
            <tr>
              <th>First seen</th>
              <th>Status</th>
              <th>File</th>
              <th>Mime</th>
              <th className="num">Size</th>
              <th className="num">Attempts</th>
              <th>Linked</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && failures.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
                <i className="pi pi-spin pi-spinner" /> Loading…
              </td></tr>
            )}
            {!loading && failures.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--t-3)' }}>
                <i className="pi pi-check-circle" style={{ marginRight: 6, color: 'var(--ok-fg)' }} />
                No failed or pending Drive files. Pipeline is clean.
              </td></tr>
            )}
            {failures.map((r) => (
              <tr key={r.file_id} style={{ cursor: 'default' }}>
                <td className="muted">{formatDateTime(r.first_seen_at)}</td>
                <td><span className={`chip chip--${r.status === 'failed' ? 'err' : 'warn'}`}>{r.status}</span></td>
                <td className="mono" style={{ fontSize: 11.5, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.file_name}
                </td>
                <td className="muted" style={{ fontSize: 11.5 }}>{r.mime_type || '—'}</td>
                <td className="num">{fmtBytes(r.size_bytes)}</td>
                <td className="num">{r.attempts}</td>
                <td className="muted" style={{ fontSize: 11.5 }}>
                  {r.invoice_id ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/invoices/validate/${r.invoice_id}`)}
                      style={{
                        background: 'transparent', border: 0, padding: 0,
                        color: 'var(--brand-600)', cursor: 'pointer', fontWeight: 700,
                        textDecoration: 'underline dotted'
                      }}
                      title={`Open invoice ${r.invoice_number || '#' + r.invoice_id}`}
                    >
                      {r.invoice_number || `#${r.invoice_id}`}
                    </button>
                  ) : '—'}
                </td>
                <td className="muted" style={{ maxWidth: 240, fontSize: 11.5 }}>{r.error_message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const selectStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--b-2)',
  borderRadius: 8,
  background: 'var(--s-0)',
  color: 'var(--t-1)',
  fontSize: 12.5,
  cursor: 'pointer',
  fontFamily: 'inherit'
}

export default AutomationAdminPage
