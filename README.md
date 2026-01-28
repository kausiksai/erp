# Billing System - Invoice Upload with OCR

A billing system application that allows users to upload invoice PDFs and extract data using DeepSeek-OCR technology.

## Features

- **User Authentication**: Secure login system with JWT tokens and role-based access control
- **PDF Upload**: Drag and drop or browse to upload invoice PDFs
- **OCR Data Extraction**: Uses DeepSeek-OCR to automatically extract invoice data
- **PDF Viewer**: View uploaded PDFs with page navigation
- **Form Fields**: Automatically populated form fields for invoice details
- **Data Storage**: Stores extracted invoice data in PostgreSQL database

## Tech Stack

### Backend
- Node.js + Express
- PostgreSQL
- Multer (file upload handling)
- PDF parsing and OCR integration
- DeepSeek-OCR API integration

### Frontend
- React + TypeScript
- Vite
- PrimeReact UI components
- React-PDF for PDF viewing
- Tailwind CSS

## Project Structure

```
biling_system/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express server and API routes
│   │   ├── db.js             # PostgreSQL connection pool
│   │   ├── schema.sql        # Database schema
│   │   └── initDb.js         # Database initialization script
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   └── InvoiceUpload.tsx  # Main invoice upload page
│   │   ├── utils/
│   │   │   └── api.ts        # API utility functions
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── index.css
│   │   └── App.css
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

## Setup Instructions

### Prerequisites
- Node.js (v18 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

### Backend Setup

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

4. Update `.env` with your database credentials:
```env
DATABASE_URL=postgresql://user:password@localhost:5432/billing_system
DEEPSEEK_OCR_API=https://api.deepseek.com/ocr
DEEPSEEK_API_KEY=your_api_key_here
PORT=4000
```

5. Initialize database:
```bash
npm run db:init
```

6. Create default admin user:
```bash
npm run db:create-user
```

   This creates a default admin user with:
   - Username: `admin` (or set `DEFAULT_ADMIN_USERNAME` in `.env`)
   - Email: `admin@example.com` (or set `DEFAULT_ADMIN_EMAIL` in `.env`)
   - Password: `admin123` (or set `DEFAULT_ADMIN_PASSWORD` in `.env`)
   - Role: `admin` (or set `DEFAULT_ADMIN_ROLE` in `.env`)

   ⚠️ **Important**: Change the default password after first login!

7. Start the server:
```bash
npm run dev
```

The backend API will be running on `http://localhost:4000`

### Frontend Setup

1. Navigate to frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

The frontend will be running on `http://localhost:3000`

## Usage

1. Open the application in your browser (typically `http://localhost:3000`)
2. **Login** with your credentials (default: `admin` / `admin123`)
3. Navigate to "Invoice Upload" from the home page
4. Click "Browse Files" or drag and drop a PDF invoice
5. The PDF will be displayed on the left side
6. Click "Extract Data" button to process the invoice with DeepSeek-OCR
7. Review and edit the extracted data in the form fields on the right
8. Click "Save Invoice" to store the data in the database

## DeepSeek-OCR Integration

The application integrates with DeepSeek-OCR for intelligent invoice data extraction. Based on the [official GitHub repository](https://github.com/deepseek-ai/DeepSeek-OCR):

- **DeepSeek-OCR** is a 3B-parameter model with 97% character-level accuracy
- Uses 10× input compression (100 tokens vs 6000+ for traditional OCR)
- Supports multiple modes: Tiny (512×512, 64 tokens), Small (640×640, 100 tokens), Base (1024×1024, 256 tokens), Large (1280×1280, 400 tokens)
- Outputs clean markdown from documents

### Setup DeepSeek-OCR Service

The application uses the **actual DeepSeek-OCR code** from the [official repository](https://github.com/deepseek-ai/DeepSeek-OCR). The model runs locally using transformers.

#### Quick Setup (Recommended)

**Windows:**
```bash
cd backend\ocr_service
setup.bat
```

**Linux/Mac:**
```bash
cd backend/ocr_service
chmod +x setup.sh
./setup.sh
```

#### Manual Setup

1. **Create Python environment:**
```bash
cd backend/ocr_service
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. **Install PyTorch with CUDA 11.8:**
```bash
pip install torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu118
```

3. **Install dependencies:**
```bash
pip install -r requirements.txt
pip install flash-attn==2.7.3 --no-build-isolation
```

4. **Install Poppler (for PDF conversion):**
   - **Windows**: Download from [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) and add to PATH
   - **Ubuntu/Debian**: `sudo apt-get install poppler-utils`
   - **macOS**: `brew install poppler`

5. **Start the OCR service:**
```bash
python ocr_service.py
```

The service will run on `http://localhost:5000` (configured in `.env`).

**Requirements:**
- Python 3.12.9 (recommended) or 3.12+
- CUDA 11.8+ and GPU (recommended) or CPU (very slow)
- ~10GB disk space for model download
- GPU with 8GB+ VRAM (recommended 16GB+)

**Note**: If the OCR service is not running, the application will automatically fall back to basic PDF text extraction.

See `backend/ocr_service/QUICKSTART.md` for detailed setup instructions.

## Authentication

The application includes a complete authentication system:

- **JWT-based authentication**: Secure token-based authentication
- **Role-based access control**: Support for different user roles (admin, user, etc.)
- **Password hashing**: Passwords are hashed using bcrypt
- **Protected routes**: All application routes require authentication
- **Session management**: Tokens stored in localStorage

### User Roles

The system supports role-based access control. Default roles:
- `admin` - Full system access
- `user` - Standard user access

You can extend roles as needed for your use case.

### API Endpoints

**Authentication:**
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/me` - Get current user info (protected)

## Database Schema

The application uses the following main tables:
- `users` - User accounts with authentication and role information
- `invoices` - Main invoice records
- `invoice_lines` - Invoice line items
- `invoice_attachments` - Stored PDF files
- `suppliers` - Supplier information
- `purchase_orders` - Purchase order records
- `purchase_order_lines` - Purchase order line items
- `owners` - Company/owner information

Refer to `backend/src/schema.sql` for the complete schema.

## API Endpoints

**Authentication (Public):**
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login and get JWT token

**Authentication (Protected):**
- `GET /api/auth/me` - Get current user info

**Invoices (Protected):**
- `POST /api/invoices/upload` - Upload invoice PDF and extract data
- `GET /api/invoices/:id` - Get invoice details
- `PUT /api/invoices/:id` - Update invoice
- `GET /api/invoices/:id/pdf` - Download invoice PDF
- `GET /api/invoices` - List all invoices

**Purchase Orders (Protected):**
- `GET /api/purchase-orders` - List all purchase orders
- `GET /api/purchase-orders/:poNumber` - Get purchase order by number
- `GET /api/purchase-orders/:poId/line-items` - Get purchase order line items

**Other (Protected):**
- `GET /api/owner` - Get owner/company information
- `GET /api/suppliers/:supplierName` - Get supplier by name

## License

ISC
