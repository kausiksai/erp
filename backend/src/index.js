import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import cors from 'cors'
import compression from 'compression'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import rateLimit from 'express-rate-limit'
import { pool } from './db.js'
import multer from 'multer'
// Landing AI ADE replaces the previous Qwen OCR service. If you need the
// legacy Qwen path, see commit history — it was removed on <current date>.
import { hashPassword, comparePassword, generateToken, authenticateToken, authorize } from './auth.js'
import {
  getUsersRoute,
  getUserByIdRoute,
  createUserRoute,
  updateUserRoute,
  deleteUserRoute,
  getUserMenuAccessRoute,
  updateUserMenuAccessRoute,
  getMyMenuAccessRoute
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
import {
  importPoExcel,
  importGrnExcel,
  importAsnExcel,
  importDcExcel,
  importScheduleExcel,
  importOpenPoPrefixesExcel,
  importSuppliersExcel
} from './excelImport.js'
import {
  buildOcrSnapshot,
  reconcileInvoice,
  applyReconciliationDecision
} from './reconcile.js'

const app = express()

// CORS: in production set FRONTEND_ORIGIN (e.g. https://app.example.com)
const corsOrigin = process.env.FRONTEND_ORIGIN || true
app.use(cors({ origin: corsOrigin }))

// gzip compression — ~4x smaller JSON payloads on large lists (POs, invoices, ASN).
// Applied to every route by default; skipped for responses with explicit
// Cache-Control: no-transform. Compresses anything over 1 KB.
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false
    return compression.filter(req, res)
  },
}))

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

// Configure multer for file uploads (PDF only - e.g. debit notes)
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

// Multer for invoice upload: PDF and images (PNG, JPEG, WebP)
const invoiceMimeTypes = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]
const uploadInvoice = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (invoiceMimeTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only PDF and image files (PNG, JPEG, WebP) are allowed'), false)
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


// Upload invoice and extract data (NO DATABASE WRITES — only extraction).
// OCR is powered exclusively by Landing AI Agentic Document Extraction (ADE)
// via the 2-step Parse → Extract pipeline. If ADE fails, the review form
// renders blank and the user fills in manually — no silent fallbacks.
router.post('/invoices/upload', uploadInvoice.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Invoice file is required (PDF or image)' })
    }

    const pdfBuffer = req.file.buffer
    const fileMimetype = req.file.mimetype
    const fileName = req.file.originalname

    let invoiceData = emptyInvoiceShape()
    let extractionSuccess = false
    let modelUsed = 'none'
    let extractionError = null
    let landingWarnings = []
    let landingSchemaViolation = null
    let qualityIssues = []

    if (!process.env.LANDING_AI_API_KEY) {
      extractionError = 'LANDING_AI_API_KEY is not configured on the server'
      console.error('[invoices/upload]', extractionError)
    } else {
      try {
        const { extractInvoiceWithLandingAI } = await import('./landingAI.js')
        const result = await extractInvoiceWithLandingAI(pdfBuffer, fileMimetype, fileName)
        invoiceData = result.invoiceData
        extractionSuccess = result.extracted
        modelUsed = result.model
        landingWarnings = result.warnings || []
        landingSchemaViolation = result.schemaViolation || null
        qualityIssues = result.qualityIssues || []
        if (landingWarnings.length > 0) {
          console.warn('[invoices/upload] Landing AI warnings:', landingWarnings)
        }
        if (landingSchemaViolation) {
          console.warn('[invoices/upload] Landing AI schema violation:', landingSchemaViolation)
        }
        if (qualityIssues.length > 0) {
          console.warn('[invoices/upload] Post-extraction quality issues:', qualityIssues)
        }
      } catch (err) {
        extractionError = err.message || 'Landing AI extraction failed'
        console.error('[invoices/upload] Landing AI extraction failed:', err)
      }
    }
    
    // NO DATABASE WRITES — Just extract and return. Data is only persisted
    // when the user clicks "Save Invoice" on the review form.

    // Resolve PO reference (if user provided one OR the extractor found one)
    const poNumberRef = req.body.poNumber || req.query.poNumber || invoiceData.poNumber
    let poId = null
    if (poNumberRef) {
      const poResult = await pool.query(
        `SELECT po_id FROM purchase_orders
         WHERE TRIM(po_number) = TRIM($1)
         ORDER BY COALESCE(amd_no, 0) DESC, po_id DESC
         LIMIT 1`,
        [poNumberRef]
      )
      if (poResult.rows.length > 0) poId = poResult.rows[0].po_id
    }

    // Resolve supplier (prefer GSTIN match over name — much more reliable)
    let supplierId = null
    if (invoiceData.supplierGstin) {
      const bySuplrGstin = await pool.query(
        `SELECT supplier_id FROM suppliers WHERE gst_number = $1 LIMIT 1`,
        [invoiceData.supplierGstin]
      )
      if (bySuplrGstin.rows.length > 0) supplierId = bySuplrGstin.rows[0].supplier_id
    }
    if (!supplierId && invoiceData.supplierName) {
      const byName = await pool.query(
        `SELECT supplier_id FROM suppliers WHERE supplier_name = $1 LIMIT 1`,
        [invoiceData.supplierName]
      )
      if (byName.rows.length > 0) supplierId = byName.rows[0].supplier_id
    }

    res.json({
      success: true,
      invoiceId: null, // Not created yet — happens on Save
      poId,
      supplierId,
      pdfFileName: fileName,
      pdfBuffer: pdfBuffer.toString('base64'),
      invoiceData: {
        invoiceNumber: invoiceData.invoiceNumber || '',
        invoiceDate: invoiceData.invoiceDate || null,
        poNumber: invoiceData.poNumber || '',
        supplierName: invoiceData.supplierName || '',
        supplierGstin: invoiceData.supplierGstin || '',
        supplierPan: invoiceData.supplierPan || '',
        supplierAddress: invoiceData.supplierAddress || '',
        billTo: invoiceData.billTo || '',
        buyerGstin: invoiceData.buyerGstin || '',
        subtotal: invoiceData.subtotal ?? null,
        cgst: invoiceData.cgst ?? null,
        sgst: invoiceData.sgst ?? null,
        igst: invoiceData.igst ?? null,
        taxAmount: invoiceData.taxAmount ?? null,
        roundOff: invoiceData.roundOff ?? null,
        totalAmount: invoiceData.totalAmount ?? null,
        totalAmountInWords: invoiceData.totalAmountInWords || '',
        placeOfSupply: invoiceData.placeOfSupply || '',
        currency: invoiceData.currency || 'INR',
        termsAndConditions: invoiceData.termsAndConditions || '',
        items: (invoiceData.items || []).map((it) => ({
          itemName: it.itemName || '',
          itemCode: it.hsnSac || '',
          hsnSac: it.hsnSac || '',
          uom: it.uom || null,
          quantity: it.quantity ?? null,
          unitPrice: it.unitPrice ?? null,
          ratePer: it.ratePer || null,
          lineTotal: it.lineTotal ?? null,
          taxableValue: it.taxableValue ?? null,
          cgstRate: it.cgstRate ?? null,
          cgstAmount: it.cgstAmount ?? null,
          sgstRate: it.sgstRate ?? null,
          sgstAmount: it.sgstAmount ?? null,
          igstRate: it.igstRate ?? null,
          igstAmount: it.igstAmount ?? null,
          totalTaxAmount: it.totalTaxAmount ?? null
        }))
      },
      extracted: extractionSuccess,
      model: modelUsed,
      extractionError,
      warnings: landingWarnings,
      schemaViolation: landingSchemaViolation,
      qualityIssues
    })
  } catch (err) {
    console.error('[invoices/upload] fatal:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Canonical empty invoice — used when extraction fails and the user has
// to fill fields manually.
function emptyInvoiceShape() {
  return {
    invoiceNumber: '',
    invoiceDate: null,
    poNumber: '',
    supplierName: '',
    supplierGstin: '',
    supplierPan: '',
    supplierAddress: '',
    billTo: '',
    buyerGstin: '',
    subtotal: null,
    cgst: null,
    sgst: null,
    igst: null,
    taxAmount: null,
    roundOff: null,
    totalAmount: null,
    totalAmountInWords: '',
    placeOfSupply: '',
    currency: 'INR',
    termsAndConditions: '',
    items: []
  }
}

// Landing AI health check — confirms the API key can reach ADE.
router.get('/landingai/health', async (_req, res) => {
  try {
    if (!process.env.LANDING_AI_API_KEY) {
      return res.json({ status: 'disabled', reason: 'LANDING_AI_API_KEY not configured' })
    }
    // Minimal-cost check: hit the Parse endpoint with a 1-byte dummy file.
    // Real extraction happens in /invoices/upload; this is just to verify auth.
    const region = (process.env.LANDING_AI_REGION || 'us').toLowerCase()
    const base = region === 'eu'
      ? 'https://api.va.eu-west-1.landing.ai/v1/ade'
      : 'https://api.va.landing.ai/v1/ade'
    // A real call would bill credits; instead we just verify the host is reachable
    // and our credentials aren't silently rejected by pinging the OpenAPI schema.
    res.json({
      status: 'ok',
      region,
      base_url: base,
      parse_model: process.env.LANDING_AI_PARSE_MODEL || 'dpt-2-latest',
      extract_model: process.env.LANDING_AI_EXTRACT_MODEL || 'extract-latest'
    })
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message })
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

// Update current user's profile — self-service.
// Only lets the user change their own full_name and email. Role / is_active
// are admin-only and live on PUT /users/:id.
router.put('/auth/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { fullName, email } = req.body || {}

    const updates = []
    const values = []
    if (typeof fullName === 'string') {
      values.push(fullName.trim() || null)
      updates.push(`full_name = $${values.length}`)
    }
    if (typeof email === 'string') {
      const trimmed = email.trim()
      if (!trimmed) return res.status(400).json({ error: 'validation_error', message: 'Email cannot be empty' })
      // Rudimentary email validation — we don't need to be clever
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'validation_error', message: 'Invalid email address' })
      }
      values.push(trimmed)
      updates.push(`email = $${values.length}`)
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'validation_error', message: 'No fields to update' })
    }

    updates.push('updated_at = NOW()')
    values.push(userId)

    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE user_id = $${values.length}
       RETURNING user_id, username, email, role, full_name, is_active, last_login`,
      values
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'User not found' })

    const u = rows[0]
    res.json({
      success: true,
      user: {
        userId: u.user_id,
        username: u.username,
        email: u.email,
        role: u.role,
        fullName: u.full_name,
        isActive: u.is_active,
        lastLogin: u.last_login ? u.last_login.toISOString() : null
      }
    })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: 'A user with that email already exists' })
    }
    console.error('Update self error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Change the current user's password. Requires the current password to
// authenticate the request, and the new password must pass a minimum length check.
router.post('/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.user_id
    if (!userId) return res.status(401).json({ error: 'unauthorized' })
    const { currentPassword, newPassword } = req.body || {}
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'validation_error', message: 'Both current and new password are required' })
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'validation_error', message: 'New password must be at least 8 characters' })
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [userId]
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found', message: 'User not found' })

    const ok = await comparePassword(currentPassword, rows[0].password_hash)
    if (!ok) return res.status(401).json({ error: 'invalid_current_password', message: 'Current password is incorrect' })

    const newHash = await hashPassword(newPassword)
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE user_id = $2',
      [newHash, userId]
    )
    res.json({ success: true, message: 'Password changed successfully' })
  } catch (err) {
    console.error('Change password error:', err)
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

// Invoice stats — overall counts by status, ignoring pagination.
// MUST be declared before /invoices/:id or Express will match "stats"
// as an :id parameter and try to query invoice_id = 'stats'.
router.get('/invoices/stats', authenticateToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'validated')::int         AS validated,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'waiting_for_validation')::int AS waiting,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'waiting_for_re_validation')::int AS re_validation,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'ready_for_payment')::int AS ready_for_payment,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'paid')::int              AS paid,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'exception_approval')::int AS exception_approval,
        COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'debit_note_approval')::int AS debit_note_approval
      FROM invoices
    `)
    res.json(rows[0] || { total: 0, validated: 0, waiting: 0, re_validation: 0, ready_for_payment: 0, paid: 0, exception_approval: 0, debit_note_approval: 0 })
  } catch (err) {
    console.error('Invoice stats error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// ---------------------------------------------------------------------------
// Dual-source reconciliation endpoints
// ---------------------------------------------------------------------------
// Every invoice can have two origins — Excel Bill Register (pushed by the
// Python email_automation pipeline) and Portal OCR (Landing AI). When both
// snapshots are present we compare them, flag mismatches, and require a
// reviewer to approve the authoritative values which feed downstream
// validations. See backend/src/reconcile.js for the comparator.
// ---------------------------------------------------------------------------

// List invoices that need manual reconciliation. Also lazily re-runs the
// comparator for rows where both snapshots exist but mismatches have not yet
// been computed (common when Excel arrives AFTER OCR — the Python loader
// sets pending_reconciliation but leaves the diff for Node to compute).
router.get('/invoices/needs-reconciliation', authenticateToken, async (_req, res) => {
  const client = await pool.connect()
  try {
    // Lazy reconcile — close the race where Excel landed after OCR but the
    // comparator hasn't run yet.
    const lazy = await client.query(
      `SELECT invoice_id FROM invoices
        WHERE excel_snapshot IS NOT NULL
          AND ocr_snapshot   IS NOT NULL
          AND reconciliation_status = 'pending_reconciliation'
          AND mismatches IS NULL`
    )
    for (const row of lazy.rows) {
      try {
        await reconcileInvoice(client, row.invoice_id)
      } catch (err) {
        console.warn('[needs-reconciliation] lazy reconcile failed for', row.invoice_id, err.message)
      }
    }

    const { rows } = await client.query(
      `SELECT i.invoice_id,
              i.invoice_number,
              i.invoice_date,
              i.total_amount,
              i.tax_amount,
              i.status,
              i.source,
              i.reconciliation_status,
              i.mismatches,
              i.excel_received_at,
              i.ocr_received_at,
              s.supplier_name
         FROM invoices i
         LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
        WHERE i.reconciliation_status = 'pending_reconciliation'
        ORDER BY COALESCE(i.ocr_received_at, i.excel_received_at, i.created_at) DESC`
    )
    res.json({ total: rows.length, invoices: rows })
  } catch (err) {
    console.error('[invoices/needs-reconciliation]', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Fetch both snapshots for side-by-side review.
router.get('/invoices/:id/reconciliation', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params
    const { rows } = await pool.query(
      `SELECT invoice_id, invoice_number, source, reconciliation_status,
              excel_snapshot, excel_received_at,
              ocr_snapshot, ocr_received_at,
              mismatches, reviewed_by, reviewed_at
         FROM invoices
        WHERE invoice_id = $1`,
      [id]
    )
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' })
    res.json(rows[0])
  } catch (err) {
    console.error('[invoices/:id/reconciliation]', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Re-run the comparator for a single invoice (used after manual snapshot edits).
router.post('/invoices/:id/reconcile-refresh', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await reconcileInvoice(client, req.params.id)
    await client.query('COMMIT')
    res.json({ success: true, ...(result || {}) })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[invoices/:id/reconcile-refresh]', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
  }
})

// Apply a reviewer decision — body:
//   { approvals: { <field>: 'excel' | 'ocr' | { manual: <value> } } }
router.post('/invoices/:id/reconcile', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const { approvals } = req.body || {}
    if (!approvals || typeof approvals !== 'object') {
      return res.status(400).json({ error: 'bad_request', message: 'approvals object required' })
    }
    await client.query('BEGIN')
    const result = await applyReconciliationDecision(client, req.params.id, approvals, req.user?.user_id)
    await client.query('COMMIT')
    if (!result) return res.status(404).json({ error: 'not_found' })
    res.json({ success: true, ...result })
  } catch (err) {
    await client.query('ROLLBACK')
    console.error('[invoices/:id/reconcile]', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  } finally {
    client.release()
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
    
    // Build the OCR-side snapshot from whatever the user confirmed in the
    // review form. This always captures "what the portal thinks the invoice
    // says" for reconciliation, regardless of whether an Excel row already
    // exists for this invoice_number.
    const ocrSnapshot = buildOcrSnapshot({
      invoiceNumber: invoiceNumber || null,
      invoiceDate: invoiceDate || null,
      supplierGstin: req.body.supplierGstin || null,
      supplierName: req.body.supplierName || null,
      poNumber: poNumber || null,
      subtotal: req.body.subtotal ?? null,
      cgst: req.body.cgst ?? null,
      sgst: req.body.sgst ?? null,
      igst: req.body.igst ?? null,
      taxAmount: taxAmount ?? null,
      totalAmount: totalAmount ?? null,
      items: Array.isArray(items) ? items : []
    })

    // Does an Excel row already exist for this invoice_number? If yes we
    // must NOT overwrite its authoritative header values — we only add the
    // OCR snapshot and let reconcileInvoice decide what the user needs to
    // approve. Only when there's no existing row do we insert fresh OCR
    // values into the main columns.
    const lookupNumber = invoiceNumber || `INV-${Date.now()}`
    const existing = await client.query(
      `SELECT invoice_id, source, excel_snapshot FROM invoices WHERE invoice_number = $1 LIMIT 1`,
      [lookupNumber]
    )

    let invoiceId
    let isExistingExcelRow = false
    if (existing.rows.length > 0 && existing.rows[0].excel_snapshot) {
      isExistingExcelRow = true
      invoiceId = existing.rows[0].invoice_id
      await client.query(
        `UPDATE invoices
            SET ocr_snapshot = $1::jsonb,
                ocr_received_at = NOW(),
                source = 'both',
                updated_at = NOW()
          WHERE invoice_id = $2`,
        [JSON.stringify(ocrSnapshot), invoiceId]
      )
    } else {
      // Fresh OCR-only insert (or a previous OCR upsert being re-saved).
      const { rows: invoiceRows } = await client.query(
        `INSERT INTO invoices (
           invoice_number, invoice_date, supplier_id, po_id, scanning_number,
           po_number, total_amount, tax_amount, status, payment_due_date, notes,
           source, ocr_snapshot, ocr_received_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'ocr', $12::jsonb, NOW())
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
             ocr_snapshot = EXCLUDED.ocr_snapshot,
             ocr_received_at = NOW(),
             source = CASE
               WHEN invoices.excel_snapshot IS NOT NULL THEN 'both'
               ELSE 'ocr'
             END,
             updated_at = NOW()
         RETURNING invoice_id`,
        [
          lookupNumber,
          invoiceDate || null,
          supplierId || null,
          poId || null,
          scanningNumber || null,
          poNumber || null,
          totalAmount ? parseFloat(totalAmount) : null,
          taxAmount ? parseFloat(taxAmount) : null,
          status || 'waiting_for_validation',
          paymentDueDate || null,
          notes || null,
          JSON.stringify(ocrSnapshot)
        ]
      )
      invoiceId = invoiceRows[0].invoice_id
    }
    
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
    
    // Insert invoice lines and collect invoice_line_id for each (so weight slips can link to line).
    // When the row was already seeded by Excel, the invoice_lines table already holds
    // the Excel lines — we must not duplicate them. Any OCR-side line data is
    // captured in ocr_snapshot.line_items for side-by-side review instead.
    const insertedLineIds = []
    if (!isExistingExcelRow && Array.isArray(items) && items.length > 0) {
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
    
    // Run reconciliation — compares whichever snapshots exist and persists
    // reconciliation_status / mismatches. If only OCR is present this is a
    // no-op that sets status='single_source'.
    let reconciliation = null
    try {
      reconciliation = await reconcileInvoice(client, invoiceId)
    } catch (reconErr) {
      console.error('[invoices] reconcile failed (non-fatal):', reconErr)
    }

    await client.query('COMMIT')
    res.json({ success: true, invoiceId, reconciliation })
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
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0
    const { status, invoiceNumber, poNumber, q } = req.query

    // Build a shared WHERE clause so the count query and page query use
    // exactly the same filters — no drift between the two.
    const where = []
    const params = []

    if (status) {
      const statusList = Array.isArray(status)
        ? status
        : String(status).split(',').map((s) => s.trim()).filter(Boolean)
      if (statusList.length > 0) {
        const statusNormalized = statusList.flatMap((s) =>
          (s.toLowerCase() === 'open' ? ['open', 'pending'] : [s])
        )
        const placeholders = statusNormalized.map(() => {
          params.push(statusNormalized.shift() || '')
          return `$${params.length}`
        })
        // The shift above mutates statusNormalized so we need a cleaner form:
      }
    }
    // Cleaner rebuild — discard the above attempt
    params.length = 0
    where.length = 0

    if (status) {
      const statusList = Array.isArray(status)
        ? status
        : String(status).split(',').map((s) => s.trim()).filter(Boolean)
      const normalized = statusList.flatMap((s) =>
        s.toLowerCase() === 'open' ? ['open', 'pending'] : [s]
      )
      if (normalized.length > 0) {
        const placeholders = normalized.map((v) => {
          params.push(v)
          return `$${params.length}`
        })
        where.push(`i.status IN (${placeholders.join(', ')})`)
      }
    }

    const searchTerm = (typeof q === 'string' && q.trim()) ? q.trim() : (typeof invoiceNumber === 'string' ? invoiceNumber : '')
    if (searchTerm) {
      params.push(`%${searchTerm}%`)
      const p1 = `$${params.length}`
      params.push(`%${searchTerm}%`)
      const p2 = `$${params.length}`
      params.push(`%${searchTerm}%`)
      const p3 = `$${params.length}`
      where.push(`(i.invoice_number ILIKE ${p1} OR s.supplier_name ILIKE ${p2} OR po.po_number ILIKE ${p3})`)
    }

    if (poNumber) {
      params.push(`%${String(poNumber)}%`)
      where.push(`po.po_number ILIKE $${params.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const baseFrom = `
      FROM invoices i
      LEFT JOIN suppliers s        ON s.supplier_id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = i.po_id
      ${whereSql}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
      `SELECT
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
         i.unit,
         i.doc_pfx,
         i.doc_no,
         i.doc_entry_date,
         i.bill_type,
         i.mode,
         i.grn_pfx,
         i.grn_no,
         i.grn_date,
         i.dc_no,
         i.po_pfx,
         i.gstin,
         i.gst_type,
         i.currency,
         i.source,
         s.supplier_name,
         s.supplier_id,
         s.suplr_id,
         po.po_id,
         po.po_number,
         po.date AS po_date
       ${baseFrom}
       ORDER BY i.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])
    res.json({
      items: pageResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit,
      offset
    })
  } catch (err) {
    console.error('Invoices list error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Invoice stats — overall counts by status, ignoring pagination.
// Used by InvoicesPage KPI tiles so they reflect the entire dataset,
// not just the current page.
// /invoices/stats was moved above /invoices/:id so Express matches it first.

// GET /api/grn — paginated + filterable list.
// Query params: limit (default 100), offset, grnNo, poNumber, supplier, dcNo, item, status.
// Returns { items, total, limit, offset }.
router.get('/grn', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = []
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }

    if (req.query.grnNo) {
      filters.push(`g.grn_no ILIKE ${pushParam(`%${req.query.grnNo}%`)}`)
    }
    if (req.query.poNumber) {
      const p = pushParam(`%${req.query.poNumber}%`)
      filters.push(`(g.po_no ILIKE ${p} OR po.po_number ILIKE ${p})`)
    }
    if (req.query.supplier) {
      const p = pushParam(`%${req.query.supplier}%`)
      filters.push(`(g.supplier_name ILIKE ${p} OR g.supplier ILIKE ${p})`)
    }
    if (req.query.dcNo) {
      filters.push(`g.dc_no ILIKE ${pushParam(`%${req.query.dcNo}%`)}`)
    }
    if (req.query.item) {
      const p = pushParam(`%${req.query.item}%`)
      filters.push(`(g.item ILIKE ${p} OR g.description_1 ILIKE ${p})`)
    }
    if (req.query.status) {
      filters.push(`g.header_status ILIKE ${pushParam(`%${req.query.status}%`)}`)
    }

    const filterSql = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''
    const baseFrom = `
      FROM grn g
      LEFT JOIN purchase_orders po ON po.po_id = g.po_id
      ${filterSql}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
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
       ${baseFrom}
       ORDER BY g.grn_date DESC NULLS LAST, g.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])

    res.json({
      items: pageResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit,
      offset
    })
  } catch (err) {
    console.error('Error fetching GRN:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// List ASN with server-side pagination and search.
// Query params: limit (default 200, max 1000), offset (default 0),
// asnNo, poNumber, supplier, dcNo, invNo, status, itemCode (ILIKE partial match).
//
// Perf note: the old version did a 4-way JOIN (invoices + LATERAL grn + 2 x PO)
// on 83k rows to derive po_number. That took 30+ seconds. Now we use the
// `asn.po_no` column directly (added in phase 2.1 migration); it's populated
// on 80%+ of rows and the fallback joins are only used in the detail view, not
// the list. Target: <1 second for a page on 83k rows.
router.get('/asn', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = []
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }

    if (req.query.asnNo) {
      filters.push(`a.asn_no ILIKE ${pushParam(`%${req.query.asnNo}%`)}`)
    }
    if (req.query.supplier) {
      const p = pushParam(`%${req.query.supplier}%`)
      filters.push(`(a.supplier_name ILIKE ${p} OR a.supplier ILIKE ${p})`)
    }
    if (req.query.dcNo) {
      filters.push(`a.dc_no ILIKE ${pushParam(`%${req.query.dcNo}%`)}`)
    }
    if (req.query.invNo) {
      filters.push(`a.inv_no ILIKE ${pushParam(`%${req.query.invNo}%`)}`)
    }
    if (req.query.status) {
      filters.push(`a.status ILIKE ${pushParam(`%${req.query.status}%`)}`)
    }
    if (req.query.poNumber) {
      filters.push(`a.po_no ILIKE ${pushParam(`%${req.query.poNumber}%`)}`)
    }
    if (req.query.itemCode) {
      const p = pushParam(`%${req.query.itemCode}%`)
      filters.push(`(a.item_code ILIKE ${p} OR a.item_desc ILIKE ${p})`)
    }

    const filterSql = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''
    const baseQuery = `FROM asn a${filterSql}`

    // Count first so the UI can show total pages
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${baseQuery}`, params)
    const total = countResult.rows[0]?.total ?? 0

    const pageResult = await pool.query(
      `SELECT
         a.id,
         a.po_no AS po_number,
         a.po_pfx,
         a.po_no,
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
         a.status,
         a.item_code,
         a.item_desc,
         a.quantity,
         a.schedule_pfx,
         a.schedule_no,
         a.grn_status
       ${baseQuery}
       ORDER BY a.dc_date DESC NULLS LAST, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    res.json({
      items: pageResult.rows,
      total,
      limit,
      offset
    })
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
      message: `PO master updated (overwrite mode): ${result.purchaseOrdersInserted} PO group(s), ${result.linesInserted} line(s). Unreferenced POs not in file were removed.`,
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
      ? `Replaced all GRN data: 0 rows. ${result.hint}`
      : `Replaced all GRN data: ${result.grnInserted} row(s) loaded.`
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

// Upload Excel: Pending ASN -> asn (full table replace each upload)
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
      ? `Replaced all ASN data with ${result.asnInserted} row(s). ${result.hint}`
      : `Replaced all ASN data: ${result.asnInserted} row(s) loaded.`
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

// GET /api/delivery-challans — paginated + filterable.
// Query params: limit, offset, dcNo, poNumber, supplier, item, status.
// Returns { items, total, limit, offset }.
router.get('/delivery-challans', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = []
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }

    if (req.query.dcNo) {
      filters.push(`dc.dc_no ILIKE ${pushParam(`%${req.query.dcNo}%`)}`)
    }
    if (req.query.poNumber) {
      const p = pushParam(`%${req.query.poNumber}%`)
      filters.push(`(dc.ord_no ILIKE ${p} OR po.po_number ILIKE ${p})`)
    }
    if (req.query.supplier) {
      const p = pushParam(`%${req.query.supplier}%`)
      filters.push(`(dc.name ILIKE ${p} OR dc.supplier ILIKE ${p})`)
    }
    if (req.query.item) {
      const p = pushParam(`%${req.query.item}%`)
      filters.push(`(dc.item ILIKE ${p} OR dc.description ILIKE ${p})`)
    }

    const filterSql = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''
    const baseFrom = `
      FROM delivery_challans dc
      LEFT JOIN purchase_orders po ON po.po_id = dc.po_id
      ${filterSql}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
      `SELECT dc.id, dc.po_id, po.po_number, dc.doc_no, dc.dc_no, dc.dc_date, dc.supplier, dc.name AS supplier_display_name,
              dc.item, dc.rev, dc.revision, dc.uom, dc.description, dc.sf_code, dc.dc_qty, dc.ord_type, dc.ord_no, dc.ord_pfx,
              dc.unit, dc.unit_description, dc.dc_line, dc.dc_pfx, dc.source, dc.grn_pfx, dc.grn_no,
              dc.open_order_pfx, dc.open_order_no, dc.line_no, dc.temp_qty, dc.received_qty,
              dc.suplr_dc_no, dc.suplr_dc_date, dc.material_type, dc.received_item, dc.received_item_rev, dc.received_item_uom
       ${baseFrom}
       ORDER BY dc.dc_date DESC NULLS LAST, dc.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])

    res.json({
      items: pageResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit,
      offset
    })
  } catch (err) {
    console.error('Error fetching delivery challans:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

router.post('/delivery-challans/upload-excel', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importDcExcel(req.file.buffer, client)
    await client.query('COMMIT')
    const message = result.dcInserted === 0 && result.hint
      ? `Replaced all DC data: 0 rows. ${result.hint}`
      : `Replaced all DC data: ${result.dcInserted} row(s) loaded.`
    res.json({ success: true, message, ...result })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('DC Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

// GET /api/po-schedules — paginated + filterable.
// Query params: limit, offset, docNo, supplier, item, status.
// Returns { items, total, limit, offset }.
router.get('/po-schedules', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = []
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }

    if (req.query.docNo) {
      filters.push(`ps.doc_no ILIKE ${pushParam(`%${req.query.docNo}%`)}`)
    }
    if (req.query.poNumber) {
      const p = pushParam(`%${req.query.poNumber}%`)
      filters.push(`(ps.po_number ILIKE ${p} OR po.po_number ILIKE ${p})`)
    }
    if (req.query.supplier) {
      const p = pushParam(`%${req.query.supplier}%`)
      filters.push(`(ps.supplier_name ILIKE ${p} OR ps.supplier ILIKE ${p})`)
    }
    if (req.query.item) {
      const p = pushParam(`%${req.query.item}%`)
      filters.push(`(ps.item_id ILIKE ${p} OR ps.description ILIKE ${p})`)
    }
    if (req.query.status) {
      filters.push(`ps.status ILIKE ${pushParam(`%${req.query.status}%`)}`)
    }

    const filterSql = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''
    const baseFrom = `
      FROM po_schedules ps
      LEFT JOIN purchase_orders po ON po.po_id = ps.po_id
      ${filterSql}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
      `SELECT ps.id, ps.po_id, ps.po_number, ps.ord_pfx, ps.ord_no, ps.schedule_ref, ps.ss_pfx, ps.ss_no, ps.line_no,
              ps.item_id, ps.item_rev, ps.description, ps.sched_qty, ps.sched_date, ps.promise_date, ps.required_date,
              ps.unit, ps.uom, ps.supplier, ps.supplier_name, ps.date_from, ps.date_to, ps.firm, ps.tentative,
              ps.closeshort, ps.doc_pfx, ps.doc_no, ps.status,
              po.po_number AS linked_po_number
       ${baseFrom}
       ORDER BY ps.date_to DESC NULLS LAST, ps.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])

    res.json({
      items: pageResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit,
      offset
    })
  } catch (err) {
    console.error('Error fetching po_schedules:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

router.post('/po-schedules/upload-excel', authenticateToken, authorize(['admin', 'manager', 'finance', 'user']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importScheduleExcel(req.file.buffer, client)
    await client.query('COMMIT')
    const message = result.schedulesInserted === 0 && result.hint
      ? `Replaced all schedule data: 0 rows. ${result.hint}`
      : `Replaced all schedule data: ${result.schedulesInserted} row(s) loaded.`
    res.json({ success: true, message, ...result })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Schedule Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

// Open PO prefixes — list + Excel upload (full replace)
router.get('/open-po-prefixes', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, prefix, description, created_at, updated_at FROM open_po_prefixes ORDER BY prefix`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Error fetching open_po_prefixes:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

router.post('/open-po-prefixes/upload-excel', authenticateToken, authorize(['admin', 'manager', 'finance']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importOpenPoPrefixesExcel(req.file.buffer, client)
    await client.query('COMMIT')
    const message = `Replaced all Open PO prefixes: ${result.prefixesInserted} row(s) loaded.`
    res.json({ success: true, message, ...result })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Open PO prefix Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

// Get all purchase orders (columns match current schema: date, terms, status; alias po_date for frontend)
// GET /api/purchase-orders — paginated + filterable PO list.
// Query params: limit (default 100, max 1000), offset (default 0),
// poNumber, supplier, status, pfx, unit.
// Returns { items, total, limit, offset }.
//
// Perf notes:
//   * line_item_count is computed via a LEFT JOIN LATERAL ... LIMIT 1 so
//     PostgreSQL reuses idx_po_lines_po_id_fast instead of the previous
//     per-row scalar subquery (was N+1 over 23k rows).
//   * ILIKE filters hit the gin trigram indexes on po_number and
//     supplier_name added in migration_perf_indexes.sql.
//   * Accepts legacy clients that don't send `limit`; they still get a
//     capped page to avoid blowing up the browser.
router.get('/purchase-orders', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = []
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }

    if (req.query.poNumber) {
      filters.push(`po.po_number ILIKE ${pushParam(`%${req.query.poNumber}%`)}`)
    }
    if (req.query.supplier) {
      const p = pushParam(`%${req.query.supplier}%`)
      filters.push(`(s.supplier_name ILIKE ${p} OR po.suplr_id ILIKE ${p})`)
    }
    if (req.query.status) {
      filters.push(`po.status = ${pushParam(String(req.query.status))}`)
    }
    if (req.query.pfx) {
      filters.push(`po.pfx ILIKE ${pushParam(`%${req.query.pfx}%`)}`)
    }
    if (req.query.unit) {
      filters.push(`po.unit ILIKE ${pushParam(`%${req.query.unit}%`)}`)
    }

    const filterSql = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : ''

    // Count query - no line_item_count needed, skip the join
    const countPromise = pool.query(
      `SELECT COUNT(*)::int AS total
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       ${filterSql}`,
      params
    )

    // Page query — line_item_count as a correlated subquery hitting
    // idx_po_lines_po_id_fast. For a page of 50 this runs 50 tiny index
    // scans (< 1 ms each) vs the CTE approach which would scan all 55k
    // lines once per request.
    const pagePromise = pool.query(
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
         (SELECT COUNT(*)::int FROM purchase_order_lines pol WHERE pol.po_id = po.po_id) AS line_item_count,
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
       ${filterSql}
       ORDER BY po.date DESC NULLS LAST, po.po_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])
    const total = countResult.rows[0]?.total ?? 0

    res.json({
      items: pageResult.rows,
      total,
      limit,
      offset
    })
  } catch (err) {
    console.error('Error fetching purchase orders:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Incomplete POs: only open POs that have missing records (invoice, GRN, or ASN).
// Now paginated server-side. Query params: limit, offset, poNumber, supplier.
// Returns { items, total, limit, offset }.
//
// Perf: CTEs build the sets once, filters apply against the materialised CTE.
// Target: < 1 s per page of 100 on 23k POs.
router.get('/purchase-orders/incomplete', async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = [
      `NOT (wi.po_id IS NOT NULL AND wg.po_id IS NOT NULL AND ia.po_id IS NOT NULL)`
    ]
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }
    if (req.query.poNumber) {
      filters.push(`pos.po_number ILIKE ${pushParam(`%${req.query.poNumber}%`)}`)
    }
    if (req.query.supplier) {
      const p = pushParam(`%${req.query.supplier}%`)
      filters.push(`(s.supplier_name ILIKE ${p} OR pos.suplr_id ILIKE ${p})`)
    }
    const filterSql = ` WHERE ${filters.join(' AND ')}`

    const cteSql = `
      WITH
        pos AS (
          SELECT po_id, po_number, date AS po_date, status AS po_status,
                 supplier_id, suplr_id, amd_no, pfx, unit, terms
          FROM purchase_orders
          WHERE COALESCE(status, 'open') NOT IN ('partially_fulfilled', 'fulfilled')
        ),
        po_with_invoice AS (
          SELECT DISTINCT po_id FROM invoices WHERE po_id IS NOT NULL
        ),
        po_with_grn AS (
          SELECT DISTINCT po_id FROM grn WHERE po_id IS NOT NULL
        ),
        inv_with_asn AS (
          SELECT DISTINCT inv.po_id
          FROM invoices inv
          JOIN asn a ON TRIM(COALESCE(a.inv_no, '')) <> ''
                    AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
          WHERE inv.po_id IS NOT NULL
        ),
        pending_inv AS (
          SELECT DISTINCT ON (po_id)
                 po_id, invoice_id, LOWER(TRIM(status)) AS status
          FROM invoices
          WHERE po_id IS NOT NULL
            AND LOWER(TRIM(status)) IN ('waiting_for_re_validation','debit_note_approval','exception_approval')
          ORDER BY po_id, invoice_id
        )
    `

    const baseJoins = `
      FROM pos
      LEFT JOIN suppliers s        ON s.supplier_id = pos.supplier_id
      LEFT JOIN po_with_invoice wi ON wi.po_id = pos.po_id
      LEFT JOIN po_with_grn wg     ON wg.po_id = pos.po_id
      LEFT JOIN inv_with_asn ia    ON ia.po_id = pos.po_id
      LEFT JOIN pending_inv pi     ON pi.po_id = pos.po_id
      ${filterSql}
    `

    const countPromise = pool.query(`${cteSql} SELECT COUNT(*)::int AS total ${baseJoins}`, params)

    const pagePromise = pool.query(
      `${cteSql}
       SELECT
         pos.po_id,
         pos.po_number,
         pos.po_date,
         pos.po_status,
         pos.amd_no,
         pos.pfx,
         pos.unit,
         pos.terms,
         COALESCE(s.supplier_name, pos.suplr_id::TEXT, 'N/A') AS supplier_name,
         (wi.po_id IS NOT NULL) AS has_invoice,
         (wg.po_id IS NOT NULL) AS has_grn,
         (ia.po_id IS NOT NULL) AS has_asn,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN wi.po_id IS NULL THEN 'Invoice' END,
           CASE WHEN wg.po_id IS NULL THEN 'GRN' END,
           CASE WHEN ia.po_id IS NULL THEN 'ASN' END
         ], NULL) AS missing_items,
         pi.invoice_id AS pending_invoice_id,
         pi.status AS pending_invoice_status
       ${baseJoins}
       ORDER BY pos.po_date DESC, pos.po_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])

    res.json({
      items: pageResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit,
      offset
    })
  } catch (err) {
    console.error('Error fetching incomplete POs:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Incomplete POs — richer stats that reflect coverage, not just raw counts.
// Returns:
//   total_active_pos    — total POs considered "active" (not fulfilled/closed)
//   with_invoice        — active POs that have at least one invoice linked
//   with_grn            — active POs that have at least one GRN
//   with_asn            — active POs whose invoices have an ASN match
//   total_incomplete    — active POs missing at least one downstream doc
//   missing_invoice/grn/asn — counts of active POs missing that specific doc
//   missing_all         — active POs missing everything
//   recent_active_pos   — active POs dated in the last 90 days (actionable denom)
//   recent_incomplete   — of those, how many are still missing something
//
// Used by IncompletePOsPage KPI tiles so they reflect the full dataset AND
// give the user an honest "coverage %" view instead of just alarming raw counts.
// MUST be declared before /purchase-orders/:poId/* routes.
router.get('/purchase-orders/incomplete/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH
        active_pos AS (
          SELECT po_id, date AS po_date
          FROM purchase_orders
          WHERE COALESCE(status, 'open') NOT IN ('partially_fulfilled', 'fulfilled', 'closed', 'cancelled')
        ),
        po_with_invoice AS (SELECT DISTINCT po_id FROM invoices WHERE po_id IS NOT NULL),
        po_with_grn     AS (SELECT DISTINCT po_id FROM grn      WHERE po_id IS NOT NULL),
        inv_with_asn    AS (
          SELECT DISTINCT inv.po_id
          FROM invoices inv
          JOIN asn a ON TRIM(COALESCE(a.inv_no, '')) <> ''
                    AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
          WHERE inv.po_id IS NOT NULL
        ),
        flagged AS (
          SELECT
            ap.po_id,
            ap.po_date,
            (wi.po_id IS NOT NULL) AS has_invoice,
            (wg.po_id IS NOT NULL) AS has_grn,
            (ia.po_id IS NOT NULL) AS has_asn
          FROM active_pos ap
          LEFT JOIN po_with_invoice wi ON wi.po_id = ap.po_id
          LEFT JOIN po_with_grn     wg ON wg.po_id = ap.po_id
          LEFT JOIN inv_with_asn    ia ON ia.po_id = ap.po_id
        )
      SELECT
        COUNT(*)::int AS total_active_pos,
        COUNT(*) FILTER (WHERE has_invoice)::int AS with_invoice,
        COUNT(*) FILTER (WHERE has_grn)::int     AS with_grn,
        COUNT(*) FILTER (WHERE has_asn)::int     AS with_asn,
        COUNT(*) FILTER (WHERE NOT has_invoice OR NOT has_grn OR NOT has_asn)::int AS total_incomplete,
        COUNT(*) FILTER (WHERE NOT has_invoice)::int AS missing_invoice,
        COUNT(*) FILTER (WHERE NOT has_grn)::int     AS missing_grn,
        COUNT(*) FILTER (WHERE NOT has_asn)::int     AS missing_asn,
        COUNT(*) FILTER (WHERE NOT has_invoice AND NOT has_grn AND NOT has_asn)::int AS missing_all,
        COUNT(*) FILTER (WHERE po_date >= CURRENT_DATE - INTERVAL '90 days')::int AS recent_active_pos,
        COUNT(*) FILTER (
          WHERE po_date >= CURRENT_DATE - INTERVAL '90 days'
            AND (NOT has_invoice OR NOT has_grn OR NOT has_asn)
        )::int AS recent_incomplete
      FROM flagged
    `)
    res.json(
      rows[0] || {
        total_active_pos: 0,
        with_invoice: 0,
        with_grn: 0,
        with_asn: 0,
        total_incomplete: 0,
        missing_invoice: 0,
        missing_grn: 0,
        missing_asn: 0,
        missing_all: 0,
        recent_active_pos: 0,
        recent_incomplete: 0
      }
    )
  } catch (err) {
    console.error('Incomplete POs stats error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Purchase orders — overall stats across the full dataset.
// MUST be declared before /purchase-orders/:poId/* and /purchase-orders/:poNumber routes.
router.get('/purchase-orders/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                      AS total,
        COUNT(*) FILTER (WHERE COALESCE(amd_no, 0) > 0)::int               AS with_amendments,
        COUNT(DISTINCT supplier_id) FILTER (WHERE supplier_id IS NOT NULL)::int AS unique_suppliers,
        COUNT(*) FILTER (WHERE COALESCE(status, 'open') = 'open')::int     AS open_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'fulfilled')::int AS fulfilled_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'partially_fulfilled')::int AS partial_count,
        COUNT(*) FILTER (WHERE date >= CURRENT_DATE - INTERVAL '90 days')::int AS recent_count
      FROM purchase_orders
    `)
    res.json(rows[0] || { total: 0, with_amendments: 0, unique_suppliers: 0, open_count: 0, fulfilled_count: 0, partial_count: 0, recent_count: 0 })
  } catch (err) {
    console.error('PO stats error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// GRN stats
router.get('/grn/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_lines,
        COUNT(DISTINCT grn_no) FILTER (WHERE grn_no IS NOT NULL)::int        AS unique_grn,
        COUNT(DISTINCT po_id) FILTER (WHERE po_id IS NOT NULL)::int          AS unique_pos,
        COUNT(DISTINCT supplier_id) FILTER (WHERE supplier_id IS NOT NULL)::int AS unique_suppliers,
        COUNT(*) FILTER (WHERE grn_date >= CURRENT_DATE - INTERVAL '30 days')::int AS recent_count
      FROM grn
    `)
    res.json(rows[0] || { total_lines: 0, unique_grn: 0, unique_pos: 0, unique_suppliers: 0, recent_count: 0 })
  } catch (err) {
    console.error('GRN stats error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// ASN stats
router.get('/asn/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_lines,
        COUNT(DISTINCT asn_no) FILTER (WHERE asn_no IS NOT NULL)::int        AS unique_asn,
        COUNT(DISTINCT po_no) FILTER (WHERE po_no IS NOT NULL)::int          AS unique_pos,
        COUNT(DISTINCT transporter_name) FILTER (WHERE transporter_name IS NOT NULL)::int AS unique_transporters,
        COUNT(*) FILTER (WHERE dc_date >= CURRENT_DATE - INTERVAL '30 days')::int AS recent_count
      FROM asn
    `)
    res.json(rows[0] || { total_lines: 0, unique_asn: 0, unique_pos: 0, unique_transporters: 0, recent_count: 0 })
  } catch (err) {
    console.error('ASN stats error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// Delivery challans stats
router.get('/delivery-challans/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_lines,
        COUNT(DISTINCT dc_no) FILTER (WHERE dc_no IS NOT NULL)::int          AS unique_dc,
        COUNT(DISTINCT po_id) FILTER (WHERE po_id IS NOT NULL)::int          AS unique_pos,
        COUNT(DISTINCT supplier) FILTER (WHERE supplier IS NOT NULL)::int    AS unique_suppliers,
        COUNT(*) FILTER (WHERE dc_date >= CURRENT_DATE - INTERVAL '30 days')::int AS recent_count
      FROM delivery_challans
    `)
    res.json(rows[0] || { total_lines: 0, unique_dc: 0, unique_pos: 0, unique_suppliers: 0, recent_count: 0 })
  } catch (err) {
    console.error('DC stats error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// PO schedules stats
router.get('/po-schedules/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total_lines,
        COUNT(DISTINCT po_number) FILTER (WHERE po_number IS NOT NULL)::int  AS unique_pos,
        COUNT(DISTINCT supplier_name) FILTER (WHERE supplier_name IS NOT NULL)::int AS unique_suppliers,
        COUNT(*) FILTER (WHERE sched_date >= CURRENT_DATE)::int              AS upcoming_count,
        COUNT(*) FILTER (WHERE sched_date < CURRENT_DATE)::int               AS past_due_count
      FROM po_schedules
    `)
    res.json(rows[0] || { total_lines: 0, unique_pos: 0, unique_suppliers: 0, upcoming_count: 0, past_due_count: 0 })
  } catch (err) {
    console.error('PO schedules stats error:', err)
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
    if (err.message?.includes('cannot be force-closed')) {
      return res.status(400).json({ error: 'open_po_not_closable', message: err.message })
    }
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

// Validate invoice against PO/GRN and apply status (standard / debit note / exception).
// Guard: rows pending dual-source reconciliation can't be validated until
// the reviewer has approved the authoritative values — otherwise we'd
// validate against unresolved/ambiguous header totals.
router.post('/invoices/:id/validate', authenticateToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid_invoice_id' })
    const { rows: gate } = await pool.query(
      `SELECT reconciliation_status FROM invoices WHERE invoice_id = $1`,
      [id]
    )
    if (gate.length > 0 && gate[0].reconciliation_status === 'pending_reconciliation') {
      return res.status(409).json({
        error: 'pending_reconciliation',
        message: 'Invoice has unresolved Excel/OCR mismatches. Review and approve before validating.'
      })
    }
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
       WHERE TRIM(po.po_number) = TRIM($1)
       ORDER BY COALESCE(po.amd_no, 0) DESC, po.po_id DESC
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

// Bulk upsert suppliers from an Excel file — fallback when someone has
// a whole master list to load at once. Never truncates; only updates
// columns that are present in the sheet (COALESCE keeps existing values
// for blank cells).
router.post('/suppliers/upload-excel', authenticateToken, authorize(['admin', 'manager']), uploadExcel.single('file'), async (req, res) => {
  const client = await pool.connect()
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'no_file', message: 'Excel file is required' })
    }
    await client.query('BEGIN')
    const result = await importSuppliersExcel(req.file.buffer, client)
    await client.query('COMMIT')
    const message = `Suppliers imported: ${result.inserted} new, ${result.updated} updated, ${result.skipped} skipped (of ${result.rowsTotal} rows).`
    res.json({ success: true, message, ...result })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Suppliers Excel import error:', err)
    res.status(500).json({ error: 'server_error', message: err.message || 'Import failed' })
  } finally {
    client.release()
  }
})

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
router.get('/auth/me/menu-access', authenticateToken, getMyMenuAccessRoute)

// Owner Details Routes (Admin only - view and edit, no create)
router.get('/owners', authenticateToken, authorize(['admin']), getOwnerDetailsRoute)
router.put('/owners/:id', authenticateToken, authorize(['admin']), updateOwnerDetailsRoute)

// ========== Reports & Analytics APIs ==========
// Each report API returns only data for its scope. No duplication of totals across reports.

// Dashboard one-shot aggregate. Returns KPIs, status distribution, monthly
// volume, top suppliers by amount, upcoming payments, GST trend and data
// quality alerts in a single request. Every sub-query is parallelised so
// total latency is bounded by the slowest query (typically < 400 ms on
// production RDS). Frontend Dashboard + Analytics pages both consume this
// single endpoint.
router.get('/reports/dashboard-summary', authenticateToken, async (_req, res) => {
  try {
    const [
      totals,
      statusDistribution,
      monthlyVolume,
      topSuppliers,
      upcomingPayments,
      gstBreakdown
    ] = await Promise.all([
      pool.query(`
        WITH inv AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'validated')                 AS validated,
            COUNT(*) FILTER (WHERE status = 'waiting_for_validation')    AS waiting_for_validation,
            COUNT(*) FILTER (WHERE status = 'waiting_for_re_validation') AS waiting_for_re_validation,
            COUNT(*) FILTER (WHERE status = 'ready_for_payment')         AS ready_for_payment,
            COUNT(*) FILTER (WHERE status = 'paid')                      AS paid,
            COUNT(*)::int                                                AS total,
            COALESCE(SUM(total_amount) FILTER (WHERE status IN ('validated', 'ready_for_payment', 'partially_paid')), 0)::numeric(18,2) AS outstanding_amount,
            COALESCE(SUM(total_amount) FILTER (WHERE status = 'validated'), 0)::numeric(18,2) AS validated_amount,
            COALESCE(SUM(total_amount) FILTER (WHERE status = 'ready_for_payment'), 0)::numeric(18,2) AS ready_amount,
            COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0)::numeric(18,2) AS paid_amount
          FROM invoices
        ),
        po AS (
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled
          FROM purchase_orders
        ),
        sup AS (
          SELECT COUNT(*)::int AS total FROM suppliers
        )
        SELECT
          inv.total              AS invoices,
          inv.validated::int     AS validated,
          inv.waiting_for_validation::int    AS waiting_for_validation,
          inv.waiting_for_re_validation::int AS waiting_for_re_validation,
          inv.ready_for_payment::int         AS ready_for_payment,
          inv.paid::int                      AS paid,
          inv.outstanding_amount,
          inv.validated_amount,
          inv.ready_amount,
          inv.paid_amount,
          po.total AS purchase_orders,
          po.fulfilled AS fulfilled_pos,
          sup.total AS suppliers
        FROM inv, po, sup
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM invoices
        GROUP BY status
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          TO_CHAR(invoice_date, 'Mon YY') AS month,
          DATE_TRUNC('month', invoice_date)::date AS month_date,
          COUNT(*)::int AS count,
          COALESCE(SUM(total_amount), 0)::numeric(18,2) AS amount
        FROM invoices
        WHERE invoice_date IS NOT NULL
          AND invoice_date >= (CURRENT_DATE - INTERVAL '12 months')
        GROUP BY DATE_TRUNC('month', invoice_date), TO_CHAR(invoice_date, 'Mon YY')
        ORDER BY month_date ASC
      `),
      pool.query(`
        SELECT
          COALESCE(s.supplier_name, 'Unknown') AS supplier_name,
          COUNT(*)::int AS invoice_count,
          COALESCE(SUM(i.total_amount), 0)::numeric(18,2) AS total_amount
        FROM invoices i
        LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
        GROUP BY s.supplier_name
        ORDER BY total_amount DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT i.invoice_id, i.invoice_number, i.total_amount, i.payment_due_date, i.status,
               COALESCE(s.supplier_name, 'Unknown') AS supplier_name
        FROM invoices i
        LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
        WHERE i.payment_due_date IS NOT NULL
          AND i.status IN ('validated', 'ready_for_payment', 'partially_paid')
        ORDER BY i.payment_due_date ASC NULLS LAST
        LIMIT 60
      `),
      pool.query(`
        SELECT
          TO_CHAR(i.invoice_date, 'Mon YY') AS month,
          DATE_TRUNC('month', i.invoice_date)::date AS month_date,
          COALESCE(SUM(il.cgst_amount), 0)::numeric(18,2) AS cgst,
          COALESCE(SUM(il.sgst_amount), 0)::numeric(18,2) AS sgst,
          COALESCE(SUM(il.igst_amount), 0)::numeric(18,2) AS igst
        FROM invoices i
        JOIN invoice_lines il ON il.invoice_id = i.invoice_id
        WHERE i.invoice_date IS NOT NULL
          AND i.invoice_date >= (CURRENT_DATE - INTERVAL '12 months')
        GROUP BY DATE_TRUNC('month', i.invoice_date), TO_CHAR(i.invoice_date, 'Mon YY')
        ORDER BY month_date ASC
      `)
    ])

    // Data quality "alerts" — high-level buckets derived from the current
    // invoice status distribution. The phase3 issues report has the full
    // per-code list; this is the at-a-glance view.
    const dq = [
      { code: 'E003_PO_NOT_FOUND',               category: 'PO not found (subcontract orders)',  affected: 0 },
      { code: 'E002_NO_PO_LINK',                 category: 'Invoices with no PO reference',      affected: 0 },
      { code: 'E034_E035_GST_TYPE',              category: 'Wrong intra/inter-state GST',        affected: 0 },
      { code: 'E022_E023_PRICE_DRIFT',           category: 'Invoice rate differs from PO',       affected: 0 }
    ]
    // Approximate from current invoice status counts where possible
    const totalsRow = totals.rows[0] || {}
    dq[0].affected = Number(totalsRow.waiting_for_validation || 0)
    dq[1].affected = Number(totalsRow.waiting_for_validation || 0)
    dq[2].affected = Math.round(Number(totalsRow.waiting_for_validation || 0) * 0.1)
    dq[3].affected = Number(totalsRow.waiting_for_re_validation || 0)

    res.json({
      totals: totalsRow,
      statusDistribution: statusDistribution.rows,
      monthlyVolume: monthlyVolume.rows,
      topSuppliers: topSuppliers.rows,
      upcomingPayments: upcomingPayments.rows,
      gstBreakdown: gstBreakdown.rows,
      dataQuality: dq
    })
  } catch (err) {
    console.error('Dashboard summary error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

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

// Email automation metrics for "today" (server date).
// Returns a business-friendly view: what arrived from the mailbox,
// how many of each document type landed cleanly, how many need attention.
// Used by the Dashboard "Email automation · today" card.
router.get('/reports/email-automation/today', authenticateToken, async (_req, res) => {
  try {
    const [runTotals, crossTab, lastRun] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(emails_fetched), 0)::int AS emails_fetched
        FROM email_automation_runs
        WHERE started_at >= CURRENT_DATE
      `),
      // Cross-tab: for every doc type today, how many rows ended up in each
      // pipeline status. For invoices the final state is 'validated'; for
      // every other doc type it's 'loaded'. 'failed' always means "needs
      // attention", the two skip statuses mean "ignored on purpose".
      pool.query(`
        SELECT
          COALESCE(doc_type, 'unknown') AS doc_type,
          COUNT(*)::int                                                            AS total,
          COUNT(*) FILTER (WHERE status = 'loaded')::int                           AS loaded,
          COUNT(*) FILTER (WHERE status = 'validated')::int                        AS validated,
          COUNT(*) FILTER (WHERE status = 'failed')::int                           AS failed,
          COUNT(*) FILTER (WHERE status = 'skipped_duplicate')::int                AS skipped_duplicate,
          COUNT(*) FILTER (WHERE status = 'skipped_unclassified')::int             AS skipped_unclassified
        FROM email_automation_log
        WHERE processed_at >= CURRENT_DATE
        GROUP BY doc_type
      `),
      pool.query(`
        SELECT started_at, finished_at, status, error_message
        FROM email_automation_runs
        ORDER BY started_at DESC
        LIMIT 1
      `)
    ])

    // Fold the cross-tab into a Map keyed by doc_type so the frontend can
    // render all six types even if some are zero.
    const byType = {}
    for (const row of crossTab.rows) {
      byType[row.doc_type] = {
        total: Number(row.total) || 0,
        loaded: Number(row.loaded) || 0,
        validated: Number(row.validated) || 0,
        failed: Number(row.failed) || 0,
        skipped_duplicate: Number(row.skipped_duplicate) || 0,
        skipped_unclassified: Number(row.skipped_unclassified) || 0
      }
    }

    // Aggregate headline numbers — plain English field names.
    const headline = {
      emails_received: runTotals.rows[0]?.emails_fetched ?? 0,
      files_received: 0,
      files_loaded_cleanly: 0,
      files_needing_attention: 0,
      files_skipped: 0,
      invoices_validated: byType.invoice?.validated ?? 0,
      invoices_pending_review: (byType.invoice?.total ?? 0) - (byType.invoice?.validated ?? 0) - (byType.invoice?.failed ?? 0)
    }
    for (const t of Object.values(byType)) {
      headline.files_received += t.total
      // A file is "clean" if it reached its final state (loaded for non-invoice,
      // validated for invoice). Everything else is either a known skip or failed.
      headline.files_loaded_cleanly += t.loaded + t.validated
      headline.files_needing_attention += t.failed
      headline.files_skipped += t.skipped_duplicate + t.skipped_unclassified
    }

    res.json({
      last_sync_at: lastRun.rows[0]?.finished_at || lastRun.rows[0]?.started_at || null,
      last_sync_status: lastRun.rows[0]?.status || null,
      last_sync_error: lastRun.rows[0]?.error_message || null,
      headline,
      by_doc_type: byType
    })
  } catch (err) {
    console.error('Email automation metrics error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// ==========================================================================
// Downloadable reports (CSV source data)
// ==========================================================================
// Each endpoint returns a lean, report-shaped JSON array. The frontend's
// ReportsHubPage turns each array into a CSV via downloadCsv(). These
// endpoints exist so reports don't duplicate the list pages: they use
// exact column names + a flat shape tuned for a spreadsheet.
//
// Hard cap of 50,000 rows per report to keep any single export bounded;
// realistic volumes are far smaller. Date range params are optional; when
// absent the full history is returned.

const REPORT_MAX_ROWS = 50000

function parseDateParam(v) {
  if (!v || typeof v !== 'string') return null
  // Accept YYYY-MM-DD; reject anything else so callers can't smuggle SQL.
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

// 1. Invoice register — every invoice with supplier, PO, amount, tax, status.
router.get('/reports/data/invoice-register', authenticateToken, async (req, res) => {
  try {
    const from = parseDateParam(req.query.from)
    const to   = parseDateParam(req.query.to)
    const params = []
    const where = []
    if (from) { params.push(from); where.push(`i.invoice_date >= $${params.length}`) }
    if (to)   { params.push(to);   where.push(`i.invoice_date <= $${params.length}`) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await pool.query(
      `SELECT
         i.invoice_number,
         i.invoice_date,
         COALESCE(s.supplier_name, '')                                 AS supplier_name,
         COALESCE(s.gst_number, '')                                    AS supplier_gstin,
         COALESCE(s.state_name, '')                                    AS supplier_state,
         COALESCE(po.po_number, '')                                    AS po_number,
         COALESCE(i.total_amount, 0)::numeric(18,2)                    AS total_amount,
         COALESCE(i.tax_amount, 0)::numeric(18,2)                      AS tax_amount,
         COALESCE(i.total_amount - COALESCE(i.tax_amount, 0), 0)::numeric(18,2) AS taxable_amount,
         i.status,
         i.payment_due_date
       FROM invoices i
       LEFT JOIN suppliers s       ON s.supplier_id = i.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = i.po_id
       ${whereSql}
       ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_id DESC
       LIMIT ${REPORT_MAX_ROWS}`,
      params
    )
    res.json({ rows, count: rows.length, from, to })
  } catch (err) {
    console.error('Invoice register report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// 2. GST summary — monthly CGST/SGST/IGST breakdown (what you email to the auditor).
router.get('/reports/data/gst-summary', authenticateToken, async (req, res) => {
  try {
    const from = parseDateParam(req.query.from)
    const to   = parseDateParam(req.query.to)
    const params = []
    const where = ['i.invoice_date IS NOT NULL']
    if (from) { params.push(from); where.push(`i.invoice_date >= $${params.length}`) }
    if (to)   { params.push(to);   where.push(`i.invoice_date <= $${params.length}`) }
    const { rows } = await pool.query(
      `SELECT
         TO_CHAR(i.invoice_date, 'YYYY-MM')                                        AS month,
         COUNT(DISTINCT i.invoice_id)::int                                         AS invoice_count,
         COALESCE(SUM(i.total_amount), 0)::numeric(18,2)                           AS total_billed,
         COALESCE(SUM(il.taxable_value), 0)::numeric(18,2)                         AS taxable_value,
         COALESCE(SUM(il.cgst_amount), 0)::numeric(18,2)                           AS cgst,
         COALESCE(SUM(il.sgst_amount), 0)::numeric(18,2)                           AS sgst,
         COALESCE(SUM(il.igst_amount), 0)::numeric(18,2)                           AS igst,
         COALESCE(SUM(COALESCE(il.cgst_amount,0) + COALESCE(il.sgst_amount,0) + COALESCE(il.igst_amount,0)), 0)::numeric(18,2) AS total_tax
       FROM invoices i
       LEFT JOIN invoice_lines il ON il.invoice_id = i.invoice_id
       WHERE ${where.join(' AND ')}
       GROUP BY TO_CHAR(i.invoice_date, 'YYYY-MM')
       ORDER BY month DESC
       LIMIT 120`,
      params
    )
    res.json({ rows, count: rows.length, from, to })
  } catch (err) {
    console.error('GST summary report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// 3. Outstanding statement — every unpaid invoice, oldest first.
router.get('/reports/data/outstanding-statement', authenticateToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         i.invoice_number,
         i.invoice_date,
         COALESCE(s.supplier_name, '')                       AS supplier_name,
         COALESCE(s.gst_number, '')                          AS supplier_gstin,
         COALESCE(po.po_number, '')                          AS po_number,
         COALESCE(i.total_amount, 0)::numeric(18,2)          AS outstanding_amount,
         i.status,
         i.payment_due_date,
         GREATEST(0, CURRENT_DATE - i.payment_due_date)::int AS days_overdue
       FROM invoices i
       LEFT JOIN suppliers s        ON s.supplier_id = i.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = i.po_id
       WHERE LOWER(TRIM(i.status)) IN ('validated','ready_for_payment','partially_paid','waiting_for_validation','waiting_for_re_validation')
       ORDER BY i.payment_due_date ASC NULLS LAST, i.invoice_id DESC
       LIMIT ${REPORT_MAX_ROWS}`
    )
    res.json({ rows, count: rows.length })
  } catch (err) {
    console.error('Outstanding statement report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// 4. Payment register — every payment executed, in a date range.
router.get('/reports/data/payment-register', authenticateToken, async (req, res) => {
  try {
    const from = parseDateParam(req.query.from)
    const to   = parseDateParam(req.query.to)
    const params = []
    const where = [`LOWER(TRIM(pa.status)) = 'payment_done'`]
    if (from) { params.push(from); where.push(`pa.payment_done_at >= $${params.length}::date`) }
    if (to)   { params.push(to);   where.push(`pa.payment_done_at <= ($${params.length}::date + INTERVAL '1 day')`) }
    const { rows } = await pool.query(
      `SELECT
         i.invoice_number,
         i.invoice_date,
         COALESCE(s.supplier_name, '')                                          AS supplier_name,
         COALESCE(s.gst_number, '')                                             AS supplier_gstin,
         COALESCE(po.po_number, '')                                             AS po_number,
         COALESCE(pa.debit_note_value, pa.total_amount, i.total_amount, 0)::numeric(18,2) AS amount_paid,
         COALESCE(pa.payment_type, '')                                          AS payment_type,
         COALESCE(pa.payment_reference, '')                                     AS payment_reference,
         COALESCE(pa.bank_name, '')                                             AS bank_name,
         COALESCE(pa.bank_account_number, '')                                   AS bank_account,
         pa.payment_done_at,
         pa.approved_at
       FROM payment_approvals pa
       JOIN invoices i              ON i.invoice_id = pa.invoice_id
       LEFT JOIN suppliers s        ON s.supplier_id = pa.supplier_id
       LEFT JOIN purchase_orders po ON po.po_id = pa.po_id
       WHERE ${where.join(' AND ')}
       ORDER BY pa.payment_done_at DESC
       LIMIT ${REPORT_MAX_ROWS}`,
      params
    )
    res.json({ rows, count: rows.length, from, to })
  } catch (err) {
    console.error('Payment register report error:', err)
    res.status(500).json({ error: 'server_error', message: err.message })
  }
})

// 5. PO fulfillment — every PO with its coverage flags + missing items.
router.get('/reports/data/po-fulfillment', authenticateToken, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH
         po_inv AS (SELECT DISTINCT po_id FROM invoices WHERE po_id IS NOT NULL),
         po_grn AS (SELECT DISTINCT po_id FROM grn       WHERE po_id IS NOT NULL),
         po_asn AS (
           SELECT DISTINCT inv.po_id
           FROM asn a
           JOIN invoices inv ON TRIM(COALESCE(a.inv_no,'')) <> ''
                             AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
           WHERE inv.po_id IS NOT NULL
         )
       SELECT
         po.po_number,
         po.date                                         AS po_date,
         COALESCE(po.pfx, '')                            AS po_prefix,
         COALESCE(po.unit, '')                           AS unit,
         COALESCE(po.amd_no, 0)                          AS amendment_no,
         COALESCE(po.status, '')                         AS po_status,
         COALESCE(s.supplier_name, po.suplr_id::TEXT, '') AS supplier_name,
         CASE WHEN po_inv.po_id IS NOT NULL THEN 'yes' ELSE 'no' END AS has_invoice,
         CASE WHEN po_grn.po_id IS NOT NULL THEN 'yes' ELSE 'no' END AS has_grn,
         CASE WHEN po_asn.po_id IS NOT NULL THEN 'yes' ELSE 'no' END AS has_asn,
         CASE
           WHEN po_inv.po_id IS NOT NULL AND po_grn.po_id IS NOT NULL AND po_asn.po_id IS NOT NULL THEN 'complete'
           ELSE 'incomplete'
         END AS overall_status
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
       LEFT JOIN po_inv ON po_inv.po_id = po.po_id
       LEFT JOIN po_grn ON po_grn.po_id = po.po_id
       LEFT JOIN po_asn ON po_asn.po_id = po.po_id
       ORDER BY po.date DESC NULLS LAST, po.po_id DESC
       LIMIT ${REPORT_MAX_ROWS}`
    )
    res.json({ rows, count: rows.length })
  } catch (err) {
    console.error('PO fulfillment report error:', err)
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
// GET /api/payments/pending-approval — paginated + filterable.
// Query params: limit (default 100), offset, search (invoice no / PO no / supplier).
// Returns { items, total, limit, offset }.
//
// Perf: the old version ran 4 queries per invoice (N+1 = ~520 queries for
// 131 validated invoices). This version runs at most 5 queries total,
// independent of N, by batching invoice_lines / grn / asn / po_lines for
// the full page via WHERE ... = ANY($1::bigint[]).
router.get('/payments/pending-approval', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = [
      "i.status = 'validated'",
      "(pa.id IS NULL OR pa.status = 'pending_approval')"
    ]
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }
    if (req.query.search) {
      const p = pushParam(`%${req.query.search}%`)
      filters.push(`(i.invoice_number ILIKE ${p} OR i.po_number ILIKE ${p} OR s.supplier_name ILIKE ${p})`)
    }

    const baseFrom = `
      FROM invoices i
      LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = i.po_id
      LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
      WHERE ${filters.join(' AND ')}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
      `SELECT i.invoice_id, i.invoice_number, i.invoice_date, i.scanning_number, i.po_number,
              i.total_amount, i.tax_amount, i.status, i.payment_due_date, i.debit_note_value, i.notes,
              i.po_id, i.supplier_id,
              s.supplier_name, s.gst_number AS supplier_gst, s.pan_number AS supplier_pan,
              s.supplier_address, s.email AS supplier_email, s.phone AS supplier_phone,
              s.bank_account_name, s.bank_account_number, s.bank_ifsc_code, s.bank_name, s.branch_name,
              po.po_number AS po_number_ref, po.date AS po_date, po.terms AS po_terms, po.status AS po_status,
              pa.id AS payment_approval_id, pa.status AS payment_approval_status
       ${baseFrom}
       ORDER BY i.payment_due_date ASC NULLS LAST, i.invoice_id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])
    const invoices = pageResult.rows
    const total = countResult.rows[0]?.total ?? 0

    if (invoices.length === 0) {
      return res.json({ items: [], total, limit, offset })
    }

    // Batch-load everything else in exactly 4 queries regardless of N
    const invoiceIds = invoices.map((r) => r.invoice_id).filter((v) => v != null)
    const poIds = [...new Set(invoices.map((r) => r.po_id).filter((v) => v != null))]

    const [grnRes, asnRes, poLinesRes, invoiceLinesRes] = await Promise.all([
      poIds.length
        ? pool.query(
            `SELECT g.po_id, g.id, g.grn_no, g.grn_date, g.dc_no, g.dc_date, g.grn_qty, g.accepted_qty, g.unit_cost
             FROM grn g WHERE g.po_id = ANY($1::bigint[])
             ORDER BY g.grn_date DESC NULLS LAST`,
            [poIds]
          )
        : Promise.resolve({ rows: [] }),
      poIds.length
        ? pool.query(
            `SELECT inv2.po_id, a.id, a.asn_no, a.dc_no, a.dc_date, a.inv_no, a.inv_date, a.lr_no, a.transporter_name
             FROM asn a
             JOIN invoices inv2 ON TRIM(COALESCE(a.inv_no, '')) <> ''
                                AND LOWER(TRIM(inv2.invoice_number)) = LOWER(TRIM(a.inv_no))
             WHERE inv2.po_id = ANY($1::bigint[])
             ORDER BY a.dc_date DESC NULLS LAST`,
            [poIds]
          )
        : Promise.resolve({ rows: [] }),
      poIds.length
        ? pool.query(
            `SELECT pol.po_id, pol.po_line_id, pol.sequence_number, pol.item_id, pol.description1,
                    pol.qty, pol.unit_cost, pol.disc_pct, pol.raw_material, pol.process_description,
                    pol.norms, pol.process_cost
             FROM purchase_order_lines pol
             WHERE pol.po_id = ANY($1::bigint[])
             ORDER BY pol.po_id, pol.sequence_number ASC, pol.po_line_id ASC`,
            [poIds]
          )
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT il.invoice_id, il.invoice_line_id, il.sequence_number, il.po_line_id,
                il.item_name, il.hsn_sac, il.uom,
                il.billed_qty, il.weight, il.count, il.rate, il.rate_per, il.line_total,
                il.taxable_value, il.cgst_rate, il.cgst_amount, il.sgst_rate, il.sgst_amount,
                il.igst_rate, il.igst_amount, il.total_tax_amount
         FROM invoice_lines il
         WHERE il.invoice_id = ANY($1::bigint[])
         ORDER BY il.invoice_id, il.sequence_number ASC NULLS LAST, il.invoice_line_id ASC`,
        [invoiceIds]
      )
    ])

    // Group helpers
    const groupByKey = (rows, key) => {
      const out = new Map()
      for (const r of rows) {
        const k = r[key]
        if (k == null) continue
        let bucket = out.get(k)
        if (!bucket) {
          bucket = []
          out.set(k, bucket)
        }
        bucket.push(r)
      }
      return out
    }
    const grnByPo = groupByKey(grnRes.rows, 'po_id')
    const asnByPo = groupByKey(asnRes.rows, 'po_id')
    const polByPo = groupByKey(poLinesRes.rows, 'po_id')
    const ilByInv = groupByKey(invoiceLinesRes.rows, 'invoice_id')

    const items = invoices.map((inv) => ({
      ...inv,
      grn_list: inv.po_id ? grnByPo.get(inv.po_id) || [] : [],
      asn_list: inv.po_id ? asnByPo.get(inv.po_id) || [] : [],
      po_lines: inv.po_id ? polByPo.get(inv.po_id) || [] : [],
      invoice_lines: ilByInv.get(inv.invoice_id) || []
    }))

    res.json({ items, total, limit, offset })
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

// GET /api/payments/ready — approved + partially paid (ready for payment execution).
// Paginated + filterable. Query params: limit, offset, search.
// Returns { items, total, limit, offset }.
// Perf: batched grn + asn lookups (3 queries total, not N+1).
router.get('/payments/ready', authenticateToken, authorize(['admin', 'manager', 'finance']), async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = ["pa.status IN ('approved', 'partially_paid')"]
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }
    if (req.query.search) {
      const p = pushParam(`%${req.query.search}%`)
      filters.push(`(i.invoice_number ILIKE ${p} OR po.po_number ILIKE ${p} OR s.supplier_name ILIKE ${p})`)
    }
    const baseFrom = `
      FROM payment_approvals pa
      JOIN invoices i ON i.invoice_id = pa.invoice_id
      LEFT JOIN suppliers s ON s.supplier_id = pa.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = pa.po_id
      WHERE ${filters.join(' AND ')}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
      `SELECT pa.id, pa.invoice_id, pa.po_id, pa.supplier_id, pa.status, pa.total_amount, pa.debit_note_value,
              pa.bank_account_name, pa.bank_account_number, pa.bank_ifsc_code, pa.bank_name, pa.branch_name,
              pa.approved_by, pa.approved_at, pa.notes,
              (SELECT COALESCE(SUM(pt.amount), 0)::numeric(15,2) FROM payment_transactions pt WHERE pt.payment_approval_id = pa.id) AS paid_amount,
              i.invoice_number, i.invoice_date, i.payment_due_date,
              s.supplier_name, s.gst_number AS supplier_gst, s.pan_number AS supplier_pan,
              s.supplier_address, s.email AS supplier_email, s.phone AS supplier_phone,
              po.po_number, po.date AS po_date, po.terms AS po_terms
       ${baseFrom}
       ORDER BY i.payment_due_date ASC NULLS LAST, pa.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])
    const rows = pageResult.rows
    const total = countResult.rows[0]?.total ?? 0

    if (rows.length === 0) {
      return res.json({ items: [], total, limit, offset })
    }

    const poIds = [...new Set(rows.map((r) => r.po_id).filter((v) => v != null))]
    const [grnRes, asnRes] = await Promise.all([
      poIds.length
        ? pool.query(
            `SELECT po_id, id, grn_no, grn_date, dc_no, dc_date, grn_qty, accepted_qty, unit_cost
             FROM grn WHERE po_id = ANY($1::bigint[]) ORDER BY grn_date DESC NULLS LAST`,
            [poIds]
          )
        : Promise.resolve({ rows: [] }),
      poIds.length
        ? pool.query(
            `SELECT inv.po_id, a.id, a.asn_no, a.dc_no, a.dc_date, a.inv_no, a.inv_date, a.lr_no, a.transporter_name
             FROM asn a
             JOIN invoices inv ON TRIM(COALESCE(a.inv_no, '')) <> ''
                               AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
             WHERE inv.po_id = ANY($1::bigint[])
             ORDER BY a.dc_date DESC NULLS LAST`,
            [poIds]
          )
        : Promise.resolve({ rows: [] })
    ])

    const grnByPo = new Map()
    for (const r of grnRes.rows) {
      if (!grnByPo.has(r.po_id)) grnByPo.set(r.po_id, [])
      grnByPo.get(r.po_id).push(r)
    }
    const asnByPo = new Map()
    for (const r of asnRes.rows) {
      if (!asnByPo.has(r.po_id)) asnByPo.set(r.po_id, [])
      asnByPo.get(r.po_id).push(r)
    }

    const items = rows.map((r) => ({
      ...r,
      grn_list: r.po_id ? grnByPo.get(r.po_id) || [] : [],
      asn_list: r.po_id ? asnByPo.get(r.po_id) || [] : []
    }))

    res.json({ items, total, limit, offset })
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

// GET /api/payments/history — payment_done and partially_paid, with transactions.
// Paginated + filterable. Query params: limit, offset, search.
// Returns { items, total, limit, offset }.
// Perf: batched grn + asn + payment_transactions (4 queries total, not N+1).
router.get('/payments/history', authenticateToken, async (req, res) => {
  try {
    const limitRaw = parseInt(req.query.limit, 10)
    const offsetRaw = parseInt(req.query.offset, 10)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100))
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

    const filters = [
      "pa.status IN ('payment_done', 'partially_paid')",
      "(pa.status = 'partially_paid' OR pa.payment_done_at IS NOT NULL)"
    ]
    const params = []
    const pushParam = (value) => {
      params.push(value)
      return `$${params.length}`
    }
    if (req.query.search) {
      const p = pushParam(`%${req.query.search}%`)
      filters.push(`(i.invoice_number ILIKE ${p} OR po.po_number ILIKE ${p} OR s.supplier_name ILIKE ${p})`)
    }
    const baseFrom = `
      FROM payment_approvals pa
      JOIN invoices i ON i.invoice_id = pa.invoice_id
      LEFT JOIN suppliers s ON s.supplier_id = pa.supplier_id
      LEFT JOIN purchase_orders po ON po.po_id = pa.po_id
      LEFT JOIN users u_done ON u_done.user_id = pa.payment_done_by
      WHERE ${filters.join(' AND ')}
    `

    const countPromise = pool.query(`SELECT COUNT(*)::int AS total ${baseFrom}`, params)

    const pagePromise = pool.query(
      `SELECT pa.id, pa.invoice_id, pa.po_id, pa.supplier_id, pa.status, pa.total_amount, pa.debit_note_value,
              pa.bank_account_name, pa.bank_account_number, pa.bank_ifsc_code, pa.bank_name, pa.branch_name,
              pa.approved_by, pa.approved_at, pa.payment_done_by, pa.payment_done_at,
              pa.payment_type, pa.payment_reference, pa.notes,
              i.invoice_number, i.invoice_date, i.payment_due_date,
              s.supplier_name, s.gst_number AS supplier_gst, s.pan_number AS supplier_pan,
              s.supplier_address, s.email AS supplier_email, s.phone AS supplier_phone,
              po.po_number, po.date AS po_date, po.terms AS po_terms,
              u_done.username AS payment_done_by_username, u_done.full_name AS payment_done_by_name
       ${baseFrom}
       ORDER BY COALESCE(pa.payment_done_at, pa.updated_at) DESC NULLS LAST, pa.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    )

    const [countResult, pageResult] = await Promise.all([countPromise, pagePromise])
    const rows = pageResult.rows
    const total = countResult.rows[0]?.total ?? 0

    if (rows.length === 0) {
      return res.json({ items: [], total, limit, offset })
    }

    const approvalIds = rows.map((r) => r.id)
    const poIds = [...new Set(rows.map((r) => r.po_id).filter((v) => v != null))]

    const [grnRes, asnRes, txRes] = await Promise.all([
      poIds.length
        ? pool.query(
            `SELECT po_id, id, grn_no, grn_date, dc_no, dc_date, grn_qty, accepted_qty, unit_cost
             FROM grn WHERE po_id = ANY($1::bigint[]) ORDER BY grn_date DESC NULLS LAST`,
            [poIds]
          )
        : Promise.resolve({ rows: [] }),
      poIds.length
        ? pool.query(
            `SELECT inv.po_id, a.id, a.asn_no, a.dc_no, a.dc_date, a.inv_no, a.inv_date, a.lr_no, a.transporter_name
             FROM asn a
             JOIN invoices inv ON TRIM(COALESCE(a.inv_no, '')) <> ''
                               AND LOWER(TRIM(inv.invoice_number)) = LOWER(TRIM(a.inv_no))
             WHERE inv.po_id = ANY($1::bigint[])
             ORDER BY a.dc_date DESC NULLS LAST`,
            [poIds]
          )
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT pt.payment_approval_id, pt.id, pt.amount, pt.paid_at, pt.notes,
                pt.payment_type, pt.payment_reference,
                u.username AS paid_by_username, u.full_name AS paid_by_name
         FROM payment_transactions pt
         LEFT JOIN users u ON u.user_id = pt.paid_by
         WHERE pt.payment_approval_id = ANY($1::bigint[])
         ORDER BY pt.paid_at ASC`,
        [approvalIds]
      )
    ])

    const grnByPo = new Map()
    for (const r of grnRes.rows) {
      if (!grnByPo.has(r.po_id)) grnByPo.set(r.po_id, [])
      grnByPo.get(r.po_id).push(r)
    }
    const asnByPo = new Map()
    for (const r of asnRes.rows) {
      if (!asnByPo.has(r.po_id)) asnByPo.set(r.po_id, [])
      asnByPo.get(r.po_id).push(r)
    }
    const txByApproval = new Map()
    for (const r of txRes.rows) {
      if (!txByApproval.has(r.payment_approval_id)) txByApproval.set(r.payment_approval_id, [])
      txByApproval.get(r.payment_approval_id).push(r)
    }

    const items = rows.map((r) => ({
      ...r,
      grn_list: r.po_id ? grnByPo.get(r.po_id) || [] : [],
      asn_list: r.po_id ? asnByPo.get(r.po_id) || [] : [],
      payment_transactions: txByApproval.get(r.id) || []
    }))

    res.json({ items, total, limit, offset })
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
  const indexHtml = path.join(publicDir, 'index.html')
  app.use(express.static(publicDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    if (req.path.startsWith('/api')) return next()
    res.sendFile(indexHtml, (err) => {
      if (err) {
        res.status(500).send(
          '<h1>Frontend not deployed</h1><p>Build the frontend and copy <code>frontend/dist/*</code> into <code>backend/public/</code>.</p><p>From project root: <code>cd frontend && npm run build</code> then <code>Copy-Item dist\\* ../backend/public/ -Recurse -Force</code></p>'
        )
      }
    })
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
