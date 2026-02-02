import { useState, useEffect, useRef } from 'react'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { DataTable } from 'primereact/datatable'
import { Column } from 'primereact/column'
import { Button } from 'primereact/button'
import { Dialog } from 'primereact/dialog'
import { InputText } from 'primereact/inputtext'
import { Toast } from 'primereact/toast'
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl, getDisplayError } from '../utils/api'
import { isValidEmail } from '../utils/validation'
import styles from './SupplierRegistration.module.css'

interface Supplier {
  supplier_id: number
  supplier_name: string
  gst_number: string | null
  pan_number: string | null
  supplier_address: string | null
  city: string | null
  state_code: string | null
  state_name: string | null
  pincode: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  msme_number: string | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_ifsc_code: string | null
  bank_name: string | null
  branch_name: string | null
  website: string | null
  contact_person: string | null
  created_at?: string
  updated_at?: string
}

const emptySupplier: Omit<Supplier, 'supplier_id' | 'created_at' | 'updated_at'> & { supplier_id?: number } = {
  supplier_name: '',
  gst_number: '',
  pan_number: '',
  supplier_address: '',
  city: '',
  state_code: '',
  state_name: '',
  pincode: '',
  email: '',
  phone: '',
  mobile: '',
  msme_number: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_ifsc_code: '',
  bank_name: '',
  branch_name: '',
  website: '',
  contact_person: ''
}

function SupplierRegistration() {
  const toast = useRef<Toast>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formData, setFormData] = useState<typeof emptySupplier>({ ...emptySupplier })
  const [isEditMode, setIsEditMode] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  useEffect(() => {
    fetchSuppliers()
  }, [])

  const fetchSuppliers = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl('suppliers'), {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('Failed to fetch suppliers')
      const data = await response.json()
      setSuppliers(data)
    } catch (error: unknown) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: getDisplayError(error),
        life: 5000
      })
    } finally {
      setLoading(false)
    }
  }

  const handleAdd = () => {
    setIsEditMode(false)
    setEditingId(null)
    setFormData({ ...emptySupplier })
    setShowDialog(true)
  }

  const handleEdit = async (row: Supplier) => {
    try {
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl(`suppliers/by-id/${row.supplier_id}`), {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!response.ok) throw new Error('Failed to load supplier')
      const data = await response.json()
      setFormData({
        supplier_id: data.supplier_id,
        supplier_name: data.supplier_name ?? '',
        gst_number: data.gst_number ?? '',
        pan_number: data.pan_number ?? '',
        supplier_address: data.supplier_address ?? '',
        city: data.city ?? '',
        state_code: data.state_code ?? '',
        state_name: data.state_name ?? '',
        pincode: data.pincode ?? '',
        email: data.email ?? '',
        phone: data.phone ?? '',
        mobile: data.mobile ?? '',
        msme_number: data.msme_number ?? '',
        bank_account_name: data.bank_account_name ?? '',
        bank_account_number: data.bank_account_number ?? '',
        bank_ifsc_code: data.bank_ifsc_code ?? '',
        bank_name: data.bank_name ?? '',
        branch_name: data.branch_name ?? '',
        website: data.website ?? '',
        contact_person: data.contact_person ?? ''
      })
      setIsEditMode(true)
      setEditingId(row.supplier_id)
      setShowDialog(true)
    } catch (error: unknown) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: getDisplayError(error),
        life: 5000
      })
    }
  }

  const handleDelete = (row: Supplier) => {
    confirmDialog({
      message: `Are you sure you want to delete supplier "${row.supplier_name}"? This cannot be undone.`,
      header: 'Confirm Deletion',
      icon: 'pi pi-exclamation-triangle',
      accept: async () => {
        try {
          const token = localStorage.getItem('authToken')
          const response = await fetch(apiUrl(`suppliers/${row.supplier_id}`), {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
          })
          const errData = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(errData.message || 'Failed to delete supplier')
          toast.current?.show({
            severity: 'success',
            summary: 'Success',
            detail: 'Supplier deleted successfully',
            life: 3000
          })
          fetchSuppliers()
        } catch (error: any) {
          toast.current?.show({
            severity: 'error',
            summary: 'Error',
            detail: error.message || 'Failed to delete supplier',
            life: 5000
          })
        }
      }
    })
  }

  const handleSave = async () => {
    if (!formData.supplier_name?.trim()) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Validation',
        detail: 'Supplier name is required',
        life: 3000
      })
      return
    }
    if (formData.email?.trim() && !isValidEmail(formData.email)) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Validation',
        detail: 'Please enter a valid email address',
        life: 3000
      })
      return
    }
    try {
      setSaving(true)
      const token = localStorage.getItem('authToken')
      const url = isEditMode && editingId
        ? apiUrl(`suppliers/${editingId}`)
        : apiUrl('suppliers')
      const method = isEditMode ? 'PUT' : 'POST'
      const body = {
        supplier_name: formData.supplier_name.trim(),
        gst_number: formData.gst_number || null,
        pan_number: formData.pan_number || null,
        supplier_address: formData.supplier_address || null,
        city: formData.city || null,
        state_code: formData.state_code || null,
        state_name: formData.state_name || null,
        pincode: formData.pincode || null,
        email: formData.email || null,
        phone: formData.phone || null,
        mobile: formData.mobile || null,
        msme_number: formData.msme_number || null,
        bank_account_name: formData.bank_account_name || null,
        bank_account_number: formData.bank_account_number || null,
        bank_ifsc_code: formData.bank_ifsc_code || null,
        bank_name: formData.bank_name || null,
        branch_name: formData.branch_name || null,
        website: formData.website || null,
        contact_person: formData.contact_person || null
      }
      let response: Response
      try {
        response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(body)
        })
      } catch (fetchErr) {
        throw new Error(getDisplayError(fetchErr))
      }
      const errData = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(errData.message || (method === 'POST' ? 'Failed to create supplier' : 'Failed to update supplier'))
      toast.current?.show({
        severity: 'success',
        summary: 'Success',
        detail: isEditMode ? 'Supplier updated successfully' : 'Supplier created successfully',
        life: 3000
      })
      setShowDialog(false)
      fetchSuppliers()
    } catch (error: unknown) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: getDisplayError(error),
        life: 5000
      })
    } finally {
      setSaving(false)
    }
  }

  const handleInputChange = (field: keyof typeof formData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const actionsBody = (row: Supplier) => (
    <div className={styles.actionsCell}>
      <Button
        icon="pi pi-pencil"
        rounded
        text
        severity="secondary"
        size="small"
        onClick={() => handleEdit(row)}
        aria-label="Edit"
      />
      <Button
        icon="pi pi-trash"
        rounded
        text
        severity="danger"
        size="small"
        onClick={() => handleDelete(row)}
        aria-label="Delete"
      />
    </div>
  )

  const dialogFooter = (
    <div className={styles.dialogFooter}>
      <Button label="Cancel" icon="pi pi-times" outlined onClick={() => setShowDialog(false)} disabled={saving} />
      <Button label={isEditMode ? 'Update' : 'Add'} icon="pi pi-check" onClick={handleSave} loading={saving} disabled={saving} />
    </div>
  )

  if (loading) {
    return (
      <div className={styles.page}>
        <Header />
        <Toast ref={toast} position="top-right" />
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
            <h1 className={styles.title}>Suppliers</h1>
            <p className={styles.subtitle}>Manage supplier records</p>
          </div>
          <div className={styles.headerActions}>
            <PageNavigation onRefresh={fetchSuppliers} refreshLoading={loading} />
            <Button
              label="Add Supplier"
              icon="pi pi-plus"
              className={styles.addButton}
              onClick={handleAdd}
            />
          </div>
        </div>

        <div className="dts-section dts-section-accent">
          <h2 className="dts-sectionTitle">Suppliers</h2>
          <p className="dts-sectionSubtitle">Manage supplier records. Add, edit, or remove suppliers.</p>
          <div className="dts-tableWrapper">
            <div className="dts-tableContainer">
              <DataTable
                value={suppliers}
                dataKey="supplier_id"
                paginator
                rows={10}
                rowsPerPageOptions={[5, 10, 25, 50]}
                emptyMessage="No suppliers found. Add one to get started."
                stripedRows
              >
                <Column field="supplier_name" header="Supplier Name" sortable style={{ minWidth: '180px' }} />
                <Column field="gst_number" header="GST Number" sortable style={{ minWidth: '140px' }} />
                <Column field="city" header="City" sortable style={{ minWidth: '120px' }} />
                <Column field="email" header="Email" sortable style={{ minWidth: '180px' }} />
                <Column field="contact_person" header="Contact Person" sortable style={{ minWidth: '140px' }} />
                <Column header="Actions" body={actionsBody} style={{ width: '120px' }} />
              </DataTable>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        header={isEditMode ? 'Edit Supplier' : 'Add Supplier'}
        visible={showDialog}
        onHide={() => !saving && setShowDialog(false)}
        footer={dialogFooter}
        className={styles.dialog}
        style={{ width: '90vw', maxWidth: '720px' }}
        blockScroll
      >
        <div className={styles.formSections}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}><i className="pi pi-building" /> Basic Information</h3>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label className={styles.label}>Supplier Name <span className={styles.required}>*</span></label>
                <InputText
                  value={formData.supplier_name}
                  onChange={e => handleInputChange('supplier_name', e.target.value)}
                  className={styles.input}
                  placeholder="Enter supplier name"
                />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>GST Number</label>
                <InputText value={formData.gst_number} onChange={e => handleInputChange('gst_number', e.target.value)} className={styles.input} placeholder="GST number" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>PAN Number</label>
                <InputText value={formData.pan_number} onChange={e => handleInputChange('pan_number', e.target.value)} className={styles.input} placeholder="PAN number" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>MSME Number</label>
                <InputText value={formData.msme_number} onChange={e => handleInputChange('msme_number', e.target.value)} className={styles.input} placeholder="MSME number" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Website</label>
                <InputText value={formData.website} onChange={e => handleInputChange('website', e.target.value)} className={styles.input} placeholder="Website URL" />
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}><i className="pi pi-map-marker" /> Address</h3>
            <div className={styles.formGrid}>
              <div className={styles.formFieldFull}>
                <label className={styles.label}>Address</label>
                <InputText value={formData.supplier_address} onChange={e => handleInputChange('supplier_address', e.target.value)} className={styles.input} placeholder="Full address" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>City</label>
                <InputText value={formData.city} onChange={e => handleInputChange('city', e.target.value)} className={styles.input} placeholder="City" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>State Code</label>
                <InputText value={formData.state_code} onChange={e => handleInputChange('state_code', e.target.value)} className={styles.input} placeholder="State code" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>State Name</label>
                <InputText value={formData.state_name} onChange={e => handleInputChange('state_name', e.target.value)} className={styles.input} placeholder="State name" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Pincode</label>
                <InputText value={formData.pincode} onChange={e => handleInputChange('pincode', e.target.value)} className={styles.input} placeholder="Pincode" />
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}><i className="pi pi-phone" /> Contact</h3>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label className={styles.label}>Email</label>
                <InputText type="email" value={formData.email} onChange={e => handleInputChange('email', e.target.value)} className={styles.input} placeholder="Email" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Phone</label>
                <InputText value={formData.phone} onChange={e => handleInputChange('phone', e.target.value)} className={styles.input} placeholder="Phone" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Mobile</label>
                <InputText value={formData.mobile} onChange={e => handleInputChange('mobile', e.target.value)} className={styles.input} placeholder="Mobile" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Contact Person</label>
                <InputText value={formData.contact_person} onChange={e => handleInputChange('contact_person', e.target.value)} className={styles.input} placeholder="Contact person" />
              </div>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}><i className="pi pi-wallet" /> Bank Details</h3>
            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label className={styles.label}>Account Name</label>
                <InputText value={formData.bank_account_name} onChange={e => handleInputChange('bank_account_name', e.target.value)} className={styles.input} placeholder="Account name" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Account Number</label>
                <InputText value={formData.bank_account_number} onChange={e => handleInputChange('bank_account_number', e.target.value)} className={styles.input} placeholder="Account number" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>IFSC Code</label>
                <InputText value={formData.bank_ifsc_code} onChange={e => handleInputChange('bank_ifsc_code', e.target.value)} className={styles.input} placeholder="IFSC code" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Bank Name</label>
                <InputText value={formData.bank_name} onChange={e => handleInputChange('bank_name', e.target.value)} className={styles.input} placeholder="Bank name" />
              </div>
              <div className={styles.formField}>
                <label className={styles.label}>Branch Name</label>
                <InputText value={formData.branch_name} onChange={e => handleInputChange('branch_name', e.target.value)} className={styles.input} placeholder="Branch name" />
              </div>
            </div>
          </section>
        </div>
      </Dialog>
    </div>
  )
}

export default SupplierRegistration
