#!/bin/bash

echo "========================================"
echo "  Qwen OCR Service Setup"
echo "========================================"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed"
    echo "Please install Python 3.10+ and try again"
    exit 1
fi

echo "[1/4] Creating virtual environment..."
python3 -m venv venv
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to create virtual environment"
    exit 1
fi

echo "[2/4] Activating virtual environment..."
source venv/bin/activate

echo "[3/4] Upgrading pip..."
pip install --upgrade pip

echo "[4/4] Installing dependencies..."
pip install -r requirements.txt
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install dependencies"
    exit 1
fi

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo "1. Install Poppler:"
echo "   Ubuntu/Debian: sudo apt-get install poppler-utils"
echo "   macOS: brew install poppler"
echo ""
echo "2. Start the service:"
echo "   source venv/bin/activate"
echo "   python qwen_service.py"
echo ""
echo "3. The service will download the model on first run (~4GB for 2B model)"
echo ""
