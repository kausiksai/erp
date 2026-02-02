import { useState, useEffect, useRef } from 'react'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import { Button } from 'primereact/button'
import { InputText } from 'primereact/inputtext'
import { Toast } from 'primereact/toast'
import { ProgressSpinner } from 'primereact/progressspinner'
import { apiUrl } from '../utils/api'
import styles from './OwnerDetails.module.css'

interface OwnerDetails {
  owner_id: number | null
  owner_name: string
  gst_number: string
  pan_number: string
  owner_address: string
  city: string
  state_code: string
  state_name: string
  pincode: string
  email: string
  phone: string
  mobile: string
  msme_number: string
  cin_number: string
  bank_account_name: string
  bank_account_number: string
  bank_ifsc_code: string
  bank_name: string
  branch_name: string
  website: string
  contact_person: string
}

function OwnerDetails() {
  const toast = useRef<Toast>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [editingSection, setEditingSection] = useState<string | null>(null)
  const [ownerDetails, setOwnerDetails] = useState<OwnerDetails>({
    owner_id: null,
    owner_name: '',
    gst_number: '',
    pan_number: '',
    owner_address: '',
    city: '',
    state_code: '',
    state_name: '',
    pincode: '',
    email: '',
    phone: '',
    mobile: '',
    msme_number: '',
    cin_number: '',
    bank_account_name: '',
    bank_account_number: '',
    bank_ifsc_code: '',
    bank_name: '',
    branch_name: '',
    website: '',
    contact_person: ''
  })

  useEffect(() => {
    fetchOwnerDetails()
  }, [])

  const fetchOwnerDetails = async () => {
    try {
      setLoading(true)
      const token = localStorage.getItem('authToken')
      
      if (!token) {
        throw new Error('No authentication token found')
      }

      const url = apiUrl('owners')
      console.log('Fetching owner details from:', url)
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })

      console.log('Response status:', response.status)

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('API Error:', errorData)
        throw new Error(errorData.message || `Failed to fetch owner details: ${response.status}`)
      }

      const data = await response.json()
      console.log('Owner details received:', data)
      setOwnerDetails(data)
      setOriginalDetails(data)
    } catch (error: any) {
      console.error('Error fetching owner details:', error)
      // Show error toast
      if (toast.current) {
        toast.current.show({
          severity: 'error',
          summary: 'Error',
          detail: error.message || 'Failed to load owner details. Please check console for details.',
          life: 5000
        })
      }
      // Keep ownerDetails in default state (empty) so page can still render
    } finally {
      setLoading(false)
    }
  }

  const [originalDetails, setOriginalDetails] = useState<OwnerDetails | null>(null)

  const handleEdit = (section: string) => {
    setEditingSection(section)
    setOriginalDetails({ ...ownerDetails })
  }

  const handleCancel = (section: string) => {
    setEditingSection(null)
    if (originalDetails) {
      setOwnerDetails(originalDetails)
    }
    setOriginalDetails(null)
  }

  const handleSave = async (section: string) => {
    try {
      if (!ownerDetails.owner_id) {
        toast.current?.show({
          severity: 'warn',
          summary: 'Cannot Save',
          detail: 'Owner details do not exist. Please contact your system administrator to set up owner details.',
          life: 5000
        })
        return
      }

      if (section === 'basic' && !ownerDetails.owner_name) {
        toast.current?.show({
          severity: 'warn',
          summary: 'Validation Error',
          detail: 'Owner name is required',
          life: 3000
        })
        return
      }

      setSaving(section)
      const token = localStorage.getItem('authToken')
      const response = await fetch(apiUrl(`owners/${ownerDetails.owner_id}`), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(ownerDetails)
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.message || 'Failed to update owner details')
      }

      const updated = await response.json()
      setOwnerDetails(updated)
      setEditingSection(null)
      setOriginalDetails(null)

      toast.current?.show({
        severity: 'success',
        summary: 'Success',
        detail: 'Section updated successfully',
        life: 3000
      })
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: error.message || 'Failed to update owner details',
        life: 5000
      })
    } finally {
      setSaving(null)
    }
  }

  const handleInputChange = (field: keyof OwnerDetails, value: string) => {
    setOwnerDetails(prev => ({
      ...prev,
      [field]: value
    }))
  }

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

  const hasOwner = ownerDetails.owner_id !== null

  return (
    <div className={styles.page}>
      <Header />
      <Toast ref={toast} position="top-right" />
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.title}>Owner Details</h1>
            <p className={styles.subtitle}>Company owner information</p>
          </div>
          <PageNavigation onRefresh={fetchOwnerDetails} refreshLoading={loading} />
        </div>

        {!hasOwner ? (
          <EmptyState
            icon="pi pi-info-circle"
            title="No owner details"
            description="Owner details have not been set up yet. Contact your system administrator."
          />
        ) : (
          <div className={styles.sectionsContainer}>
            {/* Top Row: Basic Information and Bank Details */}
            <div className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  <i className="pi pi-building"></i>
                  Basic Information
                </h2>
                {editingSection !== 'basic' ? (
                  <Button
                    icon="pi pi-pencil"
                    onClick={() => handleEdit('basic')}
                    className={styles.editIconButton}
                    rounded
                    text
                    severity="secondary"
                    aria-label="Edit section"
                  />
                ) : (
                  <div className={styles.sectionActions}>
                    <Button
                      label="Cancel"
                      icon="pi pi-times"
                      onClick={() => handleCancel('basic')}
                      outlined
                      disabled={saving === 'basic'}
                      size="small"
                    />
                    <Button
                      label="Save"
                      icon="pi pi-check"
                      onClick={() => handleSave('basic')}
                      loading={saving === 'basic'}
                      size="small"
                      className="btnPrimary"
                    />
                  </div>
                )}
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label className={styles.label}>
                    Owner Name <span className={styles.required}>*</span>
                  </label>
                  <InputText
                    value={ownerDetails.owner_name}
                    onChange={(e) => handleInputChange('owner_name', e.target.value)}
                    disabled={editingSection !== 'basic'}
                    className={styles.input}
                    placeholder="Enter owner/company name"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>GST Number</label>
                  <InputText
                    value={ownerDetails.gst_number}
                    onChange={(e) => handleInputChange('gst_number', e.target.value)}
                    disabled={editingSection !== 'basic'}
                    className={styles.input}
                    placeholder="Enter GST number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>PAN Number</label>
                  <InputText
                    value={ownerDetails.pan_number}
                    onChange={(e) => handleInputChange('pan_number', e.target.value)}
                    disabled={editingSection !== 'basic'}
                    className={styles.input}
                    placeholder="Enter PAN number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>CIN Number</label>
                  <InputText
                    value={ownerDetails.cin_number}
                    onChange={(e) => handleInputChange('cin_number', e.target.value)}
                    disabled={editingSection !== 'basic'}
                    className={styles.input}
                    placeholder="Enter CIN number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>MSME Number</label>
                  <InputText
                    value={ownerDetails.msme_number}
                    onChange={(e) => handleInputChange('msme_number', e.target.value)}
                    disabled={editingSection !== 'basic'}
                    className={styles.input}
                    placeholder="Enter MSME number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Website</label>
                  <InputText
                    value={ownerDetails.website}
                    onChange={(e) => handleInputChange('website', e.target.value)}
                    disabled={editingSection !== 'basic'}
                    className={styles.input}
                    placeholder="Enter website URL"
                  />
                </div>
              </div>
            </div>

            <div className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  <i className="pi pi-wallet"></i>
                  Bank Details
                </h2>
                {editingSection !== 'bank' ? (
                  <Button
                    icon="pi pi-pencil"
                    onClick={() => handleEdit('bank')}
                    className={styles.editIconButton}
                    rounded
                    text
                    severity="secondary"
                    aria-label="Edit section"
                  />
                ) : (
                  <div className={styles.sectionActions}>
                    <Button
                      label="Cancel"
                      icon="pi pi-times"
                      onClick={() => handleCancel('bank')}
                      outlined
                      disabled={saving === 'bank'}
                      size="small"
                    />
                    <Button
                      label="Save"
                      icon="pi pi-check"
                      onClick={() => handleSave('bank')}
                      loading={saving === 'bank'}
                      size="small"
                    />
                  </div>
                )}
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label className={styles.label}>Account Name</label>
                  <InputText
                    value={ownerDetails.bank_account_name}
                    onChange={(e) => handleInputChange('bank_account_name', e.target.value)}
                    disabled={editingSection !== 'bank'}
                    className={styles.input}
                    placeholder="Enter bank account name"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Account Number</label>
                  <InputText
                    value={ownerDetails.bank_account_number}
                    onChange={(e) => handleInputChange('bank_account_number', e.target.value)}
                    disabled={editingSection !== 'bank'}
                    className={styles.input}
                    placeholder="Enter bank account number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>IFSC Code</label>
                  <InputText
                    value={ownerDetails.bank_ifsc_code}
                    onChange={(e) => handleInputChange('bank_ifsc_code', e.target.value)}
                    disabled={editingSection !== 'bank'}
                    className={styles.input}
                    placeholder="Enter IFSC code"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Bank Name</label>
                  <InputText
                    value={ownerDetails.bank_name}
                    onChange={(e) => handleInputChange('bank_name', e.target.value)}
                    disabled={editingSection !== 'bank'}
                    className={styles.input}
                    placeholder="Enter bank name"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Branch Name</label>
                  <InputText
                    value={ownerDetails.branch_name}
                    onChange={(e) => handleInputChange('branch_name', e.target.value)}
                    disabled={editingSection !== 'bank'}
                    className={styles.input}
                    placeholder="Enter branch name"
                  />
                </div>
              </div>
            </div>

            {/* Bottom Row: Address Information and Contact Information */}
            <div className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  <i className="pi pi-map-marker"></i>
                  Address Information
                </h2>
                {editingSection !== 'address' ? (
                  <Button
                    icon="pi pi-pencil"
                    onClick={() => handleEdit('address')}
                    className={styles.editIconButton}
                    rounded
                    text
                    severity="secondary"
                    aria-label="Edit section"
                  />
                ) : (
                  <div className={styles.sectionActions}>
                    <Button
                      label="Cancel"
                      icon="pi pi-times"
                      onClick={() => handleCancel('address')}
                      outlined
                      disabled={saving === 'address'}
                      size="small"
                    />
                    <Button
                      label="Save"
                      icon="pi pi-check"
                      onClick={() => handleSave('address')}
                      loading={saving === 'address'}
                      size="small"
                      className="btnPrimary"
                    />
                  </div>
                )}
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formFieldFull}>
                  <label className={styles.label}>Address</label>
                  <InputText
                    value={ownerDetails.owner_address}
                    onChange={(e) => handleInputChange('owner_address', e.target.value)}
                    disabled={editingSection !== 'address'}
                    className={styles.input}
                    placeholder="Enter address"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>City</label>
                  <InputText
                    value={ownerDetails.city}
                    onChange={(e) => handleInputChange('city', e.target.value)}
                    disabled={editingSection !== 'address'}
                    className={styles.input}
                    placeholder="Enter city"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>State Code</label>
                  <InputText
                    value={ownerDetails.state_code}
                    onChange={(e) => handleInputChange('state_code', e.target.value)}
                    disabled={editingSection !== 'address'}
                    className={styles.input}
                    placeholder="Enter state code"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>State Name</label>
                  <InputText
                    value={ownerDetails.state_name}
                    onChange={(e) => handleInputChange('state_name', e.target.value)}
                    disabled={editingSection !== 'address'}
                    className={styles.input}
                    placeholder="Enter state name"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Pincode</label>
                  <InputText
                    value={ownerDetails.pincode}
                    onChange={(e) => handleInputChange('pincode', e.target.value)}
                    disabled={editingSection !== 'address'}
                    className={styles.input}
                    placeholder="Enter pincode"
                  />
                </div>
              </div>
            </div>

            <div className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>
                  <i className="pi pi-phone"></i>
                  Contact Information
                </h2>
                {editingSection !== 'contact' ? (
                  <Button
                    icon="pi pi-pencil"
                    onClick={() => handleEdit('contact')}
                    className={styles.editIconButton}
                    rounded
                    text
                    severity="secondary"
                    aria-label="Edit section"
                  />
                ) : (
                  <div className={styles.sectionActions}>
                    <Button
                      label="Cancel"
                      icon="pi pi-times"
                      onClick={() => handleCancel('contact')}
                      outlined
                      disabled={saving === 'contact'}
                      size="small"
                    />
                    <Button
                      label="Save"
                      icon="pi pi-check"
                      onClick={() => handleSave('contact')}
                      loading={saving === 'contact'}
                      size="small"
                      className="btnPrimary"
                    />
                  </div>
                )}
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label className={styles.label}>Email</label>
                  <InputText
                    type="email"
                    value={ownerDetails.email}
                    onChange={(e) => handleInputChange('email', e.target.value)}
                    disabled={editingSection !== 'contact'}
                    className={styles.input}
                    placeholder="Enter email address"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Phone</label>
                  <InputText
                    value={ownerDetails.phone}
                    onChange={(e) => handleInputChange('phone', e.target.value)}
                    disabled={editingSection !== 'contact'}
                    className={styles.input}
                    placeholder="Enter phone number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Mobile</label>
                  <InputText
                    value={ownerDetails.mobile}
                    onChange={(e) => handleInputChange('mobile', e.target.value)}
                    disabled={editingSection !== 'contact'}
                    className={styles.input}
                    placeholder="Enter mobile number"
                  />
                </div>

                <div className={styles.formField}>
                  <label className={styles.label}>Contact Person</label>
                  <InputText
                    value={ownerDetails.contact_person}
                    onChange={(e) => handleInputChange('contact_person', e.target.value)}
                    disabled={editingSection !== 'contact'}
                    className={styles.input}
                    placeholder="Enter contact person name"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default OwnerDetails
