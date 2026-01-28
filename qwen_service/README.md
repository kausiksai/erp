# Qwen OCR Service

FastAPI service for extracting structured data from PDFs using Qwen2.5-VL Vision-Language models.

## Setup

### Prerequisites

- Python 3.10+
- CUDA-capable GPU (recommended) or CPU
- Poppler (for PDF to image conversion)

### Installation

1. **Create virtual environment:**
```bash
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
```

2. **Install dependencies:**
```bash
pip install -r requirements.txt
```

3. **Install Poppler:**
   - **Windows**: Download from [poppler-windows](https://github.com/oschwartz10612/poppler-windows/releases) and add to PATH
   - **Ubuntu/Debian**: `sudo apt-get install poppler-utils`
   - **macOS**: `brew install poppler`

### Running the Service

```bash
python qwen_service.py
```

The service will run on `http://localhost:5000`

## API Endpoints

### POST /ocr
Extract data from PDF

**Request:**
- `pdf`: PDF file (multipart/form-data)
- `prompt`: Optional custom extraction prompt

**Response:**
```json
{
  "success": true,
  "text": "Extracted text...",
  "pages": [
    {
      "page": 1,
      "text": "Page 1 text..."
    }
  ],
  "page_count": 1,
  "model": "Qwen2.5-VL"
}
```

### GET /health
Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "model_loaded": true,
  "device": "cuda",
  "model_name": "Qwen2.5-VL"
}
```

## Model Selection

Edit `qwen_service.py` to change the model:

```python
model_name = "Qwen/Qwen2-VL-2B-Instruct"  # 2B parameters, ~4GB VRAM
# model_name = "Qwen/Qwen2-VL-7B-Instruct"  # 7B parameters, ~14GB VRAM
```

## Performance Tips

1. Use GPU for faster inference
2. Adjust DPI in `pdf_to_images()` for quality/speed balance
3. Use smaller model for faster processing
4. Enable quantization for lower memory usage
