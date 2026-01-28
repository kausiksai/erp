import 'dotenv/config'
import express from 'express'
import cors from 'cors'
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

const app = express()

app.use(cors())
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

// Health check (no prefix needed)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

app.get('/db-health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 as ok')
    res.json({ status: 'ok', db: rows[0].ok })
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message })
  }
})

// Create API router for /api prefix routes
const router = express.Router()

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
        data.poNumber = jsonData.poNumber || ''
        data.supplierName = jsonData.supplierName || ''
        data.billTo = jsonData.billTo || ''
        
        // Helper function to parse numeric values (removes currency symbols, commas, and units)
        const parseNumeric = (value) => {
          if (!value || value === '') return null
          if (typeof value === 'number') return value
          const str = String(value).trim()
          // Remove currency symbols and commas first
          let cleaned = str.replace(/[₹$,€₹]/g, '')
          // Extract the first number found (handles cases like "240.700 Kgs" or "55,361.00")
          // Match number with optional decimal part
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

// Login
router.post('/auth/login', async (req, res) => {
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
        fullName: user.full_name
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


// Get invoice PDF
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params
    const { rows } = await pool.query(
      `SELECT file_name, file_data FROM invoice_attachments 
       WHERE invoice_id = $1 
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
         s.email as supplier_email,
         s.phone as supplier_phone,
         s.mobile as supplier_mobile,
         po.po_id,
         po.po_number,
         po.po_date,
         po.bill_to,
         po.bill_to_address,
         po.bill_to_gstin,
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
    
    // Get PO line items if PO exists
    let poLineItems = []
    if (invoice.po_id) {
      const { rows: poLines } = await pool.query(
        `SELECT 
           pol.po_line_id,
           pol.po_id,
           pol.item_name,
           pol.item_description,
           pol.hsn_sac,
           pol.uom,
           pol.quantity,
           pol.sequence_number
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

// Create invoice (only saves when Save Invoice is clicked - no updates to suppliers, PO, or other tables)
router.post('/invoices', async (req, res) => {
  const client = await pool.connect()
  try {
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
      pdfFileName,
      pdfBuffer
    } = req.body
    
    await client.query('BEGIN')
    
    // CREATE new invoice (no updates to suppliers, PO, or other tables)
    const { rows: invoiceRows } = await client.query(
      `INSERT INTO invoices (invoice_number, invoice_date, supplier_id, po_id, scanning_number, total_amount, tax_amount, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (invoice_number) DO UPDATE
       SET invoice_date = EXCLUDED.invoice_date,
           supplier_id = EXCLUDED.supplier_id,
           po_id = EXCLUDED.po_id,
           scanning_number = EXCLUDED.scanning_number,
           total_amount = EXCLUDED.total_amount,
           tax_amount = EXCLUDED.tax_amount,
           status = EXCLUDED.status,
           notes = EXCLUDED.notes,
           updated_at = NOW()
       RETURNING invoice_id`,
      [
        invoiceNumber || `INV-${Date.now()}`,
        invoiceDate || null,
        supplierId || null, // Use provided supplier ID, don't create/update suppliers
        poId || null, // Use provided PO ID, don't update PO
        scanningNumber || null,
        totalAmount ? parseFloat(totalAmount) : null,
        taxAmount ? parseFloat(taxAmount) : null,
        status || 'pending',
        notes || null
      ]
    )
    
    const invoiceId = invoiceRows[0].invoice_id
    
    // Store PDF attachment if provided
    if (pdfFileName && pdfBuffer) {
      const pdfBufferBinary = Buffer.from(pdfBuffer, 'base64')
      await client.query(
        `INSERT INTO invoice_attachments (invoice_id, file_name, file_data)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [invoiceId, pdfFileName, pdfBufferBinary]
      )
    }
    
    // Get PO line items if PO is linked (for matching only, no updates)
    let poLineItems = []
    if (poId) {
      const poLinesResult = await client.query(
        'SELECT po_line_id, item_name, sequence_number FROM purchase_order_lines WHERE po_id = $1 ORDER BY sequence_number',
        [poId]
      )
      poLineItems = poLinesResult.rows
    }
    
    // Insert invoice lines
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
        
        await client.query(
          `INSERT INTO invoice_lines 
           (invoice_id, po_id, po_line_id, item_name, hsn_sac, uom, billed_qty, rate, rate_per,
            line_total, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
            total_tax_amount, sequence_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            invoiceId,
            poId || null,
            poLineId,
            item.itemName || '',
            item.hsnSac || item.itemCode || null,
            item.uom || null,
            item.billedQty ? parseFloat(item.billedQty) : null,
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
      items
    } = req.body
    
    await client.query('BEGIN')
    
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
        'SELECT po_line_id, item_name, sequence_number FROM purchase_order_lines WHERE po_id = $1 ORDER BY sequence_number',
        [finalPoId]
      )
      poLineItems = poLinesResult.rows
    }
    
    // Update items if provided
    if (Array.isArray(items)) {
      // Delete existing lines
      await client.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [id])
      
      // Insert new lines
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
        
        await client.query(
          `INSERT INTO invoice_lines 
           (invoice_id, po_id, po_line_id, item_name, hsn_sac, uom, billed_qty, rate, rate_per,
            line_total, taxable_value, cgst_rate, cgst_amount, sgst_rate, sgst_amount,
            total_tax_amount, sequence_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            id,
            finalPoId,
            poLineId,
            item.itemName || '',
            item.hsnSac || item.itemCode || null,
            item.uom || null,
            item.billedQty ? parseFloat(item.billedQty) : null,
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
        i.created_at,
        i.updated_at,
        s.supplier_name,
        s.supplier_id,
        po.po_id,
        po.po_number,
        po.po_date
      FROM invoices i
      LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = i.po_id
      WHERE 1=1
    `
    
    const params = []
    let paramCount = 0
    
    if (status) {
      paramCount++
      query += ` AND i.status = $${paramCount}`
      params.push(status)
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

// Get purchase order by PO number
// Get all purchase orders
router.get('/purchase-orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         po.po_id,
         po.po_number,
         po.po_date,
         po.bill_to,
         po.bill_to_address,
         po.bill_to_gstin,
         po.status,
         po.terms_and_conditions,
         po.payment_terms,
         po.delivery_terms,
         po.created_at,
         po.updated_at,
         s.supplier_name,
         s.supplier_id,
         (SELECT COUNT(*) FROM purchase_order_lines pol WHERE pol.po_id = po.po_id) as line_item_count
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       ORDER BY po.po_date DESC, po.created_at DESC`
    )
    
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Get purchase order line items by PO ID
router.get('/purchase-orders/:poId/line-items', async (req, res) => {
  try {
    const { poId } = req.params
    const result = await pool.query(
      `SELECT 
         pol.po_line_id,
         pol.po_id,
         pol.item_name,
         pol.item_description,
         pol.hsn_sac,
         pol.uom,
         pol.quantity,
         pol.sequence_number
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
    // Decode the PO number in case it's URL encoded
    let { poNumber } = req.params
    poNumber = decodeURIComponent(poNumber)
    
    // Get purchase order with supplier info
    const poResult = await pool.query(
      `SELECT 
         po.*,
         s.supplier_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       WHERE po.po_number = $1`,
      [poNumber]
    )
    
    if (poResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'not_found', 
        message: `Purchase order number "${poNumber}" does not exist in the system`
      })
    }
    
    const po = poResult.rows[0]
    
    // Get purchase order lines with all fields including po_line_id
    const linesResult = await pool.query(
      `SELECT 
         pol.po_line_id,
         pol.po_id,
         pol.item_name,
         pol.item_description,
         pol.hsn_sac,
         pol.uom,
         pol.quantity,
         pol.sequence_number
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

// Get supplier details by name (for validation)
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

// Mount API routes under /api prefix
app.use('/api', router)

export default app

if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 4000
  app.listen(port, () => {
    console.log(`Billing System API listening on http://localhost:${port}`)
  })
}
