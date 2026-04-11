interface StatusChipProps {
  status: string | null | undefined
}

const STATUS_TO_CHIP: Record<string, { label: string; variant: 'success' | 'info' | 'warn' | 'danger' | 'muted' }> = {
  validated:                 { label: 'Validated',            variant: 'info' },
  waiting_for_validation:    { label: 'Waiting for validation', variant: 'muted' },
  waiting_for_re_validation: { label: 'Re-validation',        variant: 'warn' },
  debit_note_approval:       { label: 'Debit note approval',  variant: 'warn' },
  exception_approval:        { label: 'Exception approval',   variant: 'warn' },
  ready_for_payment:         { label: 'Ready for payment',    variant: 'info' },
  partially_paid:            { label: 'Partially paid',       variant: 'info' },
  paid:                      { label: 'Paid',                 variant: 'success' },
  completed:                 { label: 'Completed',            variant: 'success' },
  rejected:                  { label: 'Rejected',             variant: 'danger' },
  open:                      { label: 'Open',                 variant: 'muted' },
  partially_fulfilled:       { label: 'Partially fulfilled',  variant: 'info' },
  fulfilled:                 { label: 'Fulfilled',            variant: 'success' },
  pending:                   { label: 'Pending',              variant: 'muted' },
  approved:                  { label: 'Approved',             variant: 'success' },
  payment_done:              { label: 'Payment done',         variant: 'success' },
  pending_approval:          { label: 'Pending approval',     variant: 'warn' }
}

function StatusChip({ status }: StatusChipProps) {
  if (!status) return <span className="status-chip status-chip--muted">Unknown</span>
  const key = String(status).toLowerCase().replace(/[\s-]+/g, '_')
  const mapped = STATUS_TO_CHIP[key]
  const label = mapped?.label ?? String(status).replace(/_/g, ' ')
  const variant = mapped?.variant ?? 'muted'
  return <span className={`status-chip status-chip--${variant}`}>{label}</span>
}

export default StatusChip
