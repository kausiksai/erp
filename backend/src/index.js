import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import cors from 'cors'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import rateLimit from 'express-rate-limit'
import { pool } from './db.js'
import multer from 'multer'
import { extractWithQwen } from './qwenService.js'
import { hashPassword, comparePassword, generateToken, authenticateToken, authorize } from './auth.js'
import {
  getUsersRoute,
  getUserByIdRoute,
  createUserRoute,
  updateUserRoute,
  deleteUserRoute,
  getUserMenuAccessRoute,
  updateUserMenuAccessRoute
} from './userManagement.js'
import {
  getOwnerDetailsRoute,
  updateOwnerDetailsRoute
} from './ownerDetails.js'
import {
  getSuppliersRoute,
  getSupplierByIdRoute,
  createSupplierRoute,
  updateSupplierRoute,
  deleteSupplierRoute
} from './supplierManagement.js'
import {
  getCumulativeQuantities,
  validateInvoiceAgainstPoGrn,
  runFullValidation,
  validateAndUpdateInvoiceStatus,
  applyStandardValidation,
  proceedToPaymentFromMismatch,
  moveToDebitNoteApproval,
  forceClosePo,
  exceptionApprove,
  debitNoteApprove,
  updatePoStatusFromCumulative
} from './poInvoiceValidation.js'
import { importPoExcel, importGrnExcel, importAsnExcel } from './excelImport.js'

const app = express()

// CORS: in production set FRONTEND_ORIGIN (e.g. https://app.example.com)
const corsOrigin = process.env.FRONTEND_ORIGIN || true
app.use(cors({ origin: corsOrigin }))

// Structured request logging (method, path, status, duration, timestamp)
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    if (process.env.NODE_ENV === 'production') {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs: duration
      }))
    } else {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`)
    }
  })
  next()
})

// General API rate limit (200 requests per 15 min per IP) – skip login so only loginLimiter applies
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 200,
  message: { error: 'too_many_requests', message: 'Too many requests, please try again later.' },
  skip: (req) => req.method === 'POST' && req.path === '/auth/login'
})

const jsonLimit = process.env.JSON_LIMIT || '25mb'
app.use(express.json({ limit: jsonLimit }))
app.use(express.urlencoded({ limit: jsonLimit, extended: true }))

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true)
    } else {
      cb(new Error('Only PDF files are allowed'), false)
    }
  }
})

// Multer for Excel uploads (PO, GRN, ASN)
const excelMimeTypes = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel'
]
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (excelMimeTypes.includes(file.mimetype) || file.originalname?.match(/\.(xlsx|xls)$/i)) {
      cb(null, true)
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false)
    }
  }
})

// Health check: includes DB connectivity (no prefix)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1 as ok')
    res.json({ status: 'ok', db: 'connected' })
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message })
  }
})

// Create API router for /api prefix routes
const router = express.Router()
router.use(apiLimiter)

/**
 * Parse extracted text/markdown to extract structured invoice data
 * Handles both JSON output from Qwen and text-based extraction
 */
function parseInvoiceData(extractedData) {
  const data = {
    // Header Fields
    invoiceNumber: '',
    invoiceDate: '',
    poNumber: '',
    supplierName: '',
    billTo: '',
    
    // Financial Summary
    subtotal: '',
    cgst: '',
    sgst: '',
    taxAmount: '',
    roundOff: '',
    totalAmount: '',
    totalAmountInWords: '',
    
    // Misc/Footer
    termsAndConditions: '',
    authorisedSignatory: '',
    receiverSignature: '',
    
    // Line Items
    items: []
  }
  
  // Ensure text is always a string
  let text = extractedData.text || extractedData.markdown || ''
  if (typeof text !== 'string') {
    // If it's an object, stringify it
    text = typeof text === 'object' ? JSON.stringify(text) : String(text)
  }
  
  // Try to parse JSON if Qwen returned structured data
  try {
    // Look for JSON in the response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const jsonData = JSON.parse(jsonMatch[0])
      if (jsonData.invoiceNumber || jsonData.items) {
        // Helper function to parse date strings (handles formats like "11-Aug-25", "DD-MMM-YY", etc.)
        const parseDate = (dateStr) => {
          if (!dateStr || dateStr === '') return ''
          if (typeof dateStr === 'string') {
            // Handle formats like "11-Aug-25", "11-Aug-2025", "DD-MMM-YY"
            const monthMap = {
              'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
              'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
              'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
            }
            
            // Try to match DD-MMM-YY or DD-MMM-YYYY format
            const dateMatch = dateStr.match(/(\d{1,2})[-.\/](\w{3,})[-.\/](\d{2,4})/i)
            if (dateMatch) {
              const day = dateMatch[1].padStart(2, '0')
              const monthStr = dateMatch[2].toLowerCase().substring(0, 3)
              const yearStr = dateMatch[3]
              const year = yearStr.length === 2 ? `20${yearStr}` : yearStr
              const month = monthMap[monthStr] || dateMatch[2].padStart(2, '0')
              return `${year}-${month}-${day}`
            }
            
            // If it's already in YYYY-MM-DD format, return as is
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
              return dateStr
            }
          }
          return dateStr
        }
        
        // Header Fields
        data.invoiceNumber = jsonData.invoiceNumber || ''
        data.invoiceDate = parseDate(jsonData.invoiceDate)
        // PO number: keep only the PO identifier (e.g. PO9251598), strip year/financial-year suffix like "/ 2025-26"
        const rawPo = (jsonData.poNumber || '').trim()
        data.poNumber = rawPo.replace(/\s*[\/\-]\s*(20\d{2}[-\s]?\d{2}|FY\s*\d{2}[-\s]?\d{2}).*$/i, '').trim() || rawPo
        data.supplierName = jsonData.supplierName || ''
        data.billTo = jsonData.billTo || ''
        
        // Helper function to parse numeric values (removes currency symbols, commas, and units)
        const parseNumeric = (value) => {
          if (!value || value === '') return null
          if (typeof value === 'number') return value
          const str = String(value).trim()
          // Remove currency symbols and commas so "3,130.00" and "₹55,361.00" parse correctly
          const cleaned = str.replace(/[₹$,€]/g, '').replace(/,/g, '')
          // Extract the full number (handles "240.700 Kgs", "3130.00", "55361.00")
          const numberMatch = cleaned.match(/(\d+\.?\d*)/)
          if (numberMatch) {
            const parsed = parseFloat(numberMatch[1])
            return isNaN(parsed) ? null : parsed
          }
          return null
        }
        
        // Helper function to parse percentage values (removes % sign)
        const parsePercentage = (value) => {
          if (!value || value === '') return null
          if (typeof value === 'number') return value
          const cleaned = String(value).replace(/%/g, '').trim()
          const parsed = parseFloat(cleaned)
          return isNaN(parsed) ? null : parsed
        }
        
        // Financial Summary - parse numeric values and handle subtotal (may be incorrectly set to quantity)
        data.subtotal = parseNumeric(jsonData.subtotal) !== null ? String(parseNumeric(jsonData.subtotal)) : ''
        // If subtotal looks like a quantity (has units), try to calculate from items instead
        if (jsonData.subtotal && /[A-Za-z]/.test(String(jsonData.subtotal))) {
          // Calculate subtotal from items if available
          const calculatedSubtotal = (jsonData.items || []).reduce((sum, item) => {
            const amount = parseNumeric(item.amount || item.lineTotal)
            return sum + (amount || 0)
          }, 0)
          data.subtotal = calculatedSubtotal > 0 ? String(calculatedSubtotal) : ''
        }
        data.cgst = parseNumeric(jsonData.cgst) !== null ? String(parseNumeric(jsonData.cgst)) : ''
        data.sgst = parseNumeric(jsonData.sgst) !== null ? String(parseNumeric(jsonData.sgst)) : ''
        data.taxAmount = parseNumeric(jsonData.taxAmount) !== null ? String(parseNumeric(jsonData.taxAmount)) : ''
        // If taxAmount is not provided, calculate from CGST + SGST
        if (!data.taxAmount && (data.cgst || data.sgst)) {
          const cgstVal = parseNumeric(data.cgst) || 0
          const sgstVal = parseNumeric(data.sgst) || 0
          data.taxAmount = String(cgstVal + sgstVal)
        }
        data.roundOff = parseNumeric(jsonData.roundOff) !== null ? String(parseNumeric(jsonData.roundOff)) : ''
        data.totalAmount = parseNumeric(jsonData.totalAmount) !== null ? String(parseNumeric(jsonData.totalAmount)) : ''
        data.totalAmountInWords = jsonData.totalAmountInWords || ''
        
        // Misc/Footer
        data.termsAndConditions = jsonData.termsAndConditions || ''
        data.authorisedSignatory = jsonData.authorisedSignatory || ''
        data.receiverSignature = jsonData.receiverSignature || ''
        
        // Line Items with tax details - properly map all fields
        data.items = (jsonData.items || []).map(item => ({
          itemName: item.itemName || '',
          // Parse quantity - extract number from strings like "240.700 Kgs"
          quantity: parseNumeric(item.quantity),
          // Parse unit price
          unitPrice: parseNumeric(item.unitPrice),
          // Map 'amount' to 'lineTotal' if lineTotal is not present
          lineTotal: parseNumeric(item.lineTotal || item.amount),
          itemCode: item.itemCode || item.hsnSac || '',
          hsnSac: item.hsnSac || item.itemCode || '',
          taxableValue: parseNumeric(item.taxableValue),
          // Parse CGST rate - handle both "cgstRate" and "cgstPercent" fields, remove % sign
          cgstRate: parsePercentage(item.cgstRate || item.cgstPercent),
          cgstAmount: parseNumeric(item.cgstAmount),
          // Parse SGST rate - handle both "sgstRate" and "sgstPercent" fields, remove % sign
          sgstRate: parsePercentage(item.sgstRate || item.sgstPercent),
          sgstAmount: parseNumeric(item.sgstAmount),
          totalTaxAmount: parseNumeric(item.totalTaxAmount)
        }))
        
        return data
      }
    }
  } catch (e) {
  }
  
  // Fallback: Regex-based extraction
  const originalText = text.replace(/\s+/g, ' ')
  
  // Extract invoice number
  const invoiceNoPatterns = [
    /(?:invoice\s*#?|invoice\s*number|inv\s*no|bill\s*no|invoice\s*id|invoice\s*no\.)[\s:]*([A-Z0-9\/\-]+(?:\/\d{2,}-\d{2,}\/\d+)?)/i,
    /\b([A-Z]{2,6}\/\d{2,}-\d{2,}\/\d+)\b/,
    /invoice[^\w]*([A-Z0-9\/\-]{8,20})/i,
  ]
  
  for (const pattern of invoiceNoPatterns) {
    const match = originalText.match(pattern)
    if (match && match[1]) {
      data.invoiceNumber = match[1].trim()
      break
    }
  }
  
  // Extract date - handles DD-MM-YY, DD-MMM-YY, YYYY-MM-DD formats
  const datePatterns = [
    /(?:date|invoice\s*date|dated)[\s:]*(\d{1,2}[-.\/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-.\/]\d{2,4})/i,
    /(?:date|invoice\s*date|dated)[\s:]*(\d{1,2}[-.\/]\d{1,2}[-.\/]\d{2,4})/i,
    /(?:date|invoice\s*date)[\s:]*(\d{4}[-.\/]\d{1,2}[-.\/]\d{1,2})/i,
  ]
  
  const monthMap = {
    'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
    'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
    'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
  }
  
  for (const pattern of datePatterns) {
    const match = originalText.match(pattern)
    if (match && match[1]) {
      const dateStr = match[1].trim()
      const parts = dateStr.split(/[-\/]/)
      if (parts.length === 3) {
        let day, month, year
        if (parts[2].length === 4) {
          // YYYY-MM-DD format
          year = parts[2]
          month = parts[1].padStart(2, '0')
          day = parts[0].padStart(2, '0')
        } else {
          // DD-MM-YY or DD-MMM-YY format
          day = parts[0].padStart(2, '0')
          year = '20' + parts[2]
          
          // Check if month is a name (e.g., Aug, Jan)
          const monthStr = parts[1].toLowerCase().substring(0, 3)
          if (monthMap[monthStr]) {
            month = monthMap[monthStr]
          } else {
            // Numeric month
            month = parts[1].padStart(2, '0')
          }
        }
        data.invoiceDate = `${year}-${month}-${day}`
        break
      }
    }
  }
  
  // Extract supplier name
  const supplierPatterns = [
    /(?:supplier|vendor|from|billed\s*by|seller)[\s:]*([A-Z][a-zA-Z\s&]{10,60})/i,
    /^([A-Z][a-zA-Z\s&]{10,60})(?:\s+No\.|\s+Address|\s+GST)/m,
  ]
  
  for (const pattern of supplierPatterns) {
    const match = originalText.match(pattern)
    if (match && match[1]) {
      data.supplierName = match[1].trim().split('\n')[0].trim()
      if (data.supplierName.length > 5 && data.supplierName.length < 100) {
        break
      }
    }
  }
  
  // Extract totals
  const totalPatterns = [
    /(?:total|grand\s*total|amount\s*payable|total\s*amount)[\s:]*[€₹]?\s*([\d,]+\.?\d{0,2})/i,
    /\b[€₹]\s*([\d,]+\.?\d{0,2})\b/,
  ]
  
  for (const pattern of totalPatterns) {
    const match = originalText.match(pattern)
    if (match && match[1]) {
      const totalStr = match[1].replace(/[€₹$,\s]/g, '').trim()
      if (totalStr && !isNaN(totalStr)) {
        data.totalAmount = totalStr
        break
      }
    }
  }
  
  // Extract tax amount
  const taxPatterns = [
    /(?:tax\s*amount|total\s*tax|cgst\s*\+\s*sgst)[\s:]*([\d,]+\.?\d{0,2})/i,
  ]
  
  for (const pattern of taxPatterns) {
    const match = originalText.match(pattern)
    if (match && match[1]) {
      data.taxAmount = match[1].replace(/[,]/g, '')
      break
    }
  }
  
  // Extract line items from markdown tables or text
  const lines = text.split('\n')
  const items = []
  let inTable = false
  
  for (const line of lines) {
    // Look for table rows
    if (line.includes('|') && line.split('|').length > 3) {
      inTable = true
      const cells = line.split('|').map(c => c.trim()).filter(c => c)
      if (cells.length >= 4 && !cells[0].toLowerCase().match(/^(item|description|qty|quantity|rate|price|amount|total)/i)) {
        // Try to extract item data
        const itemName = cells[0] || cells[1] || ''
        const qty = cells.find(c => /^\d+\.?\d*$/.test(c)) || ''
        const price = cells.find(c => /^\d+\.\d{2}$/.test(c)) || ''
        const total = cells[cells.length - 1] || ''
        
        if (itemName && itemName.length > 2 && !itemName.toLowerCase().includes('total')) {
          items.push({
            itemName: itemName.trim(),
            quantity: qty ? parseFloat(qty) : null,
            unitPrice: price ? parseFloat(price) : null,
            lineTotal: total ? parseFloat(total.replace(/[,]/g, '')) : null,
            itemCode: ''
          })
        }
      }
    }
  }
  
  data.items = items
  
  return data
}

// Upload invoice and extract data (NO DATABASE WRITES - only extraction)
router.post('/invoices/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'PDF file is required' })
    }
    
    const pdfBuffer = req.file.buffer
    
    // Comprehensive prompt for extracting all invoice fields
    const invoicePrompt = `Extract ALL invoice information from this document. 
    Return the data in JSON format with the following complete structure:
    {
      "invoiceNumber": "invoice number or ID",
      "invoiceDate": "date in YYYY-MM-DD format",
      "supplierName": "supplier or vendor name",
      "billTo": "bill to customer/company name",
      "items": [
        {
          "itemName": "item/service description",
          "quantity": "quantity as number",
          "unitPrice": "unit price/rate as number",
          "lineTotal": "line total/amount as number",
          "itemCode": "HSN/SAC code",
          "hsnSac": "HSN/SAC code (alternative)",
          "taxableValue": "taxable value for this item",
          "cgstRate": "CGST rate percentage",
          "cgstAmount": "CGST amount for this item",
          "sgstRate": "SGST rate percentage",
          "sgstAmount": "SGST amount for this item",
          "totalTaxAmount": "total tax amount for this item"
        }
      ],
      "subtotal": "subtotal before tax",
      "cgst": "total CGST amount",
      "sgst": "total SGST amount",
      "taxAmount": "total tax amount (CGST + SGST)",
      "roundOff": "round off amount if available",
      "totalAmount": "grand total amount",
      "totalAmountInWords": "total amount in words",
      "termsAndConditions": "terms and conditions text",
      "authorisedSignatory": "authorised signatory name",
      "receiverSignature": "receiver signature name if available"
    }
    Extract ALL fields visible in the invoice. Extract all line items from tables with complete tax details. Be precise with numbers and dates.`
    
    let extractedData
    let extractionSuccess = false
    
    try {
      extractedData = await extractWithQwen(pdfBuffer, req.file.originalname, invoicePrompt)
      extractionSuccess = true
      const textLength = typeof extractedData.text === 'string' ? extractedData.text.length : 'N/A'
    } catch (err) {
      // Continue without extraction - user can manually enter data
      extractedData = {
        text: '',
        markdown: '',
        extracted: false
      }
    }
    
    // Parse the extracted text to get structured invoice data
    const invoiceData = extractionSuccess ? parseInvoiceData(extractedData) : {
      invoiceNumber: '',
      invoiceDate: '',
      poNumber: '',
      supplierName: '',
      billTo: '',
      subtotal: '',
      cgst: '',
      sgst: '',
      taxAmount: '',
      roundOff: '',
      totalAmount: '',
      totalAmountInWords: '',
      termsAndConditions: '',
      authorisedSignatory: '',
      receiverSignature: '',
      items: []
    }
    
    // NO DATABASE WRITES - Just extract and return data
    // Data will only be saved when "Save Invoice" button is clicked
    
    // Get PO ID if PO number was validated (for reference only, not saved yet)
    let poId = null
    const poNumber = req.body.poNumber || req.query.poNumber
    if (poNumber) {
      const poResult = await pool.query(
        'SELECT po_id FROM purchase_orders WHERE po_number = $1',
        [poNumber]
      )
      if (poResult.rows.length > 0) {
        poId = poResult.rows[0].po_id
      }
    }
    
    // Get supplier ID if supplier exists (for reference only, not saved yet)
    let supplierId = null
    if (invoiceData.supplierName) {
      const supplierResult = await pool.query(
        `SELECT supplier_id FROM suppliers WHERE supplier_name = $1 LIMIT 1`,
        [invoiceData.supplierName]
      )
      if (supplierResult.rows.length > 0) {
        supplierId = supplierResult.rows[0].supplier_id
      }
    }
    
    // Prepare response with all fields (NO invoiceId - will be created on save)
    const responseData = {
      success: true,
      invoiceId: null, // No invoice created yet - will be created when Save Invoice is clicked
      poId: poId, // For reference
      supplierId: supplierId, // For reference
      pdfFileName: req.file.originalname,
      pdfBuffer: pdfBuffer.toString('base64'), // Store PDF as base64 for later saving
      invoiceData: {
        // Header Fields
        invoiceNumber: invoiceData.invoiceNumber || '',
        invoiceDate: invoiceData.invoiceDate || null,
        poNumber: invoiceData.poNumber || '',
        supplierName: invoiceData.supplierName || '',
        billTo: invoiceData.billTo || '',
        
        // Financial Summary
        subtotal: invoiceData.subtotal || '',
        cgst: invoiceData.cgst || '',
        sgst: invoiceData.sgst || '',
        taxAmount: invoiceData.taxAmount || '',
        roundOff: invoiceData.roundOff || '',
        totalAmount: invoiceData.totalAmount || '',
        totalAmountInWords: invoiceData.totalAmountInWords || '',
        
        // Misc/Footer
        termsAndConditions: invoiceData.termsAndConditions || '',
        authorisedSignatory: invoiceData.authorisedSignatory || '',
        receiverSignature: invoiceData.receiverSignature || '',
        
        // Line Items with tax details
        items: (invoiceData.items || []).map(item => ({
          itemName: item.itemName || '',
          itemCode: item.itemCode || item.hsnSac || '',
          hsnSac: item.hsnSac || item.itemCode || '',
          quantity: item.quantity || null,
          unitPrice: item.unitPrice || null,
          lineTotal: item.lineTotal || null,
          taxableValue: item.taxableValue || null,
          cgstRate: item.cgstRate || null,
          cgstAmount: item.cgstAmount || null,
          sgstRate: item.sgstRate || null,
          sgstAmount: item.sgstAmount || null,
          totalTaxAmount: item.totalTaxAmount || null
        }))
      },
      extracted: extractionSuccess,
      model: extractionSuccess ? (extractedData.model || 'Qwen2.5-VL') : 'none'
    }
    
    res.json(responseData)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Health check for Qwen service
router.get('/qwen/health', async (req, res) => {
  try {
    const { checkQwenHealth } = await import('./qwenService.js')
    const health = await checkQwenHealth()
    res.json(health)
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message })
  }
})

// Extract weight from weight slip PDF
router.post('/invoices/extract-weight', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'PDF file is required' })
    }
    
    const pdfBuffer = req.file.buffer
    
    try {
      const { extractWeightFromPDF } = await import('./qwenService.js')
      const weightResult = await extractWeightFromPDF(pdfBuffer, req.file.originalname)
      
      res.json({
        success: true,
        weight: weightResult.weight || null
      })
    } catch (err) {
      console.error('Weight extraction error:', err)
      res.status(500).json({ 
        success: false,
        error: 'Weight extraction failed',
        weight: null
      })
    }
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// ============================================
// Authentication Routes
// ============================================

// Register a new user
router.post('/auth/register', async (req, res) => {
  try {
    const { username, email, password, fullName, role = 'user' } = req.body

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'validation_error', message: 'Username, email, and password are required' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'validation_error', message: 'Password must be at least 6 characters' })
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT user_id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    )

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'conflict', message: 'Username or email already exists' })
    }

    // Hash password
    const passwordHash = await hashPassword(password)

    // Create user
    const { rows } = await pool.query(
      `INSERT INTO users (username, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, username, email, role, full_name, created_at`,
      [username, email, passwordHash, fullName || null, role]
    )

    const user = rows[0]

    // Generate token
    const token = generateToken(user)

    res.status(201).json({
      success: true,
      token,
      user: {
        userId: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        fullName: user.full_name
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Stricter rate limit for login (10 attempts per 15 min per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
  message: { error: 'too_many_attempts', message: 'Too many login attempts. Please try again later.' }
})

// Login
router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body

    // Validation
    if (!username || !password) {
      return res.status(400).json({ error: 'validation_error', message: 'Username and password are required' })
    }

    // Find user by username or email
    const { rows } = await pool.query(
      'SELECT user_id, username, email, password_hash, role, full_name, is_active FROM users WHERE username = $1 OR email = $1',
      [username]
    )

    if (rows.length === 0) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid username or password' })
    }

    const user = rows[0]

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({ error: 'forbidden', message: 'Account is inactive' })
    }

    // Verify password
    const isValidPassword = await comparePassword(password, user.password_hash)
    if (!isValidPassword) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid username or password' })
    }

    // Update last login
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE user_id = $1',
      [user.user_id]
    )
    const { rows: lastLoginRows } = await pool.query(
      'SELECT last_login FROM users WHERE user_id = $1',
      [user.user_id]
    )
    const lastLogin = lastLoginRows[0]?.last_login ?? null

    // Generate token
    const token = generateToken(user)

    res.json({
      success: true,
      token,
      user: {
        userId: user.user_id,
        username: user.username,
        email: user.email,
        role: user.role,
        fullName: user.full_name,
        lastLogin: lastLogin ? lastLogin.toISOString() : null
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get current user (protected route)
router.get('/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT user_id, username, email, role, full_name, is_active, last_login, created_at FROM users WHERE user_id = $1',
      [req.user.user_id]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'User not found' })
    }

    res.json({
      userId: rows[0].user_id,
      username: rows[0].username,
      email: rows[0].email,
      role: rows[0].role,
      fullName: rows[0].full_name,
      isActive: rows[0].is_active,
      lastLogin: rows[0].last_login,
      createdAt: rows[0].created_at
    })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Invoices pending debit note approval – must be before /invoices/:id so "pending-debit-note" is not treated as id
router.get('/invoices/pending-debit-note', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), async (req, res) => {
  try {
    // Query invoices first (no dependency on debit_notes table – works even if table not created yet)
    // Match both 'debit_note_approval' and human-readable variants like 'Debit Note Approval'
    const { rows } = await pool.query(
      `SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.total_amount, i.status,
              i.po_id, po.po_number, COALESCE(s.supplier_name, '') AS supplier_name
       FROM invoices i
       LEFT JOIN purchase_orders po ON po.po_id = i.po_id
       LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
       WHERE REPLACE(LOWER(TRIM(COALESCE(i.status, ''))), ' ', '_') = 'debit_note_approval'
       ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_id DESC`
    )
    // Optionally attach debit note file names from debit_notes table (if table exists)
    let fileNamesByInvoice = {}
    try {
      const { rows: dnRows } = await pool.query(
        `SELECT invoice_id, file_name FROM debit_notes ORDER BY uploaded_at DESC`
      )
      for (const r of dnRows) {
        if (fileNamesByInvoice[r.invoice_id] == null) fileNamesByInvoice[r.invoice_id] = r.file_name
      }
    } catch (_dnErr) {
      // debit_notes table may not exist yet – ignore, list still works
    }
    const result = []
    for (const inv of rows) {
      const validation = await validateInvoiceAgainstPoGrn(inv.invoice_id)
      result.push({
        ...inv,
        debit_note_file_name: fileNamesByInvoice[inv.invoice_id] || null,
        validation: {
          reason: validation.validationFailureReason || validation.reason,
          thisInvQty: validation.thisInvQty,
          poQty: validation.poQty,
          grnQty: validation.grnQty
        }
      })
    }
    res.json(result)
  } catch (err) {
    console.error('Pending debit note list error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Exception invoices: received after PO was already fulfilled – must be before /invoices/:id
router.get('/invoices/pending-exception', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.total_amount, i.status,
              i.po_id, po.po_number, COALESCE(s.supplier_name, '') AS supplier_name
       FROM invoices i
       LEFT JOIN purchase_orders po ON po.po_id = i.po_id
       LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
       WHERE LOWER(TRIM(COALESCE(i.status, ''))) = 'exception_approval'
       ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_id DESC`
    )
    const result = []
    for (const inv of rows) {
      const validation = await validateInvoiceAgainstPoGrn(inv.invoice_id)
      result.push({
        ...inv,
        validation: {
          reason: validation.reason || 'PO already fulfilled; invoice received after PO was closed.'
        }
      })
    }
    res.json(result)
  } catch (err) {
    console.error('Pending exception list error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// List invoice attachments (invoice PDF from invoice_attachments + weight slips from invoice_weight_attachments)
router.get('/invoices/:id/attachments', async (req, res) => {
  try {
    const { id } = req.params
    const [invRows, weightRows] = await Promise.all([
      pool.query(
        `SELECT id, file_name, 'invoice' AS attachment_type, uploaded_at
         FROM invoice_attachments
         WHERE invoice_id = $1 AND COALESCE(attachment_type, 'invoice') = 'invoice'
         ORDER BY uploaded_at`,
        [id]
      ),
      pool.query(
        `SELECT w.id, w.file_name, 'weight_slip' AS attachment_type, w.uploaded_at
         FROM invoice_weight_attachments w
         JOIN invoice_lines l ON l.invoice_line_id = w.invoice_line_id
         WHERE l.invoice_id = $1
         ORDER BY l.sequence_number, w.uploaded_at`,
        [id]
      )
    ])
    const list = [
      ...invRows.rows.map(r => ({ ...r, attachment_type: 'invoice' })),
      ...weightRows.rows.map(r => ({ ...r, attachment_type: 'weight_slip' }))
    ].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at))
    res.json(list)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get one attachment by type and id (view or download). type = 'invoice' | 'weight_slip'
router.get('/invoices/:id/attachments/:type/:attachmentId', async (req, res) => {
  try {
    const { id, type, attachmentId } = req.params
    const download = req.query.download === '1' || req.query.download === 'true'
    let rows
    if (type === 'invoice') {
      const r = await pool.query(
        `SELECT file_name, file_data FROM invoice_attachments
         WHERE invoice_id = $1 AND id = $2`,
        [id, attachmentId]
      )
      rows = r.rows
    } else if (type === 'weight_slip') {
      const r = await pool.query(
        `SELECT w.file_name, w.file_data
         FROM invoice_weight_attachments w
         JOIN invoice_lines l ON l.invoice_line_id = w.invoice_line_id
         WHERE l.invoice_id = $1 AND w.id = $2`,
        [id, attachmentId]
      )
      rows = r.rows
    } else {
      return res.status(400).json({ error: 'invalid_type', message: 'type must be invoice or weight_slip' })
    }
    if (rows.length === 0 || !rows[0].file_data) {
      return res.status(404).json({ error: 'not_found' })
    }
    const disposition = download ? 'attachment' : 'inline'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `${disposition}; filename="${rows[0].file_name}"`)
    res.send(rows[0].file_data)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get invoice PDF (main invoice attachment)
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params
    const { rows } = await pool.query(
      `SELECT file_name, file_data FROM invoice_attachments 
       WHERE invoice_id = $1 AND COALESCE(attachment_type, 'invoice') = 'invoice'
       ORDER BY uploaded_at DESC 
       LIMIT 1`,
      [id]
    )
    
    if (rows.length === 0 || !rows[0].file_data) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].file_name}"`)
    res.send(rows[0].file_data)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get debit note PDF for an invoice
router.get('/invoices/:id/debit-note-pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params
    const { rows } = await pool.query(
      `SELECT file_name, file_data FROM debit_notes
       WHERE invoice_id = $1
       ORDER BY uploaded_at DESC LIMIT 1`,
      [id]
    )
    if (rows.length === 0 || !rows[0].file_data) {
      return res.status(404).json({ error: 'not_found' })
    }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].file_name}"`)
    res.send(rows[0].file_data)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Upload debit note PDF for an invoice
router.post('/invoices/:id/debit-note-pdf', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), upload.single('pdf'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'PDF file is required' })
    }
    const fileName = req.file.originalname || `debit-note-${id}.pdf`
    const buffer = req.file.buffer

    await pool.query(`DELETE FROM debit_notes WHERE invoice_id = $1`, [id])
    await pool.query(
      `INSERT INTO debit_notes (invoice_id, file_name, file_data)
       VALUES ($1, $2, $3)`,
      [id, fileName, buffer]
    )
    res.json({ success: true, file_name: fileName })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get invoice details
router.get('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { rows: invoiceRows } = await pool.query(
      `SELECT 
         i.*,
         s.supplier_name,
         s.gst_number as supplier_gst,
         s.pan_number as supplier_pan,
         s.supplier_address,
         s.city as supplier_city,
         s.state_code as supplier_state_code,
         s.state_name as supplier_state_name,
         s.pincode as supplier_pincode,
         s.email as supplier_email,
         s.phone as supplier_phone,
         s.mobile as supplier_mobile,
         s.msme_number as supplier_msme_number,
         s.website as supplier_website,
         s.contact_person as supplier_contact_person,
         s.bank_account_name as supplier_bank_account_name,
         s.bank_account_number as supplier_bank_account_number,
         s.bank_ifsc_code as supplier_bank_ifsc_code,
         s.bank_name as supplier_bank_name,
         s.branch_name as supplier_branch_name,
         po.po_id,
         po.po_number,
         po.date AS po_date,
         po.unit as po_unit,
         po.ref_unit as po_ref_unit,
         po.pfx as po_pfx,
         po.amd_no as po_amd_no,
         po.terms as po_terms,
         NULL::TEXT AS bill_to,
         NULL::TEXT AS bill_to_address,
         NULL::TEXT AS bill_to_gstin,
         po.status as po_status
       FROM invoices i
       LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = i.po_id
       WHERE i.invoice_id = $1`,
      [id]
    )
    
    if (invoiceRows.length === 0) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    const invoice = invoiceRows[0]
    
    // Get invoice line items
    const { rows: lineRows } = await pool.query(
      `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sequence_number`,
      [id]
    )
    
    // Get PO line items if PO exists (all columns from purchase_order_lines)
    let poLineItems = []
    if (invoice.po_id) {
      const { rows: poLines } = await pool.query(
        `SELECT 
           pol.po_line_id,
           pol.po_id,
           pol.sequence_number,
           pol.item_id,
           COALESCE(pol.description1, pol.item_id) AS item_name,
           pol.description1 AS item_description,
           pol.qty AS quantity,
           pol.unit_cost,
           pol.disc_pct,
           pol.raw_material,
           pol.process_description,
           pol.norms,
           pol.process_cost
         FROM purchase_order_lines pol
         WHERE pol.po_id = $1
         ORDER BY pol.sequence_number`,
        [invoice.po_id]
      )
      poLineItems = poLines
    }
    
    res.json({
      ...invoice,
      items: lineRows,
      poLineItems: poLineItems
    })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Parse payment terms days from PO terms text (e.g. "30 DAYS", "60 DAYS FROM RECEIPT")
function parsePaymentTermsDays(terms) {
  if (!terms || typeof terms !== 'string') return 30
  const match = String(terms).toUpperCase().trim().match(/(\d+)\s*DAY/i)
  return match ? Math.max(0, parseInt(match[1], 10)) || 30 : 30
}

// Create invoice (only saves when Save Invoice is clicked - no updates to suppliers, PO, or other tables)
router.post('/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
    const {
      invoiceNumber,
      invoiceDate,
      supplierId,
      poId,
      poNumber: bodyPoNumber,
      scanningNumber,
      totalAmount,
      taxAmount,
      status,
      notes,
      items,
      pdfFileName,
      pdfBuffer,
      weightSlips
    } = req.body
    
    await client.query('BEGIN')
    
    // Resolve po_number and payment_due_date from body or PO lookup when po_id is set
    let poNumber = bodyPoNumber != null && String(bodyPoNumber).trim() !== '' ? String(bodyPoNumber).trim() : null
    let paymentDueDate = null
    if (poId) {
      const poRow = await client.query('SELECT po_number, terms FROM purchase_orders WHERE po_id = $1', [poId])
      const po = poRow.rows[0]
      if (po) {
        if (!poNumber) poNumber = po.po_number
        if (invoiceDate) {
          const days = parsePaymentTermsDays(po.terms)
          const d = new Date(invoiceDate)
          d.setDate(d.getDate() + days)
          paymentDueDate = d.toISOString().slice(0, 10)
        }
      }
    }
    
    // CREATE new invoice (no updates to suppliers, PO, or other tables)
    const { rows: invoiceRows } = await client.query(
      `INSERT INTO invoices (invoice_number, invoice_date, supplier_id, po_id, scanning_number, po_number, total_amount, tax_amount, status, payment_due_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (invoice_number) DO UPDATE
       SET invoice_date = EXCLUDED.invoice_date,
           supplier_id = EXCLUDED.supplier_id,
           po_id = EXCLUDED.po_id,
           scanning_number = EXCLUDED.scanning_number,
           po_number = EXCLUDED.po_number,
           total_amount = EXCLUDED.total_amount,
           tax_amount = EXCLUDED.tax_amount,
           status = EXCLUDED.status,
           payment_due_date = EXCLUDED.payment_due_date,
           notes = EXCLUDED.notes,
           updated_at = NOW()
       RETURNING invoice_id`,
      [
        invoiceNumber || `INV-${Date.now()}`,
        invoiceDate || null,
        supplierId || null,
        poId || null,
        scanningNumber || null,
        poNumber || null,
        totalAmount ? parseFloat(totalAmount) : null,
        taxAmount ? parseFloat(taxAmount) : null,
        status || 'waiting_for_validation',
        paymentDueDate || null,
        notes || null
      ]
    )
    
    const invoiceId = invoiceRows[0].invoice_id
    
    // Store PDF attachment if provided
    if (pdfFileName && pdfBuffer) {
      const pdfBufferBinary = Buffer.from(pdfBuffer, 'base64')
      await client.query(
        `INSERT INTO invoice_attachments (invoice_id, file_name, file_data, attachment_type)
         VALUES ($1, $2, $3, 'invoice')`,
        [invoiceId, pdfFileName, pdfBufferBinary]
      )
    }
    
    // Get PO line items if PO is linked (for matching only, no updates)
    let poLineItems = []
    if (poId) {
      const poLinesResult = await client.query(
        'SELECT po_line_id, COALESCE(description1, item_id) AS item_name, sequence_number FROM purchase_order_lines WHERE po_id = $1 ORDER BY sequence_number',
        [poId]
      )
      poLineItems = poLinesResult.rows
    }
    
    // Insert invoice lines and collect invoice_line_id for each (so weight slips can link to line)
    const insertedLineIds = []
    if (Array.isArray(items) && items.length > 0) {
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        
        // Match PO line ID by sequence number or item name (no PO updates)
        let poLineId = item.poLineId || null
        if (poId && !poLineId && poLineItems.length > 0) {
          // Try to match by sequence number first
          if (poLineItems[index]) {
            poLineId = poLineItems[index].po_line_id
          } else {
            // Fallback: try to match by item name
            const matchedLine = poLineItems.find(poLine => 
              poLine.item_name && item.itemName && 
              poLine.item_name.toLowerCase().trim() === item.itemName.toLowerCase().trim()
            )
            if (matchedLine) {
              poLineId = matchedLine.po_line_id
            }
          }
        }
        
        const lineResult = await client.query(
          `INSERT INTO invoice_lines 
           (invoice_id, po_id, po_line_id, item_name, hsn_sac, uom, billed_qty, weight, count, rate, rate_per,
            line_total, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
            total_tax_amount, sequence_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING invoice_line_id`,
          [
            invoiceId,
            poId || null,
            poLineId,
            item.itemName || '',
            item.hsnSac || item.itemCode || null,
            item.uom || null,
            item.billedQty ? parseFloat(item.billedQty) : null,
            item.weight != null ? parseFloat(item.weight) : null,
            item.count != null ? parseInt(item.count, 10) : null,
            item.rate || item.unitPrice ? parseFloat(item.rate || item.unitPrice) : null,
            item.ratePer || null,
            item.lineTotal ? parseFloat(item.lineTotal) : null,
            item.taxableValue ? parseFloat(item.taxableValue) : null,
            item.cgstRate ? parseFloat(item.cgstRate) : null,
            item.cgstAmount ? parseFloat(item.cgstAmount) : null,
            item.sgstRate ? parseFloat(item.sgstRate) : null,
            item.sgstAmount ? parseFloat(item.sgstAmount) : null,
            item.totalTaxAmount ? parseFloat(item.totalTaxAmount) : null,
            index + 1 // sequence_number
          ]
        )
        if (lineResult.rows[0]) {
          insertedLineIds.push(lineResult.rows[0].invoice_line_id)
        }
      }
    }
    
    // Store weight slip attachments in invoice_weight_attachments (one per line)
    if (Array.isArray(weightSlips) && weightSlips.length > 0) {
      for (const ws of weightSlips) {
        const fileName = ws.fileName || `weight-slip-line-${ws.lineIndex ?? 0}.pdf`
        const buffer = ws.buffer ? Buffer.from(ws.buffer, 'base64') : null
        if (buffer) {
          const lineIndex = ws.lineIndex != null ? parseInt(ws.lineIndex, 10) : 0
          const invoiceLineId = Number.isNaN(lineIndex) || lineIndex < 0 || lineIndex >= insertedLineIds.length
            ? null
            : insertedLineIds[lineIndex]
          if (invoiceLineId) {
            await client.query(
              `INSERT INTO invoice_weight_attachments (invoice_line_id, file_name, file_data)
               VALUES ($1, $2, $3)
               ON CONFLICT (invoice_line_id) DO UPDATE SET file_name = EXCLUDED.file_name, file_data = EXCLUDED.file_data`,
              [invoiceLineId, fileName, buffer]
            )
          }
        }
      }
    }
    
    await client.query('COMMIT')
    res.json({ success: true, invoiceId })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Update invoice (only updates invoices and invoice_lines, no updates to suppliers, PO, or other tables)
router.put('/invoices/:id', async (req, res) => {
  const client = await pool.connect()
  try {
    const { id } = req.params
    const {
      invoiceNumber,
      invoiceDate,
      supplierId,
      poId,
      scanningNumber,
      totalAmount,
      taxAmount,
      status,
      notes,
      items,
      weightSlips
    } = req.body
    
    await client.query('BEGIN')
    
    const existingInv = await client.query(
      'SELECT po_id, invoice_date FROM invoices WHERE invoice_id = $1',
      [id]
    )
    const existing = existingInv.rows[0] || {}
    const effectivePoId = poId !== undefined ? poId : existing.po_id
    const effectiveInvoiceDate = invoiceDate !== undefined ? invoiceDate : existing.invoice_date
    
    const updateFields = []
    const values = []
    let idx = 1
    
    if (invoiceNumber !== undefined) {
      updateFields.push(`invoice_number = $${idx++}`)
      values.push(invoiceNumber)
    }
    if (invoiceDate !== undefined) {
      updateFields.push(`invoice_date = $${idx++}`)
      values.push(invoiceDate)
    }
    if (supplierId !== undefined) {
      updateFields.push(`supplier_id = $${idx++}`)
      values.push(supplierId)
    }
    if (poId !== undefined) {
      updateFields.push(`po_id = $${idx++}`)
      values.push(poId)
      let poNumber = req.body.poNumber != null && String(req.body.poNumber).trim() !== '' ? String(req.body.poNumber).trim() : null
      let poTerms = null
      const poRow = await client.query('SELECT po_number, terms FROM purchase_orders WHERE po_id = $1', [poId])
      if (poRow.rows[0]) {
        if (!poNumber) poNumber = poRow.rows[0].po_number
        poTerms = poRow.rows[0].terms
      }
      if (poNumber !== null) {
        updateFields.push(`po_number = $${idx++}`)
        values.push(poNumber)
      }
      if (effectiveInvoiceDate && poTerms != null) {
        const days = parsePaymentTermsDays(poTerms)
        const d = new Date(effectiveInvoiceDate)
        d.setDate(d.getDate() + days)
        updateFields.push(`payment_due_date = $${idx++}`)
        values.push(d.toISOString().slice(0, 10))
      }
    }
    if (req.body.poNumber !== undefined && poId === undefined) {
      updateFields.push(`po_number = $${idx++}`)
      values.push(String(req.body.poNumber).trim() || null)
    }
    if (invoiceDate !== undefined && effectivePoId && poId === undefined) {
      const poRow = await client.query('SELECT terms FROM purchase_orders WHERE po_id = $1', [effectivePoId])
      const days = parsePaymentTermsDays(poRow.rows[0]?.terms)
      const d = new Date(invoiceDate)
      d.setDate(d.getDate() + days)
      updateFields.push(`payment_due_date = $${idx++}`)
      values.push(d.toISOString().slice(0, 10))
    }
    if (scanningNumber !== undefined) {
      updateFields.push(`scanning_number = $${idx++}`)
      values.push(scanningNumber)
    }
    if (totalAmount !== undefined) {
      updateFields.push(`total_amount = $${idx++}`)
      values.push(parseFloat(totalAmount))
    }
    if (taxAmount !== undefined) {
      updateFields.push(`tax_amount = $${idx++}`)
      values.push(parseFloat(taxAmount))
    }
    if (status !== undefined) {
      updateFields.push(`status = $${idx++}`)
      values.push(status)
    }
    if (notes !== undefined) {
      updateFields.push(`notes = $${idx++}`)
      values.push(notes)
    }
    
    updateFields.push(`updated_at = NOW()`)
    values.push(id)
    
    if (updateFields.length > 1) {
      await client.query(
        `UPDATE invoices SET ${updateFields.join(', ')} WHERE invoice_id = $${idx}`,
        values
      )
    }
    
    // Get the final PO ID (from update or existing invoice)
    let finalPoId = poId
    if (finalPoId === undefined) {
      // If PO ID not provided in update, check existing invoice
      const existingInvoice = await client.query(
        'SELECT po_id FROM invoices WHERE invoice_id = $1',
        [id]
      )
      if (existingInvoice.rows.length > 0) {
        finalPoId = existingInvoice.rows[0].po_id
      }
    }
    
    // Get PO line items if PO is linked (for matching)
    let poLineItems = []
    if (finalPoId) {
      const poLinesResult = await client.query(
        'SELECT po_line_id, COALESCE(description1, item_id) AS item_name, sequence_number FROM purchase_order_lines WHERE po_id = $1 ORDER BY sequence_number',
        [finalPoId]
      )
      poLineItems = poLinesResult.rows
    }
    
    // Update items if provided; collect invoice_line_id for each so weight slips can link
    const insertedLineIds = []
    if (Array.isArray(items)) {
      // Delete existing lines (attachments with invoice_line_id are CASCADE deleted or orphaned; we keep invoice-level attachments)
      await client.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [id])
      
      // Insert new lines and collect invoice_line_id
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        
        // Determine PO line ID - use provided one, or match by sequence/item name
        let poLineId = item.poLineId || null
        if (finalPoId && !poLineId && poLineItems.length > 0) {
          // Try to match by sequence number first
          if (poLineItems[index]) {
            poLineId = poLineItems[index].po_line_id
          } else {
            // Fallback: try to match by item name
            const matchedLine = poLineItems.find(poLine => 
              poLine.item_name && item.itemName && 
              poLine.item_name.toLowerCase().trim() === item.itemName.toLowerCase().trim()
            )
            if (matchedLine) {
              poLineId = matchedLine.po_line_id
            }
          }
        }
        
        const lineResult = await client.query(
          `INSERT INTO invoice_lines 
           (invoice_id, po_id, po_line_id, item_name, hsn_sac, uom, billed_qty, weight, count, rate, rate_per,
            line_total, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
            total_tax_amount, sequence_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING invoice_line_id`,
          [
            id,
            finalPoId,
            poLineId,
            item.itemName || '',
            item.hsnSac || item.itemCode || null,
            item.uom || null,
            item.billedQty ? parseFloat(item.billedQty) : null,
            item.weight != null ? parseFloat(item.weight) : null,
            item.count != null ? parseInt(item.count, 10) : null,
            item.rate || item.unitPrice ? parseFloat(item.rate || item.unitPrice) : null,
            item.ratePer || null,
            item.lineTotal ? parseFloat(item.lineTotal) : null,
            item.taxableValue ? parseFloat(item.taxableValue) : null,
            item.cgstRate ? parseFloat(item.cgstRate) : null,
            item.cgstAmount ? parseFloat(item.cgstAmount) : null,
            item.sgstRate ? parseFloat(item.sgstRate) : null,
            item.sgstAmount ? parseFloat(item.sgstAmount) : null,
            item.totalTaxAmount ? parseFloat(item.totalTaxAmount) : null,
            index + 1 // sequence_number
          ]
        )
        if (lineResult.rows[0]) {
          insertedLineIds.push(lineResult.rows[0].invoice_line_id)
        }
      }
    }
    
    // Store additional weight slip attachments in invoice_weight_attachments (on update)
    if (Array.isArray(weightSlips) && weightSlips.length > 0) {
      for (const ws of weightSlips) {
        const fileName = ws.fileName || `weight-slip-line-${ws.lineIndex ?? 0}.pdf`
        const buffer = ws.buffer ? Buffer.from(ws.buffer, 'base64') : null
        if (buffer) {
          const lineIndex = ws.lineIndex != null ? parseInt(ws.lineIndex, 10) : 0
          const invoiceLineId = Number.isNaN(lineIndex) || lineIndex < 0 || lineIndex >= insertedLineIds.length
            ? null
            : insertedLineIds[lineIndex]
          if (invoiceLineId) {
            await client.query(
              `INSERT INTO invoice_weight_attachments (invoice_line_id, file_name, file_data)
               VALUES ($1, $2, $3)
               ON CONFLICT (invoice_line_id) DO UPDATE SET file_name = EXCLUDED.file_name, file_data = EXCLUDED.file_data`,
              [invoiceLineId, fileName, buffer]
            )
          }
        }
      }
    }
    
    await client.query('COMMIT')
    res.json({ success: true })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Get all invoices with search and filter
router.get('/invoices', async (req, res) => {
  try {
    const {
      limit = 100,
      offset = 0,
      status,
      invoiceNumber,
      poNumber
    } = req.query

    let query = `
      SELECT 
        i.invoice_id,
        i.invoice_number,
        i.invoice_date,
        i.scanning_number,
        i.total_amount,
        i.tax_amount,
        i.status,
        i.payment_due_date,
        i.created_at,
        i.updated_at,
        s.supplier_name,
        s.supplier_id,
        po.po_id,
        po.po_number,
        po.date AS po_date
      FROM invoices i
      LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = i.po_id
      WHERE 1=1
    `

    const params = []
    let paramCount = 0

    if (status) {
      const statusList = Array.isArray(status)
        ? status
        : String(status).split(',').map((s) => s.trim()).filter(Boolean)
      if (statusList.length > 0) {
        const statusNormalized = statusList.flatMap((s) =>
          (s.toLowerCase() === 'open' ? ['open', 'pending'] : [s])
        )
        const placeholders = statusNormalized.map(() => {
          paramCount++
          return `$${paramCount}`
        }).join(', ')
        query += ` AND i.status IN (${placeholders})`
        params.push(...statusNormalized)
      }
    }
    
    if (invoiceNumber) {
      paramCount++
      query += ` AND i.invoice_number ILIKE $${paramCount}`
      params.push(`%${invoiceNumber}%`)
    }
    
    if (poNumber) {
      paramCount++
      query += ` AND po.po_number ILIKE $${paramCount}`
      params.push(`%${poNumber}%`)
    }
    
    query += ` ORDER BY i.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`
    params.push(limit, offset)
    
    const { rows } = await pool.query(query, params)
    res.json(rows)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// List all GRN (with po_number from purchase_orders)
router.get('/grn', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         g.id,
         g.po_id,
         po.po_number,
         g.supplier_id,
         g.supplier_name,
         g.grn_no,
         g.grn_date,
         g.grn_line,
         g.po_no,
         g.dc_no,
         g.dc_date,
         g.unit,
         g.item,
         g.description_1,
         g.uom,
         g.grn_qty,
         g.accepted_qty,
         g.unit_cost,
         g.header_status,
         g.line_status,
         g.gate_entry_no,
         g.supplier_doc_no,
         g.supplier_doc_date,
         g.supplier,
         g.exchange_rate,
         g.grn_year,
         g.grn_period,
         g.po_pfx,
         g.po_line
       FROM grn g
       LEFT JOIN purchase_orders po ON po.po_id = g.po_id
       ORDER BY g.grn_date DESC NULLS LAST, g.id DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching GRN:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// List all ASN; po_number derived via (1) asn.inv_no -> invoices -> po, or (2) fallback asn.dc_no -> grn -> po
// Match is trim + case-insensitive so Excel/API variations still link
router.get('/asn', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         a.id,
         COALESCE(po.po_number, po_grn.po_number) AS po_number,
         COALESCE(a.supplier_name, a.supplier) AS supplier_name,
         a.asn_no,
         a.supplier,
         a.dc_no,
         a.dc_date,
         a.inv_no,
         a.inv_date,
         a.lr_no,
         a.lr_date,
         a.unit,
         a.transporter,
         a.transporter_name,
         a.doc_no_date,
         a.status
       FROM asn a
       LEFT JOIN invoices inv ON TRIM(COALESCE(a.inv_no, '')) <> ''
         AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
       LEFT JOIN purchase_orders po ON po.po_id = inv.po_id
       LEFT JOIN LATERAL (
         SELECT g.po_id FROM grn g
         WHERE TRIM(COALESCE(a.dc_no, '')) <> '' AND LOWER(TRIM(g.dc_no)) = LOWER(TRIM(a.dc_no))
         LIMIT 1
       ) g ON true
       LEFT JOIN purchase_orders po_grn ON po_grn.po_id = g.po_id
       ORDER BY a.dc_date DESC NULLS LAST, a.id DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching ASN:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Upload Excel: PO matched -> purchase_orders + purchase_order_lines
router.post('/purchase-orders/upload-excel', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importPoExcel(req.file.buffer, client)
    await client.query('COMMIT')
    res.json({
      success: true,
      message: `Imported ${result.purchaseOrdersInserted} PO(s) and ${result.linesInserted} line(s)`,
      ...result
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('PO Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

// Upload Excel: GRN matched -> grn
router.post('/grn/upload-excel', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importGrnExcel(req.file.buffer, client)
    await client.query('COMMIT')
    const message = result.grnInserted === 0 && result.hint
      ? `Imported ${result.grnInserted} GRN record(s). ${result.hint}`
      : `Imported ${result.grnInserted} GRN record(s)`
    res.json({
      success: true,
      message,
      ...result
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('GRN Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

// Upload Excel: Pending ASN -> asn
router.post('/asn/upload-excel', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importAsnExcel(req.file.buffer, client)
    await client.query('COMMIT')
    const message = result.asnInserted === 0 && result.hint
      ? `Imported ${result.asnInserted} ASN record(s). ${result.hint}`
      : `Imported ${result.asnInserted} ASN record(s)`
    res.json({
      success: true,
      message,
      ...result
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('ASN Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

// Get all purchase orders (columns match current schema: date, terms, status; alias po_date for frontend)
router.get('/purchase-orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         po.po_id,
         po.po_number,
         po.date AS po_date,
         po.unit,
         po.ref_unit,
         po.pfx,
         po.amd_no,
         po.suplr_id,
         po.supplier_id,
         po.terms,
         po.status,
         s.supplier_name,
         (SELECT COUNT(*) FROM purchase_order_lines pol WHERE pol.po_id = po.po_id) AS line_item_count,
         NULL::TEXT AS bill_to,
         NULL::TEXT AS bill_to_address,
         NULL::TEXT AS bill_to_gstin,
         NULL::TEXT AS terms_and_conditions,
         NULL::TEXT AS payment_terms,
         NULL::TEXT AS delivery_terms,
         NULL::TIMESTAMPTZ AS created_at,
         NULL::TIMESTAMPTZ AS updated_at
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       ORDER BY po.date DESC, po.po_id DESC`
    )
    
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Incomplete POs: only open POs that have missing records (invoice, GRN, or ASN).
// Partially fulfilled and fulfilled POs are excluded; PO stays open until all invoices are in the system.
router.get('/purchase-orders/incomplete', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         po.po_id,
         po.po_number,
         po.date AS po_date,
         po.status AS po_status,
         COALESCE(s.supplier_name, po.suplr_id::TEXT, 'N/A') AS supplier_name,
         EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.po_id) AS has_invoice,
         EXISTS (SELECT 1 FROM grn g WHERE g.po_id = po.po_id) AS has_grn,
         EXISTS (SELECT 1 FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) AND inv.po_id = po.po_id) AS has_asn,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.po_id) THEN 'Invoice' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM grn g WHERE g.po_id = po.po_id) THEN 'GRN' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) AND inv.po_id = po.po_id) THEN 'ASN' END
         ], NULL) AS missing_items,
         (SELECT i.invoice_id FROM invoices i WHERE i.po_id = po.po_id AND LOWER(TRIM(i.status)) IN ('waiting_for_re_validation','debit_note_approval','exception_approval') LIMIT 1) AS pending_invoice_id,
         (SELECT LOWER(TRIM(i.status)) FROM invoices i WHERE i.po_id = po.po_id AND LOWER(TRIM(i.status)) IN ('waiting_for_re_validation','debit_note_approval','exception_approval') LIMIT 1) AS pending_invoice_status
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       WHERE COALESCE(po.status, 'open') NOT IN ('partially_fulfilled', 'fulfilled')
         AND NOT (
           EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.po_id)
           AND EXISTS (SELECT 1 FROM grn g WHERE g.po_id = po.po_id)
           AND EXISTS (SELECT 1 FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) AND inv.po_id = po.po_id)
         )
       ORDER BY po.date DESC, po.po_id DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching incomplete POs:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Cumulative quantities per PO (invoice, GRN, PO totals) for validation / UI
router.get('/purchase-orders/:poId/cumulative', async (req, res) => {
  try {
    const poId = parseInt(req.params.poId, 10)
    if (Number.isNaN(poId)) return res.status(400).json({ error: 'invalid_po_id' })
    const cum = await getCumulativeQuantities(poId)
    res.json(cum)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Force close PO (partially_fulfilled → fulfilled)
router.patch('/purchase-orders/:poId/force-close', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  const client = await pool.connect()
  try {
    const poId = parseInt(req.params.poId, 10)
    if (Number.isNaN(poId)) return res.status(400).json({ error: 'invalid_po_id' })
    await client.query('BEGIN')
    const result = await forceClosePo(client, poId)
    await client.query('COMMIT')
    res.json(result)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.message?.includes('not found')) return res.status(404).json({ error: 'po_not_found', message: err.message })
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Validation summary (read-only): reason and quantities; includes full details (errors, warnings, header, lines, totals, GRN, ASN) when invalid
router.get('/invoices/:id/validation-summary', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    const result = await validateInvoiceAgainstPoGrn(id)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Full validation report (all checks: header, line-level, totals, GRN, ASN) for UI to show breakdown
router.get('/invoices/:id/validation-report', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    const result = await runFullValidation(id)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Validate invoice against PO/GRN and apply status (standard / debit note / exception)
router.post('/invoices/:id/validate', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    const result = await validateAndUpdateInvoiceStatus(id)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Resolve validation mismatch: proceed to payment or send to debit note
router.post('/invoices/:id/validate-resolution', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    const { resolution } = req.body || {}
    if (resolution !== 'proceed_to_payment' && resolution !== 'send_to_debit_note') {
      return res.status(400).json({ error: 'invalid_resolution', message: 'resolution must be proceed_to_payment or send_to_debit_note' })
    }
    await client.query('BEGIN')
    if (resolution === 'proceed_to_payment') {
      const applied = await proceedToPaymentFromMismatch(client, id)
      await client.query('COMMIT')
      return res.json({ action: 'validated', ...applied })
    }
    await moveToDebitNoteApproval(client, id)
    await client.query('COMMIT')
    return res.json({ action: 'debit_note_approval', invoiceStatus: 'debit_note_approval' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.message?.includes('not found')) return res.status(404).json({ error: 'invoice_not_found', message: err.message })
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Exception approve: invoice for already-fulfilled PO → ready_for_payment
router.patch('/invoices/:id/exception-approve', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  const client = await pool.connect()
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    await client.query('BEGIN')
    const result = await exceptionApprove(client, id)
    await client.query('COMMIT')
    res.json(result)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.message?.includes('not found')) return res.status(404).json({ error: 'invoice_not_found', message: err.message })
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Debit note approve: set debit_note_value, invoice → ready_for_payment, PO → partially_fulfilled
router.patch('/invoices/:id/debit-note-approve', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  const client = await pool.connect()
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    const { debit_note_value } = req.body || {}
    await client.query('BEGIN')
    const result = await debitNoteApprove(client, id, debit_note_value != null ? parseFloat(debit_note_value) : null)
    await client.query('COMMIT')
    res.json(result)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.message?.includes('not found')) return res.status(404).json({ error: 'invoice_not_found', message: err.message })
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Get purchase order line items by PO ID – all columns from purchase_order_lines schema only
router.get('/purchase-orders/:poId/line-items', async (req, res) => {
  try {
    const { poId } = req.params
    const result = await pool.query(
      `SELECT 
         pol.po_line_id,
         pol.po_id,
         pol.sequence_number,
         pol.item_id,
         pol.description1,
         pol.qty,
         pol.unit_cost,
         pol.disc_pct,
         pol.raw_material,
         pol.process_description,
         pol.norms,
         pol.process_cost
       FROM purchase_order_lines pol
       WHERE pol.po_id = $1
       ORDER BY pol.sequence_number`,
      [poId]
    )
    
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

router.get('/purchase-orders/:poNumber', async (req, res) => {
  try {
    let { poNumber } = req.params
    poNumber = decodeURIComponent(poNumber)
    
    const poResult = await pool.query(
      `SELECT 
         po.po_id,
         po.po_number,
         po.date AS po_date,
         po.unit,
         po.ref_unit,
         po.pfx,
         po.amd_no,
         po.suplr_id,
         po.supplier_id,
         po.terms,
         po.status,
         s.supplier_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       WHERE po.po_number = $1 AND (po.amd_no = 0 OR po.amd_no IS NULL)
       LIMIT 1`,
      [poNumber]
    )
    
    if (poResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'not_found', 
        message: `Purchase order number "${poNumber}" does not exist in the system`
      })
    }
    
    const po = poResult.rows[0]
    
    const linesResult = await pool.query(
      `SELECT 
         pol.po_line_id,
         pol.po_id,
         pol.sequence_number,
         pol.item_id,
         pol.description1,
         pol.qty,
         pol.unit_cost,
         pol.disc_pct,
         pol.raw_material,
         pol.process_description,
         pol.norms,
         pol.process_cost
       FROM purchase_order_lines pol
       WHERE pol.po_id = $1
       ORDER BY pol.sequence_number`,
      [po.po_id]
    )
    
    res.json({
      ...po,
      items: linesResult.rows
    })
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get owner details (for header)
router.get('/owner', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         owner_id,
         owner_name,
         gst_number,
         pan_number,
         owner_address,
         city,
         state_name,
         pincode,
         email,
         phone,
         mobile,
         cin_number,
         website,
         contact_person
       FROM owners
       ORDER BY created_at ASC
       LIMIT 1`
    )
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'not_found', 
        message: 'Owner information not found'
      })
    }
    
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Supplier CRUD (admin/manager) – must be before /suppliers/:supplierName
router.get('/suppliers', authenticateToken, authorize(['admin', 'manager']), getSuppliersRoute)
router.get('/suppliers/by-id/:id', authenticateToken, authorize(['admin', 'manager']), getSupplierByIdRoute)
router.post('/suppliers', authenticateToken, authorize(['admin', 'manager']), createSupplierRoute)
router.put('/suppliers/:id', authenticateToken, authorize(['admin', 'manager']), updateSupplierRoute)
router.delete('/suppliers/:id', authenticateToken, authorize(['admin', 'manager']), deleteSupplierRoute)

// Get supplier details by name (for validation / invoice flow)
router.get('/suppliers/:supplierName', async (req, res) => {
  try {
    const { supplierName } = req.params
    const decodedName = decodeURIComponent(supplierName).trim()
    
    // Try exact match first
    let { rows } = await pool.query(
      `SELECT * FROM suppliers WHERE supplier_name = $1`,
      [decodedName]
    )
    
    // If no exact match, try case-insensitive match
    if (rows.length === 0) {
      const { rows: caseInsensitiveRows } = await pool.query(
        `SELECT * FROM suppliers WHERE LOWER(TRIM(supplier_name)) = LOWER(TRIM($1))`,
        [decodedName]
      )
      rows = caseInsensitiveRows
    }
    
    // If still no match, try partial match (contains)
    if (rows.length === 0) {
      const { rows: partialRows } = await pool.query(
        `SELECT * FROM suppliers WHERE LOWER(TRIM(supplier_name)) LIKE LOWER(TRIM($1)) OR LOWER(TRIM($1)) LIKE LOWER(TRIM(supplier_name))`,
        [`%${decodedName}%`]
      )
      rows = partialRows
    }
    
    if (rows.length === 0) {
      return res.status(404).json({ 
        error: 'not_found', 
        message: `Supplier "${decodedName}" not found in the system`
      })
    }
    
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Menu Items Routes - Get menu items for a specific role (checks database permissions)
router.get('/menu-items', authenticateToken, async (req, res) => {
  try {
    // Use authenticated user's role from token, fallback to query param
    const role = req.user?.role || req.query.role
    
    if (!role) {
      return res.status(400).json({ error: 'role_required', message: 'Role parameter is required' })
    }
    
    // Normalize role to lowercase
    const normalizedRole = role.toLowerCase()

    // Define role-based category priorities (lower number = higher priority)
    const categoryPriorities = {
      'admin': {
        'master-data': 1,
        'reports': 2,
        'status-actions': 3,
        'invoices': 4,
        'purchase-orders': 5,
        'finance': 6
      },
      'manager': {
        'status-actions': 1,
        'invoices': 2,
        'purchase-orders': 3,
        'master-data': 4,
        'finance': 5,
        'reports': 6
      },
      'finance': {
        'finance': 1,
        'invoices': 2,
        'reports': 3,
        'status-actions': 4,
        'purchase-orders': 5,
        'master-data': 6
      },
      'user': {
        'status-actions': 1,
        'invoices': 2,
        'purchase-orders': 3,
        'master-data': 4,
        'finance': 5,
        'reports': 6
      },
      'viewer': {
        'reports': 1,
        'invoices': 2,
        'finance': 3,
        'status-actions': 4,
        'purchase-orders': 5,
        'master-data': 6
      }
    }

    // Get priority for category based on role
    const getCategoryPriority = (categoryId) => {
      const priorities = categoryPriorities[normalizedRole] || categoryPriorities['user']
      return priorities[categoryId] || 999
    }

    // Get all active menu items with access for the role from role_menu_access table
    const query = `
      SELECT 
        mi.menu_item_id,
        mi.menu_id,
        mi.title,
        mi.description,
        mi.icon,
        mi.path,
        mi.color,
        mi.category_id,
        mi.category_title,
        mi.category_description,
        mi.display_order,
        mi.is_coming_soon,
        COALESCE(rma.has_access, FALSE) as has_access
      FROM menu_items mi
      LEFT JOIN role_menu_access rma ON mi.menu_item_id = rma.menu_item_id 
        AND rma.role = $1
      WHERE mi.is_active = TRUE
        AND COALESCE(rma.has_access, FALSE) = TRUE
      ORDER BY mi.category_id, mi.display_order, mi.title
    `

    const result = await pool.query(query, [normalizedRole])
    
    // Group by category
    const categories = {}
    result.rows.forEach(item => {
      if (item.has_access) {
        if (!categories[item.category_id]) {
          categories[item.category_id] = {
            id: item.category_id,
            title: item.category_title,
            description: item.category_description,
            priority: getCategoryPriority(item.category_id),
            items: []
          }
        }
        categories[item.category_id].items.push({
          id: item.menu_id,
          title: item.title,
          description: item.description,
          icon: item.icon,
          path: item.path,
          color: item.color,
          comingSoon: item.is_coming_soon,
          order: item.display_order
        })
      }
    })

    // Convert to array, sort categories by priority, then sort items within each category
    const menuCategories = Object.values(categories)
      .map(cat => ({
        ...cat,
        // Sort items: active items first (comingSoon = false), then by display_order
        items: cat.items.sort((a, b) => {
          // Active items come before coming soon items
          if (a.comingSoon !== b.comingSoon) {
            return a.comingSoon ? 1 : -1
          }
          // Then sort by display order
          return (a.order || 0) - (b.order || 0)
        })
      }))
      .sort((a, b) => a.priority - b.priority) // Sort categories by role-based priority
      .filter(cat => cat.items.length > 0)

    res.json(menuCategories)
  } catch (err) {
    console.error('Error fetching menu items:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

router.get('/menu-items/all', authenticateToken, authorize(['admin', 'manager']), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        menu_item_id,
        menu_id,
        title,
        description,
        icon,
        path,
        color,
        category_id,
        category_title,
        category_description,
        display_order,
        is_active,
        is_coming_soon,
        created_at,
        updated_at
      FROM menu_items
      WHERE is_active = TRUE
      ORDER BY category_id, display_order, title
    `)
    
    res.json(rows)
  } catch (err) {
    console.error('Error fetching all menu items:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// User Management Routes (Admin/Manager only)
router.get('/users', authenticateToken, authorize(['admin', 'manager']), getUsersRoute)
router.get('/users/:id', authenticateToken, authorize(['admin', 'manager']), getUserByIdRoute)
router.post('/users', authenticateToken, authorize(['admin']), createUserRoute)
router.put('/users/:id', authenticateToken, authorize(['admin']), updateUserRoute)
router.delete('/users/:id', authenticateToken, authorize(['admin']), deleteUserRoute)
router.get('/users/:id/menu-access', authenticateToken, authorize(['admin', 'manager']), getUserMenuAccessRoute)
router.put('/users/:id/menu-access', authenticateToken, authorize(['admin']), updateUserMenuAccessRoute)

// Owner Details Routes (Admin only - view and edit, no create)
router.get('/owners', authenticateToken, authorize(['admin']), getOwnerDetailsRoute)
router.put('/owners/:id', authenticateToken, authorize(['admin']), updateOwnerDetailsRoute)

// ========== Reports & Analytics APIs ==========
// Each report API returns only data for its scope. No duplication of totals across reports.

// Invoice Report only: volume, status, and date distribution (no amounts – see Financial)
router.get('/reports/invoices-summary', authenticateToken, async (req, res) => {
  try {
    const [summary, byMonth, byStatus] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_invoices,
          COALESCE(AVG(total_amount), 0)::numeric(18,2) AS avg_amount
        FROM invoices
      `),
      pool.query(`
        SELECT
          TO_CHAR(invoice_date, 'Mon YYYY') AS month_label,
          DATE_TRUNC('month', invoice_date)::date AS month_date,
          COUNT(*)::int AS count
        FROM invoices
        WHERE invoice_date IS NOT NULL
        GROUP BY DATE_TRUNC('month', invoice_date), TO_CHAR(invoice_date, 'Mon YYYY')
        ORDER BY month_date ASC
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM invoices
        GROUP BY status
        ORDER BY count DESC
      `)
    ])
    res.json({
      summary: summary.rows[0],
      byMonth: byMonth.rows,
      byStatus: byStatus.rows
    })
  } catch (err) {
    console.error('Invoice report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Supplier Report: counts, activity, fastest delivering (avg days PO → invoice), best suppliers (top by value)
router.get('/reports/suppliers-summary', authenticateToken, async (req, res) => {
  try {
    const [summary, suppliers, fastestDelivering, bestSuppliers] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM suppliers)::int AS total_suppliers,
          (SELECT COUNT(*) FROM purchase_orders)::int AS total_pos,
          (SELECT COUNT(*) FROM suppliers s WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.supplier_id = s.supplier_id))::int AS active_suppliers,
          (SELECT COUNT(*) FROM suppliers s WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.supplier_id = s.supplier_id))::int AS suppliers_with_no_invoices
      `),
      pool.query(`
        SELECT
          s.supplier_id,
          s.supplier_name,
          s.city,
          s.gst_number,
          (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.supplier_id)::int AS po_count,
          (SELECT COUNT(*) FROM invoices i WHERE i.supplier_id = s.supplier_id)::int AS invoice_count,
          COALESCE((SELECT SUM(i.total_amount) FROM invoices i WHERE i.supplier_id = s.supplier_id), 0)::numeric(18,2) AS total_invoice_amount
        FROM suppliers s
        ORDER BY total_invoice_amount DESC NULLS LAST
      `),
      pool.query(`
        SELECT
          s.supplier_id,
          s.supplier_name,
          ROUND(AVG((i.invoice_date - po.date)), 1)::numeric AS avg_days_po_to_invoice,
          COUNT(DISTINCT po.po_id)::int AS po_count,
          COUNT(i.invoice_id)::int AS invoice_count
        FROM suppliers s
        JOIN purchase_orders po ON po.supplier_id = s.supplier_id
        JOIN invoices i ON i.po_id = po.po_id AND i.invoice_date IS NOT NULL AND po.date IS NOT NULL
        GROUP BY s.supplier_id, s.supplier_name
        HAVING COUNT(i.invoice_id) > 0
        ORDER BY avg_days_po_to_invoice ASC NULLS LAST
        LIMIT 15
      `),
      pool.query(`
        SELECT
          s.supplier_id,
          s.supplier_name,
          COUNT(i.invoice_id)::int AS invoice_count,
          COALESCE(SUM(i.total_amount), 0)::numeric(18,2) AS total_invoice_amount
        FROM suppliers s
        JOIN invoices i ON i.supplier_id = s.supplier_id
        GROUP BY s.supplier_id, s.supplier_name
        ORDER BY total_invoice_amount DESC NULLS LAST
        LIMIT 10
      `)
    ])
    res.json({
      summary: summary.rows[0],
      suppliers: suppliers.rows,
      fastest_delivering: fastestDelivering.rows,
      best_suppliers: bestSuppliers.rows
    })
  } catch (err) {
    console.error('Supplier report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Financial Reports: totals, by month (amount & tax), trends
router.get('/reports/financial-summary', authenticateToken, async (req, res) => {
  try {
    const [summary, byMonth] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_invoices,
          COALESCE(SUM(total_amount), 0)::numeric(18,2) AS total_billed,
          COALESCE(SUM(tax_amount), 0)::numeric(18,2) AS total_tax,
          COALESCE(AVG(total_amount), 0)::numeric(18,2) AS avg_invoice_amount
        FROM invoices
      `),
      pool.query(`
        SELECT
          TO_CHAR(invoice_date, 'Mon YYYY') AS month_label,
          DATE_TRUNC('month', invoice_date)::date AS month_date,
          COUNT(*)::int AS invoice_count,
          COALESCE(SUM(total_amount), 0)::numeric(18,2) AS amount,
          COALESCE(SUM(tax_amount), 0)::numeric(18,2) AS tax_amount
        FROM invoices
        WHERE invoice_date IS NOT NULL
        GROUP BY DATE_TRUNC('month', invoice_date), TO_CHAR(invoice_date, 'Mon YYYY')
        ORDER BY month_date ASC
      `)
    ])
    res.json({
      summary: summary.rows[0],
      byMonth: byMonth.rows
    })
  } catch (err) {
    console.error('Financial report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Procurement / PO summary (for Reports & Analytics)
router.get('/reports/procurement-summary', authenticateToken, async (req, res) => {
  try {
    const [summary, byStatus, incompleteCount] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_pos,
          (SELECT COUNT(*) FROM grn)::int AS total_grn,
          (SELECT COUNT(*) FROM asn)::int AS total_asn,
          (SELECT COUNT(*) FROM invoices)::int AS total_invoices
        FROM purchase_orders
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM purchase_orders
        GROUP BY status
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT COUNT(DISTINCT po.po_id)::int AS count
        FROM purchase_orders po
        WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.po_id)
           OR NOT EXISTS (SELECT 1 FROM grn g WHERE g.po_id = po.po_id)
           OR NOT EXISTS (SELECT 1 FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) AND inv.po_id = po.po_id)
      `)
    ])
    res.json({
      summary: { ...summary.rows[0], incomplete_po_count: incompleteCount.rows[0]?.count ?? 0 },
      byStatus: byStatus.rows
    })
  } catch (err) {
    console.error('Procurement report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Finance Dashboard: single API for financial summary, payment pipeline, and finance analytics
router.get('/reports/dashboard', authenticateToken, async (req, res) => {
  try {
    const [financial, invoiceByStatus, paymentCounts, paymentAmounts, debitNote, recentPayments, topSuppliers, byMonth] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_invoices,
          COALESCE(SUM(total_amount), 0)::numeric(18,2) AS total_billed,
          COALESCE(SUM(tax_amount), 0)::numeric(18,2) AS total_tax,
          COALESCE(AVG(total_amount), 0)::numeric(18,2) AS avg_invoice_amount,
          COALESCE(SUM(CASE WHEN invoice_date >= DATE_TRUNC('month', CURRENT_DATE)::date THEN total_amount ELSE 0 END), 0)::numeric(18,2) AS current_month_billed,
          COALESCE(SUM(CASE WHEN invoice_date >= DATE_TRUNC('year', CURRENT_DATE)::date THEN total_amount ELSE 0 END), 0)::numeric(18,2) AS ytd_billed
        FROM invoices
      `),
      pool.query(`
        SELECT LOWER(TRIM(status)) AS status, COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::numeric(18,2) AS total_amount
        FROM invoices
        GROUP BY status
        ORDER BY count DESC
      `),
      Promise.all([
        pool.query(`
          SELECT COUNT(*)::int AS count FROM invoices i
          LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
          WHERE LOWER(TRIM(i.status)) = 'validated'
            AND (pa.id IS NULL OR LOWER(TRIM(pa.status)) = 'pending_approval')
        `),
        pool.query(`SELECT COUNT(*)::int AS count FROM payment_approvals WHERE LOWER(TRIM(status)) = 'approved'`),
        pool.query(`SELECT COUNT(*)::int AS count FROM payment_approvals WHERE LOWER(TRIM(status)) = 'payment_done'`)
      ]),
      Promise.all([
        pool.query(`
          SELECT COALESCE(SUM(CASE WHEN i.debit_note_value IS NOT NULL AND i.debit_note_value > 0 THEN i.debit_note_value ELSE i.total_amount END), 0)::numeric(18,2) AS amount
          FROM invoices i
          LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
          WHERE LOWER(TRIM(i.status)) = 'validated' AND (pa.id IS NULL OR LOWER(TRIM(pa.status)) = 'pending_approval')
        `),
        pool.query(`
          SELECT COALESCE(SUM(COALESCE(debit_note_value, total_amount)), 0)::numeric(18,2) AS amount
          FROM payment_approvals WHERE LOWER(TRIM(status)) = 'approved'
        `),
        pool.query(`
          SELECT COALESCE(SUM(COALESCE(debit_note_value, total_amount)), 0)::numeric(18,2) AS amount
          FROM payment_approvals WHERE LOWER(TRIM(status)) = 'payment_done'
        `)
      ]),
      pool.query(`
        SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::numeric(18,2) AS total_amount
        FROM invoices WHERE LOWER(TRIM(status)) = 'debit_note_approval'
      `),
      pool.query(`
        SELECT pa.id, i.invoice_number, s.supplier_name,
               COALESCE(pa.debit_note_value, pa.total_amount, i.total_amount)::numeric(18,2) AS amount,
               pa.payment_done_at
        FROM payment_approvals pa
        JOIN invoices i ON i.invoice_id = pa.invoice_id
        LEFT JOIN suppliers s ON s.supplier_id = pa.supplier_id
        WHERE LOWER(TRIM(pa.status)) = 'payment_done' AND pa.payment_done_at IS NOT NULL
        ORDER BY pa.payment_done_at DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT s.supplier_name, COUNT(i.invoice_id)::int AS invoice_count, COALESCE(SUM(i.total_amount), 0)::numeric(18,2) AS total_amount
        FROM suppliers s
        JOIN invoices i ON i.supplier_id = s.supplier_id
        GROUP BY s.supplier_id, s.supplier_name
        ORDER BY total_amount DESC NULLS LAST
        LIMIT 10
      `),
      pool.query(`
        SELECT
          TO_CHAR(invoice_date, 'Mon YYYY') AS month_label,
          DATE_TRUNC('month', invoice_date)::date AS month_date,
          COUNT(*)::int AS invoice_count,
          COALESCE(SUM(total_amount), 0)::numeric(18,2) AS amount,
          COALESCE(SUM(tax_amount), 0)::numeric(18,2) AS tax_amount
        FROM invoices
        WHERE invoice_date IS NOT NULL
        GROUP BY DATE_TRUNC('month', invoice_date), TO_CHAR(invoice_date, 'Mon YYYY')
        ORDER BY month_date DESC
        LIMIT 12
      `)
    ])
    const [pendingApproval, ready, paymentDone] = paymentCounts.map(r => r.rows[0]?.count ?? 0)
    const finRow = financial.rows[0]
    const totalBilled = parseFloat(finRow?.total_billed ?? 0)
    const totalTax = parseFloat(finRow?.total_tax ?? 0)
    const taxPct = totalBilled > 0 ? ((totalTax / totalBilled) * 100).toFixed(2) : '0.00'
    res.json({
      financial: {
        ...finRow,
        tax_pct: taxPct
      },
      invoiceByStatus: invoiceByStatus.rows,
      payments: {
        pending_approval_count: pendingApproval,
        ready_count: ready,
        payment_done_count: paymentDone,
        pending_approval_amount: paymentAmounts[0].rows[0]?.amount ?? 0,
        ready_amount: paymentAmounts[1].rows[0]?.amount ?? 0,
        payment_done_amount: paymentAmounts[2].rows[0]?.amount ?? 0
      },
      debitNote: debitNote.rows[0] || { count: 0, total_amount: '0' },
      recentPayments: recentPayments.rows,
      topSuppliers: topSuppliers.rows,
      procurement: {
        total_pos: (await pool.query('SELECT COUNT(*)::int AS c FROM purchase_orders')).rows[0]?.c ?? 0,
        total_grn: (await pool.query('SELECT COUNT(*)::int AS c FROM grn')).rows[0]?.c ?? 0,
        total_asn: (await pool.query('SELECT COUNT(*)::int AS c FROM asn')).rows[0]?.c ?? 0,
        total_invoices: finRow?.total_invoices ?? 0,
        incomplete_po_count: (await pool.query(`
          SELECT COUNT(*)::int AS c FROM purchase_orders po
          WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.po_id = po.po_id)
            OR NOT EXISTS (SELECT 1 FROM grn g WHERE g.po_id = po.po_id)
            OR NOT EXISTS (SELECT 1 FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) AND inv.po_id = po.po_id)
        `)).rows[0]?.c ?? 0
      },
      byMonth: byMonth.rows.reverse()
    })
  } catch (err) {
    console.error('Dashboard report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// ========== Payment Approval & Ready for Payments ==========

// List invoices with status validated that are pending manager approval (no payment_approvals or status pending_approval)
router.get('/payments/pending-approval', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  try {
    const { rows: invoices } = await pool.query(
      `SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.scanning_number, i.po_number,
              i.total_amount, i.tax_amount, i.status, i.payment_due_date, i.debit_note_value, i.notes,
              i.po_id, i.supplier_id,
              s.supplier_name, s.gst_number AS supplier_gst, s.pan_number AS supplier_pan,
              s.supplier_address, s.email AS supplier_email, s.phone AS supplier_phone,
              s.bank_account_name, s.bank_account_number, s.bank_ifsc_code, s.bank_name, s.branch_name,
              po.po_number AS po_number_ref, po.date AS po_date, po.terms AS po_terms, po.status AS po_status,
              pa.id AS payment_approval_id, pa.status AS payment_approval_status
       FROM invoices i
       LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = i.po_id
       LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
       WHERE i.status = 'validated'
         AND (pa.id IS NULL OR pa.status = 'pending_approval')
       ORDER BY i.payment_due_date ASC NULLS LAST, i.invoice_id ASC`
    )
    const result = []
    for (const inv of invoices) {
      let grnList = []
      let asnList = []
      let poLinesList = []
      let invoiceLinesList = []
      const queries = []
      if (inv.po_id) {
        queries.push(
          pool.query(
            `SELECT g.id, g.grn_no, g.grn_date, g.dc_no, g.dc_date, g.grn_qty, g.accepted_qty, g.unit_cost
             FROM grn g WHERE g.po_id = $1 ORDER BY g.grn_date DESC NULLS LAST`,
            [inv.po_id]
          ),
          pool.query(
            `SELECT a.id, a.asn_no, a.dc_no, a.dc_date, a.inv_no, a.inv_date, a.lr_no, a.transporter_name
             FROM asn a JOIN invoices inv2 ON TRIM(COALESCE(a.inv_no,'')) <> '' AND LOWER(TRIM(inv2.invoice_number)) = LOWER(TRIM(a.inv_no)) WHERE inv2.po_id = $1 ORDER BY a.dc_date DESC NULLS LAST`,
            [inv.po_id]
          ),
          pool.query(
            `SELECT pol.po_line_id, pol.sequence_number, pol.item_id, pol.description1, pol.qty,
                    pol.unit_cost, pol.disc_pct, pol.raw_material, pol.process_description, pol.norms, pol.process_cost
             FROM purchase_order_lines pol WHERE pol.po_id = $1 ORDER BY pol.sequence_number ASC, pol.po_line_id ASC`,
            [inv.po_id]
          )
        )
      }
      queries.push(
        pool.query(
          `SELECT il.invoice_line_id, il.sequence_number, il.po_line_id, il.item_name, il.hsn_sac, il.uom,
                  il.billed_qty, il.weight, il.count, il.rate, il.rate_per, il.line_total,
                  il.taxable_value, il.cgst_rate, il.cgst_amount, il.sgst_rate, il.sgst_amount, il.total_tax_amount
           FROM invoice_lines il WHERE il.invoice_id = $1 ORDER BY il.sequence_number ASC NULLS LAST, il.invoice_line_id ASC`,
          [inv.invoice_id]
        )
      )
      const resolved = await Promise.all(queries)
      let idx = 0
      if (inv.po_id) {
        grnList = resolved[idx++].rows
        asnList = resolved[idx++].rows
        poLinesList = resolved[idx++].rows
      }
      invoiceLinesList = resolved[idx].rows
      result.push({
        ...inv,
        grn_list: grnList,
        asn_list: asnList,
        po_lines: poLinesList,
        invoice_lines: invoiceLinesList
      })
    }
    res.json(result)
  } catch (err) {
    console.error('Pending approval list error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Approve payment: create/update payment_approvals to approved, snapshot banking (from body or supplier)
router.post('/payments/approve', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  const client = await pool.connect()
  try {
    const userId = req.user?.user_id
    const { invoiceId, bank_account_name, bank_account_number, bank_ifsc_code, bank_name, branch_name, notes } = req.body || {}
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId_required' })
    const invId = parseInt(invoiceId, 10)
    if (Number.isNaN(invId)) return res.status(400).json({ error: 'invalid_invoice_id' })

    await client.query('BEGIN')

    const inv = await client.query(
      `SELECT i.invoice_id, i.po_id, i.supplier_id, i.total_amount, i.debit_note_value,
              s.bank_account_name AS s_bank_name, s.bank_account_number AS s_bank_no,
              s.bank_ifsc_code AS s_ifsc, s.bank_name AS s_bank, s.branch_name AS s_branch
       FROM invoices i
       LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
       WHERE i.invoice_id = $1 AND i.status = 'validated'`,
      [invId]
    )
    if (inv.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'invoice_not_found', message: 'Invoice not found or not validated' })
    }
    const row = inv.rows[0]
    const totalAmount = row.debit_note_value != null ? row.debit_note_value : row.total_amount
    const bankName = bank_account_name != null ? bank_account_name : row.s_bank_name
    const bankNo = bank_account_number != null ? bank_account_number : row.s_bank_no
    const ifsc = bank_ifsc_code != null ? bank_ifsc_code : row.s_ifsc
    const bank = bank_name != null ? bank_name : row.s_bank
    const branch = branch_name != null ? branch_name : row.s_branch

    await client.query(
      `INSERT INTO payment_approvals
        (invoice_id, po_id, supplier_id, status, total_amount, debit_note_value,
         bank_account_name, bank_account_number, bank_ifsc_code, bank_name, branch_name,
         approved_by, approved_at, notes, updated_at)
       VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, NOW())
       ON CONFLICT (invoice_id) DO UPDATE SET
         po_id = EXCLUDED.po_id,
         supplier_id = EXCLUDED.supplier_id,
         status = 'approved',
         total_amount = EXCLUDED.total_amount,
         debit_note_value = EXCLUDED.debit_note_value,
         bank_account_name = EXCLUDED.bank_account_name,
         bank_account_number = EXCLUDED.bank_account_number,
         bank_ifsc_code = EXCLUDED.bank_ifsc_code,
         bank_name = EXCLUDED.bank_name,
         branch_name = EXCLUDED.branch_name,
         approved_by = EXCLUDED.approved_by,
         approved_at = NOW(),
         notes = EXCLUDED.notes,
         updated_at = NOW()`,
      [invId, row.po_id, row.supplier_id, totalAmount, row.debit_note_value,
        bankName, bankNo, ifsc, bank, branch, userId, notes || null]
    )
    await client.query(
      "UPDATE invoices SET status = 'ready_for_payment', updated_at = NOW() WHERE invoice_id = $1",
      [invId]
    )
    await client.query('COMMIT')
    res.json({ success: true, message: 'Payment approved' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Approve payment error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Reject payment
router.patch('/payments/reject', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  try {
    const userId = req.user?.user_id
    const { invoiceId, rejection_reason } = req.body || {}
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId_required' })
    const invId = parseInt(invoiceId, 10)
    if (Number.isNaN(invId)) return res.status(400).json({ error: 'invalid_invoice_id' })

    const inv = await pool.query(
      'SELECT invoice_id, po_id, supplier_id, total_amount, debit_note_value FROM invoices WHERE invoice_id = $1',
      [invId]
    )
    if (inv.rows.length === 0) return res.status(404).json({ error: 'invoice_not_found' })
    const row = inv.rows[0]
    const totalAmount = row.debit_note_value != null ? row.debit_note_value : row.total_amount

    await pool.query(
      `INSERT INTO payment_approvals
        (invoice_id, po_id, supplier_id, status, total_amount, debit_note_value, rejected_by, rejected_at, rejection_reason, updated_at)
       VALUES ($1, $2, $3, 'rejected', $4, $5, $6, NOW(), $7, NOW())
       ON CONFLICT (invoice_id) DO UPDATE SET
         status = 'rejected',
         rejected_by = EXCLUDED.rejected_by,
         rejected_at = NOW(),
         rejection_reason = EXCLUDED.rejection_reason,
         updated_at = NOW()`,
      [invId, row.po_id, row.supplier_id, totalAmount, row.debit_note_value, userId, rejection_reason || null]
    )
    await pool.query(
      "UPDATE invoices SET status = 'rejected', updated_at = NOW() WHERE invoice_id = $1",
      [invId]
    )
    res.json({ success: true, message: 'Payment rejected' })
  } catch (err) {
    console.error('Reject payment error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// List approved and partially paid payments (ready for payment execution)
router.get('/payments/ready', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pa.id, pa.invoice_id, pa.po_id, pa.supplier_id, pa.status, pa.total_amount, pa.debit_note_value,
              pa.bank_account_name, pa.bank_account_number, pa.bank_ifsc_code, pa.bank_name, pa.branch_name,
              pa.approved_by, pa.approved_at, pa.notes,
              (SELECT COALESCE(SUM(pt.amount), 0)::numeric(15,2) FROM payment_transactions pt WHERE pt.payment_approval_id = pa.id) AS paid_amount,
              i.invoice_number, i.invoice_date, i.payment_due_date,
              s.supplier_name, s.gst_number AS supplier_gst, s.pan_number AS supplier_pan, s.supplier_address, s.email AS supplier_email, s.phone AS supplier_phone,
              po.po_number, po.date AS po_date, po.terms AS po_terms
       FROM payment_approvals pa
       JOIN invoices i ON i.invoice_id = pa.invoice_id
       LEFT JOIN suppliers s ON s.supplier_id = pa.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = pa.po_id
       WHERE pa.status IN ('approved', 'partially_paid')
       ORDER BY i.payment_due_date ASC NULLS LAST, pa.id ASC`
    )
    const result = []
    for (const r of rows) {
      let grnList = []
      let asnList = []
      if (r.po_id) {
        const [grnRes, asnRes] = await Promise.all([
          pool.query('SELECT id, grn_no, grn_date, dc_no, dc_date, grn_qty, accepted_qty, unit_cost FROM grn WHERE po_id = $1 ORDER BY grn_date DESC', [r.po_id]),
          pool.query('SELECT a.id, a.asn_no, a.dc_no, a.dc_date, a.inv_no, a.inv_date, a.lr_no, a.transporter_name FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,\'\')) <> \'\' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) WHERE inv.po_id = $1 ORDER BY a.dc_date DESC', [r.po_id])
        ])
        grnList = grnRes.rows
        asnList = asnRes.rows
      }
      result.push({ ...r, grn_list: grnList, asn_list: asnList })
    }
    res.json(result)
  } catch (err) {
    console.error('Ready payments list error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Record a partial or full payment
router.post('/payments/record-payment', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  const client = await pool.connect()
  try {
    const userId = req.user?.user_id
    const { paymentApprovalId, amount, notes, paymentType, paymentReference } = req.body || {}
    const approvalId = paymentApprovalId != null ? parseInt(paymentApprovalId, 10) : NaN
    if (Number.isNaN(approvalId) || amount == null) {
      return res.status(400).json({ error: 'invalid_input', message: 'paymentApprovalId and amount are required' })
    }
    const payAmount = parseFloat(amount)
    if (!Number.isFinite(payAmount) || payAmount <= 0) {
      return res.status(400).json({ error: 'invalid_amount', message: 'Amount must be a positive number' })
    }

    await client.query('BEGIN')

    const pa = await client.query(
      `SELECT pa.id, pa.invoice_id, pa.total_amount, pa.debit_note_value, pa.status
       FROM payment_approvals pa
       WHERE pa.id = $1 AND pa.status IN ('approved', 'partially_paid')`,
      [approvalId]
    )
    if (pa.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'not_found', message: 'Approval not found or not in approved/partially_paid status' })
    }
    const row = pa.rows[0]
    const totalAmount = parseFloat(row.debit_note_value != null ? row.debit_note_value : row.total_amount) || 0

    const sumResult = await client.query(
      'SELECT COALESCE(SUM(amount), 0)::numeric(15,2) AS paid FROM payment_transactions WHERE payment_approval_id = $1',
      [approvalId]
    )
    const paidSoFar = parseFloat(sumResult.rows[0]?.paid || 0)
    const remaining = totalAmount - paidSoFar
    if (payAmount > remaining) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'amount_exceeds_remaining', message: `Amount cannot exceed remaining balance (₹${remaining.toFixed(2)})` })
    }

    await client.query(
      `INSERT INTO payment_transactions (payment_approval_id, amount, paid_by, notes, payment_type, payment_reference) VALUES ($1, $2, $3, $4, $5, $6)`,
      [approvalId, payAmount, userId, notes || null, paymentType || null, paymentReference || null]
    )

    const newPaidTotal = paidSoFar + payAmount
    const isFullyPaid = newPaidTotal >= totalAmount - 0.01

    if (isFullyPaid) {
      await client.query(
        `UPDATE payment_approvals SET status = 'payment_done', payment_done_by = $1, payment_done_at = NOW(), payment_type = $2, payment_reference = $3, updated_at = NOW() WHERE id = $4`,
        [userId, paymentType || null, paymentReference || null, approvalId]
      )
      await client.query(
        "UPDATE invoices SET status = 'paid', updated_at = NOW() WHERE invoice_id = $1",
        [row.invoice_id]
      )
    } else {
      await client.query(
        `UPDATE payment_approvals SET status = 'partially_paid', updated_at = NOW() WHERE id = $1`,
        [approvalId]
      )
      await client.query(
        "UPDATE invoices SET status = 'partially_paid', updated_at = NOW() WHERE invoice_id = $1",
        [row.invoice_id]
      )
    }

    await client.query('COMMIT')
    res.json({
      success: true,
      message: isFullyPaid ? 'Payment completed' : 'Partial payment recorded',
      paidSoFar: newPaidTotal,
      remaining: totalAmount - newPaidTotal,
      status: isFullyPaid ? 'payment_done' : 'partially_paid'
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Record payment error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Payment history: payment_done and partially_paid, with part-payment transactions for each
router.get('/payments/history', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pa.id, pa.invoice_id, pa.po_id, pa.supplier_id, pa.status, pa.total_amount, pa.debit_note_value,
              pa.bank_account_name, pa.bank_account_number, pa.bank_ifsc_code, pa.bank_name, pa.branch_name,
              pa.approved_by, pa.approved_at, pa.payment_done_by, pa.payment_done_at, pa.payment_type, pa.payment_reference, pa.notes,
              i.invoice_number, i.invoice_date, i.payment_due_date,
              s.supplier_name, s.gst_number AS supplier_gst, s.pan_number AS supplier_pan, s.supplier_address, s.email AS supplier_email, s.phone AS supplier_phone,
              po.po_number, po.date AS po_date, po.terms AS po_terms,
              u_done.username AS payment_done_by_username, u_done.full_name AS payment_done_by_name
       FROM payment_approvals pa
       JOIN invoices i ON i.invoice_id = pa.invoice_id
       LEFT JOIN suppliers s ON s.supplier_id = pa.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = pa.po_id
       LEFT JOIN users u_done ON u_done.user_id = pa.payment_done_by
       WHERE pa.status IN ('payment_done', 'partially_paid')
         AND (pa.status = 'partially_paid' OR pa.payment_done_at IS NOT NULL)
       ORDER BY COALESCE(pa.payment_done_at, (SELECT MAX(pt.paid_at) FROM payment_transactions pt WHERE pt.payment_approval_id = pa.id)) DESC NULLS LAST, pa.id DESC`
    )
    const result = []
    for (const r of rows) {
      let grnList = []
      let asnList = []
      if (r.po_id) {
        const [grnRes, asnRes] = await Promise.all([
          pool.query('SELECT id, grn_no, grn_date, dc_no, dc_date, grn_qty, accepted_qty, unit_cost FROM grn WHERE po_id = $1 ORDER BY grn_date DESC', [r.po_id]),
          pool.query('SELECT a.id, a.asn_no, a.dc_no, a.dc_date, a.inv_no, a.inv_date, a.lr_no, a.transporter_name FROM asn a JOIN invoices inv ON TRIM(COALESCE(a.inv_no,\'\')) <> \'\' AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no)) WHERE inv.po_id = $1 ORDER BY a.dc_date DESC', [r.po_id])
        ])
        grnList = grnRes.rows
        asnList = asnRes.rows
      }
      let paymentTransactions = []
      try {
        const txRows = await pool.query(
          `SELECT pt.id, pt.amount, pt.paid_at, pt.notes, pt.payment_type, pt.payment_reference, u.username AS paid_by_username, u.full_name AS paid_by_name
           FROM payment_transactions pt
           LEFT JOIN users u ON u.user_id = pt.paid_by
           WHERE pt.payment_approval_id = $1 ORDER BY pt.paid_at ASC`,
          [r.id]
        )
        paymentTransactions = txRows.rows || []
      } catch (txErr) {
        console.warn('Payment transactions fetch failed for approval', r.id, txErr.message)
      }
      result.push({ ...r, grn_list: grnList, asn_list: asnList, payment_transactions: paymentTransactions })
    }
    res.json(result)
  } catch (err) {
    console.error('Payment history list error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Mark payment as done (records full remaining amount as one transaction, then marks done)
router.patch('/payments/:id/mark-done', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  const client = await pool.connect()
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_id' })
    const userId = req.user?.user_id
    const { paymentType, paymentReference } = req.body || {}

    await client.query('BEGIN')

    const pa = await client.query(
      `SELECT pa.id, pa.invoice_id, pa.total_amount, pa.debit_note_value, pa.status
       FROM payment_approvals pa WHERE pa.id = $1 AND pa.status IN ('approved', 'partially_paid')`,
      [id]
    )
    if (pa.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'not_found', message: 'Approval record not found or not in approved/partially_paid status' })
    }
    const row = pa.rows[0]
    const totalAmount = parseFloat(row.debit_note_value != null ? row.debit_note_value : row.total_amount) || 0
    const sumResult = await client.query(
      'SELECT COALESCE(SUM(amount), 0)::numeric(15,2) AS paid FROM payment_transactions WHERE payment_approval_id = $1',
      [id]
    )
    const paidSoFar = parseFloat(sumResult.rows[0]?.paid || 0)
    const remaining = Math.max(0, totalAmount - paidSoFar)

    if (remaining > 0) {
      await client.query(
        `INSERT INTO payment_transactions (payment_approval_id, amount, paid_by, payment_type, payment_reference) VALUES ($1, $2, $3, $4, $5)`,
        [id, remaining, userId, paymentType || null, paymentReference || null]
      )
    }

    await client.query(
      `UPDATE payment_approvals SET status = 'payment_done', payment_done_by = $1, payment_done_at = NOW(), payment_type = $2, payment_reference = $3, updated_at = NOW() WHERE id = $4`,
      [userId, paymentType || null, paymentReference || null, id]
    )
    await client.query(
      "UPDATE invoices SET status = 'paid', updated_at = NOW() WHERE invoice_id = $1",
      [row.invoice_id]
    )

    await client.query('COMMIT')
    res.json({ success: true, message: 'Payment marked as done' })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Mark done error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Mount API routes under /api prefix
app.use('/api', router)

// Production: serve frontend static files and SPA fallback
if (process.env.NODE_ENV === 'production') {
  const publicDir = path.join(__dirname, '..', 'public')
  app.use(express.static(publicDir))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

export default app

// Env validation at startup (required in production)
function validateEnv() {
  if (process.env.NODE_ENV === 'production') {
    const required = []
    if (!process.env.JWT_SECRET) required.push('JWT_SECRET')
    if (!process.env.DATABASE_URL && !process.env.PGDATABASE) required.push('PGDATABASE or DATABASE_URL')
    if (!process.env.DATABASE_URL && !process.env.PGUSER) required.push('PGUSER')
    if (!process.env.DATABASE_URL && !process.env.PGPASSWORD) required.push('PGPASSWORD')
    if (required.length > 0) {
      console.error('Missing required env vars:', required.join(', '))
      process.exit(1)
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  validateEnv()
  const port = process.env.PORT || 4000
  app.listen(port, () => {
    console.log(`Billing System API listening on http://localhost:${port}`)
  })
}
