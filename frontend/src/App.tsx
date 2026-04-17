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
import Dashboard from './pages/Dashboard'
import Analytics from './pages/Analytics'
import ReportsHubPage from './pages/ReportsHubPage'
import InvoicesPage from './pages/InvoicesPage'
import InvoiceDetailPage from './pages/InvoiceDetailPage'
import InvoiceUploadPage from './pages/InvoiceUploadPage'
import NeedsReconciliationPage from './pages/NeedsReconciliationPage'
import PurchaseOrdersPage from './pages/PurchaseOrdersPage'
import IncompletePOsPage from './pages/IncompletePOsPage'
import GRNPage from './pages/GRNPage'
import ASNPage from './pages/ASNPage'
import DCPage from './pages/DCPage'
import SchedulesPage from './pages/SchedulesPage'
import OpenPoPrefixesPage from './pages/OpenPoPrefixesPage'
import SuppliersPage from './pages/SuppliersPage'
import SupplierFormPage from './pages/SupplierFormPage'
import UsersPage from './pages/UsersPage'
import OwnerPage from './pages/OwnerPage'
import PaymentsPage from './pages/PaymentsPage'
import ProfilePage from './pages/ProfilePage'

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
        <Route path="/"          element={<ShellRoute><Dashboard /></ShellRoute>} />
        <Route path="/analytics" element={<ShellRoute><Analytics /></ShellRoute>} />
        <Route path="/reports"   element={<ShellRoute><ReportsHubPage /></ShellRoute>} />

        {/* Workflow — Invoices */}
        <Route path="/invoices/validate"       element={<ShellRoute><InvoicesPage /></ShellRoute>} />
        <Route path="/invoices/validate/:id"   element={<ShellRoute><InvoiceDetailPage /></ShellRoute>} />
        <Route path="/invoices/upload"         element={<ShellRoute><InvoiceUploadPage /></ShellRoute>} />
        <Route path="/invoices/reconciliation" element={<ShellRoute><NeedsReconciliationPage /></ShellRoute>} />

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
        <Route path="/grn"                        element={<ShellRoute><GRNPage /></ShellRoute>} />
        <Route path="/asn"                        element={<ShellRoute><ASNPage /></ShellRoute>} />
        <Route path="/delivery-challans"          element={<ShellRoute><DCPage /></ShellRoute>} />
        <Route path="/po-schedules"               element={<ShellRoute><SchedulesPage /></ShellRoute>} />
        <Route path="/open-po-prefixes"           element={<ShellRoute><OpenPoPrefixesPage /></ShellRoute>} />

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

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
