@echo off
echo ========================================
echo   Qwen OCR Service Setup
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.10+ and try again
    pause
    exit /b 1
)

echo [1/4] Creating virtual environment...
python -m venv venv
if errorlevel 1 (
    echo ERROR: Failed to create virtual environment
    pause
    exit /b 1
)

echo [2/4] Activating virtual environment...
call venv\Scripts\activate.bat

echo [3/4] Upgrading pip...
python -m pip install --upgrade pip

echo [4/4] Installing dependencies...
pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Install Poppler for Windows:
echo    Download from: https://github.com/oschwartz10612/poppler-windows/releases
echo    Add to PATH: C:\path\to\poppler\Library\bin
echo.
echo 2. Start the service:
echo    python qwen_service.py
echo.
echo 3. The service will download the model on first run (~4GB for 2B model)
echo.
pause
