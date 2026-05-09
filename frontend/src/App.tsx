import './App.css'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import ScrollToTop from './components/ScrollToTop'
import SessionExpiredHandler from './components/SessionExpiredHandler'
import AppShell from './components/AppShell'
import ProtectedRoute from './components/ProtectedRoute'
import { useAuth } from './contexts/AuthContext'

// Brand-new pages — every page is a from-scratch rewrite.
import Login from './pages/Login'
import WorkspacePage from './pages/WorkspacePage'
import Analytics from './pages/Analytics'
import ReportsHubPage from './pages/ReportsHubPage'
import InvoicesPage from './pages/InvoicesPage'
import InvoiceDetailPage from './pages/InvoiceDetailPage'
import InvoiceUploadPage from './pages/InvoiceUploadPage'
import ReconciliationPage from './pages/ReconciliationPage'
import PurchaseOrdersPage from './pages/PurchaseOrdersPage'
import IncompletePOsPage from './pages/IncompletePOsPage'
import ReceiptsPage from './pages/ReceiptsPage'
import OpenPoPrefixesPage from './pages/OpenPoPrefixesPage'
import SuppliersPage from './pages/SuppliersPage'
import SupplierFormPage from './pages/SupplierFormPage'
import UsersPage from './pages/UsersPage'
import OwnerPage from './pages/OwnerPage'
import PaymentsPage from './pages/PaymentsPage'
import ProfilePage from './pages/ProfilePage'
import ItemPriceHistoryPage from './pages/ItemPriceHistoryPage'
import RedesignPlaceholder from './pages/RedesignPlaceholder'

/** Every authenticated route renders inside the global AppShell. */
function ShellRoute({
  children,
  requiredRole
}: {
  children: ReactNode
  requiredRole?: string[]
}) {
  return (
    <ProtectedRoute requiredRole={requiredRole}>
      <AppShell>{children}</AppShell>
    </ProtectedRoute>
  )
}

function App() {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <div className="appLoadingWrap">
        <i className="pi pi-spin pi-spinner" aria-hidden></i>
        <span>Loading…</span>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <ScrollToTop />
      <SessionExpiredHandler />
      <Routes>
        {/* Public */}
        <Route
          path="/login"
          element={isAuthenticated ? <Navigate to="/" replace /> : <Login />}
        />

        {/* Overview */}
        <Route path="/"          element={<ShellRoute><WorkspacePage /></ShellRoute>} />
        <Route path="/insights"  element={<ShellRoute><Analytics /></ShellRoute>} />
        <Route path="/analytics" element={<Navigate to="/insights" replace />} />
        <Route path="/reports"   element={<ShellRoute><ReportsHubPage /></ShellRoute>} />

        {/* Workflow — Invoices */}
        <Route path="/invoices/validate"       element={<ShellRoute><InvoicesPage /></ShellRoute>} />
        <Route path="/invoices/validate/:id"   element={<ShellRoute><InvoiceDetailPage /></ShellRoute>} />
        <Route path="/invoices/upload"         element={<ShellRoute><InvoiceUploadPage /></ShellRoute>} />
        <Route path="/invoices/reconciliation" element={<ShellRoute><ReconciliationPage /></ShellRoute>} />

        {/* Workflow — Payments */}
        <Route
          path="/payments/approve"
          element={<ShellRoute requiredRole={['admin', 'manager', 'finance']}><PaymentsPage /></ShellRoute>}
        />
        <Route
          path="/payments/ready"
          element={<ShellRoute requiredRole={['admin', 'manager', 'finance']}><PaymentsPage /></ShellRoute>}
        />
        <Route path="/payments/history" element={<ShellRoute><PaymentsPage /></ShellRoute>} />

        {/* Documents */}
        <Route path="/purchase-orders"            element={<ShellRoute><PurchaseOrdersPage /></ShellRoute>} />
        <Route path="/purchase-orders/incomplete" element={<ShellRoute><IncompletePOsPage /></ShellRoute>} />
        {/* Legacy receipt routes redirect to the consolidated /receipts page. */}
        <Route path="/grn"                        element={<Navigate to="/receipts?type=grn" replace />} />
        <Route path="/asn"                        element={<Navigate to="/receipts?type=asn" replace />} />
        <Route path="/delivery-challans"          element={<Navigate to="/receipts?type=dc" replace />} />
        <Route path="/po-schedules"               element={<Navigate to="/receipts?type=schedule" replace />} />
        <Route path="/open-po-prefixes"           element={<ShellRoute><OpenPoPrefixesPage /></ShellRoute>} />
        <Route path="/items/price-history"        element={<ShellRoute><ItemPriceHistoryPage /></ShellRoute>} />

        {/* Masters */}
        <Route path="/suppliers"              element={<ShellRoute><SuppliersPage /></ShellRoute>} />
        <Route
          path="/suppliers/registration"
          element={<ShellRoute requiredRole={['admin', 'manager']}><SupplierFormPage /></ShellRoute>}
        />
        <Route
          path="/users/registration"
          element={<ShellRoute requiredRole={['admin', 'manager']}><UsersPage /></ShellRoute>}
        />
        <Route
          path="/owners/details"
          element={<ShellRoute requiredRole={['admin']}><OwnerPage /></ShellRoute>}
        />

        {/* System */}
        <Route path="/profile" element={<ShellRoute><ProfilePage /></ShellRoute>} />

        {/* Redesign IA — new wrapper paths. Each is replaced with its real
            page during Phase 3; placeholders avoid 404s in the meantime. */}
        <Route path="/receipts" element={<ShellRoute><ReceiptsPage /></ShellRoute>} />
        <Route path="/rules" element={<ShellRoute requiredRole={['admin']}><RedesignPlaceholder title="Validation rules" subtitle="The 28-rule validation library — every check the engine runs, current count, owner, and severity controls." /></ShellRoute>} />
        <Route path="/audit" element={<ShellRoute requiredRole={['admin']}><RedesignPlaceholder title="Audit log" subtitle="Chronological record of every meaningful action — automated or human — across the portal." /></ShellRoute>} />
        <Route path="/settings" element={<ShellRoute><RedesignPlaceholder title="Settings" subtitle="Profile, Users, Owners, and Open PO prefixes consolidated into one tabbed screen." /></ShellRoute>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
