import './App.css'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import Home from './pages/Home'
import Login from './pages/Login'
import InvoiceUpload from './pages/InvoiceUpload'
import PurchaseOrderDetails from './pages/PurchaseOrderDetails'
import GRNDetails from './pages/GRNDetails'
import ASNDetails from './pages/ASNDetails'
import InvoiceValidate from './pages/InvoiceValidate'
import InvoiceDetails from './pages/InvoiceDetails'
import IncompletePOs from './pages/IncompletePOs'
import UserRegistration from './pages/UserRegistration'
import OwnerDetails from './pages/OwnerDetails'
import SupplierRegistration from './pages/SupplierRegistration'
import InvoiceReports from './pages/InvoiceReports'
import SupplierReports from './pages/SupplierReports'
import FinancialReports from './pages/FinancialReports'
import ApprovePayments from './pages/ApprovePayments'
import ReadyForPayments from './pages/ReadyForPayments'
import PaymentHistory from './pages/PaymentHistory'
import FinanceDashboard from './pages/FinanceDashboard'
import ProtectedRoute from './components/ProtectedRoute'

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
      <Routes>
        <Route 
          path="/login" 
          element={isAuthenticated ? <Navigate to="/" replace /> : <Login />} 
        />
        <Route 
          path="/" 
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/invoices/upload" 
          element={
            <ProtectedRoute>
              <InvoiceUpload />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/invoices/validate" 
          element={
            <ProtectedRoute>
              <InvoiceValidate />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/invoices/validate/:id" 
          element={
            <ProtectedRoute>
              <InvoiceDetails />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/purchase-orders/upload" 
          element={
            <ProtectedRoute>
              <PurchaseOrderDetails />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/purchase-orders/incomplete" 
          element={
            <ProtectedRoute>
              <IncompletePOs />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/grn/details" 
          element={
            <ProtectedRoute>
              <GRNDetails />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/asn/details" 
          element={
            <ProtectedRoute>
              <ASNDetails />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/users/registration" 
          element={
            <ProtectedRoute requiredRole={['admin', 'manager']}>
              <UserRegistration />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/owners/details" 
          element={
            <ProtectedRoute requiredRole={['admin']}>
              <OwnerDetails />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/suppliers/registration" 
          element={
            <ProtectedRoute requiredRole={['admin', 'manager']}>
              <SupplierRegistration />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/finance/dashboard" 
          element={
            <ProtectedRoute requiredRole={['admin', 'manager', 'finance', 'viewer']}>
              <FinanceDashboard />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/payments/approve" 
          element={
            <ProtectedRoute requiredRole={['admin', 'manager', 'finance']}>
              <ApprovePayments />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/payments/ready" 
          element={
            <ProtectedRoute requiredRole={['admin', 'manager', 'finance']}>
              <ReadyForPayments />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/payments/history" 
          element={
            <ProtectedRoute>
              <PaymentHistory />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/reports/invoices" 
          element={
            <ProtectedRoute>
              <InvoiceReports />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/reports/financial" 
          element={
            <ProtectedRoute>
              <FinancialReports />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/reports/suppliers" 
          element={
            <ProtectedRoute>
              <SupplierReports />
            </ProtectedRoute>
          } 
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
