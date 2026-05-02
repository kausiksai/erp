import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import StatusChip from './StatusChip'
import InvoiceExpansion from './InvoiceExpansion'
import { apiFetch, getDisplayError, getErrorMessageFromResponse } from '../utils/api'
import { formatDate, formatDateTime, formatINRSymbol, formatQty, parseAmount } from '../utils/format'

/* =========================================================================
 *   Types
 * ========================================================================= */

interface PoHeader {
  po_id: number
  po_number: string | null
  po_date: string | null
  supplier_name: string | null
  status: string | null
  amd_no?: number | string | null
  pfx?: string | null
  unit?: string | null
  ref_unit?: string | null
  suplr_id?: string | null
  terms?: string | null
  line_item_count?: number | string | null
  created_at?: string | null
  updated_at?: string | null
}

interface PoLine {
  po_line_id: number
  sequence_number: number | string | null
  item_id: string | null
  description1: string | null
  qty: number | string | null
  unit_cost: number | string | null
  disc_pct: number | string | null
  raw_material: string | null
  process_description: string | null
  norms: string | null
  process_cost: number | string | null
}

interface InvoiceRow {
  invoice_id: number
  invoice_number: string | null
  invoice_date: string | null
  supplier_name?: string | null
  total_amount: number | string | null
  status: string | null
  reconciliation_status?: string | null
}

interface GrnRow {
  id: number
  grn_no: string | null
  grn_date: string | null
  supplier_doc_no: string | null
  supplier_doc_date: string | null
  item: string | null
  description_1?: string | null
  accepted_qty: number | string | null
  unit_cost: number | string | null
  uom?: string | null
}

interface AsnRow {
  asn_id?: number
  asn_no: string | null
  asn_date: string | null
  supplier_name?: string | null
  item?: string | null
  description?: string | null
  qty: number | string | null
  uom?: string | null
}

interface DcRow {
  id?: number
  dc_no: string | null
  dc_date: string | null
  supplier_name?: string | null
  item?: string | null
  qty: number | string | null
  uom?: string | null
}

interface ScheduleRow {
  id?: number
  doc_no?: string | null
  doc_pfx?: string | null
  sched_date?: string | null
  promise_date?: string | null
  required_date?: string | null
  sched_qty?: number | string | null
  uom?: string | null
  item_id?: string | null
  description?: string | null
  status?: string | null
}

type TabKey = 'lines' | 'invoices' | 'grn' | 'asn' | 'dc' | 'schedule'

type DrillTarget =
  | { type: 'invoice'; id: number; title: string }
  | { type: 'grn'; row: GrnRow }
  | { type: 'asn'; row: AsnRow }
  | { type: 'dc'; row: DcRow }
  | { type: 'schedule'; row: ScheduleRow }

/* Module-level cache (per po_id) so re-expanding the same PO is instant. */
const linesCache = new Map<number, PoLine[]>()
const invoicesCache = new Map<number, InvoiceRow[]>()
const grnCache = new Map<number, GrnRow[]>()
const asnCache = new Map<number, AsnRow[]>()
const dcCache = new Map<number, DcRow[]>()
const scheduleCache = new Map<number, ScheduleRow[]>()

/* =========================================================================
 *   Component
 * ========================================================================= */

export default function PoExpansion({ po }: { po: PoHeader }) {
  const [activeTab, setActiveTab] = useState<TabKey>('lines')
  const [drillTarget, setDrillTarget] = useState<DrillTarget | null>(null)

  /* ---------- per-tab data + loading state ---------- */
  const [lines, setLines] = useState<PoLine[]>(() => linesCache.get(po.po_id) ?? [])
  const [invoices, setInvoices] = useState<InvoiceRow[]>(() => invoicesCache.get(po.po_id) ?? [])
  const [grns, setGrns] = useState<GrnRow[]>(() => grnCache.get(po.po_id) ?? [])
  const [asns, setAsns] = useState<AsnRow[]>(() => asnCache.get(po.po_id) ?? [])
  const [dcs, setDcs] = useState<DcRow[]>(() => dcCache.get(po.po_id) ?? [])
  const [schedules, setSchedules] = useState<ScheduleRow[]>(() => scheduleCache.get(po.po_id) ?? [])

  const [loading, setLoading] = useState({
    lines: !linesCache.has(po.po_id),
    invoices: !invoicesCache.has(po.po_id),
    grn: !grnCache.has(po.po_id),
    asn: !asnCache.has(po.po_id),
    dc: !dcCache.has(po.po_id),
    schedule: !scheduleCache.has(po.po_id),
  })
  const [error, setError] = useState<{ [k in TabKey]?: string }>({})

  /* ---------- fetch lines (PO-id keyed) ---------- */
  useEffect(() => {
    let alive = true
    if (linesCache.has(po.po_id)) return
    ;(async () => {
      try {
        const res = await apiFetch(`purchase-orders/${po.po_id}/line-items`)
        if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, 'Failed to load PO lines'))
        const body = await res.json()
        const rows: PoLine[] = Array.isArray(body) ? body : body.items || []
        linesCache.set(po.po_id, rows)
        if (alive) setLines(rows)
      } catch (err) {
        if (alive) setError((e) => ({ ...e, lines: getDisplayError(err) }))
      } finally {
        if (alive) setLoading((l) => ({ ...l, lines: false }))
      }
    })()
    return () => { alive = false }
  }, [po.po_id])

  /* ---------- fetch all linked-doc tabs in parallel (po_number keyed) ---------- */
  useEffect(() => {
    let alive = true
    const poNum = po.po_number
    if (!poNum) {
      // Without a PO number we can't fetch linked docs.
      setLoading((l) => ({ ...l, invoices: false, grn: false, asn: false, dc: false, schedule: false }))
      return
    }
    const q = encodeURIComponent(poNum)

    type TabFetch<T> = {
      key: TabKey
      url: string
      cache: Map<number, T[]>
      setter: (rows: T[]) => void
    }
    const jobs: Array<TabFetch<unknown>> = [
      { key: 'invoices', url: `invoices?poNumber=${q}&limit=500`, cache: invoicesCache as Map<number, unknown[]>, setter: (r) => setInvoices(r as InvoiceRow[]) },
      { key: 'grn',      url: `grn?poNumber=${q}&limit=1000`,     cache: grnCache as Map<number, unknown[]>,      setter: (r) => setGrns(r as GrnRow[]) },
      { key: 'asn',      url: `asn?poNumber=${q}&limit=1000`,     cache: asnCache as Map<number, unknown[]>,      setter: (r) => setAsns(r as AsnRow[]) },
      { key: 'dc',       url: `delivery-challans?poNumber=${q}&limit=1000`, cache: dcCache as Map<number, unknown[]>, setter: (r) => setDcs(r as DcRow[]) },
      { key: 'schedule', url: `po-schedules?poNumber=${q}&limit=1000`,      cache: scheduleCache as Map<number, unknown[]>, setter: (r) => setSchedules(r as ScheduleRow[]) },
    ] as Array<TabFetch<unknown>>

    jobs.forEach((job) => {
      if (job.cache.has(po.po_id)) return
      ;(async () => {
        try {
          const res = await apiFetch(job.url)
          if (!res.ok) throw new Error(await getErrorMessageFromResponse(res, `Failed to load ${job.key}`))
          const body = await res.json()
          const rows: unknown[] = Array.isArray(body) ? body : body.items || body.invoices || body.rows || []
          job.cache.set(po.po_id, rows)
          if (alive) job.setter(rows)
        } catch (err) {
          if (alive) setError((e) => ({ ...e, [job.key]: getDisplayError(err) }))
        } finally {
          if (alive) setLoading((l) => ({ ...l, [job.key]: false }))
        }
      })()
    })

    return () => { alive = false }
  }, [po.po_id, po.po_number])

  /* ---------- derived ---------- */
  const poValue = useMemo(
    () => lines.reduce((sum, ln) => sum + (parseAmount(ln.qty) ?? 0) * (parseAmount(ln.unit_cost) ?? 0), 0),
    [lines]
  )

  const counts: Record<TabKey, number> = {
    lines: lines.length,
    invoices: invoices.length,
    grn: grns.length,
    asn: asns.length,
    dc: dcs.length,
    schedule: schedules.length,
  }

  return (
    <div
      style={{
        padding: '1rem 1.25rem 1.5rem',
        background: 'var(--surface-1)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.9rem'
      }}
    >
      {/* Header hero */}
      <div
        style={{
          position: 'relative',
          padding: '1rem 1.2rem',
          borderRadius: 'var(--radius-lg)',
          background: 'linear-gradient(135deg, rgba(139,92,246,0.10), rgba(6,182,212,0.08))',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap'
        }}
      >
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 11,
            background: 'linear-gradient(135deg, var(--accent-violet), var(--brand-600))',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            flexShrink: 0
          }}
        >
          <i className="pi pi-shopping-cart" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
              Purchase order
            </span>
            <StatusChip status={po.status} />
            {Number(po.amd_no || 0) > 0 && (
              <span
                style={{
                  padding: '0.1rem 0.5rem',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  borderRadius: 9999,
                  background: 'var(--status-info-bg)',
                  color: 'var(--status-info-fg)'
                }}
              >
                AMD {po.amd_no}
              </span>
            )}
          </div>
          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginTop: '0.15rem' }}>
            {po.po_number || '—'}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {po.supplier_name || '—'}
            {po.po_date && <> · {formatDate(po.po_date)}</>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
            PO base value
          </div>
          <div style={{ fontSize: '1.45rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1 }}>
            {formatINRSymbol(poValue)}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {lines.length} line{lines.length === 1 ? '' : 's'} (qty × unit cost)
          </div>
        </div>
      </div>

      {/* PO facts */}
      <Panel icon="pi-id-card" color="var(--brand-600)" title="PO facts">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '0.85rem'
          }}
        >
          <Field label="PO number"       value={po.po_number} />
          <Field label="PO date"         value={formatDate(po.po_date)} />
          <Field label="Prefix"          value={po.pfx} />
          <Field label="Unit"            value={po.unit} />
          <Field label="Ref unit"        value={po.ref_unit} />
          <Field label="Amendment"       value={po.amd_no != null ? `AMD ${po.amd_no}` : null} />
          <Field label="Supplier"        value={po.supplier_name} />
          <Field label="Supplier code"   value={po.suplr_id} />
          <Field label="Status"          value={po.status} />
          <Field label="Payment terms"   value={po.terms} />
          <Field label="Line items"      value={po.line_item_count != null ? String(po.line_item_count) : String(lines.length)} />
          {po.created_at && <Field label="Created" value={formatDateTime(po.created_at)} />}
          {po.updated_at && <Field label="Updated" value={formatDateTime(po.updated_at)} />}
        </div>
      </Panel>

      {/* Tab strip */}
      <TabBar
        active={activeTab}
        onChange={setActiveTab}
        loading={loading}
        counts={counts}
      />

      {/* Active tab content */}
      {activeTab === 'lines' && (
        <Panel icon="pi-list" color="var(--accent-violet)" title={`PO line items${lines.length ? ` (${lines.length})` : ''}`}>
          <LinesContent
            lines={lines}
            poValue={poValue}
            loading={loading.lines}
            error={error.lines}
          />
        </Panel>
      )}

      {activeTab === 'invoices' && (
        <Panel icon="pi-file" color="var(--brand-600)" title={`Invoices (${invoices.length})`}>
          <InvoicesContent
            rows={invoices}
            loading={loading.invoices}
            error={error.invoices}
            onOpen={(inv) =>
              setDrillTarget({
                type: 'invoice',
                id: inv.invoice_id,
                title: inv.invoice_number || `Invoice ${inv.invoice_id}`,
              })
            }
          />
        </Panel>
      )}

      {activeTab === 'grn' && (
        <Panel icon="pi-box" color="var(--accent-emerald)" title={`Goods receipt notes (${grns.length})`}>
          <GrnContent
            rows={grns}
            loading={loading.grn}
            error={error.grn}
            onOpen={(row) => setDrillTarget({ type: 'grn', row })}
          />
        </Panel>
      )}

      {activeTab === 'asn' && (
        <Panel icon="pi-truck" color="var(--accent-blue)" title={`Advance shipment notices (${asns.length})`}>
          <AsnContent
            rows={asns}
            loading={loading.asn}
            error={error.asn}
            onOpen={(row) => setDrillTarget({ type: 'asn', row })}
          />
        </Panel>
      )}

      {activeTab === 'dc' && (
        <Panel icon="pi-send" color="var(--accent-amber)" title={`Delivery challans (${dcs.length})`}>
          <DcContent
            rows={dcs}
            loading={loading.dc}
            error={error.dc}
            onOpen={(row) => setDrillTarget({ type: 'dc', row })}
          />
        </Panel>
      )}

      {activeTab === 'schedule' && (
        <Panel icon="pi-calendar" color="var(--accent-rose)" title={`Schedules (${schedules.length})`}>
          <ScheduleContent
            rows={schedules}
            loading={loading.schedule}
            error={error.schedule}
            onOpen={(row) => setDrillTarget({ type: 'schedule', row })}
          />
        </Panel>
      )}

      {/* Drill-through side panel */}
      {drillTarget && (
        <DrillSidePanel target={drillTarget} onClose={() => setDrillTarget(null)} />
      )}
    </div>
  )
}

/* =========================================================================
 *   Tab strip
 * ========================================================================= */

function TabBar({
  active,
  onChange,
  counts,
  loading,
}: {
  active: TabKey
  onChange: (k: TabKey) => void
  counts: Record<TabKey, number>
  loading: Record<TabKey, boolean>
}) {
  const tabs: Array<{ key: TabKey; label: string; icon: string }> = [
    { key: 'lines',    label: 'Lines',     icon: 'pi-list' },
    { key: 'invoices', label: 'Invoices',  icon: 'pi-file' },
    { key: 'grn',      label: 'GRN',       icon: 'pi-box' },
    { key: 'asn',      label: 'ASN',       icon: 'pi-truck' },
    { key: 'dc',       label: 'DC',        icon: 'pi-send' },
    { key: 'schedule', label: 'Schedule',  icon: 'pi-calendar' },
  ]
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.4rem',
        padding: '0.45rem',
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.key
        const isLoading = loading[t.key]
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.5rem 0.85rem',
              fontSize: '0.85rem',
              fontWeight: 700,
              border: 'none',
              cursor: 'pointer',
              borderRadius: 'var(--radius-md)',
              background: isActive ? 'var(--brand-600)' : 'transparent',
              color: isActive ? '#fff' : 'var(--text-secondary)',
              transition: 'background 0.15s ease',
            }}
          >
            <i className={`pi ${t.icon}`} />
            <span>{t.label}</span>
            {isLoading ? (
              <span
                style={{
                  fontSize: '0.7rem',
                  opacity: 0.75,
                  marginLeft: '0.15rem',
                }}
              >
                …
              </span>
            ) : (
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 800,
                  padding: '0.1rem 0.45rem',
                  borderRadius: 9999,
                  background: isActive ? 'rgba(255,255,255,0.22)' : 'var(--surface-2)',
                  color: isActive ? '#fff' : 'var(--text-muted)',
                  marginLeft: '0.15rem',
                }}
              >
                {counts[t.key]}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* =========================================================================
 *   Tab content panels
 * ========================================================================= */

function LinesContent({
  lines,
  poValue,
  loading,
  error,
}: {
  lines: PoLine[]
  poValue: number
  loading: boolean
  error?: string
}) {
  if (loading) return <Spinner label="Loading lines…" />
  if (error) return <ErrorRow message={error} />
  if (lines.length === 0) return <EmptyRow>No line items captured for this PO.</EmptyRow>
  return (
    <ScrollTable
      headers={['#', 'Item ID', 'Description', 'Qty', 'Unit cost', 'Disc %', 'Raw material', 'Process', 'Process cost', 'Line value']}
      alignRight={[3, 4, 5, 8, 9]}
      rows={lines.map((ln, i) => {
        const q = parseAmount(ln.qty) ?? 0
        const c = parseAmount(ln.unit_cost) ?? 0
        return [
          String(ln.sequence_number ?? i + 1),
          ln.item_id || '—',
          ln.description1 || '—',
          formatQty(ln.qty),
          formatINRSymbol(ln.unit_cost),
          ln.disc_pct != null ? `${ln.disc_pct}` : '—',
          ln.raw_material || '—',
          ln.process_description || '—',
          formatINRSymbol(ln.process_cost),
          formatINRSymbol(q * c),
        ]
      })}
      footer={['', '', '', '', '', '', '', '', 'Total', formatINRSymbol(poValue)]}
    />
  )
}

function InvoicesContent({
  rows,
  loading,
  error,
  onOpen,
}: {
  rows: InvoiceRow[]
  loading: boolean
  error?: string
  onOpen: (r: InvoiceRow) => void
}) {
  if (loading) return <Spinner label="Loading invoices…" />
  if (error) return <ErrorRow message={error} />
  if (rows.length === 0) return <EmptyRow>No invoice has been raised against this PO yet.</EmptyRow>
  return (
    <ClickableTable
      headers={['Invoice #', 'Date', 'Total', 'Status', 'Reconciliation']}
      alignRight={[2]}
      rows={rows.map((r) => ({
        cells: [
          r.invoice_number || '—',
          formatDate(r.invoice_date),
          formatINRSymbol(r.total_amount),
          r.status || '—',
          r.reconciliation_status || '—',
        ],
        onClick: () => onOpen(r),
      }))}
    />
  )
}

function GrnContent({
  rows,
  loading,
  error,
  onOpen,
}: {
  rows: GrnRow[]
  loading: boolean
  error?: string
  onOpen: (r: GrnRow) => void
}) {
  if (loading) return <Spinner label="Loading GRNs…" />
  if (error) return <ErrorRow message={error} />
  if (rows.length === 0) return <EmptyRow>No GRN recorded for this PO.</EmptyRow>
  return (
    <ClickableTable
      headers={['GRN #', 'GRN date', 'Supplier doc', 'Doc date', 'Item', 'Qty', 'UOM', 'Unit cost']}
      alignRight={[5, 7]}
      rows={rows.map((r) => ({
        cells: [
          r.grn_no || '—',
          formatDate(r.grn_date),
          r.supplier_doc_no || '—',
          formatDate(r.supplier_doc_date),
          r.item || r.description_1 || '—',
          formatQty(r.accepted_qty),
          r.uom || '—',
          formatINRSymbol(r.unit_cost),
        ],
        onClick: () => onOpen(r),
      }))}
    />
  )
}

function AsnContent({
  rows,
  loading,
  error,
  onOpen,
}: {
  rows: AsnRow[]
  loading: boolean
  error?: string
  onOpen: (r: AsnRow) => void
}) {
  if (loading) return <Spinner label="Loading ASNs…" />
  if (error) return <ErrorRow message={error} />
  if (rows.length === 0) return <EmptyRow>No ASN recorded for this PO.</EmptyRow>
  return (
    <ClickableTable
      headers={['ASN #', 'ASN date', 'Item', 'Qty', 'UOM']}
      alignRight={[3]}
      rows={rows.map((r) => ({
        cells: [
          r.asn_no || '—',
          formatDate(r.asn_date),
          r.item || r.description || '—',
          formatQty(r.qty),
          r.uom || '—',
        ],
        onClick: () => onOpen(r),
      }))}
    />
  )
}

function DcContent({
  rows,
  loading,
  error,
  onOpen,
}: {
  rows: DcRow[]
  loading: boolean
  error?: string
  onOpen: (r: DcRow) => void
}) {
  if (loading) return <Spinner label="Loading DCs…" />
  if (error) return <ErrorRow message={error} />
  if (rows.length === 0) return <EmptyRow>No delivery challan recorded for this PO.</EmptyRow>
  return (
    <ClickableTable
      headers={['DC #', 'DC date', 'Item', 'Qty', 'UOM']}
      alignRight={[3]}
      rows={rows.map((r) => ({
        cells: [
          r.dc_no || '—',
          formatDate(r.dc_date),
          r.item || '—',
          formatQty(r.qty),
          r.uom || '—',
        ],
        onClick: () => onOpen(r),
      }))}
    />
  )
}

function ScheduleContent({
  rows,
  loading,
  error,
  onOpen,
}: {
  rows: ScheduleRow[]
  loading: boolean
  error?: string
  onOpen: (r: ScheduleRow) => void
}) {
  if (loading) return <Spinner label="Loading schedules…" />
  if (error) return <ErrorRow message={error} />
  if (rows.length === 0) return <EmptyRow>No schedule recorded for this PO.</EmptyRow>
  return (
    <ClickableTable
      headers={['Schedule #', 'Sched date', 'Promise date', 'Item', 'Qty', 'UOM', 'Status']}
      alignRight={[4]}
      rows={rows.map((r) => ({
        cells: [
          r.doc_no || '—',
          formatDate(r.sched_date ?? null),
          formatDate(r.promise_date ?? null),
          r.description || r.item_id || '—',
          formatQty(r.sched_qty),
          r.uom || '—',
          r.status || '—',
        ],
        onClick: () => onOpen(r),
      }))}
    />
  )
}

/* =========================================================================
 *   Drill-through side panel
 * ========================================================================= */

function DrillSidePanel({ target, onClose }: { target: DrillTarget; onClose: () => void }) {
  // Body scroll lock while the panel is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Esc key closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  let title = ''
  let body: ReactNode = null
  switch (target.type) {
    case 'invoice':
      title = `Invoice · ${target.title}`
      body = <InvoiceExpansion invoiceId={target.id} poNumber={null} />
      break
    case 'grn':
      title = `GRN · ${target.row.grn_no || target.row.id || '—'}`
      body = <KeyValueGrid data={target.row as unknown as Record<string, unknown>} />
      break
    case 'asn':
      title = `ASN · ${target.row.asn_no || target.row.asn_id || '—'}`
      body = <KeyValueGrid data={target.row as unknown as Record<string, unknown>} />
      break
    case 'dc':
      title = `Delivery challan · ${target.row.dc_no || target.row.id || '—'}`
      body = <KeyValueGrid data={target.row as unknown as Record<string, unknown>} />
      break
    case 'schedule':
      title = `Schedule · ${target.row.doc_no || target.row.id || '—'}`
      body = <KeyValueGrid data={target.row as unknown as Record<string, unknown>} />
      break
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.55)',
        backdropFilter: 'blur(2px)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, 92vw)',
          height: '100vh',
          background: 'var(--surface-0)',
          boxShadow: '-4px 0 28px rgba(15,23,42,0.18)',
          borderLeft: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'po-side-panel-in 0.18s ease-out',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '0.85rem 1.1rem',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--surface-1)',
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'linear-gradient(135deg, var(--accent-violet), var(--brand-600))',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.9rem',
              flexShrink: 0,
            }}
          >
            <i className={`pi ${target.type === 'invoice' ? 'pi-file' : target.type === 'grn' ? 'pi-box' : target.type === 'asn' ? 'pi-truck' : target.type === 'dc' ? 'pi-send' : 'pi-calendar'}`} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700 }}>
              Linked document
            </div>
            <div
              style={{
                fontSize: '1rem',
                fontWeight: 800,
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '1.2rem',
              color: 'var(--text-muted)',
              padding: '0.4rem 0.55rem',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <i className="pi pi-times" />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 0, background: 'var(--surface-1)' }}>
          {body}
        </div>
      </div>
      <style>{`
        @keyframes po-side-panel-in {
          from { transform: translateX(20px); opacity: 0.75; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </div>
  )
}

function KeyValueGrid({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (entries.length === 0) {
    return <div style={{ padding: '1.2rem' }}><EmptyRow>No fields to display.</EmptyRow></div>
  }
  return (
    <div style={{ padding: '1.1rem 1.25rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.85rem 1.1rem',
          background: 'var(--surface-0)',
          padding: '1rem 1.15rem',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {entries.map(([key, val]) => (
          <Field
            key={key}
            label={prettyKey(key)}
            value={typeof val === 'object' ? JSON.stringify(val) : String(val as string | number)}
          />
        ))}
      </div>
    </div>
  )
}

function prettyKey(k: string): string {
  return k
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/* =========================================================================
 *   Shared primitives (kept local so this component is self-contained)
 * ========================================================================= */

function Panel({
  icon,
  color,
  title,
  children,
}: {
  icon: string
  color: string
  title: string
  children: ReactNode
}) {
  return (
    <div
      style={{
        background: 'var(--surface-0)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: '1rem 1.15rem',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.8rem',
          paddingBottom: '0.6rem',
          borderBottom: '1px dashed var(--border-subtle)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: `color-mix(in srgb, ${color} 18%, transparent)`,
            color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            flexShrink: 0,
          }}
        >
          <i className={`pi ${icon}`} />
        </div>
        <h4 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.005em' }}>
          {title}
        </h4>
      </div>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  const empty = value == null || value === '' || value === '—'
  return (
    <div>
      <div
        style={{
          fontSize: '0.66rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '0.88rem',
          color: empty ? 'var(--text-muted)' : 'var(--text-primary)',
          fontWeight: empty ? 400 : 600,
          marginTop: '0.2rem',
          wordBreak: 'break-word',
        }}
      >
        {empty ? '—' : value}
      </div>
    </div>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <div style={{ padding: '1.2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
      <i className="pi pi-spin pi-spinner" style={{ fontSize: '1.3rem', color: 'var(--brand-600)' }} />
      <div style={{ marginTop: '0.45rem', fontSize: '0.85rem' }}>{label}</div>
    </div>
  )
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '0.75rem 0.9rem',
        background: 'var(--status-danger-bg)',
        color: 'var(--status-danger-fg)',
        border: '1px solid var(--status-danger-ring)',
        borderRadius: 'var(--radius-md)',
        fontSize: '0.86rem',
      }}
    >
      <i className="pi pi-exclamation-triangle" /> {message}
    </div>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '1rem',
        textAlign: 'center',
        color: 'var(--text-muted)',
        background: 'var(--surface-1)',
        borderRadius: 'var(--radius-md)',
        border: '1px dashed var(--border-default)',
        fontSize: '0.85rem',
      }}
    >
      {children}
    </div>
  )
}

function ScrollTable({
  headers,
  rows,
  alignRight = [],
  footer,
}: {
  headers: string[]
  rows: string[][]
  alignRight?: number[]
  footer?: string[]
}) {
  const rightSet = new Set(alignRight)
  return (
    <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
        <thead>
          <tr style={{ background: 'var(--surface-1)' }}>
            {headers.map((h, i) => (
              <th
                key={h + i}
                style={{
                  padding: '0.6rem 0.8rem',
                  textAlign: rightSet.has(i) ? 'right' : 'left',
                  fontSize: '0.68rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                  borderBottom: '1px solid var(--border-subtle)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.6rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr style={{ background: 'var(--surface-2)', fontWeight: 800 }}>
              {footer.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.65rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    borderTop: '2px solid var(--border-default)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

function ClickableTable({
  headers,
  rows,
  alignRight = [],
}: {
  headers: string[]
  rows: Array<{ cells: string[]; onClick: () => void }>
  alignRight?: number[]
}) {
  const rightSet = new Set(alignRight)
  return (
    <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
        <thead>
          <tr style={{ background: 'var(--surface-1)' }}>
            {headers.map((h, i) => (
              <th
                key={h + i}
                style={{
                  padding: '0.6rem 0.8rem',
                  textAlign: rightSet.has(i) ? 'right' : 'left',
                  fontSize: '0.68rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                  borderBottom: '1px solid var(--border-subtle)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
            <th style={{ width: 30, borderBottom: '1px solid var(--border-subtle)' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onClick={row.onClick}
              tabIndex={0}
              role="button"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.onClick() } }}
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                cursor: 'pointer',
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-1)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              {row.cells.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: '0.6rem 0.8rem',
                    textAlign: rightSet.has(j) ? 'right' : 'left',
                    color: 'var(--text-primary)',
                    whiteSpace: rightSet.has(j) ? 'nowrap' : 'normal',
                  }}
                >
                  {cell}
                </td>
              ))}
              <td style={{ padding: '0.6rem 0.8rem', textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                <i className="pi pi-chevron-right" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
