/**
 * Invoice extraction schema + post-processor for Landing AI ADE.
 *
 * This file has two responsibilities:
 *   1. `INVOICE_EXTRACTION_SCHEMA` — the JSON schema we send to Landing AI
 *      so it knows exactly what fields to extract from any invoice (printed,
 *      handwritten, complex, simple).
 *   2. `mapLandingAIResponse(response)` — turns whatever Landing AI sends back
 *      (structured fields + markdown + chunks) into the canonical shape that
 *      the /invoices/upload endpoint already returns, so the frontend doesn't
 *      need to change.
 *
 * The schema is deliberately tuned for **Indian GST tax invoices** — the
 * field descriptions include format hints (GSTIN regex, Indian date formats,
 * HSN length rules) that meaningfully improve extraction accuracy on
 * messy/handwritten inputs.
 */

// ============================================================================
//   Landing AI extraction schema
// ============================================================================

/**
 * Schema shape expected by Landing AI ADE `/v1/tools/agentic-document-analysis`.
 * The `fields_schema` parameter takes a JSON Schema with descriptions; the
 * model uses descriptions as extraction hints, so we're liberal with them.
 */
// Note: every string field uses `type: ['string', 'null']` and every number
// field uses `type: ['number', 'null']`. This tells Landing AI that missing
// values are acceptable — otherwise every missing field triggers a
// schema-violation warning, which wastes log noise and can cause the
// extraction to fail when `strict: true`. `required` is intentionally NOT
// set; see the invoice upload flow for our own required-field enforcement.
export const INVOICE_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    invoice_number: {
      type: ['string', 'null'],
      description:
        'The unique invoice number / bill number printed on the document. Examples: "TN/GS/2526/03893", "BME/25-26/246", "1537". Usually labelled INVOICE, Invoice No., Bill No., or No. Do NOT confuse with IRN (a 64-char hash), ACK No., PO No., DC No., ASN No. or GRN No. — those are different documents referenced on the invoice. Preserve slashes, hyphens and dots exactly as printed.'
    },
    invoice_date: {
      type: ['string', 'null'],
      description:
        'The invoice issue date. Normalise to YYYY-MM-DD. Source formats vary wildly: "13-12-2025" (DD-MM-YYYY), "8/11/25" (DD/MM/YY), "11-Aug-25" (DD-MMM-YY), "11-August-2025". Usually labelled Date, Dated, Invoice Date. If only DD/MM/YY is given, assume 20YY.'
    },
    supplier_name: {
      type: ['string', 'null'],
      description:
        'The name of the supplier / vendor / seller issuing the invoice (NOT the buyer/customer). Usually printed large at the top of the document. Example: "PRECISION WIRES INDIA LIMITED", "KING COTTON WASTE CO.", "Bhandari Metal Enterprises".'
    },
    supplier_gstin: {
      type: ['string', 'null'],
      description:
        'The supplier\'s 15-character GSTIN. Format: 2 digits + 5 uppercase letters + 4 digits + 1 uppercase letter + 1 digit + 2 uppercase letters. Example: "33AAACP7551L1Z5". Labelled GSTIN, GST No., GSTIN/UIN.'
    },
    supplier_pan: {
      type: ['string', 'null'],
      description:
        'The supplier\'s 10-character PAN. Format: 5 uppercase letters + 4 digits + 1 uppercase letter. Example: "AAACP7551L".'
    },
    supplier_address: {
      type: ['string', 'null'],
      description:
        'Full postal address of the supplier, including street, city, pincode. Concatenate multi-line addresses with commas.'
    },
    bill_to: {
      type: ['string', 'null'],
      description:
        'The name of the buyer (Bill To / Customer / Consignee). Example: "SRIMUKHA PRECISION TECHNOLOGIES PVT LTD". This is different from the supplier.'
    },
    buyer_gstin: {
      type: ['string', 'null'],
      description:
        'The buyer\'s 15-character GSTIN if shown. Same format as supplier_gstin.'
    },
    po_number: {
      type: ['string', 'null'],
      description:
        'The Purchase Order number referenced on the invoice. Labelled PO No., Purchase Order No., Buyer\'s Order No., Ref. Your Order No. Example: "PO2251311", "PO9250648/2025-26", "SS2/SS225.0583".'
    },
    subtotal: {
      type: ['number', 'null'],
      description:
        'Sum of line-item taxable values BEFORE tax. Also called Assessable Value, Taxable Value, Sub Total. Numeric only, ignore currency symbols.'
    },
    cgst: {
      type: ['number', 'null'],
      description:
        'Total CGST amount (Central GST) across all lines. Numeric only.'
    },
    sgst: {
      type: ['number', 'null'],
      description:
        'Total SGST amount (State GST) across all lines. Numeric only.'
    },
    igst: {
      type: ['number', 'null'],
      description:
        'Total IGST amount (Integrated GST, used for inter-state transactions). Numeric only. 0 if not shown.'
    },
    tax_amount: {
      type: ['number', 'null'],
      description:
        'Total tax amount = CGST + SGST + IGST. Numeric only.'
    },
    round_off: {
      type: ['number', 'null'],
      description:
        'Round-off adjustment (can be positive or negative, usually between -1 and 1). 0 if not shown.'
    },
    total_amount: {
      type: ['number', 'null'],
      description:
        'Grand total / Total Invoice Value / Net Amount payable. The final figure the buyer owes. Numeric only.'
    },
    total_amount_in_words: {
      type: ['string', 'null'],
      description:
        'The grand total written in English words. Example: "Rupees One Lakh Twelve Thousand Nine Hundred Eighty Eight and Paise Fifty Four Only".'
    },
    place_of_supply: {
      type: ['string', 'null'],
      description:
        'Place of supply — usually a state name + GST state code. Example: "Tamil Nadu (33)".'
    },
    currency: {
      type: ['string', 'null'],
      description:
        'ISO currency code. Almost always "INR" for Indian invoices. Default to INR if not specified.'
    },
    terms_and_conditions: {
      type: ['string', 'null'],
      description:
        'Terms of payment and/or delivery terms. Example: "30 Days", "EX-GODOWN", "Net 30".'
    },
    line_items: {
      type: 'array',
      description:
        'The table of line items / goods / services sold. Every row in the main goods table is a line item, INCLUDING freight / delivery charges / handling if they appear as separate rows with their own amount. Extract every row, never merge rows. If a row looks handwritten, extract it anyway.',
      items: {
        type: 'object',
        properties: {
          item_name: {
            type: ['string', 'null'],
            description:
              'Product or service description. If the row has multiple lines (e.g. "Pipe 73064000" then "304 Gr 11/2\\" 10G - 15 Nos"), use the primary description. Example: "Polyester Imide Gr-1", "Colour Bannian Housery Cloth", "Pipe", "Delivery Charges".'
          },
          hsn_code: {
            type: ['string', 'null'],
            description:
              'HSN / SAC code — a 4/6/8-digit numeric code classifying the goods/service. Examples: "85441110", "5202", "73064000", "996813" (service code). Labelled HSN, HSN/SAC, H.S.N.'
          },
          quantity: {
            type: ['number', 'null'],
            description:
              'The billed quantity. Look at the Qty / Quantity column. Numeric only — extract "200" from "200 kgs", "240.700" from "240.700 Kgs", "80.375" from "80.375 kg".'
          },
          uom: {
            type: ['string', 'null'],
            description:
              'Unit of measure — kg, Kgs, Nos, pcs, mtr, litres, etc. Often in the same cell as quantity.'
          },
          rate: {
            type: ['number', 'null'],
            description:
              'Unit rate / unit price. Labelled Rate, Sale Price, Rate/kg, per Kgs. Numeric only.'
          },
          rate_per: {
            type: ['string', 'null'],
            description:
              'The unit for the rate (usually matches uom). Example: "Kgs", "Nos", "kg".'
          },
          taxable_value: {
            type: ['number', 'null'],
            description:
              'Taxable value for this single line = quantity × rate (before tax). Labelled Amount, Taxable Value, Value. Numeric only.'
          },
          cgst_rate: {
            type: ['number', 'null'],
            description: 'CGST percentage for this line (e.g. 9, 2.5, 6). Numeric only, no % symbol.'
          },
          cgst_amount: {
            type: ['number', 'null'],
            description: 'CGST amount in rupees for this line. Numeric only.'
          },
          sgst_rate: {
            type: ['number', 'null'],
            description: 'SGST percentage for this line. Numeric only, no % symbol.'
          },
          sgst_amount: {
            type: ['number', 'null'],
            description: 'SGST amount in rupees for this line. Numeric only.'
          },
          igst_rate: {
            type: ['number', 'null'],
            description: 'IGST percentage for this line. 0 for intra-state invoices.'
          },
          igst_amount: {
            type: ['number', 'null'],
            description: 'IGST amount in rupees for this line. 0 for intra-state invoices.'
          },
          total_tax_amount: {
            type: ['number', 'null'],
            description: 'Total tax for this line = cgst_amount + sgst_amount + igst_amount.'
          },
          line_total: {
            type: ['number', 'null'],
            description:
              'Final amount for this line including tax = taxable_value + total_tax_amount. If the invoice only shows a single consolidated total per row, use that.'
          }
        },
        required: ['item_name']
      }
    }
  }
}

// ============================================================================
//   Post-processing / field normalisation
// ============================================================================

const GSTIN_REGEX = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{2}[A-Z\d]\b/
const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/

const MONTHS = {
  jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
  apr: '04', april: '04', may: '05', jun: '06', june: '06',
  jul: '07', july: '07', aug: '08', august: '08', sep: '09', sept: '09', september: '09',
  oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12'
}

/**
 * Best-effort date normaliser. Accepts:
 *   YYYY-MM-DD  → returns as-is
 *   DD-MM-YYYY / DD/MM/YYYY  → swaps to ISO
 *   DD-MM-YY / DD/MM/YY  → assumes 20YY
 *   DD-Mon-YY / DD-Mon-YYYY  → month name to number
 * Returns null when unparsable.
 */
export function normalizeDate(value) {
  if (value == null || value === '') return null
  const s = String(value).trim()
  if (!s) return null

  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)

  // DD-Mon-YY[YY]
  const m1 = s.match(/^(\d{1,2})[-/ ]([A-Za-z]+)[-/ ](\d{2,4})$/)
  if (m1) {
    const d = m1[1].padStart(2, '0')
    const mon = MONTHS[m1[2].toLowerCase()]
    if (!mon) return null
    const y = m1[3].length === 2 ? `20${m1[3]}` : m1[3]
    return `${y}-${mon}-${d}`
  }

  // DD-MM-YY[YY] / DD/MM/YY[YY]
  const m2 = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m2) {
    const d = m2[1].padStart(2, '0')
    const m = m2[2].padStart(2, '0')
    const y = m2[3].length === 2 ? `20${m2[3]}` : m2[3]
    return `${y}-${m}-${d}`
  }

  // Fallback — let JS Date try
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/**
 * Parse a number from strings like "₹ 1,12,988.54", "95,753.00", "37/-",
 * "8617.77 Rs.". Returns null on failure.
 */
export function parseNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const cleaned = String(value)
    .replace(/[₹$€£,]/g, '')
    .replace(/rs\.?/gi, '')
    .replace(/\/-?$/, '')
    .replace(/[^\d.\-]/g, '')
    .trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Uppercase + strip non-alphanumeric for ID-like fields (GSTIN, PAN). */
export function normalizeId(value) {
  if (value == null) return null
  const s = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s || null
}

// ============================================================================
//   Response mapper — Landing AI → canonical invoice shape
// ============================================================================

/**
 * Take whatever Landing AI returned and shape it into the canonical invoice
 * object that /invoices/upload has always returned.
 *
 * Landing AI's response envelope (v1/tools/agentic-document-analysis):
 *   { data: { markdown, chunks, extracted_schema?, extraction? }, errors }
 *
 * `extracted_schema` / `extraction` is present when we passed a fields schema
 * on the request; otherwise we have to fall back to markdown parsing.
 */
export function mapLandingAIResponse(landingResponse) {
  const data = landingResponse?.data ?? landingResponse ?? {}
  const extracted =
    data.extracted_schema ||
    data.extraction ||
    data.fields ||
    data.extracted_fields ||
    null

  // If structured extraction worked, use it directly
  if (extracted && typeof extracted === 'object') {
    return shapeFromStructured(extracted)
  }

  // Fallback — parse the markdown ourselves
  if (typeof data.markdown === 'string' && data.markdown.length > 0) {
    return shapeFromMarkdown(data.markdown)
  }

  // No usable data — return an empty canonical shape so the UI renders a
  // blank form the user can fill manually
  return emptyInvoice()
}

function emptyInvoice() {
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

function shapeFromStructured(s) {
  const line = (it) => ({
    itemName: s_get(it, 'item_name', 'itemName', 'description'),
    hsnSac: s_get(it, 'hsn_code', 'hsnSac', 'hsn', 'hsn_sac'),
    quantity: parseNumber(s_get(it, 'quantity', 'qty')),
    uom: s_get(it, 'uom', 'unit'),
    unitPrice: parseNumber(s_get(it, 'rate', 'unit_price', 'unitPrice')),
    ratePer: s_get(it, 'rate_per', 'ratePer'),
    taxableValue: parseNumber(s_get(it, 'taxable_value', 'taxableValue', 'amount')),
    cgstRate: parseNumber(s_get(it, 'cgst_rate', 'cgstRate')),
    cgstAmount: parseNumber(s_get(it, 'cgst_amount', 'cgstAmount')),
    sgstRate: parseNumber(s_get(it, 'sgst_rate', 'sgstRate')),
    sgstAmount: parseNumber(s_get(it, 'sgst_amount', 'sgstAmount')),
    igstRate: parseNumber(s_get(it, 'igst_rate', 'igstRate')),
    igstAmount: parseNumber(s_get(it, 'igst_amount', 'igstAmount')),
    totalTaxAmount: parseNumber(s_get(it, 'total_tax_amount', 'totalTaxAmount')),
    lineTotal: parseNumber(s_get(it, 'line_total', 'lineTotal', 'total'))
  })

  const items = Array.isArray(s.line_items || s.lineItems || s.items)
    ? (s.line_items || s.lineItems || s.items).map(line)
    : []

  return {
    invoiceNumber: s_get(s, 'invoice_number', 'invoiceNumber') || '',
    invoiceDate: normalizeDate(s_get(s, 'invoice_date', 'invoiceDate')),
    poNumber: s_get(s, 'po_number', 'poNumber') || '',
    supplierName: s_get(s, 'supplier_name', 'supplierName') || '',
    supplierGstin: normalizeId(s_get(s, 'supplier_gstin', 'supplierGstin', 'gstin')) || '',
    supplierPan: normalizeId(s_get(s, 'supplier_pan', 'supplierPan', 'pan')) || '',
    supplierAddress: s_get(s, 'supplier_address', 'supplierAddress') || '',
    billTo: s_get(s, 'bill_to', 'billTo') || '',
    buyerGstin: normalizeId(s_get(s, 'buyer_gstin', 'buyerGstin')) || '',
    subtotal: parseNumber(s_get(s, 'subtotal', 'taxable_value', 'assessable_value')),
    cgst: parseNumber(s_get(s, 'cgst', 'cgst_amount')),
    sgst: parseNumber(s_get(s, 'sgst', 'sgst_amount')),
    igst: parseNumber(s_get(s, 'igst', 'igst_amount')),
    taxAmount: parseNumber(s_get(s, 'tax_amount', 'taxAmount', 'total_tax')),
    roundOff: parseNumber(s_get(s, 'round_off', 'roundOff')),
    totalAmount: parseNumber(s_get(s, 'total_amount', 'totalAmount', 'grand_total')),
    totalAmountInWords: s_get(s, 'total_amount_in_words', 'totalAmountInWords') || '',
    placeOfSupply: s_get(s, 'place_of_supply', 'placeOfSupply') || '',
    currency: s_get(s, 'currency') || 'INR',
    termsAndConditions: s_get(s, 'terms_and_conditions', 'termsAndConditions', 'terms') || '',
    items
  }
}

function s_get(obj, ...keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== '') {
      return obj[k]
    }
  }
  return undefined
}

// ============================================================================
//   Markdown fallback parser — used when structured extraction is unavailable
// ============================================================================

/**
 * Best-effort extraction from the parsed markdown Landing AI returns. This is
 * only used when the structured extraction path fails. It's intentionally
 * conservative — we'd rather return blank fields than wrong data.
 */
function shapeFromMarkdown(md) {
  const invoice = emptyInvoice()

  // GSTIN — first hit is supplier, second is buyer (when two appear)
  const gstins = [...md.matchAll(new RegExp(GSTIN_REGEX, 'g'))].map((m) => m[0])
  if (gstins[0]) invoice.supplierGstin = gstins[0]
  if (gstins[1]) invoice.buyerGstin = gstins[1]

  // PAN
  const pan = md.match(PAN_REGEX)
  if (pan) invoice.supplierPan = pan[0]

  // Invoice number
  const invMatch =
    md.match(/invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Z0-9\-/]+)/i) ||
    md.match(/bill\s*no\.?\s*[:\-]?\s*([A-Z0-9\-/]+)/i) ||
    md.match(/\bno\.?\s*[:\-]?\s*(\d{3,})/i)
  if (invMatch) invoice.invoiceNumber = invMatch[1].trim()

  // Invoice date
  const dateMatch =
    md.match(/(?:invoice\s*)?date(?:d)?\s*[:\-]?\s*(\d{1,2}[-/. ]\d{1,2}[-/. ]\d{2,4}|\d{1,2}[-/. ][A-Za-z]+[-/. ]\d{2,4})/i) ||
    md.match(/\b(\d{1,2}[-/. ][A-Za-z]{3,}[-/. ]\d{2,4})\b/)
  if (dateMatch) {
    invoice.invoiceDate = normalizeDate(dateMatch[1])
  }

  // PO number
  const poMatch =
    md.match(/(?:purchase\s*order|p\.?o\.?|buyer['']s\s*order)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9\-/.]+)/i)
  if (poMatch) invoice.poNumber = poMatch[1].trim()

  // Grand total — "Total Invoice Value", "Total Amount", "Grand Total"
  const totMatch =
    md.match(/total\s*invoice\s*(?:value|amount)[^\d]*([\d,]+\.?\d*)/i) ||
    md.match(/grand\s*total[^\d]*([\d,]+\.?\d*)/i) ||
    md.match(/total\s*amount[^\d]*([\d,]+\.?\d*)/i)
  if (totMatch) invoice.totalAmount = parseNumber(totMatch[1])

  // CGST / SGST / IGST amounts
  const cgstMatch = md.match(/cgst[^0-9\-]*([\d,.]+)/i)
  if (cgstMatch) invoice.cgst = parseNumber(cgstMatch[1])
  const sgstMatch = md.match(/sgst[^0-9\-]*([\d,.]+)/i)
  if (sgstMatch) invoice.sgst = parseNumber(sgstMatch[1])
  const igstMatch = md.match(/igst[^0-9\-]*([\d,.]+)/i)
  if (igstMatch) invoice.igst = parseNumber(igstMatch[1])

  // Subtotal (Taxable / Assessable)
  const subMatch =
    md.match(/(?:taxable|assessable)\s*value[^\d]*([\d,.]+)/i) ||
    md.match(/sub\s*total[^\d]*([\d,.]+)/i)
  if (subMatch) invoice.subtotal = parseNumber(subMatch[1])

  // Line items — parse the first markdown table that looks like a line-item grid
  invoice.items = extractLineItemsFromMarkdown(md)

  return invoice
}

function extractLineItemsFromMarkdown(md) {
  const lines = md.split(/\r?\n/)
  const items = []

  // Find a markdown table with a header that includes qty/rate/amount
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    if (lines[i].includes('|') && /qty|quantity/.test(lower) && /rate|amount|value/.test(lower)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return items

  const headers = lines[headerIdx].split('|').map((c) => c.trim().toLowerCase()).filter(Boolean)
  const col = (name) => headers.findIndex((h) => h.includes(name))
  const idxQty = col('qty')
  const idxRate = col('rate')
  const idxAmt = [col('amount'), col('value'), col('total')].find((x) => x >= 0) ?? -1
  const idxDesc = [col('particular'), col('description'), col('item'), col('goods')].find((x) => x >= 0) ?? 0
  const idxHsn = col('hsn')

  // Skip header + separator row
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const row = lines[i]
    if (!row.includes('|')) break
    const cells = row.split('|').map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
    if (cells.length === 0 || cells.every((c) => !c)) continue
    const itemName = (cells[idxDesc] || '').trim()
    if (!itemName) continue
    items.push({
      itemName,
      hsnSac: idxHsn >= 0 ? (cells[idxHsn] || '') : '',
      quantity: idxQty >= 0 ? parseNumber(cells[idxQty]) : null,
      uom: null,
      unitPrice: idxRate >= 0 ? parseNumber(cells[idxRate]) : null,
      ratePer: null,
      taxableValue: null,
      cgstRate: null,
      cgstAmount: null,
      sgstRate: null,
      sgstAmount: null,
      igstRate: null,
      igstAmount: null,
      totalTaxAmount: null,
      lineTotal: idxAmt >= 0 ? parseNumber(cells[idxAmt]) : null
    })
  }
  return items
}

// ============================================================================
//   Post-extraction validation
// ============================================================================

/**
 * Cross-check the extracted invoice for internal consistency. Does NOT fail —
 * returns a list of warning strings the caller can surface in logs or in the
 * UI so a human can review questionable extractions before saving.
 *
 * Checks:
 *   - Σ(line_items.taxable_value)   ≈ subtotal    (within 1 rupee OR 1%)
 *   - Σ(line_items.line_total)      ≈ total_amount (within 1 rupee OR 1%)
 *   - cgst + sgst + igst            ≈ tax_amount   (within 1 rupee)
 *   - GSTIN format (15 chars, pattern)
 *   - PAN format (10 chars)
 *   - Invoice date is parseable and within sensible range (not 1970, not 2099)
 *   - At least 1 line item when total_amount > 0
 */
export function validateInvoiceExtraction(invoice) {
  const issues = []
  if (!invoice) return ['extraction returned no invoice data']

  // GSTIN format
  if (invoice.supplierGstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{2}[A-Z\d]$/.test(invoice.supplierGstin)) {
    issues.push(`supplier GSTIN "${invoice.supplierGstin}" does not match the 15-character pattern`)
  }
  if (invoice.buyerGstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{2}[A-Z\d]$/.test(invoice.buyerGstin)) {
    issues.push(`buyer GSTIN "${invoice.buyerGstin}" does not match the 15-character pattern`)
  }

  // PAN format
  if (invoice.supplierPan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(invoice.supplierPan)) {
    issues.push(`supplier PAN "${invoice.supplierPan}" does not match the 10-character pattern`)
  }

  // Invoice date sanity
  if (invoice.invoiceDate) {
    const y = parseInt(invoice.invoiceDate.slice(0, 4), 10)
    if (!Number.isFinite(y) || y < 2000 || y > 2099) {
      issues.push(`invoice date "${invoice.invoiceDate}" has an implausible year`)
    }
  }

  // Totals consistency
  const items = Array.isArray(invoice.items) ? invoice.items : []
  if (items.length === 0 && invoice.totalAmount && invoice.totalAmount > 0) {
    issues.push('total amount is non-zero but no line items were extracted')
  }

  const tolerance = (a, b, absTol = 1, pctTol = 0.01) => {
    const diff = Math.abs(a - b)
    return diff <= absTol || diff <= Math.abs(b) * pctTol
  }

  if (items.length > 0) {
    const sumTaxable = items.reduce((s, it) => s + (Number(it.taxableValue) || 0), 0)
    const sumLine = items.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0)

    if (invoice.subtotal && sumTaxable > 0 && !tolerance(sumTaxable, invoice.subtotal)) {
      issues.push(
        `subtotal ${invoice.subtotal} differs from Σ(line taxable) ${sumTaxable.toFixed(2)} by more than 1%`
      )
    }
    if (invoice.totalAmount && sumLine > 0 && !tolerance(sumLine, invoice.totalAmount)) {
      issues.push(
        `total amount ${invoice.totalAmount} differs from Σ(line total) ${sumLine.toFixed(2)} by more than 1%`
      )
    }
  }

  // Tax sum
  const cgst = Number(invoice.cgst) || 0
  const sgst = Number(invoice.sgst) || 0
  const igst = Number(invoice.igst) || 0
  const taxSum = cgst + sgst + igst
  if (invoice.taxAmount && taxSum > 0 && Math.abs(taxSum - invoice.taxAmount) > 1) {
    issues.push(
      `declared tax_amount ${invoice.taxAmount} differs from cgst+sgst+igst ${taxSum.toFixed(2)}`
    )
  }

  return issues
}
