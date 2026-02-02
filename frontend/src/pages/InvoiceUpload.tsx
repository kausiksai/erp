import { useState, useRef, useCallback, useEffect } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { InputText } from 'primereact/inputtext'
import { InputTextarea } from 'primereact/inputtextarea'
import { Calendar } from 'primereact/calendar'
import { InputNumber } from 'primereact/inputnumber'
import { Toast } from 'primereact/toast'
import { Button } from 'primereact/button'
import { ProgressSpinner } from 'primereact/progressspinner'
import { Divider } from 'primereact/divider'
import { Dialog } from 'primereact/dialog'
import { ConfirmDialog, confirmDialog } from 'primereact/confirmdialog'
import { FileUpload } from 'primereact/fileupload'
import { apiUrl } from '../utils/api'
import Header from '../components/Header'
import PageNavigation from '../components/PageNavigation'
import styles from './InvoiceUpload.module.css'
import 'react-pdf/dist/esm/Page/AnnotationLayer.css'
import 'react-pdf/dist/esm/Page/TextLayer.css'

// Set up PDF.js worker for react-pdf
// react-pdf v9.2.1 uses pdfjs-dist@4.8.69 internally
// Using jsdelivr CDN with exact version that react-pdf uses
// jsdelivr is more reliable than cdnjs and has better CORS support
pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs'

// Fallback options if CDN doesn't work (uncomment to use):
// Option 1: Use local file from public folder
// pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
// Option 2: Use unpkg CDN
// pdfjs.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs'

interface InvoiceItem {
  itemName: string
  quantity: number | null
  /** Quantity/weight from invoice OCR (read-only display in "Invoice weight/Quantity" column) */
  invoiceQuantity: number | null
  weight: number | null
  count: number | null
  unitPrice: number | null
  lineTotal: number | null
  itemCode?: string
  hsnSac?: string
  taxableValue?: number | null
  cgstRate?: number | null
  cgstAmount?: number | null
  sgstRate?: number | null
  sgstAmount?: number | null
  totalTaxAmount?: number | null
}

interface PurchaseOrder {
  po_id: number
  po_number: string
  po_date: string
  supplier_id?: number
  supplier_name: string
  bill_to: string
  subtotal: number | null
  cgst: number | null
  sgst: number | null
  tax_amount: number | null
  total_amount: number | null
  terms_and_conditions: string
  items: Array<{
    po_line_id: number
    item_code?: string
    item_name: string
    hsn_sac: string
    /** PO line quantity from purchase_order_lines.qty */
    qty?: number | null
    quantity?: number | null
    unit_price: number | null
    line_total: number | null
    taxable_value: number | null
    cgst_rate: number | null
    cgst_amount: number | null
    sgst_rate: number | null
    sgst_amount: number | null
    total_tax_amount: number | null
    sequence_number?: number
  }>
}

interface InvoiceData {
  // Header Fields
  invoiceNumber: string
  invoiceDate: Date | null
  scanningNumber: string
  poNumber: string
  supplierName: string
  billTo: string
  
  // Financial Summary
  subtotal: number | null
  cgst: number | null
  sgst: number | null
  taxAmount: number | null
  roundOff: number | null
  totalAmount: number | null
  totalAmountInWords: string
  
  // Misc/Footer
  termsAndConditions: string
  authorisedSignatory: string
  receiverSignature: string
  
  // Line Items
  items: InvoiceItem[]
}

export default function InvoiceUpload() {
  const [poNumber, setPoNumber] = useState<string>('')
  const [poNumberInput, setPoNumberInput] = useState<string>('')
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrder | null>(null)
  const [loadingPO, setLoadingPO] = useState<boolean>(false)
  const [poValidated, setPoValidated] = useState<boolean>(true) // Start directly in upload mode
  
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [numPages, setNumPages] = useState<number>(0)
  const [pageNumber, setPageNumber] = useState<number>(1)
  const [loading, setLoading] = useState<boolean>(false)
  const [extracting, setExtracting] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  
  // Validation states
  const [validating, setValidating] = useState<boolean>(false)
  const [validationDialogVisible, setValidationDialogVisible] = useState<boolean>(false)
  const [validationResults, setValidationResults] = useState<any>(null)
  const [validationConfirmed, setValidationConfirmed] = useState<boolean>(false)
  const [supplierDetails, setSupplierDetails] = useState<any>(null)
  
  // Weight slip scanning state
  const [weightSlipDialogVisible, setWeightSlipDialogVisible] = useState<boolean>(false)
  const [currentItemIndex, setCurrentItemIndex] = useState<number>(-1)
  const [weightSlipFile, setWeightSlipFile] = useState<File | null>(null)
  const [extractingWeight, setExtractingWeight] = useState<boolean>(false)
  
  const [invoiceData, setInvoiceData] = useState<InvoiceData>({
    // Header Fields
    invoiceNumber: '',
    invoiceDate: null,
    scanningNumber: '',
    poNumber: '',
    supplierName: '',
    billTo: '',
    
    // Financial Summary
    subtotal: null,
    cgst: null,
    sgst: null,
    taxAmount: null,
    roundOff: null,
    totalAmount: null,
    totalAmountInWords: '',
    
    // Misc/Footer
    termsAndConditions: '',
    authorisedSignatory: '',
    receiverSignature: '',
    
    // Line Items
    items: []
  })
  const [invoiceId, setInvoiceId] = useState<number | null>(null)
  const [pdfBuffer, setPdfBuffer] = useState<string | null>(null) // Store PDF as base64 for saving
  const [pdfFileName, setPdfFileName] = useState<string | null>(null)
  const toast = useRef<Toast>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const documentPreviewRef = useRef<HTMLDivElement>(null)
  const invoiceInfoRef = useRef<HTMLDivElement>(null)

  const api = useCallback((path: string) => {
    return apiUrl(path)
  }, [])

  // Generate unique alphanumeric scanning number
  const generateScanningNumber = useCallback(() => {
    const timestamp = Date.now().toString(36).toUpperCase()
    const random = Math.random().toString(36).substring(2, 8).toUpperCase()
    return `SCN-${timestamp}-${random}`
  }, [])

  // Fetch purchase order by number
  const fetchPurchaseOrder = useCallback(async (poNum: string) => {
    if (!poNum.trim()) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Validation Error',
        detail: 'Please enter a purchase order number',
        life: 3000
      })
      return false
    }

    setLoadingPO(true)
    try {
      const response = await fetch(api(`purchase-orders/${encodeURIComponent(poNum.trim())}`))
      
      if (!response.ok) {
        if (response.status === 404) {
          toast.current?.show({
            severity: 'error',
            summary: 'Purchase Order Not Found',
            detail: `Purchase order number "${poNum}" does not exist in the system`,
            life: 5000
          })
          return false
        }
        throw new Error('Failed to fetch purchase order')
      }

      const poData = await response.json()
      
      // Validate PO data structure
      if (!poData || !poData.po_id) {
        throw new Error('Invalid purchase order data received')
      }
      
      // Safely map PO items
      const poItems = Array.isArray(poData.items) ? poData.items : []
      
      try {
        // Populate invoice data from purchase order (non-editable)
        const updatedInvoiceData = {
          invoiceNumber: '',
          invoiceDate: null,
          scanningNumber: generateScanningNumber(), // Generate unique scanning number
          poNumber: poNum.trim(),
          supplierName: poData.supplier_name || '',
          billTo: poData.bill_to || '',
          subtotal: poData.subtotal || null,
          cgst: poData.cgst || null,
          sgst: poData.sgst || null,
          taxAmount: poData.tax_amount || null,
          roundOff: null,
          totalAmount: poData.total_amount || null,
          totalAmountInWords: '',
          termsAndConditions: poData.terms_and_conditions || '',
          authorisedSignatory: '',
          receiverSignature: '',
          items: poItems.map((item: any) => ({
            itemName: item?.item_name || '',
            itemCode: item?.item_code || '',
            hsnSac: item?.hsn_sac || '',
            quantity: item?.quantity || null,
            invoiceQuantity: null, // From invoice OCR only; PO load has no OCR
            unitPrice: null, // PO items don't have unit price
            lineTotal: null, // PO items don't have line total
            taxableValue: null, // PO items don't have taxable value
            cgstRate: null, // PO items don't have tax rates
            cgstAmount: null, // PO items don't have tax amounts
            sgstRate: null,
            sgstAmount: null,
            totalTaxAmount: null
          }))
        }
        
        // Update all states together
        setPurchaseOrder(poData)
        setPoNumber(poNum.trim())
        setInvoiceData(updatedInvoiceData)
        setPoValidated(true)
      } catch (stateError: any) {
        throw new Error(`Failed to process PO data: ${stateError.message}`)
      }

      toast.current?.show({
        severity: 'success',
        summary: 'Purchase Order Found',
        detail: `Purchase order ${poNum} loaded successfully`,
        life: 3000
      })
      return true
    } catch (err: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Error',
        detail: err.message || 'Failed to fetch purchase order',
        life: 5000
      })
      return false
    } finally {
      setLoadingPO(false)
    }
  }, [api])

  // Fetch PO by number and return data only (does not update invoiceData). Use when resolving PO for edited poNumber.
  const fetchPOByNumber = useCallback(async (poNum: string): Promise<PurchaseOrder | null> => {
    const trimmed = poNum?.trim()
    if (!trimmed) return null
    try {
      const response = await fetch(api(`purchase-orders/${encodeURIComponent(trimmed)}`))
      if (!response.ok) return null
      const poData = await response.json()
      if (!poData?.po_id) return null
      return poData as PurchaseOrder
    } catch {
      return null
    }
  }, [api])

  const handlePoNumberSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault()
    await fetchPurchaseOrder(poNumberInput)
  }, [poNumberInput, fetchPurchaseOrder])

  const handleResetPO = useCallback(() => {
    setPoNumber('')
    setPoNumberInput('')
    setPurchaseOrder(null)
    setPoValidated(false)
    setInvoiceData({
      invoiceNumber: '',
      invoiceDate: null,
      scanningNumber: '',
      poNumber: '',
      supplierName: '',
      billTo: '',
      subtotal: null,
      cgst: null,
      sgst: null,
      taxAmount: null,
      roundOff: null,
      totalAmount: null,
      totalAmountInWords: '',
      termsAndConditions: '',
      authorisedSignatory: '',
      receiverSignature: '',
      items: []
    })
    setPdfFile(null)
    setPdfUrl(null)
    setInvoiceId(null)
  }, [])


  // Match heights of Document Preview and Invoice Information panels
  useEffect(() => {
    const matchHeights = () => {
      if (documentPreviewRef.current && invoiceInfoRef.current) {
        const previewHeight = documentPreviewRef.current.offsetHeight
        const infoHeight = invoiceInfoRef.current.offsetHeight
        const maxHeight = Math.max(previewHeight, infoHeight)
        
        // Set both panels to the same height
        documentPreviewRef.current.style.height = `${maxHeight}px`
        invoiceInfoRef.current.style.height = `${maxHeight}px`
      }
    }

    // Match heights on mount and when content changes
    matchHeights()
    
    // Use ResizeObserver to watch for content changes
    const resizeObserver = new ResizeObserver(() => {
      matchHeights()
    })

    if (documentPreviewRef.current) {
      resizeObserver.observe(documentPreviewRef.current)
    }
    if (invoiceInfoRef.current) {
      resizeObserver.observe(invoiceInfoRef.current)
    }

    // Also match on window resize
    window.addEventListener('resize', matchHeights)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', matchHeights)
    }
  }, [invoiceData, pdfFile])


  const handleFileSelect = useCallback(async (file: File) => {
    if (file && file.type === 'application/pdf') {
      setPdfFile(file)
      const url = URL.createObjectURL(file)
      setPdfUrl(url)
      setPageNumber(1)
      setExtracting(true)
      
      // Generate unique scanning number for this scan
      const scanningNum = generateScanningNumber()
      setInvoiceData(prev => ({ ...prev, scanningNumber: scanningNum }))
      
      // Show loading message
      toast.current?.show({
        severity: 'info',
        summary: 'Uploading & Extracting',
        detail: 'Uploading PDF and extracting data with Qwen...',
        life: 3000
      })
      
      try {
        // Upload PDF and extract data
        const formData = new FormData()
        formData.append('pdf', file)
        if (invoiceData.poNumber) {
          formData.append('poNumber', invoiceData.poNumber)
        }

        const response = await fetch(api('/invoices/upload'), {
          method: 'POST',
          body: formData
        })

        if (!response.ok) {
          const error = await response.json().catch(() => ({}))
          throw new Error(error.message || 'Failed to upload invoice')
        }

        const result = await response.json()
        if (!result.invoiceData) {
          throw new Error('Invalid response: invoiceData not found')
        }
        
        const extracted = result.invoiceData

        // Parse dates
        const parseDate = (dateStr: any): Date | null => {
          if (!dateStr) return null
          if (typeof dateStr === 'string') {
            const parsed = new Date(dateStr)
            return isNaN(parsed.getTime()) ? null : parsed
          }
          if (dateStr instanceof Date) return dateStr
          return null
        }

        // Parse numeric values
        const parseNumeric = (value: any): number | null => {
          if (value === null || value === undefined || value === '') return null
          const parsed = typeof value === 'string' ? parseFloat(value.replace(/[₹$,€]/g, '').trim()) : parseFloat(value)
          return isNaN(parsed) ? null : parsed
        }

        const invoiceDataUpdate: InvoiceData = {
          // Header Fields
          invoiceNumber: extracted.invoiceNumber || '',
          invoiceDate: parseDate(extracted.invoiceDate),
          scanningNumber: invoiceData.scanningNumber || generateScanningNumber(), // Keep existing or generate new
          poNumber: invoiceData.poNumber || extracted.poNumber || '', // Keep existing or use extracted
          supplierName: extracted.supplierName || '',
          billTo: extracted.billTo || '',
          
          // Financial Summary
          subtotal: parseNumeric(extracted.subtotal),
          cgst: parseNumeric(extracted.cgst),
          sgst: parseNumeric(extracted.sgst),
          taxAmount: parseNumeric(extracted.taxAmount),
          roundOff: parseNumeric(extracted.roundOff),
          totalAmount: parseNumeric(extracted.totalAmount),
          totalAmountInWords: extracted.totalAmountInWords || '',
          
          // Misc/Footer
          termsAndConditions: extracted.termsAndConditions || '',
          authorisedSignatory: extracted.authorisedSignatory || '',
          receiverSignature: extracted.receiverSignature || '',
          
          // Line Items with tax details
          items: (extracted.items || []).map((item: any) => {
            const ocrQty = parseNumeric(item.quantity || item.billed_qty || item.billedQty)
            return {
            itemName: item.itemName || item.item_name || '',
            // Scanned Weight column (Qty + weight) must not be populated from invoice extraction
            quantity: null,
            invoiceQuantity: ocrQty, // From OCR – shown in "Inv. Qty" column only
            weight: null, // Only from weight slip PDF upload + extract
            count: null,
            unitPrice: parseNumeric(item.unitPrice || item.unit_price),
            // Map 'amount' to 'lineTotal' if lineTotal is not present (Qwen may return 'amount')
            lineTotal: parseNumeric(item.lineTotal || item.line_total || item.amount),
            itemCode: item.itemCode || item.item_code || item.hsnSac || (item as { hsn_sac?: string }).hsn_sac || '',
            hsnSac: item.hsnSac || (item as { hsn_sac?: string }).hsn_sac || item.itemCode || item.item_code || '',
            taxableValue: parseNumeric(item.taxableValue),
            // Handle both cgstRate (number) and cgstPercent (string with %) - backend should convert, but handle both
            cgstRate: parseNumeric(item.cgstRate || (item.cgstPercent ? item.cgstPercent.replace(/%/g, '') : null)),
            cgstAmount: parseNumeric(item.cgstAmount),
            // Handle both sgstRate (number) and sgstPercent (string with %) - backend should convert, but handle both
            sgstRate: parseNumeric(item.sgstRate || (item.sgstPercent ? item.sgstPercent.replace(/%/g, '') : null)),
            sgstAmount: parseNumeric(item.sgstAmount),
            totalTaxAmount: parseNumeric(item.totalTaxAmount)
          }
          })
        }

        // Update state
        setInvoiceData({ ...invoiceDataUpdate })
        setInvoiceId(result.invoiceId || null) // Will be null until Save Invoice is clicked
        setPdfBuffer(result.pdfBuffer || null) // Store PDF buffer for saving
        setPdfFileName(result.pdfFileName || null) // Store PDF filename for saving
        setValidationConfirmed(false)
        setValidationResults(null)
        setSupplierDetails(null)
        
        // Show success message
        const extractedSummary = []
        if (invoiceDataUpdate.invoiceNumber) extractedSummary.push(`Invoice: ${invoiceDataUpdate.invoiceNumber}`)
        if (invoiceDataUpdate.supplierName) extractedSummary.push(`Supplier: ${invoiceDataUpdate.supplierName}`)
        if (invoiceDataUpdate.items.length > 0) extractedSummary.push(`${invoiceDataUpdate.items.length} items`)
        
        toast.current?.show({
          severity: 'success',
          summary: result.extracted ? 'Extraction Complete' : 'Upload Complete',
          detail: result.extracted 
            ? `Invoice data extracted successfully using ${result.model || 'Qwen'}. ${extractedSummary.join(', ')}`
            : `PDF uploaded successfully. ${extractedSummary.length > 0 ? extractedSummary.join(', ') : 'Please enter data manually.'}`,
          life: 6000
        })
      } catch (error: any) {
        toast.current?.show({
          severity: 'error',
          summary: 'Upload Failed',
          detail: error.message || 'Failed to upload and extract invoice data. Please try again.',
          life: 5000
        })
        
        // Reset form on error
        setInvoiceData({
          invoiceNumber: '',
          invoiceDate: null,
          scanningNumber: '',
          supplierName: '',
          billTo: '',
          subtotal: null,
          cgst: null,
          sgst: null,
          taxAmount: null,
          roundOff: null,
          totalAmount: null,
          totalAmountInWords: '',
          termsAndConditions: '',
          authorisedSignatory: '',
          receiverSignature: '',
          items: []
        })
        setInvoiceId(null)
      } finally {
        setExtracting(false)
      }
    } else {
      toast.current?.show({
        severity: 'error',
        summary: 'Invalid File Type',
        detail: 'Please select a valid PDF file',
        life: 3000
      })
    }
  }, [api])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.target.files?.[0]
    if (file) {
      handleFileSelect(file)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleBrowseClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    fileInputRef.current?.click()
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) {
      handleFileSelect(file)
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setPageNumber(1)
  }


  const handleValidate = async () => {
    if (!pdfFile) {
      toast.current?.show({
        severity: 'warn',
        summary: 'No Invoice',
        detail: 'Please upload and extract invoice first',
        life: 3000
      })
      return
    }

    setValidating(true)
    try {
      const results: any = {
        poDetails: { valid: false, errors: [] },
        poLineDetails: { valid: false, errors: [] },
        invoiceDetails: { valid: false, errors: [] },
        supplierDetails: { valid: false, errors: [] },
        bankDetails: { valid: false, errors: [] },
        overall: { valid: false }
      }

      // Resolve PO from edited invoiceData.poNumber so validation uses the current value
      const editedPoNumber = invoiceData.poNumber?.trim() || ''
      let poToValidate: PurchaseOrder | null = purchaseOrder
      if (editedPoNumber) {
        if (purchaseOrder?.po_number === editedPoNumber) {
          poToValidate = purchaseOrder
        } else {
          poToValidate = await fetchPOByNumber(editedPoNumber)
          if (poToValidate) setPurchaseOrder(poToValidate)
        }
      }

      // 1. Validate PO Details
      if (poToValidate) {
        if (poToValidate.po_id && poToValidate.po_number && poToValidate.po_date) {
          results.poDetails.valid = true
          results.poDetails.data = {
            poNumber: poToValidate.po_number,
            poDate: poToValidate.po_date,
            supplierName: poToValidate.supplier_name,
            billTo: (poToValidate as { bill_to?: string }).bill_to ?? invoiceData.billTo ?? ''
          }
        } else {
          results.poDetails.errors.push('PO details are incomplete')
        }
      } else {
        if (editedPoNumber) results.poDetails.errors.push(`Purchase order "${editedPoNumber}" not found`)
        else results.poDetails.errors.push('Purchase Order not validated')
      }

      // 2. Validate PO Line Details (backend returns description1, qty from purchase_order_lines)
      if (poToValidate && poToValidate.items && poToValidate.items.length > 0) {
        const getItemName = (item: PurchaseOrder['items'][0]) => (item as { item_name?: string; description1?: string }).item_name ?? (item as { item_name?: string; description1?: string }).description1
        const getPoLineQty = (item: PurchaseOrder['items'][0]) => item.qty ?? item.quantity ?? null
        const missingFields = poToValidate.items.some(item =>
          !getItemName(item) || getPoLineQty(item) == null
        )
        if (!missingFields) {
          results.poLineDetails.valid = true
          results.poLineDetails.data = {
            totalItems: poToValidate.items.length,
            items: poToValidate.items.map(item => ({
              itemName: getItemName(item),
              hsnSac: (item as { hsn_sac?: string }).hsn_sac,
              quantity: getPoLineQty(item),
              unitPrice: item.unit_price ?? (item as { unit_cost?: number }).unit_cost ?? null,
              uom: (item as { uom?: string }).uom,
              sequenceNumber: item.sequence_number
            }))
          }
        } else {
          results.poLineDetails.errors.push('Some PO line items have missing fields (item name or qty)')
        }
      } else {
        results.poLineDetails.errors.push('No PO line items found')
      }

      // 3. Validate Invoice Details
      const invoiceErrors = []
      if (!invoiceData.invoiceNumber) invoiceErrors.push('Invoice number is missing')
      if (!invoiceData.invoiceDate) invoiceErrors.push('Invoice date is missing')
      if (!invoiceData.supplierName) invoiceErrors.push('Supplier name is missing')
      if (!invoiceData.billTo) invoiceErrors.push('Bill To is missing')
      if (!invoiceData.totalAmount) invoiceErrors.push('Total amount is missing')
      if (!invoiceData.items || invoiceData.items.length === 0) invoiceErrors.push('No invoice line items')
      
      // Validate that each item has either weight or count
      invoiceData.items.forEach((item, index) => {
        if (item.weight === null && (item.count === null || item.count === 0)) {
          invoiceErrors.push(`Item ${index + 1} (${item.itemName || 'Unnamed'}) must have either weight slip uploaded or count entered`)
        }
      })

      // When weight slip is uploaded: weight must match INV. QTY
      // When no weight slip but count entered: count must match INV. QTY
      const qtyTolerance = 0.01
      invoiceData.items.forEach((item, index) => {
        const invQty = item.invoiceQuantity != null ? Number(item.invoiceQuantity) : null
        const itemLabel = `Item ${index + 1} (${item.itemName || 'Unnamed'})`

        if (item.weight != null) {
          if (invQty == null) {
            invoiceErrors.push(`${itemLabel}: Inv. Qty is missing – cannot verify scanned weight`)
          } else if (Math.abs(Number(item.weight) - invQty) > qtyTolerance) {
            invoiceErrors.push(`${itemLabel}: Scanned weight (${Number(item.weight)}) does not match Inv. Qty (${invQty})`)
          }
        } else if (item.count != null && item.count > 0) {
          if (invQty == null) {
            invoiceErrors.push(`${itemLabel}: Inv. Qty is missing – cannot verify count`)
          } else if (Math.abs(Number(item.count) - invQty) > qtyTolerance) {
            invoiceErrors.push(`${itemLabel}: Count (${item.count}) does not match Inv. Qty (${invQty})`)
          }
        }
      })

      if (invoiceErrors.length === 0) {
        results.invoiceDetails.valid = true
        results.invoiceDetails.data = {
          invoiceNumber: invoiceData.invoiceNumber,
          invoiceDate: invoiceData.invoiceDate,
          supplierName: invoiceData.supplierName,
          billTo: invoiceData.billTo,
          totalAmount: invoiceData.totalAmount,
          totalItems: invoiceData.items.length,
          items: invoiceData.items.map((item, index) => ({
            itemName: item.itemName,
            hsnSac: item.hsnSac || item.itemCode,
            quantity: item.quantity ?? item.invoiceQuantity ?? null,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
            taxableValue: item.taxableValue,
            cgstRate: item.cgstRate,
            cgstAmount: item.cgstAmount,
            sgstRate: item.sgstRate,
            sgstAmount: item.sgstAmount,
            totalTaxAmount: item.totalTaxAmount,
            sequenceNumber: index + 1
          }))
        }
      } else {
        results.invoiceDetails.errors = invoiceErrors
      }

      // 4. Validate Supplier Details
      let supplierData = null
      // Use the extracted supplier name from invoice data
      const supplierNameToSearch = invoiceData.supplierName?.trim()
      
      if (supplierNameToSearch) {
        try {
          // Fetch supplier details using the extracted supplier name
          const supplierResponse = await fetch(api(`suppliers/${encodeURIComponent(supplierNameToSearch)}`))
          
          if (supplierResponse.ok) {
            supplierData = await supplierResponse.json()
            setSupplierDetails(supplierData)
            
            // Store the fetched supplier data for display
            results.supplierDetails.fetchedData = {
              supplierName: supplierData.supplier_name,
              gstNumber: supplierData.gst_number,
              panNumber: supplierData.pan_number,
              address: supplierData.supplier_address,
              email: supplierData.email,
              mobile: supplierData.mobile,
              phone: supplierData.phone
            }
            
            // Check if required fields are present in the database
            const supplierErrors = []
            if (!supplierData.gst_number || supplierData.gst_number.trim() === '') {
              supplierErrors.push('GST number is missing in database')
            }
            if (!supplierData.pan_number || supplierData.pan_number.trim() === '') {
              supplierErrors.push('PAN number is missing in database')
            }
            if (!supplierData.supplier_address || supplierData.supplier_address.trim() === '') {
              supplierErrors.push('Supplier address is missing in database')
            }
            if ((!supplierData.email || supplierData.email.trim() === '') && 
                (!supplierData.mobile || supplierData.mobile.trim() === '') &&
                (!supplierData.phone || supplierData.phone.trim() === '')) {
              supplierErrors.push('Contact information (email/mobile/phone) is missing in database')
            }

            if (supplierErrors.length === 0) {
              results.supplierDetails.valid = true
              results.supplierDetails.data = {
                supplierName: supplierData.supplier_name,
                gstNumber: supplierData.gst_number,
                panNumber: supplierData.pan_number,
                address: supplierData.supplier_address
              }
            } else {
              results.supplierDetails.errors = supplierErrors
            }
          } else {
            const errorData = await supplierResponse.json().catch(() => ({}))
            results.supplierDetails.errors.push(
              errorData.message || `Supplier "${supplierNameToSearch}" not found in database. Searched for: "${supplierNameToSearch}"`
            )
          }
        } catch (err: any) {
          results.supplierDetails.errors.push(
            `Failed to fetch supplier details: ${err.message || 'Network error'}`
          )
        }
      } else {
        results.supplierDetails.errors.push('Supplier name is missing from extracted invoice data')
      }

      // 5. Validate Bank Details (from the fetched supplier data)
      if (supplierData) {
        // Store the fetched bank data for display
        results.bankDetails.fetchedData = {
          accountNumber: supplierData.bank_account_number,
          ifscCode: supplierData.bank_ifsc_code,
          bankName: supplierData.bank_name,
          branchName: supplierData.branch_name,
          accountName: supplierData.bank_account_name
        }
        
        const bankErrors = []
        if (!supplierData.bank_account_number || supplierData.bank_account_number.trim() === '') {
          bankErrors.push('Bank account number is missing in database')
        }
        if (!supplierData.bank_ifsc_code || supplierData.bank_ifsc_code.trim() === '') {
          bankErrors.push('Bank IFSC code is missing in database')
        }
        if (!supplierData.bank_name || supplierData.bank_name.trim() === '') {
          bankErrors.push('Bank name is missing in database')
        }
        if (!supplierData.branch_name || supplierData.branch_name.trim() === '') {
          bankErrors.push('Branch name is missing in database')
        }

        if (bankErrors.length === 0) {
          results.bankDetails.valid = true
          results.bankDetails.data = {
            accountNumber: supplierData.bank_account_number,
            ifscCode: supplierData.bank_ifsc_code,
            bankName: supplierData.bank_name,
            branchName: supplierData.branch_name
          }
        } else {
          results.bankDetails.errors = bankErrors
        }
      } else {
        results.bankDetails.errors.push('Supplier details not available - cannot fetch bank details')
      }

      // Overall validation
      results.overall.valid = 
        results.poDetails.valid &&
        results.poLineDetails.valid &&
        results.invoiceDetails.valid &&
        results.supplierDetails.valid &&
        results.bankDetails.valid

      setValidationResults(results)
      setValidationDialogVisible(true)
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Validation Failed',
        detail: error.message || 'Failed to validate invoice details',
        life: 5000
      })
    } finally {
      setValidating(false)
    }
  }

  const handleValidationConfirm = () => {
    setValidationConfirmed(true)
    setValidationDialogVisible(false)
    toast.current?.show({
      severity: 'success',
      summary: 'Validation Confirmed',
      detail: 'Invoice details validated. You can now save the invoice.',
      life: 3000
    })
  }

  const handleSave = async () => {
    if (!pdfFile) {
      toast.current?.show({
        severity: 'warn',
        summary: 'No Invoice',
        detail: 'Please upload and extract invoice first',
        life: 3000
      })
      return
    }

    if (!validationConfirmed) {
      toast.current?.show({
        severity: 'warn',
        summary: 'Validation Required',
        detail: 'Please validate the invoice details before saving',
        life: 3000
      })
      return
    }

    setLoading(true)
    try {
      const calculatedSubtotal = invoiceData.items.reduce((sum, item) => {
        return sum + (item.lineTotal || 0)
      }, 0)

      // Calculate tax amount if not set
      const calculatedTaxAmount = invoiceData.taxAmount ||
        ((invoiceData.cgst || 0) + (invoiceData.sgst || 0))

      // Resolve PO from edited invoiceData.poNumber so save uses the current value
      const editedPoNumber = invoiceData.poNumber?.trim() || ''
      let poForSave: PurchaseOrder | null = purchaseOrder
      if (editedPoNumber) {
        if (purchaseOrder?.po_number !== editedPoNumber) {
          poForSave = await fetchPOByNumber(editedPoNumber)
          if (poForSave) setPurchaseOrder(poForSave)
        }
      }

      // Get supplier ID from validation results or resolved purchase order
      const supplierId = supplierDetails?.supplier_id || poForSave?.supplier_id || null

      // Generate scanning number if not set
      const scanningNumber = invoiceData.scanningNumber || generateScanningNumber()

      const payload = {
        invoiceNumber: invoiceData.invoiceNumber,
        invoiceDate: invoiceData.invoiceDate ? invoiceData.invoiceDate.toISOString().split('T')[0] : null,
        supplierId: supplierId,
        poId: poForSave?.po_id || null,
        scanningNumber: scanningNumber,
        totalAmount: invoiceData.totalAmount || calculatedSubtotal + calculatedTaxAmount,
        taxAmount: calculatedTaxAmount,
        notes: invoiceData.termsAndConditions || null,
        pdfFileName: pdfFileName,
        pdfBuffer: pdfBuffer,
        items: invoiceData.items.map((item, index) => ({
          itemName: item.itemName,
          itemCode: item.itemCode,
          hsnSac: item.hsnSac || item.itemCode,
          billedQty: item.quantity,
          weight: item.weight,
          count: item.count,
          uom: (poForSave?.items?.[index] as { uom?: string } | undefined)?.uom ?? (item as { uom?: string }).uom ?? null,
          rate: item.unitPrice,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          taxableValue: item.taxableValue,
          cgstRate: item.cgstRate,
          cgstAmount: item.cgstAmount,
          sgstRate: item.sgstRate,
          sgstAmount: item.sgstAmount,
          totalTaxAmount: item.totalTaxAmount,
          poLineId: poForSave?.items?.[index]?.po_line_id || null
        }))
      }

      // Use POST to create invoice if invoiceId is null, otherwise PUT to update
      const url = invoiceId ? api(`/invoices/${invoiceId}`) : api('/invoices')
      const method = invoiceId ? 'PUT' : 'POST'
      
      const response = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.message || 'Failed to save invoice')
      }

      const result = await response.json()
      
      // Update invoiceId if it was created
      if (result.invoiceId && !invoiceId) {
        setInvoiceId(result.invoiceId)
      }

      toast.current?.show({
        severity: 'success',
        summary: 'Invoice Saved',
        detail: 'Invoice has been saved successfully to the database',
        life: 3000
      })

      // Reset page to PO validation for next invoice processing
      setTimeout(() => {
        // Close validation dialog if open
        setValidationDialogVisible(false)
        
        // Reset all states
        setPoNumber('')
        setPoNumberInput('')
        setPurchaseOrder(null)
        setPoValidated(false)
        setPdfFile(null)
        if (pdfUrl) URL.revokeObjectURL(pdfUrl)
        setPdfUrl(null)
        setPageNumber(1)
        setNumPages(0)
        setInvoiceId(null)
        setPdfBuffer(null)
        setPdfFileName(null)
        setValidationConfirmed(false)
        setValidationResults(null)
        setSupplierDetails(null)
        setExtracting(false)
        setInvoiceData({
          invoiceNumber: '',
          invoiceDate: null,
          scanningNumber: '',
          supplierName: '',
          billTo: '',
          subtotal: null,
          cgst: null,
          sgst: null,
          taxAmount: null,
          roundOff: null,
          totalAmount: null,
          totalAmountInWords: '',
          termsAndConditions: '',
          authorisedSignatory: '',
          receiverSignature: '',
          items: []
        })
        
        // Clear file input if exists
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      }, 1500) // Small delay to show success message
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Save Failed',
        detail: error.message || 'Failed to save invoice. Please try again.',
        life: 5000
      })
    } finally {
      setLoading(false)
    }
  }

  const addItem = () => {
    setInvoiceData(prev => ({
      ...prev,
      items: [...prev.items, { 
        itemName: '', 
        quantity: null,
        invoiceQuantity: null,
        weight: null,
        count: null,
        unitPrice: null, 
        lineTotal: null,
        itemCode: '',
        hsnSac: '',
        taxableValue: null,
        cgstRate: null,
        cgstAmount: null,
        sgstRate: null,
        sgstAmount: null,
        totalTaxAmount: null
      }]
    }))
  }

  const removeItem = (index: number) => {
    setInvoiceData(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }))
  }

  const updateItem = (index: number, field: keyof InvoiceItem, value: any) => {
    setInvoiceData(prev => {
      const newItems = [...prev.items]
      const item = newItems[index]
      newItems[index] = { ...item, [field]: value }

      // When count is entered, also set quantity so line totals use it (Scanned Weight has only weight input)
      if (field === 'count') {
        newItems[index].quantity = value
      }

      if (field === 'quantity' || field === 'unitPrice' || field === 'count') {
        const qty = newItems[index].quantity
        const price = newItems[index].unitPrice
        if (qty != null && price) {
          newItems[index].lineTotal = qty * price
        }
      }

      return { ...prev, items: newItems }
    })
  }

  const handleOpenWeightSlipDialog = (itemIndex: number) => {
    setCurrentItemIndex(itemIndex)
    setWeightSlipDialogVisible(true)
    setWeightSlipFile(null)
  }

  const handleWeightSlipUpload = async (file: File) => {
    if (!file || file.type !== 'application/pdf') {
      toast.current?.show({
        severity: 'error',
        summary: 'Invalid File',
        detail: 'Please select a valid PDF file',
        life: 3000
      })
      return
    }

    setExtractingWeight(true)
    try {
      const formData = new FormData()
      formData.append('pdf', file)

      const response = await fetch(apiUrl('/invoices/extract-weight'), {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        throw new Error('Failed to extract weight from slip')
      }

      const result = await response.json()
      const extractedWeight = result.weight != null ? Number(result.weight) : null

      if (extractedWeight !== null && !Number.isNaN(extractedWeight)) {
        updateItem(currentItemIndex, 'weight', extractedWeight)
        toast.current?.show({
          severity: 'success',
          summary: 'Weight Extracted',
          detail: `Weight extracted: ${extractedWeight}`,
          life: 3000
        })
        setWeightSlipDialogVisible(false)
        setWeightSlipFile(null)
      } else {
        toast.current?.show({
          severity: 'warn',
          summary: 'Weight Not Found',
          detail: 'Could not extract weight from this slip. Try another document or use Count for this line.',
          life: 4000
        })
      }
    } catch (error: any) {
      toast.current?.show({
        severity: 'error',
        summary: 'Extraction Failed',
        detail: error.message || 'Failed to extract weight from slip',
        life: 5000
      })
    } finally {
      setExtractingWeight(false)
    }
  }

  const handleWeightSlipFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setWeightSlipFile(file)
      handleWeightSlipUpload(file)
    }
  }

  const itemTotalBodyTemplate = (rowData: InvoiceItem) => {
    const total = rowData.lineTotal || (rowData.quantity || 0) * (rowData.unitPrice || 0)
    return total > 0 ? `₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'
  }

  const itemTotalAmountBodyTemplate = (rowData: InvoiceItem) => {
    const lineTotal = rowData.lineTotal || (rowData.quantity || 0) * (rowData.unitPrice || 0)
    const cgstAmount = rowData.cgstAmount || 0
    const sgstAmount = rowData.sgstAmount || 0
    const totalAmount = lineTotal + cgstAmount + sgstAmount
    return totalAmount > 0 ? `₹${totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'
  }

  const confirmRemoveFile = () => {
    confirmDialog({
      message: 'Are you sure you want to remove this file? Extracted data will be cleared.',
      header: 'Confirm remove file',
      icon: 'pi pi-question-circle',
      acceptClassName: 'p-button-danger',
      accept: () => handleRemoveFile(),
      reject: () => {}
    })
  }

  const handleRemoveFile = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    setPdfUrl(null)
    setPdfFile(null)
    setPageNumber(1)
    setNumPages(0)
    setInvoiceId(null)
    setPdfBuffer(null)
    setPdfFileName(null)
    setValidationConfirmed(false)
    setValidationResults(null)
    setSupplierDetails(null)
    setInvoiceData({
      invoiceNumber: '',
      invoiceDate: null,
      scanningNumber: '',
      poNumber: '',
      supplierName: '',
      billTo: '',
      subtotal: null,
      cgst: null,
      sgst: null,
      taxAmount: null,
      roundOff: null,
      totalAmount: null,
      totalAmountInWords: '',
      termsAndConditions: '',
      authorisedSignatory: '',
      receiverSignature: '',
      items: []
    })
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className={styles.invoiceUploadPage}>
      <Header />
      <Toast ref={toast} position="top-right" />
      <ConfirmDialog />
      <div className={styles.pageContainer}>
        {/* Header Section */}
        <div className={styles.pageHeader}>
          <div className={styles.headerContent}>
            <div className={styles.headerIconWrapper}>
              <i className={`pi pi-file-invoice ${styles.headerIcon}`}></i>
            </div>
            <div className={styles.headerText}>
              <h1 className={styles.pageTitle}>Invoice Processing</h1>
              <p className={styles.pageSubtitle}>Upload PDF and extract data</p>
            </div>
            <PageNavigation />
          </div>
        </div>

        {/* Main Content Grid */}
        <div className={styles.contentGrid}>
          {/* Left Panel - PDF Upload & Viewer */}
          <div ref={documentPreviewRef} className={`${styles.panel} ${styles.documentPreviewPanel}`}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitleGroup}>
                <i className={`pi pi-file-pdf ${styles.panelIcon}`}></i>
                <h2 className={styles.panelTitle}>Document Preview</h2>
              </div>
              {pdfFile && (
                <div className={styles.fileInfo}>
                  <i className="pi pi-file"></i>
                  <span className={styles.fileName}>{pdfFile.name}</span>
                  <span className={styles.fileSize}>({(pdfFile.size / 1024).toFixed(1)} KB)</span>
                </div>
              )}
            </div>

            <div className={styles.panelBody}>
              {!pdfUrl ? (
                <div
                  className={`${styles.uploadArea} ${isDragging ? styles.dragging : ''}`}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                >
                  <div className={styles.uploadContent}>
                    <div className={styles.uploadIconWrapper}>
                      <i className={`pi pi-cloud-upload ${styles.uploadIcon}`}></i>
                    </div>
                    <h3 className={styles.uploadTitle}>Upload Invoice PDF</h3>
                    <p className={styles.uploadDescription}>
                      Drag and drop your invoice PDF file here, or click the button below to browse
                    </p>
                    <Button
                      label="Choose File"
                      icon="pi pi-folder-open"
                      className={styles.uploadButton}
                      onClick={handleBrowseClick}
                    />
                    <p className={styles.uploadHint}>
                      <i className="pi pi-info-circle"></i>
                      Supported format: PDF (Max size: 10MB)
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    className={styles.hiddenInput}
                    onChange={handleFileChange}
                  />
                </div>
              ) : (
                <div className={styles.pdfViewerContainer}>
                  {extracting && (
                    <div className={styles.extractingOverlay}>
                      <ProgressSpinner />
                      <p>Extracting data with Qwen AI...</p>
                    </div>
                  )}
                  <div className={styles.pdfControls}>
                    <div className={styles.pageControls}>
                      <Button
                        icon="pi pi-chevron-left"
                        className={styles.pageNavButton}
                        disabled={pageNumber <= 1}
                        onClick={() => setPageNumber(prev => Math.max(1, prev - 1))}
                      />
                      <div className={styles.pageIndicator}>
                        <span className={styles.pageText}>Page</span>
                        <span className={styles.pageNumber}>{pageNumber}</span>
                        <span className={styles.pageText}>of</span>
                        <span className={styles.pageNumber}>{numPages}</span>
                      </div>
                      <Button
                        icon="pi pi-chevron-right"
                        className={styles.pageNavButton}
                        disabled={pageNumber >= numPages}
                        onClick={() => setPageNumber(prev => Math.min(numPages, prev + 1))}
                      />
                    </div>
                    <div className={styles.actionControls}>
                      <Button
                        icon="pi pi-times"
                        className={styles.removeButton}
                        onClick={confirmRemoveFile}
                        tooltip="Remove file"
                      />
                    </div>
                  </div>
                  <div className={styles.pdfDisplay}>
                    <Document
                      file={pdfUrl}
                      onLoadSuccess={onDocumentLoadSuccess}
                        onLoadError={(error) => {
                          toast.current?.show({
                          severity: 'error',
                          summary: 'PDF Load Failed',
                          detail: 'Failed to load PDF. Please ensure the file is a valid PDF format.',
                          life: 5000
                        })
                      }}
                      loading={
                        <div className={styles.pdfLoading}>
                          <ProgressSpinner />
                          <p>Loading document...</p>
                        </div>
                      }
                      error={
                        <div className={styles.pdfLoading}>
                          <i className="pi pi-exclamation-triangle" style={{ fontSize: '48px', color: '#ef4444', marginBottom: '16px' }}></i>
                          <p style={{ color: '#ef4444', fontWeight: 600 }}>Failed to load PDF</p>
                          <p style={{ color: '#64748b', fontSize: '12px' }}>Please ensure the file is a valid PDF format</p>
                        </div>
                      }
                    >
                      <Page
                        pageNumber={pageNumber}
                        renderTextLayer={true}
                        renderAnnotationLayer={true}
                        className={styles.pdfPage}
                        onLoadError={(error) => {
                          // Silently handle page load errors
                        }}
                      />
                    </Document>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Panel - Invoice Form */}
          <div ref={invoiceInfoRef} className={`${styles.panel} ${styles.invoiceInfoPanel}`}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitleGroup}>
                <i className={`pi pi-pencil ${styles.panelIcon}`}></i>
                <h2 className={styles.panelTitle}>Invoice Information</h2>
              </div>
            </div>

            <div className={styles.panelBody}>
              <div className={styles.formContainer}>
                {/* Basic Information Section */}
                <div className={styles.formSection}>
                  <h3 className={styles.sectionTitle}>Basic Information</h3>
                  <div className={styles.formRow}>
                    <div className={styles.formField}>
                      <label className={styles.fieldLabel}>
                        <i className={`pi pi-hashtag ${styles.fieldIcon}`}></i>
                        Invoice Number <span className={styles.required}>*</span>
                      </label>
                      <InputText
                        value={invoiceData.invoiceNumber}
                        onChange={(e) => setInvoiceData(prev => ({ ...prev, invoiceNumber: e.target.value }))}
                        className={styles.fieldInput}
                        placeholder="Enter invoice number"
                      />
                    </div>
                    <div className={styles.formField}>
                      <label className={styles.fieldLabel}>
                        <i className={`pi pi-calendar ${styles.fieldIcon}`}></i>
                        Invoice Date <span className={styles.required}>*</span>
                      </label>
                      <Calendar
                        value={invoiceData.invoiceDate}
                        onChange={(e) => setInvoiceData(prev => ({ ...prev, invoiceDate: e.value as Date }))}
                        dateFormat="dd/mm/yy"
                        showIcon
                        className={styles.fieldInput}
                        placeholder="Select date"
                      />
                    </div>
                    <div className={styles.formField}>
                      <label className={styles.fieldLabel}>
                        <i className={`pi pi-barcode ${styles.fieldIcon}`}></i>
                        Scanning Number <span className={styles.required}>*</span>
                      </label>
                      <InputText
                        value={invoiceData.scanningNumber}
                        onChange={(e) => {
                          // Allow only alphanumeric characters
                          const value = e.target.value.replace(/[^A-Za-z0-9-]/g, '')
                          setInvoiceData(prev => ({ ...prev, scanningNumber: value }))
                        }}
                        className={styles.fieldInput}
                        placeholder="Auto-generated scanning number"
                        maxLength={50}
                      />
                      <small className={styles.fieldHint}>
                        Unique alphanumeric identifier for this scan
                      </small>
                    </div>
                    <div className={styles.formField}>
                      <label className={styles.fieldLabel}>
                        <i className={`pi pi-shopping-cart ${styles.fieldIcon}`}></i>
                        PO Number
                      </label>
                      <InputText
                        value={invoiceData.poNumber}
                        onChange={(e) => {
                          setInvoiceData(prev => ({ ...prev, poNumber: e.target.value }))
                        }}
                        className={styles.fieldInput}
                        placeholder="Enter purchase order number"
                      />
                      <small className={styles.fieldHint}>
                        Optional: Link invoice to purchase order
                      </small>
                    </div>
                  </div>
                </div>

                {/* Supplier & Bill To Information - Side by Side */}
                <div className={styles.formSection}>
                  <div className={styles.formRow}>
                    <div className={styles.formField}>
                      <label className={styles.fieldLabel}>
                        <i className={`pi pi-building ${styles.fieldIcon}`}></i>
                        Supplier Name
                      </label>
                      <InputText
                        value={invoiceData.supplierName}
                        onChange={(e) => setInvoiceData(prev => ({ ...prev, supplierName: e.target.value }))}
                        className={styles.fieldInput}
                        placeholder="Enter supplier name"
                      />
                    </div>
                    <div className={styles.formField}>
                      <label className={styles.fieldLabel}>
                        <i className={`pi pi-building ${styles.fieldIcon}`}></i>
                        Bill To
                      </label>
                      <InputText
                        value={invoiceData.billTo}
                        onChange={(e) => setInvoiceData(prev => ({ ...prev, billTo: e.target.value }))}
                        className={styles.fieldInput}
                        placeholder="Enter customer/company name"
                      />
                    </div>
                  </div>
                </div>

                {/* Financial Summary Section */}
                <div className={styles.formSection}>
                  <h3 className={styles.sectionTitle}>Financial Summary</h3>
                  <div className={styles.financialGrid}>
                    <div className={styles.financialField}>
                      <label className={styles.fieldLabel}>Subtotal</label>
                      <InputNumber
                        value={invoiceData.subtotal}
                        onValueChange={(e) => setInvoiceData(prev => ({ ...prev, subtotal: e.value ?? null }))}
                        mode="decimal"
                        minFractionDigits={2}
                        maxFractionDigits={2}
                        className={styles.fieldInput}
                        prefix="₹ "
                        placeholder="0.00"
                      />
                    </div>
                    <div className={styles.financialField}>
                      <label className={styles.fieldLabel}>CGST</label>
                      <InputNumber
                        value={invoiceData.cgst}
                        onValueChange={(e) => setInvoiceData(prev => ({ ...prev, cgst: e.value ?? null }))}
                        mode="decimal"
                        minFractionDigits={2}
                        maxFractionDigits={2}
                        className={styles.fieldInput}
                        prefix="₹ "
                        placeholder="0.00"
                      />
                    </div>
                    <div className={styles.financialField}>
                      <label className={styles.fieldLabel}>SGST</label>
                      <InputNumber
                        value={invoiceData.sgst}
                        onValueChange={(e) => setInvoiceData(prev => ({ ...prev, sgst: e.value ?? null }))}
                        mode="decimal"
                        minFractionDigits={2}
                        maxFractionDigits={2}
                        className={styles.fieldInput}
                        prefix="₹ "
                        placeholder="0.00"
                      />
                    </div>
                    <div className={styles.financialField}>
                      <label className={styles.fieldLabel}>Tax Amount</label>
                      <InputNumber
                        value={invoiceData.taxAmount}
                        onValueChange={(e) => setInvoiceData(prev => ({ ...prev, taxAmount: e.value ?? null }))}
                        mode="decimal"
                        minFractionDigits={2}
                        maxFractionDigits={2}
                        className={styles.fieldInput}
                        prefix="₹ "
                        placeholder="0.00"
                      />
                    </div>
                    <div className={styles.financialField}>
                      <label className={styles.fieldLabel}>Round Off</label>
                      <InputNumber
                        value={invoiceData.roundOff}
                        onValueChange={(e) => setInvoiceData(prev => ({ ...prev, roundOff: e.value ?? null }))}
                        mode="decimal"
                        minFractionDigits={2}
                        maxFractionDigits={2}
                        className={styles.fieldInput}
                        prefix="₹ "
                        placeholder="0.00"
                      />
                    </div>
                    <div className={`${styles.financialField} ${styles.totalField}`}>
                      <label className={styles.fieldLabel}>Total Amount</label>
                      <InputNumber
                        value={invoiceData.totalAmount}
                        onValueChange={(e) => setInvoiceData(prev => ({ ...prev, totalAmount: e.value ?? null }))}
                        mode="decimal"
                        minFractionDigits={2}
                        maxFractionDigits={2}
                        className={`${styles.fieldInput} ${styles.totalInput}`}
                        prefix="₹ "
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                  <div className={styles.formField} style={{ marginTop: '12px' }}>
                    <label className={styles.fieldLabel}>
                      <i className={`pi pi-file-word ${styles.fieldIcon}`}></i>
                      Total Amount (in words)
                    </label>
                    <InputText
                      value={invoiceData.totalAmountInWords}
                      onChange={(e) => setInvoiceData(prev => ({ ...prev, totalAmountInWords: e.target.value }))}
                      className={styles.fieldInput}
                      placeholder="Enter amount in words"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Line Items Section - Full Width */}
        <div className={styles.lineItemsContainer}>
          <div 
            className={styles.lineItemsPanel}
            style={{
              minHeight: invoiceData.items.length <= 3 
                ? '280px' 
                : `${Math.min(280 + (invoiceData.items.length - 3) * 55, 650)}px`
            }}
          >
            <div className={styles.panelHeader}>
              <div className={styles.panelTitleGroup}>
                <i className={`pi pi-list ${styles.panelIcon}`}></i>
                <h2 className={styles.panelTitle}>Line Items</h2>
              </div>
            </div>
            <div className={styles.panelBody}>
              <div className={styles.tableHeaderActions}>
                <Button
                  icon="pi pi-plus"
                  label="Add Item"
                  className={styles.addItemButton}
                  onClick={addItem}
                />
              </div>
              <div className={styles.itemsTableWrapper}>
                <div className={styles.lineItemsTable}>
                  <div className={styles.lineItemsScroll}>
                    <div className={styles.lineItemsHead}>
                      <div className={styles.lineItemsHeadCell}>#</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellWrap}>Item Name</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>Inv. Qty</div>
                      <div className={styles.lineItemsHeadCell}>Scanned Weight</div>
                      <div className={styles.lineItemsHeadCell}>Count</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>Unit Price</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>Amount</div>
                      <div className={styles.lineItemsHeadCell}>HSN/SAC</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>Taxable Value</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellCenter}>CGST %</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>CGST Amt</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellCenter}>SGST %</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>SGST Amt</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellRight}>Total</div>
                      <div className={styles.lineItemsHeadCell + ' ' + styles.lineItemsHeadCellCenter}>Action</div>
                    </div>
                    <div className={styles.lineItemsBody}>
                    {invoiceData.items.length === 0 ? (
                      <div className={styles.lineItemsEmpty}>
                        <i className={`pi pi-inbox ${styles.emptyIcon}`}></i>
                        <p className={styles.emptyText}>No items added yet</p>
                        <p className={styles.emptyHint}>Click &quot;Add Item&quot; to add invoice line items</p>
                      </div>
                    ) : (
                      invoiceData.items.map((rowData, rowIndex) => (
                        <div key={rowIndex} className={styles.lineItemsRow}>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellCenter}>{rowIndex + 1}</div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellItemName}>
                            <InputTextarea
                              value={rowData.itemName}
                              onChange={(e) => updateItem(rowIndex, 'itemName', e.target.value ?? '')}
                              className={styles.tableInputItemName}
                              placeholder="Item name"
                              rows={3}
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight}>
                            {rowData.invoiceQuantity != null
                              ? Number(rowData.invoiceQuantity).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
                              : '-'}
                          </div>
                          <div className={styles.lineItemsCell}>
                            <div className={styles.qtyWeightCell}>
                              <Button
                                className={styles.qtyWeightUploadBtn}
                                onClick={() => handleOpenWeightSlipDialog(rowIndex)}
                                tooltip="Upload weight slip PDF – value is filled only from extracted document"
                                tooltipOptions={{ position: 'top' }}
                                severity={rowData.weight !== null ? 'success' : 'secondary'}
                                outlined={rowData.weight === null}
                                size="small"
                                text={false}
                              >
                                <i className="pi pi-upload"></i>
                              </Button>
                              <InputText
                                value={rowData.weight != null ? String(Number(rowData.weight)) : ''}
                                readOnly
                                className={styles.qtyWeightValueInput}
                                placeholder="Upload slip"
                              />
                            </div>
                          </div>
                          <div className={styles.lineItemsCell}>
                            <div className={styles.countCell}>
                              <Button
                                className={styles.countButton}
                                onClick={() => {
                                  setTimeout(() => {
                                    const input = document.querySelector(`input[data-count-index="${rowIndex}"]`) as HTMLInputElement
                                    input?.focus()
                                  }, 100)
                                }}
                                tooltip="Enter count"
                                tooltipOptions={{ position: 'top' }}
                                severity={rowData.count !== null && rowData.count > 0 ? 'success' : 'secondary'}
                                outlined={rowData.count === null || rowData.count === 0}
                                size="small"
                                text={false}
                              >
                                <i className="pi pi-list"></i>
                              </Button>
                              <InputNumber
                                value={rowData.count}
                                onValueChange={(e) => updateItem(rowIndex, 'count', e.value)}
                                mode="decimal"
                                minFractionDigits={0}
                                maxFractionDigits={0}
                                className={styles.countInput}
                                placeholder="0"
                                min={0}
                                data-count-index={rowIndex}
                                showButtons={false}
                              />
                              {rowData.count != null && rowData.count > 0 && <span className={styles.countCheck}>✓</span>}
                            </div>
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight}>
                            <InputNumber
                              value={rowData.unitPrice}
                              onValueChange={(e) => updateItem(rowIndex, 'unitPrice', e.value)}
                              mode="decimal"
                              minFractionDigits={2}
                              maxFractionDigits={2}
                              className={styles.tableInput}
                              placeholder="0.00"
                              prefix="₹ "
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight}>
                            {itemTotalBodyTemplate(rowData)}
                          </div>
                          <div className={styles.lineItemsCell}>
                            <InputText
                              value={rowData.hsnSac ?? rowData.itemCode ?? ''}
                              onChange={(e) => {
                                const v = e.target.value
                                setInvoiceData(prev => ({
                                  ...prev,
                                  items: prev.items.map((it, i) =>
                                    i === rowIndex ? { ...it, itemCode: v, hsnSac: v } : it
                                  )
                                }))
                              }}
                              className={styles.tableInput}
                              placeholder="HSN/SAC"
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight}>
                            <InputNumber
                              value={rowData.taxableValue}
                              onValueChange={(e) => updateItem(rowIndex, 'taxableValue', e.value)}
                              mode="decimal"
                              minFractionDigits={2}
                              maxFractionDigits={2}
                              className={styles.tableInput}
                              placeholder="0.00"
                              prefix="₹ "
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellCenter}>
                            <InputNumber
                              value={rowData.cgstRate}
                              onValueChange={(e) => updateItem(rowIndex, 'cgstRate', e.value)}
                              mode="decimal"
                              minFractionDigits={0}
                              maxFractionDigits={2}
                              className={`${styles.tableInput} ${styles.tableInputNarrowPct}`}
                              placeholder="0"
                              suffix="%"
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight}>
                            <InputNumber
                              value={rowData.cgstAmount}
                              onValueChange={(e) => updateItem(rowIndex, 'cgstAmount', e.value)}
                              mode="decimal"
                              minFractionDigits={2}
                              maxFractionDigits={2}
                              className={`${styles.tableInput} ${styles.tableInputNarrowAmt}`}
                              placeholder="0.00"
                              prefix="₹ "
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellCenter}>
                            <InputNumber
                              value={rowData.sgstRate}
                              onValueChange={(e) => updateItem(rowIndex, 'sgstRate', e.value)}
                              mode="decimal"
                              minFractionDigits={0}
                              maxFractionDigits={2}
                              className={`${styles.tableInput} ${styles.tableInputNarrowPct}`}
                              placeholder="0"
                              suffix="%"
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight}>
                            <InputNumber
                              value={rowData.sgstAmount}
                              onValueChange={(e) => updateItem(rowIndex, 'sgstAmount', e.value)}
                              mode="decimal"
                              minFractionDigits={2}
                              maxFractionDigits={2}
                              className={`${styles.tableInput} ${styles.tableInputNarrowAmt}`}
                              placeholder="0.00"
                              prefix="₹ "
                            />
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellRight + ' ' + styles.lineItemsCellBold}>
                            {itemTotalAmountBodyTemplate(rowData)}
                          </div>
                          <div className={styles.lineItemsCell + ' ' + styles.lineItemsCellCenter}>
                            <Button
                              icon="pi pi-trash"
                              className={styles.deleteItemButton}
                              onClick={() => removeItem(rowIndex)}
                              tooltip="Remove item"
                            />
                          </div>
                        </div>
                      ))
                    )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons - After Line Items */}
        <div className={styles.actionButtonsContainer}>
          <div className={styles.formActions}>
            <Button
              label="Cancel"
              icon="pi pi-times"
              className={styles.cancelButton}
              onClick={confirmRemoveFile}
              disabled={!pdfFile}
            />
            <Button
              label="Validate"
              icon="pi pi-check-circle"
              className={styles.validateButton}
              loading={validating}
              onClick={handleValidate}
              disabled={!pdfFile || validating || validationConfirmed}
            />
            <Button
              label="Save Invoice"
              icon="pi pi-save"
              className={styles.saveButton}
              loading={loading}
              onClick={handleSave}
              disabled={!pdfFile || loading || !validationConfirmed}
            />
          </div>
        </div>

        {/* Validation Dialog */}
        <Dialog
          header="Invoice Validation Results"
          visible={validationDialogVisible}
          style={{ width: '900px', maxWidth: '90vw' }}
          onHide={() => setValidationDialogVisible(false)}
          footer={
            <div>
              <Button
                label="Close"
                icon="pi pi-times"
                onClick={() => setValidationDialogVisible(false)}
                className="p-button-text"
              />
              <Button
                label="Confirm & Proceed"
                icon="pi pi-check"
                onClick={handleValidationConfirm}
                disabled={!validationResults?.overall?.valid}
                className="p-button-success"
              />
            </div>
          }
        >
          {validationResults && (
            <div className={styles.validationResults}>
              <div className={`${styles.validationSection} ${validationResults.poDetails.valid ? styles.valid : styles.invalid}`}>
                <h4>
                  <i className={`pi ${validationResults.poDetails.valid ? 'pi-check-circle' : 'pi-times-circle'}`}></i>
                  Purchase Order Details
                </h4>
                {validationResults.poDetails.valid ? (
                  <div className={styles.validationData}>
                    <p><strong>PO Number:</strong> {validationResults.poDetails.data.poNumber}</p>
                    <p><strong>PO Date:</strong> {validationResults.poDetails.data.poDate}</p>
                    <p><strong>Supplier:</strong> {validationResults.poDetails.data.supplierName}</p>
                    <p><strong>Bill To:</strong> {validationResults.poDetails.data.billTo}</p>
                  </div>
                ) : (
                  <ul className={styles.validationErrors}>
                    {validationResults.poDetails.errors.map((err: string, idx: number) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className={`${styles.validationSection} ${validationResults.poLineDetails.valid ? styles.valid : styles.invalid}`}>
                <h4>
                  <i className={`pi ${validationResults.poLineDetails.valid ? 'pi-check-circle' : 'pi-times-circle'}`}></i>
                  PO Line Items
                </h4>
                {validationResults.poLineDetails.valid ? (
                  <div className={styles.validationData}>
                    <p><strong>Total Items:</strong> {validationResults.poLineDetails.data.totalItems}</p>
                  </div>
                ) : (
                  <ul className={styles.validationErrors}>
                    {validationResults.poLineDetails.errors.map((err: string, idx: number) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className={`${styles.validationSection} ${validationResults.invoiceDetails.valid ? styles.valid : styles.invalid}`}>
                <h4>
                  <i className={`pi ${validationResults.invoiceDetails.valid ? 'pi-check-circle' : 'pi-times-circle'}`}></i>
                  Invoice Details
                </h4>
                {validationResults.invoiceDetails.valid ? (
                  <div className={styles.validationData}>
                    <p><strong>Invoice Number:</strong> {validationResults.invoiceDetails.data.invoiceNumber}</p>
                    <p><strong>Invoice Date:</strong> {validationResults.invoiceDetails.data.invoiceDate?.toLocaleDateString()}</p>
                    <p><strong>Total Amount:</strong> ₹{validationResults.invoiceDetails.data.totalAmount}</p>
                    <p><strong>Line Items:</strong> {validationResults.invoiceDetails.data.totalItems}</p>
                  </div>
                ) : (
                  <ul className={styles.validationErrors}>
                    {validationResults.invoiceDetails.errors.map((err: string, idx: number) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Line Items Comparison */}
              {validationResults.poLineDetails.valid && validationResults.invoiceDetails.valid && 
               validationResults.poLineDetails.data.items && validationResults.invoiceDetails.data.items && (
                <div className={styles.validationSection}>
                  <h4>
                    <i className="pi pi-list"></i>
                    Line Items Comparison: PO vs Invoice
                  </h4>
                  <div className={styles.lineItemsComparison}>
                    <div className={styles.comparisonTable}>
                      <div className={styles.comparisonHeader}>
                        <div className={styles.comparisonCol}>#</div>
                        <div className={styles.comparisonCol}>Item Name</div>
                        <div className={styles.comparisonCol}>Quantity</div>
                        <div className={styles.comparisonCol}>Rate/Price</div>
                        <div className={styles.comparisonCol}>Status</div>
                      </div>
                      {Array.from({ length: Math.max(validationResults.poLineDetails.data.items.length, validationResults.invoiceDetails.data.items.length) }, (_, index) => {
                        const poItem = validationResults.poLineDetails.data.items[index] || null
                        const invItem = validationResults.invoiceDetails.data.items[index] || null
                        const poQty = poItem?.quantity ?? null
                        const invQty = invItem?.quantity ?? null
                        const poRate = (poItem as { unitPrice?: number | null })?.unitPrice ?? null
                        const invRate = invItem?.unitPrice ?? null

                        // Compare quantity and rate/price (use invoice quantity so INV. QTY from OCR is used when user didn't enter COUNT)
                        const quantityMatch = poItem && invItem
                          ? Math.abs((poQty ?? 0) - (invQty ?? 0)) < 0.01
                          : false
                        // Rate: match when both missing, or both present and equal. If PO has no rate, don't fail (accept invoice rate).
                        const rateMatch = poItem && invItem
                          ? (poRate == null && invRate == null) || (poRate != null && invRate != null && Math.abs(poRate - invRate) < 0.01)
                          : false

                        const isMatch = quantityMatch && rateMatch
                        const hasMismatch = poItem && invItem && !isMatch
                        const isMissing = !poItem || !invItem
                        
                        return (
                          <div key={index} className={`${styles.comparisonRow} ${isMatch ? styles.matchRow : hasMismatch ? styles.mismatchRow : styles.missingRow}`}>
                            <div className={styles.comparisonCol}>{index + 1}</div>
                            <div className={styles.comparisonCol}>
                              <div className={styles.poValue}>{poItem?.itemName || '-'}</div>
                              <div className={styles.invValue}>{invItem?.itemName || '-'}</div>
                            </div>
                            <div className={styles.comparisonCol}>
                              <div className={styles.poValue}>{poItem?.quantity != null ? poItem.quantity : '-'}</div>
                              <div className={styles.invValue}>{invItem?.quantity != null ? invItem.quantity : '-'}</div>
                            </div>
                            <div className={styles.comparisonCol}>
                              <div className={styles.poValue}>
                                {(poItem as { unitPrice?: number | null })?.unitPrice != null
                                  ? `₹${Number((poItem as { unitPrice?: number }).unitPrice).toFixed(2)}`
                                  : '-'}
                              </div>
                              <div className={styles.invValue}>
                                {invItem?.unitPrice != null ? `₹${Number(invItem.unitPrice).toFixed(2)}` : '-'}
                              </div>
                            </div>
                            <div className={styles.comparisonCol}>
                              {isMatch && <span className={styles.matchBadge}><i className="pi pi-check"></i> Match</span>}
                              {hasMismatch && <span className={styles.mismatchBadge}><i className="pi pi-exclamation-triangle"></i> Mismatch</span>}
                              {isMissing && <span className={styles.missingBadge}><i className="pi pi-minus"></i> Missing</span>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className={styles.comparisonLegend}>
                      <div className={styles.legendItem}>
                        <span className={styles.matchBadge}><i className="pi pi-check"></i> Match</span>
                        <span>Quantity and Rate/Price match between PO and Invoice</span>
                      </div>
                      <div className={styles.legendItem}>
                        <span className={styles.mismatchBadge}><i className="pi pi-exclamation-triangle"></i> Mismatch</span>
                        <span>Quantity or Rate/Price differs between PO and Invoice</span>
                      </div>
                      <div className={styles.legendItem}>
                        <span className={styles.missingBadge}><i className="pi pi-minus"></i> Missing</span>
                        <span>Item exists in one but not the other</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className={`${styles.validationSection} ${validationResults.supplierDetails.valid ? styles.valid : styles.invalid}`}>
                <h4>
                  <i className={`pi ${validationResults.supplierDetails.valid ? 'pi-check-circle' : 'pi-times-circle'}`}></i>
                  Supplier Details
                </h4>
                {validationResults.supplierDetails.valid ? (
                  <div className={styles.validationData}>
                    <p><strong>Supplier:</strong> {validationResults.supplierDetails.data.supplierName}</p>
                    <p><strong>GST:</strong> {validationResults.supplierDetails.data.gstNumber}</p>
                    <p><strong>PAN:</strong> {validationResults.supplierDetails.data.panNumber}</p>
                    <p><strong>Address:</strong> {validationResults.supplierDetails.data.address}</p>
                  </div>
                ) : (
                  <div>
                    {validationResults.supplierDetails.fetchedData && (
                      <div className={styles.validationData} style={{ marginBottom: '12px', padding: '12px', background: '#f8fafc', borderRadius: '4px' }}>
                        <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}><strong>Fetched from Database:</strong></p>
                        <p><strong>Supplier Name:</strong> {validationResults.supplierDetails.fetchedData.supplierName || 'N/A'}</p>
                        <p><strong>GST:</strong> {validationResults.supplierDetails.fetchedData.gstNumber || 'N/A'}</p>
                        <p><strong>PAN:</strong> {validationResults.supplierDetails.fetchedData.panNumber || 'N/A'}</p>
                        <p><strong>Address:</strong> {validationResults.supplierDetails.fetchedData.address || 'N/A'}</p>
                        <p><strong>Email:</strong> {validationResults.supplierDetails.fetchedData.email || 'N/A'}</p>
                        <p><strong>Mobile:</strong> {validationResults.supplierDetails.fetchedData.mobile || 'N/A'}</p>
                      </div>
                    )}
                    <ul className={styles.validationErrors}>
                      {validationResults.supplierDetails.errors.map((err: string, idx: number) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className={`${styles.validationSection} ${validationResults.bankDetails.valid ? styles.valid : styles.invalid}`}>
                <h4>
                  <i className={`pi ${validationResults.bankDetails.valid ? 'pi-check-circle' : 'pi-times-circle'}`}></i>
                  Bank Details
                </h4>
                {validationResults.bankDetails.valid ? (
                  <div className={styles.validationData}>
                    <p><strong>Account Number:</strong> {validationResults.bankDetails.data.accountNumber}</p>
                    <p><strong>IFSC Code:</strong> {validationResults.bankDetails.data.ifscCode}</p>
                    <p><strong>Bank:</strong> {validationResults.bankDetails.data.bankName}</p>
                    <p><strong>Branch:</strong> {validationResults.bankDetails.data.branchName}</p>
                  </div>
                ) : (
                  <div>
                    {validationResults.bankDetails.fetchedData && (
                      <div className={styles.validationData} style={{ marginBottom: '12px', padding: '12px', background: '#f8fafc', borderRadius: '4px' }}>
                        <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}><strong>Fetched from Database:</strong></p>
                        <p><strong>Account Number:</strong> {validationResults.bankDetails.fetchedData.accountNumber || 'N/A'}</p>
                        <p><strong>IFSC Code:</strong> {validationResults.bankDetails.fetchedData.ifscCode || 'N/A'}</p>
                        <p><strong>Bank Name:</strong> {validationResults.bankDetails.fetchedData.bankName || 'N/A'}</p>
                        <p><strong>Branch Name:</strong> {validationResults.bankDetails.fetchedData.branchName || 'N/A'}</p>
                        <p><strong>Account Name:</strong> {validationResults.bankDetails.fetchedData.accountName || 'N/A'}</p>
                      </div>
                    )}
                    <ul className={styles.validationErrors}>
                      {validationResults.bankDetails.errors.map((err: string, idx: number) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className={`${styles.validationOverall} ${validationResults.overall.valid ? styles.valid : styles.invalid}`}>
                <h3>
                  <i className={`pi ${validationResults.overall.valid ? 'pi-check-circle' : 'pi-times-circle'}`}></i>
                  {validationResults.overall.valid ? 'All Validations Passed' : 'Validation Failed'}
                </h3>
                {!validationResults.overall.valid && (
                  <p>Please fix the errors above before confirming.</p>
                )}
              </div>
            </div>
          )}
        </Dialog>

        {/* Weight Slip Scanning Dialog */}
        <Dialog
          header="Scan Weight Slip"
          visible={weightSlipDialogVisible}
          style={{ width: '600px', maxWidth: '90vw' }}
          onHide={() => {
            setWeightSlipDialogVisible(false)
            setWeightSlipFile(null)
          }}
          footer={
            <div>
              <Button
                label="Cancel"
                icon="pi pi-times"
                onClick={() => {
                  setWeightSlipDialogVisible(false)
                  setWeightSlipFile(null)
                }}
                className="p-button-text"
              />
            </div>
          }
        >
          <div style={{ padding: '1rem' }}>
            <p style={{ marginBottom: '1rem', color: '#64748b' }}>
              Scanned Weight is filled only from the uploaded document. Upload a weight slip PDF to extract and fill the weight value for this line.
            </p>
            
            {extractingWeight ? (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <ProgressSpinner />
                <p style={{ marginTop: '1rem' }}>Extracting weight from slip...</p>
              </div>
            ) : (
              <div>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={handleWeightSlipFileSelect}
                  style={{ display: 'none' }}
                  id="weight-slip-input"
                />
                <label htmlFor="weight-slip-input">
                  <Button
                    label="Choose Weight Slip PDF"
                    icon="pi pi-upload"
                    onClick={() => document.getElementById('weight-slip-input')?.click()}
                    className="p-button-primary"
                    style={{ width: '100%' }}
                  />
                </label>
                {weightSlipFile && (
                  <div style={{ marginTop: '1rem', padding: '0.5rem', background: '#f8fafc', borderRadius: '4px' }}>
                    <i className="pi pi-file"></i>
                    <span style={{ marginLeft: '0.5rem' }}>{weightSlipFile.name}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </Dialog>
      </div>
    </div>
  )
}
