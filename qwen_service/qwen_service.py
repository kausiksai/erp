import os
import base64
import traceback
import json
import re
from fastapi import FastAPI, UploadFile, File, HTTPException
from pdf2image import convert_from_bytes
from io import BytesIO
from PIL import Image
from openai import OpenAI

# ---------------- CONFIG ----------------
MODEL_NAME = "qwen-vl-ocr"

# ⚠️ Put your API key in environment variable instead
# QWEN_API_KEY = os.getenv("DASHSCOPE_API_KEY", "YOUR_API_KEY_HERE")
QWEN_API_KEY = 'sk-85db8875d6e74de9a2331951797d03f1'
client = OpenAI(
    api_key=QWEN_API_KEY,
    base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
)

# ---------------- APP ----------------
app = FastAPI(title="Qwen Invoice OCR API")

# ---------------- PROMPT ----------------
PROMPT = """
You are a professional invoice data extraction engine.

Extract invoice data from the image and return ONLY valid JSON.

CRITICAL BANK RULES:
- Account Number must contain ONLY digits.
- IFSC Code must be 11 characters like HDFC0000166.
- Branch Name must NOT contain IFSC code.
- If a line contains both Branch and IFSC (like: "Second Line Beach Road & HDFC0000166"):
    → branchName = "Second Line Beach Road"
    → ifscCode = "HDFC0000166"

JSON FORMAT:

{
 "invoiceNumber":"",
 "invoiceDate":"",
 "poNumber":"",
 "supplierName":"",

 "billTo":"",
 "billToAddress":"",
 "billToGst":"",
 "billToMobile":"",
 "placeOfSupply":"",
 "panNumber":"",

 "items":[
   {
     "itemName":"",
     "quantity":"",
     "unitPrice":"",
     "amount":"",
     "hsnSac":"",
     "taxableValue":"",
     "cgstPercent":"",
     "cgstAmount":"",
     "sgstPercent":"",
     "sgstAmount":""
   }
 ],

 "subtotal":"",
 "cgst":"",
 "sgst":"",
 "roundOff":"",
 "totalAmount":"",
 "totalAmountInWords":"",

 "bankName":"",
 "branchName":"",
 "ifscCode":"",
 "accountNumber":"",
 "accountHolderName":""
}

STRICT RULES:
- Use empty string if missing
- Extract PO Number (Purchase Order Number) if present on the invoice
- PO Number may appear as "PO No.", "P.O. No.", "Purchase Order", "PO Number", "Order No.", "Order Number", "Buyer Order No.", "Buyer Order Number", "Buyer's Order no", can start number with PO or PO- or similar
- Return ONLY the PO identifier (e.g. PO9251598). Strip any year or financial-year suffix (e.g. "/ 2025-26", "2025-26", "- 2025-26"). poNumber must be just the PO code like PO9251598 with no slash, no year, no extra text.
- unitPrice: Extract the RATE or PRICE PER UNIT from the line item table (the column often labelled "Rate", "Price", "Unit Price", "Rate/Unit"). This is the per-unit amount (e.g. 3130 or 3,130.00), NOT the quantity. Return the full numeric value; Indian format uses comma as thousand separator (3,130.00 means 3130). Do NOT confuse quantity (e.g. 20) with unit price (e.g. 3130).
- Do NOT swap IFSC and account number
- Do NOT combine branch and IFSC
- Do NOT add explanation
- Return JSON only
"""

# Weight extraction prompt
WEIGHT_PROMPT = """
You are a professional weight slip data extraction engine.

Extract the weight value from the weight slip image and return ONLY valid JSON.

JSON FORMAT:
{
 "weight": ""
}

STRICT RULES:
- Extract the weight value in kilograms (kg) or grams (g)
- Weight may appear as "Weight:", "Net Weight:", "Gross Weight:", "Wt:", "Weight (kg):", "Weight (g):", or similar
- Convert grams to kilograms if needed (divide by 1000)
- Return only the numeric weight value as a number (not as string with units)
- If weight is not found, return null
- Do NOT add explanation
- Return JSON only
"""


# ---------------- QWEN OCR CALL ----------------
def call_qwen(image: Image.Image):

    buf = BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    b64 = base64.b64encode(buf.getvalue()).decode()
    data_url = f"data:image/png;base64,{b64}"

    completion = client.chat.completions.create(
        model=MODEL_NAME,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": data_url
                        }
                    },
                    {
                        "type": "text",
                        "text": PROMPT
                    }
                ]
            }
        ],
        temperature=0,
        max_tokens=1200
    )

    return completion.choices[0].message.content


def call_qwen_weight(image: Image.Image):
    """Extract weight from weight slip image"""
    buf = BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    b64 = base64.b64encode(buf.getvalue()).decode()
    data_url = f"data:image/png;base64,{b64}"

    completion = client.chat.completions.create(
        model=MODEL_NAME,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": data_url
                        }
                    },
                    {
                        "type": "text",
                        "text": WEIGHT_PROMPT
                    }
                ]
            }
        ],
        temperature=0,
        max_tokens=200
    )

    return completion.choices[0].message.content


# ---------------- API ----------------
@app.post("/ocr")
async def extract_invoice(pdf: UploadFile = File(...)):
    try:
        pdf_bytes = await pdf.read()

        images = convert_from_bytes(pdf_bytes, dpi=300)

        if not images:
            raise Exception("PDF conversion failed")

        invoice_page = images[0]

        print("\nPDF converted to image")

        qwen_text = call_qwen(invoice_page)

        print("\n========== QWEN OUTPUT ==========\n")
        print(qwen_text)
        print("\n===============================\n")

        return {
            "success": True,
            "invoice_json": qwen_text
        }

    except Exception:
        print("\n========== ERROR ==========\n")
        traceback.print_exc()
        print("\n=========================\n")
        raise HTTPException(status_code=500, detail="Qwen OCR failed")

@app.post("/extract-weight")
async def extract_weight(pdf: UploadFile = File(...)):
    try:
        pdf_bytes = await pdf.read()

        images = convert_from_bytes(pdf_bytes, dpi=300)

        if not images:
            raise Exception("PDF conversion failed")

        weight_slip_page = images[0]

        print("\nWeight slip PDF converted to image")

        qwen_text = call_qwen_weight(weight_slip_page)

        print("\n========== QWEN WEIGHT OUTPUT ==========\n")
        print(qwen_text)
        print("\n========================================\n")

        # Parse the JSON response
        try:
            json_match = re.search(r'\{[\s\S]*\}', qwen_text)
            if json_match:
                weight_data = json.loads(json_match.group(0))
                weight_value = weight_data.get("weight")
                
                # Convert to float if it's a string
                if weight_value:
                    if isinstance(weight_value, str):
                        # Remove any non-numeric characters except decimal point
                        weight_value = float(''.join(c for c in weight_value if c.isdigit() or c == '.'))
                    else:
                        weight_value = float(weight_value)
                else:
                    weight_value = None
            else:
                weight_value = None
        except Exception as e:
            print(f"Error parsing weight: {e}")
            weight_value = None

        return {
            "success": True,
            "weight": weight_value
        }

    except Exception:
        print("\n========== ERROR ==========\n")
        traceback.print_exc()
        print("\n=========================\n")
        raise HTTPException(status_code=500, detail="Weight extraction failed")

@app.get("/health")
def health():
    return {"status": "ok"}

# ---------------- RUN ----------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
