// Menu configuration with role-based permissions
// This file defines all menu items and their visibility based on user roles

export type UserRole = 'admin' | 'manager' | 'user' | 'finance' | 'viewer'

export interface MenuItem {
  id: string
  title: string
  description: string
  icon: string
  path: string
  color: string
  comingSoon: boolean
  // Roles that can access this menu item
  allowedRoles: UserRole[]
  // Display order within category (lower numbers appear first)
  order: number
  // Optional: minimum permission level (for future use)
  permissionLevel?: number
}

export interface MenuCategory {
  id: string
  title: string
  description: string
  items: MenuItem[]
  // Roles that can see this category
  allowedRoles?: UserRole[]
}

// Define all menu items with their role permissions
const allMenuItems: MenuItem[] = [
  // Status & Actions
  {
    id: 'incomplete-pos',
    title: 'Incomplete Purchase Orders',
    description: 'View POs missing invoices, ASN, or GRN and update missing details',
    icon: 'pi pi-exclamation-triangle',
    path: '/purchase-orders/incomplete',
    color: '#dc2626',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'user'],
    order: 1
  },
  
  // Invoice Management
  {
    id: 'invoice-upload',
    title: 'Invoice Upload',
    description: 'Upload invoices and extract data automatically',
    icon: 'pi pi-file-pdf',
    path: '/invoices/upload',
    color: '#059669',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'user'],
    order: 1
  },
  {
    id: 'invoice-details',
    title: 'Invoice Details',
    description: 'View and manage invoice details and validation',
    icon: 'pi pi-file-edit',
    path: '/invoices/validate',
    color: '#2563eb',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'user', 'finance', 'viewer'],
    order: 2
  },
  
  // Purchase Orders
  {
    id: 'purchase-order',
    title: 'Purchase Order Details',
    description: 'View and manage purchase order details',
    icon: 'pi pi-shopping-cart',
    path: '/purchase-orders/upload',
    color: '#7c3aed',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'user'],
    order: 1
  },
  {
    id: 'grn-details',
    title: 'GRN Details',
    description: 'Goods Receipt Note management and tracking',
    icon: 'pi pi-box',
    path: '/grn/details',
    color: '#ea580c',
    comingSoon: true,
    allowedRoles: ['admin', 'manager', 'user'],
    order: 2
  },
  {
    id: 'asn-details',
    title: 'ASN Details',
    description: 'Advanced Shipping Notice management',
    icon: 'pi pi-truck',
    path: '/asn/details',
    color: '#0891b2',
    comingSoon: true,
    allowedRoles: ['admin', 'manager', 'user'],
    order: 3
  },
  
  // Master Data (Admin/Manager only)
  {
    id: 'user-registration',
    title: 'User Registration',
    description: 'Register and manage system users',
    icon: 'pi pi-users',
    path: '/users/registration',
    color: '#dc2626',
    comingSoon: false,
    allowedRoles: ['admin', 'manager'],
    order: 1
  },
  {
    id: 'supplier-registration',
    title: 'Supplier Registration',
    description: 'Register and manage supplier information',
    icon: 'pi pi-building',
    path: '/suppliers/registration',
    color: '#ca8a04',
    comingSoon: false,
    allowedRoles: ['admin', 'manager'],
    order: 2
  },
  
  // Finance & Payments
  {
    id: 'approve-payments',
    title: 'Approve Payments',
    description: 'Review and approve payments (PO, supplier, invoice, GRN, ASN, banking)',
    icon: 'pi pi-check-square',
    path: '/payments/approve',
    color: '#0d9488',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'finance'],
    order: 2
  },
  {
    id: 'ready-for-payment',
    title: 'Ready for Payments',
    description: 'Manage approved payments and mark as done',
    icon: 'pi pi-money-bill',
    path: '/payments/ready',
    color: '#0284c7',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'finance'],
    order: 3
  },
  {
    id: 'payment-history',
    title: 'Payment History',
    description: 'View and track payment history and status',
    icon: 'pi pi-history',
    path: '/payments/history',
    color: '#9333ea',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'finance', 'viewer'],
    order: 4
  },
  
  // Reports & Analytics
  {
    id: 'finance-dashboard',
    title: 'Finance Dashboard',
    description: 'Comprehensive financial overview and analytics',
    icon: 'pi pi-chart-line',
    path: '/finance/dashboard',
    color: '#16a34a',
    comingSoon: false,
    allowedRoles: ['admin', 'manager', 'finance', 'viewer'],
    order: 1
  },
  {
    id: 'invoice-reports',
    title: 'Invoice Reports',
    description: 'Generate comprehensive invoice reports',
    icon: 'pi pi-file',
    path: '/reports/invoices',
    color: '#be123c',
    comingSoon: true,
    allowedRoles: ['admin', 'manager', 'finance', 'viewer'],
    order: 2
  },
  {
    id: 'financial-reports',
    title: 'Financial Reports',
    description: 'Generate financial statements and reports',
    icon: 'pi pi-chart-bar',
    path: '/reports/financial',
    color: '#0d9488',
    comingSoon: true,
    allowedRoles: ['admin', 'manager', 'finance'],
    order: 3
  },
  {
    id: 'supplier-reports',
    title: 'Supplier Reports',
    description: 'Analyze supplier performance and reports',
    icon: 'pi pi-chart-pie',
    path: '/reports/suppliers',
    color: '#c2410c',
    comingSoon: true,
    allowedRoles: ['admin', 'manager'],
    order: 4
  }
]

// Organize menu items into categories
export const getMenuCategories = (userRole: UserRole): MenuCategory[] => {
  // Filter items based on user role and sort by order
  const filterItemsByRole = (items: (MenuItem | undefined)[]): MenuItem[] => 
    items
      .filter((item): item is MenuItem => item !== undefined)
      .filter(item => item.allowedRoles.includes(userRole))
      .sort((a, b) => a.order - b.order) // Sort by order property

  // Helper to safely get menu items by ID
  const getMenuItemsByIds = (...ids: string[]): (MenuItem | undefined)[] => 
    ids.map(id => allMenuItems.find(item => item.id === id))

  return [
    {
      id: 'status-actions',
      title: 'Status & Actions',
      description: 'Track incomplete records and pending actions',
      items: filterItemsByRole(getMenuItemsByIds('incomplete-pos'))
    },
    {
      id: 'invoices',
      title: 'Invoice Management',
      description: 'Manage invoices, validation, and details',
      items: filterItemsByRole(getMenuItemsByIds('invoice-upload', 'invoice-details'))
    },
    {
      id: 'purchase-orders',
      title: 'Purchase Orders',
      description: 'Purchase order and related document management',
      items: filterItemsByRole(getMenuItemsByIds('purchase-order', 'grn-details', 'asn-details'))
    },
    {
      id: 'master-data',
      title: 'Master Data',
      description: 'Manage users, suppliers, and system configuration',
      items: filterItemsByRole(getMenuItemsByIds('user-registration', 'supplier-registration'))
    },
    {
      id: 'finance',
      title: 'Finance & Payments',
      description: 'Payment approval and history',
      items: filterItemsByRole(getMenuItemsByIds('approve-payments', 'ready-for-payment', 'payment-history'))
    },
    {
      id: 'reports',
      title: 'Reports & Analytics',
      description: 'Generate reports and view analytics',
      items: filterItemsByRole(getMenuItemsByIds('finance-dashboard', 'invoice-reports', 'financial-reports', 'supplier-reports'))
    }
  ].filter(category => category.items.length > 0) // Only show categories with items
}

// Helper function to check if user has access to a specific path
export const hasAccessToPath = (path: string, userRole: UserRole): boolean => {
  const menuItem = allMenuItems.find(item => item.path === path)
  if (!menuItem) return false
  return menuItem.allowedRoles.includes(userRole)
}

// Get role display name
export const getRoleDisplayName = (role: UserRole): string => {
  const roleNames: Record<UserRole, string> = {
    admin: 'Administrator',
    manager: 'Manager',
    user: 'User',
    finance: 'Finance',
    viewer: 'Viewer'
  }
  return roleNames[role] || role
}

// Get role description
export const getRoleDescription = (role: UserRole): string => {
  const descriptions: Record<UserRole, string> = {
    admin: 'Full system access with all permissions',
    manager: 'Manage operations and approve transactions',
    user: 'Standard user with data entry capabilities',
    finance: 'Financial operations and payment management',
    viewer: 'Read-only access to view reports and data'
  }
  return descriptions[role] || 'Standard access'
}
