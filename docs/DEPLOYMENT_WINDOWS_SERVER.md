# Deploy Billing System to Windows Server (EC2)

Step-by-step guide to deploy the full application (frontend + backend) on **Windows Server 2025** with RDP access. Database is **AWS RDS PostgreSQL** (already configured).

---

## Server details

| Item | Value |
|------|--------|
| **OS** | Windows Server 2025 Base |
| **Specs** | 2 GB RAM, 30 GB HDD |
| **RDP** | `ec2-65-1-85-146.ap-south-1.compute.amazonaws.com` |
| **Login** | Username: `administrator` / Password: `Srimukha2026#@` |
| **RDP file** | `c:\Users\kausi\Downloads\ec2-65-1-85-146.ap-south-1.compute.amazonaws.com.rdp` |

---

## 1. Connect to the server

1. On your PC, double-click the RDP file (or open **Remote Desktop Connection** and enter the hostname above).
2. Log in with **administrator** / **Srimukha2026#@**.

---

## 2. Install Node.js (LTS)

1. Open a browser on the server and go to: https://nodejs.org/
2. Download the **LTS** Windows installer (e.g. **64-bit .msi**).
3. Run the installer:
   - Accept the license, leave default path (`C:\Program Files\nodejs\`).
   - Ensure **"Add to PATH"** is checked.
   - Finish the installation.
4. **Close and reopen** PowerShell or Command Prompt, then check:
   ```powershell
   node -v
   npm -v
   ```
   You should see versions (e.g. v20.x and 10.x).

---

## 3. Get the application code on the server

**Option A – Using Git (recommended)**

1. Install Git for Windows: https://git-scm.com/download/win (use defaults).
2. Open **PowerShell** and run:
   ```powershell
   cd C:\
   git clone https://github.com/Sriram-Ananth/erp.git billing_system
   cd billing_system
   ```

**Option B – Copy from your PC**

1. On your PC, zip the project folder (e.g. `biling_system` or `erp`) **excluding** `node_modules` and `.env` (you will recreate .env on the server).
2. Copy the zip to the server (e.g. via RDP clipboard, shared folder, or upload to cloud and download on server).
3. On the server, extract to e.g. `C:\billing_system`.

---

## 4. Configure database (RDS)

- Database is already set: **billing_system** on RDS.
- Ensure the **EC2 security group** allows the server to reach RDS:
  - In AWS Console: RDS → your DB → VPC security group → Inbound rules.
  - Add (or confirm) rule: **PostgreSQL (5432)** from the **EC2 instance security group** (or the server’s private IP).

If the database is **empty**, load schema and seed data **once**:

- **Option 1 – From your PC:** Use pgAdmin, DBeaver, or any PostgreSQL client. Connect to the RDS endpoint (host, port 5432, database `billing_system`, user `postgres`, password). Run in order: `backend/src/schema.sql`, then `backend/src/data.sql`.
- **Option 2 – From the server with psql:** If you install PostgreSQL client tools on the server, you can run:
  ```powershell
  cd C:\billing_system\backend
  $env:PGPASSWORD="M25Jxf9FpBjZUJFyGcTY"
  psql -h srimukha.chsm6aymy92r.ap-south-1.rds.amazonaws.com -U postgres -d billing_system -f src/schema.sql
  psql -h srimukha.chsm6aymy92r.ap-south-1.rds.amazonaws.com -U postgres -d billing_system -f src/data.sql
  ```
  (Or set PGPASSWORD in `.env` and use a script that reads it.)
- **Note:** `npm run db:init` in this project only prints the paths to the SQL files; it does not execute them. You must run the SQL files yourself as above.

---

## 5. Backend setup

1. Open **PowerShell** and go to the backend folder:
   ```powershell
   cd C:\billing_system\backend
   ```

2. Create the production `.env` file (copy from example and edit):
   ```powershell
   copy .env.example .env
   notepad .env
   ```
   Set at least:
   ```env
   PGHOST=srimukha.chsm6aymy92r.ap-south-1.rds.amazonaws.com
   PGPORT=5432
   PGDATABASE=billing_system
   PGUSER=postgres
   PGPASSWORD=M25Jxf9FpBjZUJFyGcTY

   PORT=4000
   NODE_ENV=production
   JSON_LIMIT=25mb

   JWT_SECRET=your_very_long_random_secret_here_min_32_chars
   ```
   Replace `your_very_long_random_secret_here_min_32_chars` with a strong random string (e.g. generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

   Optional:
   - `FRONTEND_ORIGIN=http://ec2-65-1-85-146.ap-south-1.compute.amazonaws.com:4000` (or your final URL).
   - `QWEN_SERVICE_URL=http://localhost:5000` if you run the OCR service on the same server.

3. Install dependencies:
   ```powershell
   npm install
   ```
   Ensure the database already has tables and seed data (see step 4). If not, run `schema.sql` and `data.sql` against RDS as described there.

4. (Optional) Quick test:
   ```powershell
   npm start
   ```
   You should see: `Billing System API listening on http://localhost:4000`. Stop with **Ctrl+C**.

---

## 6. Frontend build and copy to backend

1. Open a **new** PowerShell window and go to the frontend:
   ```powershell
   cd C:\billing_system\frontend
   ```

2. Install dependencies and build (use `/api` so the app calls the same origin in production):
   ```powershell
   npm install
   $env:VITE_API_URL="/api"; npm run build
   ```
   Or in one line:
   ```powershell
   npm install
   npm run build
   ```
   (If you don’t set `VITE_API_URL`, the app uses `/api` by default, which is correct when the backend serves the frontend.)

3. Copy the built files into the backend’s `public` folder so the backend can serve them:
   ```powershell
   if (-not (Test-Path ..\backend\public)) { New-Item -ItemType Directory -Path ..\backend\public }
   Copy-Item -Path .\dist\* -Destination ..\backend\public\ -Recurse -Force
   ```

4. Confirm files exist:
   ```powershell
   dir ..\backend\public
   ```
   You should see `index.html`, `assets\`, etc.

---

## 7. Run the application (production)

1. In PowerShell:
   ```powershell
   cd C:\billing_system\backend
   $env:NODE_ENV="production"
   npm start
   ```

2. On the server, open a browser and go to:
   - http://localhost:4000  
   You should see the app login page and be able to sign in (e.g. admin / Admin@123).

3. To allow access from other machines, open **Windows Firewall**:
   - Run `wf.msc` or: Windows Defender Firewall → Advanced settings → Inbound Rules.
   - New Rule → Port → TCP → **4000** → Allow.
   - Name it e.g. “Billing System”.

4. From another PC, use:
   - http://ec2-65-1-85-146.ap-south-1.compute.amazonaws.com:4000  
   (Replace with your EC2 public IP or DNS if different.)

---

## 8. Run in the background (optional)

So the app keeps running after you close the RDP session:

**Option A – PM2 (Node process manager)**

1. Install PM2 globally:
   ```powershell
   npm install -g pm2
   npm install -g pm2-windows-startup
   ```
2. Start the app:
   ```powershell
   cd C:\billing_system\backend
   pm2 start src/index.js --name billing-api
   pm2 save
   pm2 startup
   ```
   Follow the command it prints to enable startup on boot.

**Option B – Run as Windows Service (NSSM)**

1. Download NSSM: https://nssm.cc/download
2. Extract and run `nssm install BillingSystem`.
3. Path: `C:\Program Files\nodejs\node.exe`  
   Startup directory: `C:\billing_system\backend`  
   Arguments: `src/index.js`
4. In “Environment” add: `NODE_ENV=production` (and optionally `PORT=4000`).
5. Start the service from Services (`services.msc`) or: `nssm start BillingSystem`.

---

## 9. OCR service (optional)

If you use invoice/weight-slip OCR:

1. Install **Python 3.12+** and **Poppler** (for PDFs) on the server.
2. In `qwen_service`, create a venv, install dependencies, set `DASHSCOPE_API_KEY`, and run:
   ```powershell
   cd C:\billing_system\qwen_service
   python -m venv venv
   .\venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   python qwen_service.py
   ```
3. In backend `.env`, set:
   ```env
   QWEN_SERVICE_URL=http://localhost:5000
   ```
   You can run the OCR service in the background (e.g. with PM2 or a separate window).

---

## 10. Checklist

- [ ] Node.js LTS installed, `node` and `npm` in PATH  
- [ ] App code on server (`C:\billing_system` or your path)  
- [ ] RDS reachable from EC2 (security group allows 5432)  
- [ ] Backend `.env` set (PG*, PORT, NODE_ENV, JWT_SECRET)  
- [ ] Database has schema and seed data (schema.sql + data.sql run once on RDS)  
- [ ] Frontend built and copied to `backend\public`  
- [ ] Backend started with `NODE_ENV=production`  
- [ ] Firewall allows TCP 4000 (if needed for external access)  
- [ ] Login works at http://&lt;server&gt;:4000 (admin / Admin@123)

---

## Default login (from data.sql)

- **Username:** `admin`  
- **Email:** `admin@srimukha.com`  
- **Password:** `Admin@123`  

Change the password after first login in production.
