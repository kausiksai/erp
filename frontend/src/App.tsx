import './App.css'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import Home from './pages/Home'
import Login from './pages/Login'
import InvoiceUpload from './pages/InvoiceUpload'
import PurchaseOrderDetails from './pages/PurchaseOrderDetails'
import InvoiceValidate from './pages/InvoiceValidate'
import InvoiceDetails from './pages/InvoiceDetails'
import IncompletePOs from './pages/IncompletePOs'
import UserRegistration from './pages/UserRegistration'
import OwnerDetails from './pages/OwnerDetails'
import ComingSoon from './pages/ComingSoon'
import ProtectedRoute from './components/ProtectedRoute'

function App() {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        minHeight: '100vh' 
      }}>
        <i className="pi pi-spin pi-spinner" style={{ fontSize: '2rem' }}></i>
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
        {/* Coming Soon Routes */}
        <Route 
          path="/grn/details" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/asn/details" 
          element={
            <ProtectedRoute>
              <ComingSoon />
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
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/finance/dashboard" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/payments/ready" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/payments/history" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/reports/invoices" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/reports/financial" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route 
          path="/reports/suppliers" 
          element={
            <ProtectedRoute>
              <ComingSoon />
            </ProtectedRoute>
          } 
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
