import { useState, useEffect, useRef } from 'react'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Dialog } from 'primereact/dialog'
import { InputText } from 'primereact/inputtext'
import { Password } from 'primereact/password'
import { Dropdown } from 'primereact/dropdown'
import { Checkbox } from 'primereact/checkbox'
import { Toast } from 'primereact/toast'
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
import { Badge } from 'primereact/badge'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl } from '../utils/api'
import { useAuth } from '../contexts/AuthContext'
import { getRoleDisplayName } from '../config/menuConfig'
import styles from './UserRegistration.module.css'

interface User {
  user_id: number
  username: string
  email: string
  role: string
  full_name: string | null
  is_active: boolean
  last_login: string | null
  created_at: string
  updated_at: string
}

interface MenuAccess {
  menu_item_id: number
  menu_id: string
  title: string
  path: string
  category_id: string
  category_title: string
  has_access: boolean
}

const ROLES = [
  { label: 'Administrator', value: 'admin' },
  { label: 'Manager', value: 'manager' },
  { label: 'User', value: 'user' },
  { label: 'Finance', value: 'finance' },
  { label: 'Viewer', value: 'viewer' }
]

function UserRegistration() {
  const { user: currentUser } = useAuth()
  const toast = useRef<Toast>(null)
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [showUserDialog, setShowUserDialog] = useState(false)
  const [showMenuAccessDialog, setShowMenuAccessDialog] = useState(false)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [menuAccess, setMenuAccess] = useState<MenuAccess[]>([])
  const [loadingMenuAccess, setLoadingMenuAccess] = useState(false)
  const [allMenuItems, setAllMenuItems] = useState<MenuAccess[]>([])
  const [showMenuAccessInCreate, setShowMenuAccessInCreate] = useState(false)
  
  // Form state
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    fullName: '',
    role: 'user',
    isActive: true
  })
  const [isEditMode, setIsEditMode] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  
  // Metrics
  const [metrics, setMetrics] = useState({
    totalUsers: 0,
    activeUsers: 0,
    inactiveUsers: 0,
    roleCounts: {} as Record<string, number>
  })

  useEffect(() => {
    fetchUsers()
    fetchAllMenuItems()
  }, [])

  useEffect(() => {
    calculateMetrics()
  }, [users])

  const fetchUsers = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl('users'), {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (!response.ok) {
        throw new Error('Failed to fetch users')
      }

      const data = await response.json()
      setUsers(data)
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to load users',
        life: 5000
      })
    } finally {
      setLoading(false)
    }
  }

  const fetchAllMenuItems = async () => {
    try {
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl('menu-items/all'), {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (!response.ok) {
        throw new Error('Failed to fetch menu items')
      }

      const data = await response.json()
      // Transform to MenuAccess format
      const transformed = data.map((item: any) => ({
        menu_item_id: item.menu_item_id,
        menu_id: item.menu_id,
        title: item.title,
        path: item.path,
        category_id: item.category_id,
        category_title: item.category_title,
        has_access: false // Default to false for new users
      }))
      setAllMenuItems(transformed)
    } catch (error: any) {
      console.error('Failed to fetch menu items:', error)
      // Don't show error toast, just log it
    }
  }

  const calculateMetrics = () => {
    const totalUsers = users.length
    const activeUsers = users.filter(u => u.is_active).length
    const inactiveUsers = totalUsers - activeUsers
    
    const roleCounts: Record<string, number> = {}
    users.forEach(user => {
      roleCounts[user.role] = (roleCounts[user.role] || 0) + 1
    })
    
    setMetrics({
      totalUsers,
      activeUsers,
      inactiveUsers,
      roleCounts
    })
  }

  const fetchMenuAccess = async (userId: number) => {
    try {
      setLoadingMenuAccess(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl(`users/${userId}/menu-access`), {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      if (!response.ok) {
        throw new Error('Failed to fetch menu access')
      }

      const data = await response.json()
      setMenuAccess(data)
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to load menu access',
        life: 5000
      })
    } finally {
      setLoadingMenuAccess(false)
    }
  }

  const handleCreate = async () => {
    setIsEditMode(false)
    setFormData({
      username: '',
      email: '',
      password: '',
      fullName: '',
      role: 'user',
      isActive: true
    })
    setShowPassword(true)
    setShowMenuAccessInCreate(false)
    
    // Initialize menu access with all items set to false
    // Use allMenuItems if available, otherwise empty array
    const initialMenuAccess = allMenuItems.length > 0 
      ? allMenuItems.map(item => ({
          ...item,
          has_access: false
        }))
      : []
    setMenuAccess(initialMenuAccess)
    
    setShowUserDialog(true)
  }

  const handleEdit = (user: User) => {
    setIsEditMode(true)
    setSelectedUser(user)
    setFormData({
      username: user.username,
      email: user.email,
      password: '',
      fullName: user.full_name || '',
      role: user.role,
      isActive: user.is_active
    })
    setShowPassword(false)
    setShowUserDialog(true)
  }

  const handleDelete = (user: User) => {
    confirmDialog({
      message: `Are you sure you want to delete user "${user.username}"? This action cannot be undone.`,
      header: 'Confirm Deletion',
      icon: 'pi pi-exclamation-triangle',
      accept: async () => {
        try {
          const token = localStorage.getItem('authToken')
          const response = await fetch(apiUrl(`users/${user.user_id}`), {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          })

          if (!response.ok) {
            const error = await response.json()
            throw new Error(error.message || 'Failed to delete user')
          }

          toast.current?.show({
            severity: 'success',
            summary: 'Success',
            detail: 'User deleted successfully',
            life: 3000
          })

          fetchUsers()
        } catch (error: any) {
          toast.current?.show({
            severity: 'error',
            summary: 'Error',
            detail: error.message || 'Failed to delete user',
            life: 5000
          })
        }
      }
    })
  }

  const handleManageAccess = async (user: User) => {
    setSelectedUser(user)
    await fetchMenuAccess(user.user_id)
    setShowMenuAccessDialog(true)
  }

  const handleSaveUser = async () => {
    try {
      if (!formData.username || !formData.email) {
        toast.current?.show({
          severity: 'warn',
          summary: 'Validation Error',
          detail: 'Username and email are required',
          life: 3000
        })
        return
      }

      if (!isEditMode && !formData.password) {
        toast.current?.show({
          severity: 'warn',
          summary: 'Validation Error',
          detail: 'Password is required for new users',
          life: 3000
        })
        return
      }

      if (formData.password && formData.password.length < 6) {
        toast.current?.show({
          severity: 'warn',
          summary: 'Validation Error',
          detail: 'Password must be at least 6 characters',
          life: 3000
        })
        return
      }

      const token = localStorage.getItem('authToken')
      const url = isEditMode 
        ? apiUrl(`users/${selectedUser?.user_id}`)
        : apiUrl('users')
      
      const method = isEditMode ? 'PUT' : 'POST'
      const body: any = {
        username: formData.username,
        email: formData.email,
        fullName: formData.fullName || null,
        role: formData.role,
        isActive: formData.isActive
      }

      if (formData.password) {
        body.password = formData.password
      }

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(body)
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Failed to save user')
      }

      const savedUser = await response.json()

      // If creating a new user and menu access is configured, save it
      if (!isEditMode && menuAccess.some(item => item.has_access)) {
        const selectedMenuIds = menuAccess
          .filter(item => item.has_access)
          .map(item => item.menu_item_id)

        if (selectedMenuIds.length > 0) {
          try {
            const menuAccessResponse = await fetch(apiUrl(`users/${savedUser.user_id}/menu-access`), {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ menuItemIds: selectedMenuIds })
            })

            if (!menuAccessResponse.ok) {
              console.warn('User created but menu access update failed')
            }
          } catch (menuError) {
            console.warn('User created but menu access update failed:', menuError)
          }
        }
      }

      toast.current?.show({
        severity: 'success',
        summary: 'Success',
        detail: isEditMode ? 'User updated successfully' : 'User created successfully',
        life: 3000
      })

      setShowUserDialog(false)
      fetchUsers()
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to save user',
        life: 5000
      })
    }
  }

  const handleSaveMenuAccess = async () => {
    try {
      if (!selectedUser) return

      const selectedMenuIds = menuAccess
        .filter(item => item.has_access)
        .map(item => item.menu_item_id)

      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl(`users/${selectedUser.user_id}/menu-access`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ menuItemIds: selectedMenuIds })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Failed to update menu access')
      }

      toast.current?.show({
        severity: 'success',
        summary: 'Success',
        detail: 'Menu access updated successfully',
        life: 3000
      })

      setShowMenuAccessDialog(false)
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to update menu access',
        life: 5000
      })
    }
  }

  const toggleMenuAccess = (menuItemId: number) => {
    setMenuAccess(prev => 
      prev.map(item => 
        item.menu_item_id === menuItemId 
          ? { ...item, has_access: !item.has_access }
          : item
      )
    )
  }

  const toggleAllInCategory = (categoryId: string, value: boolean) => {
    setMenuAccess(prev =>
      prev.map(item =>
        item.category_id === categoryId
          ? { ...item, has_access: value }
          : item
      )
    )
  }

  const roleTemplate = (rowData: User) => {
    return (
      <Badge 
        value={getRoleDisplayName(rowData.role as any)} 
        severity={
          rowData.role === 'admin' ? 'danger' :
          rowData.role === 'manager' ? 'warning' :
          rowData.role === 'finance' ? 'info' :
          'success'
        }
      />
    )
  }

  const statusTemplate = (rowData: User) => {
    return (
      <Badge 
        value={rowData.is_active ? 'Active' : 'Inactive'} 
        severity={rowData.is_active ? 'success' : 'secondary'}
      />
    )
  }

  const dateTemplate = (rowData: User, field: 'created_at' | 'last_login') => {
    const date = rowData[field]
    if (!date) return <span className={styles.noData}>Never</span>
    return new Date(date).toLocaleDateString()
  }

  const actionsTemplate = (rowData: User) => {
    const isCurrentUser = currentUser?.userId === rowData.user_id
    const isAdmin = rowData.role === 'admin' && currentUser?.role !== 'admin'

    return (
      <div className={styles.actionButtons}>
        <Button
          icon="pi pi-pencil"
          rounded
          text
          severity="secondary"
          onClick={() => handleEdit(rowData)}
          tooltip="Edit User"
          tooltipOptions={{ position: 'top' }}
        />
        <Button
          icon="pi pi-key"
          rounded
          text
          severity="info"
          onClick={() => handleManageAccess(rowData)}
          tooltip="Manage Menu Access"
          tooltipOptions={{ position: 'top' }}
        />
        <Button
          icon="pi pi-trash"
          rounded
          text
          severity="danger"
          onClick={() => handleDelete(rowData)}
          disabled={isCurrentUser || isAdmin}
          tooltip={isCurrentUser ? "Cannot delete yourself" : isAdmin ? "Cannot delete admin" : "Delete User"}
          tooltipOptions={{ position: 'top' }}
        />
      </div>
    )
  }

  // Group menu access by category
  const groupedMenuAccess = menuAccess.reduce((acc, item) => {
    if (!acc[item.category_id]) {
      acc[item.category_id] = {
        categoryTitle: item.category_title,
        items: []
      }
    }
    acc[item.category_id].items.push(item)
    return acc
  }, {} as Record<string, { categoryTitle: string; items: MenuAccess[] }>)

  if (loading) {
    return (
      <div className={styles.page}>
        <Header />
        <div className={styles.loadingContainer}>
          <ProgressSpinner />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} position="top-right" />
      <ConfirmDialog />
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>User Registration & Management</h1>
            <p className={styles.subtitle}>
              Create, modify, and manage system users and their menu access permissions
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <PageNavigation />
            <Button
              label="Create New User"
              icon="pi pi-plus"
              onClick={handleCreate}
              className={styles.createButton}
            />
          </div>
        </div>

        {/* Role-wise Counts */}
        <div className={styles.roleMetricsContainer}>
          <div className={styles.roleMetricsHeader}>
            <h3 className={styles.roleMetricsTitle}>Users by Role</h3>
            <div className={styles.roleMetricsTotal}>
              <span className={styles.roleMetricsTotalLabel}>Total Roles:</span>
              <span className={styles.roleMetricsTotalValue}>{Object.keys(metrics.roleCounts).length}</span>
            </div>
          </div>
          <div className={styles.roleMetricsGrid}>
            {Object.entries(metrics.roleCounts).map(([role, count]) => (
              <div key={role} className={styles.roleMetricItem}>
                <div className={styles.roleMetricContent}>
                  <Badge 
                    value={getRoleDisplayName(role as any)} 
                    severity={
                      role === 'admin' ? 'danger' :
                      role === 'manager' ? 'warning' :
                      role === 'finance' ? 'info' :
                      'success'
                    }
                  />
                  <div className={styles.roleMetricDetails}>
                    <span className={styles.roleCount}>{count}</span>
                    <span className={styles.rolePercentage}>
                      {metrics.totalUsers > 0 
                        ? `${Math.round((count / metrics.totalUsers) * 100)}%`
                        : '0%'}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.tableContainer}>
          <div className={styles.tableHeader}>
            <div className={styles.tableSummary}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Total Users:</span>
                <span className={styles.summaryValue}>{metrics.totalUsers}</span>
              </div>
              <div className={styles.summaryDivider}></div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Active:</span>
                <span className={styles.summaryValue} style={{ color: '#059669' }}>{metrics.activeUsers}</span>
              </div>
              <div className={styles.summaryDivider}></div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Inactive:</span>
                <span className={styles.summaryValue} style={{ color: '#94a3b8' }}>{metrics.inactiveUsers}</span>
              </div>
            </div>
          </div>
          <DataTable
            value={users}
            paginator
            rows={10}
            rowsPerPageOptions={[10, 25, 50]}
            emptyMessage="No users found"
            className={styles.dataTable}
          >
            <Column field="username" header="Username" sortable style={{ minWidth: '150px' }} />
            <Column field="email" header="Email" sortable style={{ minWidth: '200px' }} />
            <Column field="full_name" header="Full Name" sortable style={{ minWidth: '180px' }} />
            <Column 
              field="role" 
              header="Role" 
              body={roleTemplate}
              sortable 
              style={{ minWidth: '120px' }} 
            />
            <Column 
              field="is_active" 
              header="Status" 
              body={statusTemplate}
              sortable 
              style={{ minWidth: '100px' }} 
            />
            <Column 
              field="last_login" 
              header="Last Login" 
              body={(row) => dateTemplate(row, 'last_login')}
              sortable 
              style={{ minWidth: '120px' }} 
            />
            <Column 
              field="created_at" 
              header="Created" 
              body={(row) => dateTemplate(row, 'created_at')}
              sortable 
              style={{ minWidth: '120px' }} 
            />
            <Column 
              header="Actions" 
              body={actionsTemplate}
              style={{ minWidth: '180px' }}
              frozen
              alignFrozen="right"
            />
          </DataTable>
        </div>
      </div>

      {/* User Create/Edit Dialog */}
      <Dialog
        header={isEditMode ? 'Edit User' : 'Create New User'}
        visible={showUserDialog}
        onHide={() => setShowUserDialog(false)}
        className={styles.userDialog}
        style={{ width: showMenuAccessInCreate ? '900px' : '600px', maxWidth: '95vw' }}
      >
        <div className={styles.dialogContent}>
          <div className={styles.formField}>
            <label htmlFor="username" className={styles.label}>
              Username <span className={styles.required}>*</span>
            </label>
            <InputText
              id="username"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              className={styles.input}
              placeholder="Enter username"
              required
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="email" className={styles.label}>
              Email <span className={styles.required}>*</span>
            </label>
            <InputText
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className={styles.input}
              placeholder="Enter email address"
              required
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="fullName" className={styles.label}>
              Full Name
            </label>
            <InputText
              id="fullName"
              value={formData.fullName}
              onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
              className={styles.input}
              placeholder="Enter full name"
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="role" className={styles.label}>
              Role <span className={styles.required}>*</span>
            </label>
            <Dropdown
              id="role"
              value={formData.role}
              options={ROLES}
              onChange={(e) => {
                setFormData({ ...formData, role: e.value })
                // When role changes in create mode, reset menu access
                if (!isEditMode && allMenuItems.length > 0) {
                  const resetMenuAccess = allMenuItems.map(item => ({
                    ...item,
                    has_access: false
                  }))
                  setMenuAccess(resetMenuAccess)
                }
              }}
              className={styles.input}
              placeholder="Select role"
            />
          </div>

          {(!isEditMode || showPassword) && (
            <div className={styles.formField}>
              <label htmlFor="password" className={styles.label}>
                Password {!isEditMode && <span className={styles.required}>*</span>}
                {isEditMode && <span className={styles.optional}>(leave blank to keep current)</span>}
              </label>
              <Password
                id="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                className={styles.input}
                placeholder="Enter password"
                feedback={false}
                toggleMask
              />
            </div>
          )}

          <div className={styles.formField}>
            <div className={styles.checkboxField}>
              <Checkbox
                inputId="isActive"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.checked ?? true })}
              />
              <label htmlFor="isActive" className={styles.checkboxLabel}>
                Active User
              </label>
            </div>
          </div>

          {!isEditMode && (
            <div className={styles.formField}>
              <div className={styles.menuAccessToggle}>
                <Button
                  label={showMenuAccessInCreate ? 'Hide Menu Access' : 'Configure Menu Access'}
                  icon={showMenuAccessInCreate ? 'pi pi-chevron-up' : 'pi pi-chevron-down'}
                  onClick={() => setShowMenuAccessInCreate(!showMenuAccessInCreate)}
                  outlined
                  className={styles.menuAccessToggleButton}
                />
              </div>
              {showMenuAccessInCreate && (
                <div className={styles.menuAccessSection}>
                  <p className={styles.menuAccessNote}>
                    Select menu items that this user can access. Access will be granted based on the selected role.
                  </p>
                  {Object.entries(groupedMenuAccess).map(([categoryId, category]) => (
                    <div key={categoryId} className={styles.menuCategory}>
                      <div className={styles.categoryHeader}>
                        <h4 className={styles.categoryTitle}>{category.categoryTitle}</h4>
                        <div className={styles.categoryActions}>
                          <Button
                            label="Select All"
                            size="small"
                            text
                            onClick={() => toggleAllInCategory(categoryId, true)}
                          />
                          <Button
                            label="Deselect All"
                            size="small"
                            text
                            onClick={() => toggleAllInCategory(categoryId, false)}
                          />
                        </div>
                      </div>
                      <div className={styles.menuItemsList}>
                        {category.items.map((item) => (
                          <div key={item.menu_item_id} className={styles.menuItemRow}>
                            <Checkbox
                              inputId={`create-menu-${item.menu_item_id}`}
                              checked={item.has_access}
                              onChange={() => toggleMenuAccess(item.menu_item_id)}
                            />
                            <label 
                              htmlFor={`create-menu-${item.menu_item_id}`}
                              className={styles.menuItemLabel}
                            >
                              <span className={styles.menuItemTitle}>{item.title}</span>
                              <span className={styles.menuItemPath}>{item.path}</span>
                            </label>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={styles.dialogActions}>
            <Button
              label="Cancel"
              icon="pi pi-times"
              onClick={() => setShowUserDialog(false)}
              outlined
            />
            <Button
              label={isEditMode ? 'Update' : 'Create'}
              icon={isEditMode ? 'pi pi-check' : 'pi pi-plus'}
              onClick={handleSaveUser}
            />
          </div>
        </div>
      </Dialog>

      {/* Menu Access Dialog */}
      <Dialog
        header={`Manage Menu Access - ${selectedUser?.username || ''}`}
        visible={showMenuAccessDialog}
        onHide={() => setShowMenuAccessDialog(false)}
        className={styles.menuAccessDialog}
        style={{ width: '800px', maxHeight: '90vh' }}
      >
        {loadingMenuAccess ? (
          <div className={styles.loadingContainer}>
            <ProgressSpinner />
          </div>
        ) : (
          <div className={styles.menuAccessContent}>
            <p className={styles.menuAccessNote}>
              Select menu items that <strong>{selectedUser?.username}</strong> (Role: <strong>{selectedUser?.role && getRoleDisplayName(selectedUser.role as any)}</strong>) can access.
            </p>
            
            {Object.entries(groupedMenuAccess).map(([categoryId, category]) => (
              <div key={categoryId} className={styles.menuCategory}>
                <div className={styles.categoryHeader}>
                  <h3 className={styles.categoryTitle}>{category.categoryTitle}</h3>
                  <div className={styles.categoryActions}>
                    <Button
                      label="Select All"
                      size="small"
                      text
                      onClick={() => toggleAllInCategory(categoryId, true)}
                    />
                    <Button
                      label="Deselect All"
                      size="small"
                      text
                      onClick={() => toggleAllInCategory(categoryId, false)}
                    />
                  </div>
                </div>
                <div className={styles.menuItemsList}>
                  {category.items.map((item) => (
                    <div key={item.menu_item_id} className={styles.menuItemRow}>
                      <Checkbox
                        inputId={`menu-${item.menu_item_id}`}
                        checked={item.has_access}
                        onChange={() => toggleMenuAccess(item.menu_item_id)}
                      />
                      <label 
                        htmlFor={`menu-${item.menu_item_id}`}
                        className={styles.menuItemLabel}
                      >
                        <span className={styles.menuItemTitle}>{item.title}</span>
                        <span className={styles.menuItemPath}>{item.path}</span>
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div className={styles.dialogActions}>
              <Button
                label="Cancel"
                icon="pi pi-times"
                onClick={() => setShowMenuAccessDialog(false)}
                outlined
              />
              <Button
                label="Save Access"
                icon="pi pi-check"
                onClick={handleSaveMenuAccess}
              />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}

export default UserRegistration
