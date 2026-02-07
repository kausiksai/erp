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
MODEL_NAME = "qwen-vl-max"

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
You are an expert invoice data extraction engine.

Your task is to read the provided invoice image or PDF and extract structured data into STRICT JSON format.

Follow these rules carefully:

-------------------------
GENERAL EXTRACTION RULES
-------------------------

1. Extract only factual data visible in the invoice.
2. If a field is missing, unclear, or not present, return an empty string "".
3. Do NOT hallucinate or guess missing values.
4. Preserve numbers exactly as written (no currency symbols).
5. Convert all numeric values to plain strings (no commas).
   Example: "1,23,456.00" → "123456.00"
6. Dates should be returned exactly as seen (do not reformat).
7. Ignore stamps, signatures, watermarks, and handwritten marks unless they contain key invoice data.
8. Extract all line items in the item table.
9. If multiple taxes are shown per item, map them correctly.
10. Return ONLY valid JSON. No explanations. No extra text.

-------------------------
FIELD EXTRACTION LOGIC
-------------------------

invoiceNumber:
- Look for labels like: Invoice No, Invoice Number, Bill No, Tax Invoice No

invoiceDate:
- Look for: Invoice Date, Date, Bill Date

poNumber:
- Look for: PO Number, Purchase Order, Buyer Order No

supplierName:
- Extract seller/company issuing the invoice

billTo:
- Extract buyer/customer company name

billToAddress:
- Full buyer address block

billToGst:
- Extract GSTIN / VAT / Tax ID of buyer

-------------------------
ITEM TABLE EXTRACTION
-------------------------

For each row in the item table extract:

itemName:
- Description of goods/services

quantity:
- Quantity or Qty column

unitPrice:
- Rate / Unit Price

amount:
- Line total amount

hsnSac:
- HSN/SAC/HS Code

taxableValue:
- Taxable amount per item (if present)

cgstPercent / cgstAmount:
sgstPercent / sgstAmount:

- Extract from item-level tax columns
- If taxes only appear in summary, leave item tax empty

-------------------------
TOTALS EXTRACTION
-------------------------

subtotal:
- Taxable total or subtotal

cgst:
sgst:
- Total CGST/SGST from summary

roundOff:
- Round off value

taxAmount:
- Total tax amount

totalAmount:
- Final invoice total

totalAmountInWords:
- Amount in words section

-------------------------
CRITICAL OUTPUT RULES
-------------------------

1. Output must be STRICT JSON
2. Use exactly this schema
3. No markdown
4. No comments
5. No extra keys
6. Always include all keys

-------------------------
OUTPUT JSON
-------------------------

{
"invoiceNumber":"",
"invoiceDate":"",
"poNumber":"",
"supplierName":"",
"billTo":"",
"billToAddress":"",
"billToGst":"",

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
"taxAmount":"",
"totalAmount":"",
"totalAmountInWords":""
}

Return ONLY this JSON.

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
