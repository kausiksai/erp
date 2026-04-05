# Billing System - Complete ERP Solution

A comprehensive billing and invoice management system with OCR-based data extraction, user management, role-based access control, and complete purchase order tracking.

## 🚀 Features

- **User Authentication & Authorization**: Secure JWT-based authentication with role-based access control (Admin, Manager, User, Finance, Viewer)
- **Invoice Management**: Upload, extract, validate, and manage invoices with OCR technology
- **Purchase Order Tracking**: Complete PO management with line items and status tracking
- **Supplier Management**: Register and manage supplier information
- **Owner/Company Details**: Manage company owner information
- **User Registration**: Admin can create, update, and manage users with menu access control
- **Menu-Based Navigation**: Dynamic menu system with role-based visibility
- **OCR Data Extraction**: Automatic invoice data extraction using Qwen-VL-OCR API
- **Weight Slip Scanning**: Extract weight data from weight slip PDFs
- **Invoice Validation**: Validate invoices against purchase orders
- **PDF Viewer**: Built-in PDF viewer for invoice documents
- **Responsive Design**: Modern, professional UI with PrimeReact components

## 📋 Tech Stack

### Backend
- **Node.js** + **Express.js** - RESTful API server
- **PostgreSQL** - Relational database
- **JWT** - Authentication tokens
- **bcrypt** - Password hashing
- **Multer** - File upload handling
- **Axios** - HTTP client for external services

### Frontend
- **React 19** + **TypeScript** - Modern UI framework
- **Vite** - Fast build tool and dev server
- **PrimeReact** - Professional UI component library
- **React Router** - Client-side routing
- **React-PDF** - PDF viewing capabilities
- **Tailwind CSS** - Utility-first CSS framework

### OCR Service
- **Python 3.12+** - OCR service runtime
- **FastAPI** - Python web framework
- **Qwen-VL-OCR** - Alibaba Cloud OCR API integration
- **Pillow** - Image processing
- **pdf2image** - PDF to image conversion

## 📊 Data Model & Production Data Flow

In production, data enters the system from two sources:

| Source | Entities | How |
|--------|----------|-----|
| **Excel import** | PO, DC, GRN, ASN | Bulk load from Excel exports. These tables are **not** created or edited through the frontend. |
| **Frontend (scan & store)** | Invoices, invoice lines, invoice attachments | User scans invoice PDF → system extracts data (OCR) → user validates → save. Invoices link to POs (already loaded from Excel) via `po_id` / `po_number`. |

- **PO (Purchase Order)** and **purchase_order_lines**: Loaded from Excel; frontend is view-only (e.g. Purchase Order Details page).
- **GRN (Goods Receipt Note)** and **ASN (Advanced Shipping Notice)**: Loaded from Excel; no frontend create/edit.
- **Invoices**: The only entity created and updated through the frontend (upload PDF, extract, validate, save). Schema and APIs are designed so invoices reference Excel-imported POs.

## Invoice, ASN, GRN & PO Processing – Functional Requirements

The system implements the following business rules for PO, Invoice, GRN, and ASN processing.

### 1. Standard PO Invoice Validation
- For any standard PO, the system processes ASN, GRN, and Invoice.
- Invoice details are validated against ASN and GRN (quantity, unit price, tax/totals where applicable).
- **If all details match:** Invoice status → **Ready for Payment**; payment due date = invoice receipt date + PO payment terms (days); PO status → **Fulfilled**.

### 2. Partial Quantity / Shortfall (Debit Note Flow)
- If Invoice, ASN, or GRN quantity is less than PO quantity: Invoice → **Debit Note Approval** and the PO appears under **Incomplete POs**.
- After the Debit Note is uploaded and approved: Invoice → **Ready for Payment**; payment amount = Debit Note value; PO status → **Partially Fulfilled**.

### 3. Partially Fulfilled PO Management
- All **Partially Fulfilled** POs are shown under **Incomplete POs** with an option to **Force Close**.
- When force-closed: PO status → **Fulfilled**.

### 4. Multiple Invoices, ASN, and GRN per PO
- A single PO may have multiple ASNs, GRNs, and Invoices.
- The system maintains **cumulative** invoice, ASN, and GRN quantities per PO.
- When cumulative quantities match the PO quantity, PO status is updated to **Fulfilled**.

### 5. Invoices Received After PO Fulfillment
- If an invoice is received for a PO already marked **Fulfilled**: Invoice → **Exception Approval**.
- After exception approval: Invoice → **Ready for Payment**.

### 6. Validate → Ready for Payment (Single Step)
- When validation **succeeds** (all checks pass): Invoice status → **Ready for Payment** immediately; a **payment_approval** record is created with status `approved` so the invoice appears in **Ready for Payments** without a separate approval step.
- When validation **fails** (e.g. invoice not linked to PO, supplier mismatch): API returns **400** with a clear reason; invoice status remains **Waiting for validation**. No fake success.

### Implementation Notes
- **Schema:** `purchase_orders` has `terms` (e.g. "60 DAYS FROM RECEIPT OF MATERIAL"); days are parsed from this text for payment due date. `status` = open | fulfilled | partially_fulfilled. `invoices` has `payment_due_date`, `debit_note_value`, `po_number`, and `status` (waiting_for_validation | ready_for_payment | debit_note_approval | exception_approval | validated | paid | rejected | …).
- **Backend:** `poInvoiceValidation.js` implements validation, cumulative quantities, and status updates. APIs: `POST /api/invoices/:id/validate`, `PATCH /api/invoices/:id/debit-note-approve`, `PATCH /api/invoices/:id/exception-approve`, `PATCH /api/purchase-orders/:id/force-close`, `GET /api/purchase-orders/:id/cumulative`.
- **Database:** `backend/src/schema.sql` contains tables and indexes. `backend/src/data.sql` contains seed data. Run `npm run db:init` (see Installation) to apply schema and load data.

---

## ✅ Rules and Validations (Implemented)

### Invoice Validation (Backend – `poInvoiceValidation.js`)

Validation runs when you click **Validate** on an invoice. The invoice must pass all checks below for status to move to **Ready for payment**.

| Rule | Description | On failure |
|------|-------------|------------|
| **PO linked** | Invoice must have `po_id` (linked to a purchase order). | Validation fails; API returns 400, e.g. "Invoice is not linked to a PO". |
| **PO exists** | The linked PO must exist in `purchase_orders`. | Validation fails; "PO not found". |
| **PO not already fulfilled** | If PO status is already **fulfilled**, invoice goes to **Exception approval** (not standard validation). | Response `action: 'exception_approval'`. |
| **Supplier match** | `invoices.supplier_id` must equal `purchase_orders.supplier_id`. | Validation fails; "Invoice supplier does not match PO supplier". |
| **Invoice number** | Invoice should have a non-empty invoice number (warning if missing). | Can still validate; warning only. |
| **Quantity vs PO** | Sum of invoice line quantities must match PO total quantity (tolerance 0.001). | Validation fails or **shortfall**; e.g. "Invoice quantity does not match PO total" or "Invoice total quantity exceeds PO total". |
| **Invoice vs GRN** | Invoice total quantity must not exceed GRN total (pay only for received). | Validation fails / shortfall; "GRN total (x) is less than invoice quantity (y). Pay only for what was received." |
| **Line-level** | Each invoice line should match a PO line (by `po_line_id` or sequence); line total ≈ qty × rate (tolerance 0.01). | Line errors contribute to validation failure. |
| **Totals** | Sum of line totals vs invoice total amount (tolerance 0.01). | Warning only; does not block validation. |
| **ASN** | If no ASN exists for the PO (via invoice number match), a warning is added. | Informational only. |

**Tolerances:** `TOL_QTY = 0.001`, `TOL_AMOUNT = 0.01`, `TOL_RATE_PCT = 0.01`.

**Validation outcomes:**

- **Valid** → Invoice status = `ready_for_payment`, payment_approval created, PO → `fulfilled`.
- **Shortfall** (quantity/GRN mismatch) → Invoice status = `waiting_for_re_validation`; user can choose "Proceed to payment" or "Send to debit note".
- **Exception** (PO already fulfilled) → Invoice status = `exception_approval`; after exception approve → ready for payment.
- **Failed** (no PO link, supplier mismatch, or other errors) → API returns **400** with `reason` and `errors`; invoice status unchanged.

**Status flows (summary):**

- **Invoice:** `waiting_for_validation` → (Validate) → `ready_for_payment` | `waiting_for_re_validation` | `debit_note_approval` | `exception_approval`. Then payment flow: approve → `ready_for_payment` → `partially_paid` / `paid`.
- **PO:** `open` → `fulfilled` or `partially_fulfilled`; force-close → `fulfilled`.

### Invoice Create/Update Rules (Backend)

| Rule | Description |
|------|-------------|
| **po_number** | On create/update, `po_number` is set from request body or looked up from `purchase_orders` using `po_id`. Stored in `invoices.po_number`. |
| **payment_due_date** | When `po_id` and `invoice_date` are present, payment due date = invoice_date + **payment terms days**. Terms days are parsed from `purchase_orders.terms` (e.g. "30 DAYS", "60 DAYS FROM RECEIPT") with default 30. |
| **scanning_number vs po_number** | Columns are separate; values are not swapped. |

### ASN and PO Number (Backend)

| Rule | Description |
|------|-------------|
| **ASN table** | `asn` table has **no** `po_id` or `supplier_id`. PO number for ASN is **derived** at display time. |
| **PO number for ASN** | Derived by: `asn.inv_no` → match `invoices.invoice_number` (trim, case-insensitive) → `invoices.po_id` → `purchase_orders.po_number`. Fallback: `asn.dc_no` → match `grn.dc_no` → `grn.po_id` → `purchase_orders.po_number`. |
| **Has ASN / ASN list for PO** | Queries use the same join (asn ↔ invoices on invoice number, then po_id) to determine if a PO has ASN or to list ASNs for a PO. |

### Excel Import Rules (Backend – `excelImport.js`)

| Entity | Rules |
|--------|--------|
| **PO** | Header row required; `po_number` (or aliases) and optional date/amd_no. Rows grouped by (po_number, amd_no); ON CONFLICT updates. |
| **GRN** | PO number column required; resolved to `po_id` from `purchase_orders`. If no matching PO, row skipped. Empty rows skipped. On 0 records imported, API returns a hint (missing column, no matching PO, etc.). |
| **ASN** | PO number **not** required. Columns: ASN No., Supplier, DC No., Inv. No., etc. `inv_no` stored as-is; PO number for ASN is derived when listing (see above). Empty rows skipped. |

### OCR Extraction Rules (Qwen Service – `qwen_service.py`)

| Rule | Description |
|------|-------------|
| **Invoice number & date** | Prompt instructs model to look for Invoice No, Bill No, GI…, Date, etc., and not leave blank when visible. |
| **PO number** | Extract only the order code (e.g. V2287); strip suffixes like " dt. 12-Jan-26", " / 2025-26". |
| **PAN vs GST** | `panNumber` = PAN only (10 chars). If only 15-char GST is found, do not put in `panNumber`; leave blank or use billToGst. |
| **Branch vs IFSC** | Branch name must not contain IFSC. If text is "Anna Nagar, Chennai. & KVBLO001154", split into branchName and ifscCode. |
| **Numbers** | Amounts returned without comma (e.g. 73668.00 not 73,668.00). |
| **Placeholders** | Values like "YOUR PLACE", "XXX", "NA" → empty string. |
| **Post-processing** | After OCR: strip PO date suffix from poNumber; split IFSC from branchName if concatenated; clear panNumber if it looks like GST (15 chars); remove commas from numeric fields; blank placeholder values. |

### Weight Slip Extraction (Qwen Service)

- **WEIGHT_PROMPT**: Extract single numeric weight (kg or g; grams converted to kg). Return JSON `{ "weight": "<value>" }` or null if not found. No explanation.

### Client-Side Validations (Frontend – `utils/validation.ts`)

| Rule | Description |
|------|-------------|
| **Email** | Must match format `[^\\s@]+@[^\\s@]+\\.[^\\s@]+`. |
| **Password** | Minimum 8 characters; at least one letter and one number. |

### Attachments and Banking

- **Invoice PDF**: Stored in `invoice_attachments` (one or more per invoice; `attachment_type = 'invoice'`).
- **Weight slips**: Stored in `invoice_weight_attachments`, one per invoice line (linked by `invoice_line_id`).
- **Debit notes**: Stored in `debit_notes` table.
- **Payment approvals**: Created when invoice is validated (ready_for_payment) or when manager approves from Approve Payments. Banking details can come from request body or supplier master.

## 📁 Project Structure

```
biling_system/
├── backend/                    # Node.js backend server
│   ├── src/
│   │   ├── index.js           # Express server and main routes
│   │   ├── db.js              # PostgreSQL connection pool
│   │   ├── schema.sql         # Database schema (tables and indexes only)
│   │   ├── data.sql           # Seed data (menu, users, suppliers) and test PO/invoice/GRN/ASN data
│   │   ├── auth.js            # Authentication middleware
│   │   ├── menu_api.js        # Menu items API
│   │   ├── userManagement.js  # User management API
│   │   ├── ownerDetails.js    # Owner details API
│   │   ├── qwenService.js     # Qwen OCR service client
│   │   ├── poInvoiceValidation.js  # PO/Invoice/GRN validation and status rules
│   │   └── initDb.js          # Database initialization
│   ├── package.json           # Backend dependencies
│   └── .env                   # Environment variables
│
├── frontend/                   # React frontend application
│   ├── src/
│   │   ├── pages/             # Page components
│   │   │   ├── Login.tsx      # Login page
│   │   │   ├── Home.tsx       # Dashboard/home page
│   │   │   ├── InvoiceUpload.tsx
│   │   │   ├── InvoiceDetails.tsx
│   │   │   ├── UserRegistration.tsx
│   │   │   ├── OwnerDetails.tsx
│   │   │   └── ...
│   │   ├── components/        # Reusable components
│   │   │   ├── Header.tsx
│   │   │   ├── PageNavigation.tsx
│   │   │   └── ProtectedRoute.tsx
│   │   ├── contexts/          # React contexts
│   │   │   └── AuthContext.tsx
│   │   └── utils/             # Utility functions
│   │       └── api.ts
│   ├── package.json           # Frontend dependencies
│   └── vite.config.ts         # Vite configuration
│
├── qwen_service/              # Python OCR service
│   ├── qwen_service.py        # FastAPI OCR service
│   ├── requirements.txt      # Python dependencies
│   └── README.md             # OCR service documentation
│
├── requirements.txt           # Project overview (this file)
├── .gitignore                # Git ignore rules
└── README.md                 # This file
```

## 🛠️ Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** v18 or higher ([Download](https://nodejs.org/))
- **PostgreSQL** v12 or higher ([Download](https://www.postgresql.org/download/))
- **Python** 3.12+ ([Download](https://www.python.org/downloads/))
- **npm** or **yarn** (comes with Node.js)
- **pip** (comes with Python)
- **Poppler** (for PDF conversion):
  - **Windows**: Download from [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) and add to PATH
  - **Ubuntu/Debian**: `sudo apt-get install poppler-utils`
  - **macOS**: `brew install poppler`

## 📦 Installation & Setup

### Step 1: Clone the Repository

```bash
git clone https://github.com/Sriram-Ananth/erp.git
cd erp
```

(Or use `https://github.com/kausiksai/erp.git` if that is your fork.)

### Step 2: Database Setup

1. **Create PostgreSQL Database**:
```sql
CREATE DATABASE billing_system;
```

2. **Update Database Credentials**:
   - Navigate to `backend/` directory
   - Create `.env` file (copy from `.env.example` if available):
```env
PGHOST=localhost
PGPORT=5432
PGDATABASE=billing_system
PGUSER=postgres
PGPASSWORD=your_password_here
PORT=4000
NODE_ENV=development
JSON_LIMIT=25mb
QWEN_SERVICE_URL=http://localhost:5000
```

### Step 3: Backend Setup

1. **Navigate to backend directory**:
```bash
cd backend
```

2. **Install dependencies**:
```bash
npm install
```

3. **Initialize database**:
```bash
npm run db:init
```
This will create all tables and insert default data including:
- Menu items
- Role-based access permissions
- Default admin user (username: `admin`, email: `admin@srimukha.com`, password: `Admin@123`)

4. **Start the backend server**:
```bash
npm run dev
```

The backend API will be running on `http://localhost:4000`

### Step 4: Frontend Setup

1. **Open a new terminal and navigate to frontend directory**:
```bash
cd frontend
```

2. **Install dependencies**:
```bash
npm install
```

3. **Start the development server**:
```bash
npm run dev
```

The frontend will be running on `http://localhost:3000`

### Step 5: Qwen OCR Service Setup

1. **Get Qwen API Key**:
   - Sign up at [Alibaba Cloud DashScope](https://dashscope.aliyun.com/)
   - Get your API key from the dashboard
   - Update `qwen_service/qwen_service.py` with your API key:
   ```python
   QWEN_API_KEY = 'your-api-key-here'
   ```
   Or set it as environment variable:
   ```bash
   export DASHSCOPE_API_KEY=your-api-key-here
   ```

2. **Navigate to qwen_service directory**:
```bash
cd qwen_service
```

3. **Create Python virtual environment** (recommended):
```bash
python -m venv venv

# Windows
venv\Scripts\activate

# Linux/Mac
source venv/bin/activate
```

4. **Install Python dependencies**:
```bash
pip install -r requirements.txt
```

5. **Start the OCR service**:
```bash
python qwen_service.py
```

The OCR service will be running on `http://localhost:5000`

**Note**: The OCR service is optional. If it's not running, the application will still work but OCR extraction will fail.

## 🚀 Running the Application

### Development Mode

1. **Start PostgreSQL** (if not running as a service)

2. **Start Backend** (Terminal 1):
```bash
cd backend
npm run dev
```

3. **Start Frontend** (Terminal 2):
```bash
cd frontend
npm run dev
```

4. **Start OCR Service** (Terminal 3 - Optional):
```bash
cd qwen_service
python qwen_service.py
```

5. **Open Browser**: Navigate to `http://localhost:3000`

### Production Build

**Backend**:
```bash
cd backend
npm start
```

**Frontend**:
```bash
cd frontend
npm run build
npm run preview
```

## 🔐 Default Login Credentials

After running `npm run db:init`, you can login with:

- **Username**: `admin`
- **Email**: `admin@srimukha.com`
- **Password**: `Admin@123`
- **Role**: `admin`

⚠️ **Important**: Change the default password after first login!

## 📚 Usage Guide

### 1. Login
- Navigate to `http://localhost:3000`
- Enter your credentials
- Click "Sign In"

### 2. Invoice Upload
- Click "Invoice Upload" from the home page
- Upload a PDF invoice
- Click "Extract Data" to process with OCR
- Review and edit extracted data
- Select measurement type (Weight or Count) for line items
- Fill in weight (via weight slip scanning) or count for each item
- Click "Save Invoice" to store in database

### 3. User Management (Admin Only)
- Click "User Registration" from the home page
- Create new users
- Assign roles and menu access
- View user metrics and statistics

### 4. Owner Details (Admin Only)
- Click "Owner Details" from Master Data section
- View and edit company owner information
- Update bank details, contact information, etc.

### 5. Purchase Orders
- View incomplete purchase orders
- Link invoices to purchase orders
- Track PO status and line items

## 🔑 API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration (if enabled)
- `GET /api/auth/me` - Get current user info

### Invoices
- `POST /api/invoices` - Create invoice (with po_number, payment_due_date from PO when po_id provided)
- `GET /api/invoices` - List invoices (filter by status, invoice number, PO number)
- `GET /api/invoices/:id` - Get invoice details (with PO, supplier, lines, attachments)
- `PUT /api/invoices/:id` - Update invoice (po_number and payment_due_date kept in sync)
- `POST /api/invoices/:id/validate` - Validate invoice against PO/GRN (→ ready_for_payment, shortfall, or exception_approval; returns 400 with reason if validation fails)
- `POST /api/invoices/:id/validate-resolution` - Resolve shortfall: `proceed_to_payment` or `send_to_debit_note`
- `PATCH /api/invoices/:id/debit-note-approve` - Approve debit note (set debit_note_value, invoice → ready_for_payment)
- `PATCH /api/invoices/:id/exception-approve` - Exception approve (invoice for already-fulfilled PO → ready_for_payment)
- `GET /api/invoices/:id/attachments` - List invoice attachments (PDF + weight slips)
- `GET /api/invoices/:id/attachments/:type/:attachmentId` - Get attachment file (type: `invoice` or `weight_slip`)
- `POST /api/invoices/upload` - Upload and extract invoice data (OCR)
- `POST /api/invoices/extract-weight` - Extract weight from weight slip PDF

### Users
- `GET /api/users` - List all users (Admin only)
- `POST /api/users` - Create user (Admin only)
- `PUT /api/users/:id` - Update user (Admin only)
- `DELETE /api/users/:id` - Delete user (Admin only)

### Menu & Access
- `GET /api/menu-items` - Get menu items based on user role
- `GET /api/menu-items/all` - Get all menu items (Admin only)

### Owner Details
- `GET /api/owner` - Get owner details
- `PUT /api/owner` - Update owner details (Admin only)

### Purchase Orders
- `GET /api/purchase-orders` - List all purchase orders
- `GET /api/purchase-orders/incomplete` - Get incomplete POs (missing invoice, GRN, or ASN)
- `GET /api/purchase-orders/:poNumber` - Get PO by number
- `GET /api/purchase-orders/:poId/cumulative` - Get cumulative PO/invoice/GRN quantities
- `PATCH /api/purchase-orders/:poId/force-close` - Force close partially fulfilled PO → fulfilled
- `POST /api/purchase-orders/upload-excel` - Import POs from Excel (**overwrite**: removes unreferenced POs not in file; upserts lines per PO)
- `POST /api/grn/upload-excel` - Import GRN from Excel (**full replace**: truncates `grn` then loads file)
- `POST /api/asn/upload-excel` - Import ASN from Excel (**full replace**: truncates `asn` then loads file)
- `GET /api/delivery-challans` - List DC rows
- `POST /api/delivery-challans/upload-excel` - Import DC Excel (**full replace** → `delivery_challans`)
- `GET /api/po-schedules` - List PO schedule lines
- `POST /api/po-schedules/upload-excel` - Import schedules (**full replace** → `po_schedules`)
- `GET /api/open-po-prefixes` - List Open PO PFX prefixes (auth)
- `POST /api/open-po-prefixes/upload-excel` - Replace all prefixes from Excel (admin/manager/finance)

**Open PO validation:** If `purchase_orders.pfx` matches `open_po_prefixes` (leading match, case-insensitive): same as standard PO **except** no invoice qty vs **PO lines** or **PO total**. **Required:** GRN with quantity, **ASN** for the PO/invoice, and **at least one Delivery Challan or Schedule**. **Invoice total quantity** must **match** (within tolerance) **GRN total** for the PO; if DC rows have a summed `dc_qty`, invoice qty must match that sum; if schedule rows have a summed `sched_qty`, invoice qty must match that sum. Supplier, rates (warnings), line totals vs qty×rate (warnings), header total vs lines (warning) as standard. On validate, PO status is set to **`open`** and **`updatePoStatusFromCumulative` never** closes Open POs.

### Payments
- `GET /api/payments/pending-approval` - Invoices validated, pending manager approval
- `POST /api/payments/approve` - Approve payment (create payment_approval, invoice → ready_for_payment)
- `GET /api/payments/ready` - List ready for payment (approved)
- `POST /api/payments/record-payment` - Record partial/full payment
- `GET /api/payments/history` - Payment history

## 🗄️ Database Schema

The database includes the following main tables:

- **users** - User accounts with authentication and roles
- **menu_items** - Menu items configuration
- **role_menu_access** - Role-based menu access control
- **suppliers** - Supplier information
- **owners** - Company/owner information
- **purchase_orders** - Purchase order records
- **purchase_order_lines** - PO line items
- **delivery_challans** - Delivery challan data (DC Excel import; full replace per upload)
- **po_schedules** - PO schedule lines (Excel import; full replace per upload)
- **open_po_prefixes** - PFX prefixes that identify Open POs for validation rules
- **grn** - Goods Receipt Notes (Excel import; has po_id)
- **asn** - Advanced Shipping Notices (Excel import; no po_id; PO number derived via inv_no → invoices → po)
- **invoices** - Invoice records (po_id, po_number, payment_due_date, status)
- **invoice_lines** - Invoice line items (weight/count, tax, line total)
- **invoice_attachments** - Invoice PDF attachments
- **invoice_weight_attachments** - Weight slip attachments (one per invoice line)
- **debit_notes** - Debit note documents
- **payment_approvals** - Payment approval records (invoice_id unique; status approved/partially_paid/payment_done)
- **payment_transactions** - Partial payment transactions

See `backend/src/schema.sql` for the complete schema with all relationships and indexes.

## 🔒 Security Features

- **JWT Authentication**: Secure token-based authentication
- **Password Hashing**: bcrypt with salt rounds
- **Role-Based Access Control**: Granular permissions per role
- **Protected Routes**: Frontend and backend route protection
- **Input Validation**: Server-side validation for all inputs
- **SQL Injection Protection**: Parameterized queries
- **CORS Configuration**: Controlled cross-origin requests

## 🧪 Testing

### Test Database Connection
```bash
cd backend
npm run db:test
```

### Create Test User
```bash
cd backend
npm run db:create-user
```

## 📝 Environment Variables

### Backend (.env)
```env
PGHOST=localhost
PGPORT=5432
PGDATABASE=billing_system
PGUSER=postgres
PGPASSWORD=your_password
PORT=4000
NODE_ENV=development
JSON_LIMIT=25mb
QWEN_SERVICE_URL=http://localhost:5000
JWT_SECRET=your_jwt_secret_here
```

### Qwen Service
Set in `qwen_service/qwen_service.py` or as environment variable:
```bash
export DASHSCOPE_API_KEY=your-api-key-here
```

## 🐛 Troubleshooting

### Backend won't start
- Check PostgreSQL is running
- Verify database credentials in `.env`
- Ensure database exists: `CREATE DATABASE billing_system;`

### Frontend won't start
- Clear `node_modules` and reinstall: `rm -rf node_modules && npm install`
- Check Node.js version: `node --version` (should be v18+)

### OCR service errors
- Verify API key is correct
- Check internet connection (API calls to Alibaba Cloud)
- Ensure Poppler is installed and in PATH

### Database connection errors
- Verify PostgreSQL is running
- Check firewall settings
- Verify credentials in `.env` file

## 📦 Dependencies

### Backend Dependencies
See `backend/package.json` for complete list:
- express, pg, bcrypt, jsonwebtoken, multer, axios, cors, dotenv, pdf-parse, form-data

### Frontend Dependencies
See `frontend/package.json` for complete list:
- react, react-dom, react-router-dom, primereact, primeicons, react-pdf, pdfjs-dist, vite, typescript, tailwindcss

### Python Dependencies
See `qwen_service/requirements.txt`:
- fastapi, uvicorn, pillow, pdf2image, openai

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

ISC

## 👥 Authors

- **Kausi** - Initial work

## 🙏 Acknowledgments

- PrimeReact for the excellent UI component library
- Alibaba Cloud for Qwen-VL-OCR API
- React team for the amazing framework
- All open-source contributors

## 📞 Support

For issues and questions:
- Open an issue on GitHub
- Check the documentation in each service's README

---

**Happy Coding! 🚀**
