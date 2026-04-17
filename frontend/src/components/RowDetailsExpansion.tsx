import type { ReactNode } from 'react'

/**
 * A reusable expansion panel for simple "list row" pages where every field is
 * already present on the row (GRN / ASN / DC / Schedules). No fetches — just a
 * well-organised card view of the data grouped into labelled sections.
 */

export interface DetailField {
  label: string
  value: ReactNode
}

export interface DetailSection {
  icon: string
  color: string
  title: string
  fields: DetailField[]
}

interface Props {
  heroIcon: string
  heroColor: string
  heroEyebrow: string
  heroTitle: ReactNode
  heroSubtitle?: ReactNode
  heroRight?: ReactNode
  sections: DetailSection[]
}

export default function RowDetailsExpansion({
  heroIcon,
  heroColor,
  heroEyebrow,
  heroTitle,
  heroSubtitle,
  heroRight,
  sections
}: Props) {
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
      {/* Hero strip */}
      <div
        style={{
          padding: '1rem 1.2rem',
          borderRadius: 'var(--radius-lg)',
          background: `linear-gradient(135deg, color-mix(in srgb, ${heroColor} 12%, transparent), color-mix(in srgb, ${heroColor} 3%, transparent))`,
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
            background: `linear-gradient(135deg, ${heroColor}, ${heroColor}cc)`,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            flexShrink: 0
          }}
        >
          <i className={`pi ${heroIcon}`} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-muted)',
              fontWeight: 700
            }}
          >
            {heroEyebrow}
          </span>
          <div
            style={{
              fontSize: '1.2rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              letterSpacing: '-0.02em',
              marginTop: '0.15rem'
            }}
          >
            {heroTitle}
          </div>
          {heroSubtitle && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
              {heroSubtitle}
            </div>
          )}
        </div>
        {heroRight && <div style={{ textAlign: 'right' }}>{heroRight}</div>}
      </div>

      {/* Sections grid — auto-fit so narrow sections (2-3 fields) sit side-by-side */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '0.9rem'
        }}
      >
        {sections.map((s) => (
          <Panel key={s.title} icon={s.icon} color={s.color} title={s.title}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '0.85rem'
              }}
            >
              {s.fields.map((f, i) => (
                <Field key={`${f.label}-${i}`} label={f.label} value={f.value} />
              ))}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  )
}

function Panel({
  icon,
  color,
  title,
  children
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
        boxShadow: 'var(--shadow-sm)'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.8rem',
          paddingBottom: '0.6rem',
          borderBottom: '1px dashed var(--border-subtle)'
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
            flexShrink: 0
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

function Field({ label, value }: { label: string; value: ReactNode }) {
  const isEmpty = value == null || value === '' || value === '—'
  return (
    <div>
      <div
        style={{
          fontSize: '0.66rem',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--text-muted)',
          fontWeight: 700
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '0.88rem',
          color: isEmpty ? 'var(--text-muted)' : 'var(--text-primary)',
          fontWeight: isEmpty ? 400 : 600,
          marginTop: '0.2rem',
          wordBreak: 'break-word'
        }}
      >
        {isEmpty ? '—' : value}
      </div>
    </div>
  )
}
