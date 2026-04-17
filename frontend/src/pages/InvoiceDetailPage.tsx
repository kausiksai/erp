import { useNavigate, useParams } from 'react-router-dom'
import PageHero from '../components/PageHero'
import InvoiceExpansion from '../components/InvoiceExpansion'

/**
 * Standalone invoice detail page (/invoices/validate/:id).
 *
 * Renders the same full InvoiceExpansion component used in the inline
 * list-row dropdown — so bookmarked URLs and direct links get the exact
 * same 6-tab view (Overview · Line items · PO · GRN & ASN · Validation ·
 * Attachments) plus all action buttons (Validate, Exception approve,
 * Debit note approve, Resolution dialog).
 */
function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const invoiceId = Number(id)

  if (!id || Number.isNaN(invoiceId)) {
    return (
      <div className="glass-card" style={{ textAlign: 'center' }}>
        <h3 className="glass-card__title">
          <i className="pi pi-exclamation-triangle" /> Invalid invoice ID
        </h3>
        <button className="action-btn" onClick={() => navigate('/invoices/validate')}>
          <i className="pi pi-arrow-left" /> Back to invoices
        </button>
      </div>
    )
  }

  return (
    <>
      <PageHero
        eyebrow="Invoice detail"
        eyebrowIcon="pi-file"
        title={`Invoice #${id}`}
        subtitle="Full invoice view — same detail you see in the list expansion, accessible via a direct link."
        actions={
          <button className="action-btn action-btn--ghost" onClick={() => navigate('/invoices/validate')}>
            <i className="pi pi-arrow-left" /> Back to invoices
          </button>
        }
      />

      <div
        className="glass-card"
        style={{ padding: 0, overflow: 'hidden' }}
      >
        <InvoiceExpansion invoiceId={invoiceId} poNumber={null} />
      </div>
    </>
  )
}

export default InvoiceDetailPage
