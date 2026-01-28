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

## 📁 Project Structure

```
biling_system/
├── backend/                    # Node.js backend server
│   ├── src/
│   │   ├── index.js           # Express server and main routes
│   │   ├── db.js              # PostgreSQL connection pool
│   │   ├── schema.sql         # Complete database schema
│   │   ├── auth.js            # Authentication middleware
│   │   ├── menu_api.js        # Menu items API
│   │   ├── userManagement.js  # User management API
│   │   ├── ownerDetails.js    # Owner details API
│   │   ├── qwenService.js     # Qwen OCR service client
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
git clone https://github.com/kausiksai/erp.git
cd erp
```

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
- `POST /api/invoices/upload` - Upload and extract invoice data
- `GET /api/invoices` - List all invoices
- `GET /api/invoices/:id` - Get invoice details
- `PUT /api/invoices/:id` - Update invoice
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
- `GET /api/purchase-orders/:poNumber` - Get PO by number
- `GET /api/purchase-orders/incomplete` - Get incomplete POs

## 🗄️ Database Schema

The database includes the following main tables:

- **users** - User accounts with authentication and roles
- **menu_items** - Menu items configuration
- **role_menu_access** - Role-based menu access control
- **suppliers** - Supplier information
- **owners** - Company/owner information
- **purchase_orders** - Purchase order records
- **purchase_order_lines** - PO line items
- **invoices** - Invoice records
- **invoice_lines** - Invoice line items with weight/count
- **invoice_attachments** - Stored PDF files

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
