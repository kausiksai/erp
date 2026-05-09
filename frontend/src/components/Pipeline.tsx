import type { ReactNode } from 'react'

/**
 * Horizontal pipeline indicator.
 *
 *   <Pipeline steps={[
 *     { label: 'PO',        state: 'done',    meta: 'SP/PO12401' },
 *     { label: 'ASN',       state: 'done',    meta: '29 Apr' },
 *     { label: 'GRN',       state: 'done',    meta: '30 Apr' },
 *     { label: 'Invoice',   state: 'done',    meta: '02 May' },
 *     { label: 'Validated', state: 'current', meta: 'today' },
 *     { label: 'Approved',  state: 'pending', meta: 'awaiting' },
 *     { label: 'Paid',      state: 'pending', meta: 'due 31 May' }
 *   ]} />
 *
 * `done` rendered in green, `current` in pulsing blue, `pending` muted,
 * `failed` red (validation blocker), `skipped` dashed grey (e.g. ASN-less
 * standard PO).
 */

export type PipelineStepState = 'done' | 'current' | 'pending' | 'failed' | 'skipped'

export interface PipelineStep {
  label: string
  state: PipelineStepState
  /** Tiny line under the label — usually a date or doc no. */
  meta?: ReactNode
  /** Numeric or text shown inside the dot when the step is pending. */
  marker?: ReactNode
}

interface PipelineProps {
  steps: PipelineStep[]
}

function dotIcon(state: PipelineStepState, marker?: ReactNode, fallbackIndex?: number) {
  if (state === 'done' || state === 'current') return <i className="pi pi-check" style={{ fontSize: '9px' }} aria-hidden />
  if (state === 'failed') return <i className="pi pi-times" style={{ fontSize: '9px' }} aria-hidden />
  return marker ?? fallbackIndex
}

function Pipeline({ steps }: PipelineProps) {
  return (
    <div className="pipeline">
      {steps.map((step, i) => {
        const next = steps[i + 1]
        // The connecting line is filled if both sides have already passed
        const lineDone = step.state === 'done' && next && (next.state === 'done' || next.state === 'current')
        return (
          <span key={i} style={{ display: 'contents' }}>
            <div className="pipeline__step">
              <div className="pipeline__head">
                <div className={`pipeline__dot pipeline__dot--${step.state}`}>
                  {dotIcon(step.state, step.marker, i + 1)}
                </div>
                <div className="pipeline__label">{step.label}</div>
              </div>
              {step.meta && <span className="pipeline__meta">{step.meta}</span>}
            </div>
            {next && <div className={`pipeline__line ${lineDone ? 'pipeline__line--done' : ''}`} />}
          </span>
        )
      })}
    </div>
  )
}

export default Pipeline
