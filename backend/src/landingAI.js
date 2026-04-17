/**
 * Landing AI Agentic Document Extraction (ADE) client.
 *
 * Pipeline optimised for MAXIMUM accuracy on Indian GST invoices:
 *
 *   1. POST /v1/ade/parse
 *      - `split=page` so multi-page uploads (invoice + GRN + packing slip)
 *        return per-page markdown we can filter
 *      - `custom_prompts` so figures/stamps/QR codes are described
 *        consistently instead of introducing noise
 *
 *   2. Smart page selection — keep only the page(s) that actually contain
 *      the tax invoice (scored by GSTIN + "TAX INVOICE" + Total Amount +
 *      HSN table presence). GRN/packing-slip pages are dropped so they
 *      don't confuse the Extract model.
 *
 *   3. POST /v1/ade/extract
 *      - Schema is our hand-crafted INVOICE_EXTRACTION_SCHEMA with
 *        Indian-specific format hints (GSTIN regex, DD/MM/YY dates, etc.)
 *      - `strict: false` so unrecognised fields are pruned rather than 422ed
 *      - `extract-latest` model for best accuracy
 *
 *   4. Post-extraction validation — cross-checks sums (line items vs total)
 *      to flag questionable extractions; surfaces Landing AI's own
 *      `warnings[]` and `schema_violation_error` so the caller can log them.
 *
 * Environment:
 *   LANDING_AI_API_KEY       (required) — Bearer token
 *   LANDING_AI_REGION        (optional) — "us" (default) | "eu"
 *   LANDING_AI_PARSE_MODEL   (optional) — default "dpt-2-latest"
 *   LANDING_AI_EXTRACT_MODEL (optional) — default "extract-latest"
 *   LANDING_AI_TIMEOUT_MS    (optional) — per-call timeout, default 90_000
 */

import { INVOICE_EXTRACTION_SCHEMA, mapLandingAIResponse, validateInvoiceExtraction } from './invoiceSchema.js'

const DEFAULT_TIMEOUT_MS = 90_000
const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [1_000, 4_000, 10_000]

function baseUrl() {
  const region = (process.env.LANDING_AI_REGION || 'us').toLowerCase()
  return region === 'eu'
    ? 'https://api.va.eu-west-1.landing.ai/v1/ade'
    : 'https://api.va.landing.ai/v1/ade'
}

/** Prompts for chunk-type-specific parsing. Figures tend to be stamps,
 *  logos, QR codes and signatures on Indian invoices — we want ADE to
 *  describe them briefly rather than invent long narratives the Extract
 *  model later gets confused by. */
const CUSTOM_PROMPTS = {
  figure:
    "Briefly describe the figure in one line. If it's a logo, stamp, signature, QR code, barcode or seal, just say so. Do not describe colour, decorative elements or background."
}

/**
 * Extract structured invoice data from a PDF or image buffer.
 *
 * @param {Buffer} buffer      - raw file bytes
 * @param {string} mimetype    - 'application/pdf' | 'image/jpeg' | 'image/png'
 * @param {string} [filename]  - for the multipart filename field
 */
export async function extractInvoiceWithLandingAI(buffer, mimetype, filename = 'invoice.pdf') {
  const apiKey = process.env.LANDING_AI_API_KEY
  if (!apiKey) {
    throw new Error('LANDING_AI_API_KEY is not configured')
  }
  const timeoutMs = parseInt(process.env.LANDING_AI_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS

  /* ---------- Step 1: Parse ---------- */
  const rawParse = await callParse({ buffer, mimetype, filename, apiKey, timeoutMs })

  // Pick only the invoice pages — never send GRN / packing-slip markdown to
  // Extract, those are confusing and often contain competing "invoice #"-
  // looking references.
  const markdown = selectInvoiceMarkdown(rawParse)
  if (!markdown || markdown.trim().length === 0) {
    throw new Error('Landing AI Parse returned no invoice content')
  }

  /* ---------- Step 2: Extract ---------- */
  const rawExtract = await callExtract({ markdown, apiKey, timeoutMs })

  const invoiceData = mapLandingAIResponse({ extraction: rawExtract?.extraction })

  /* ---------- Step 3: Post-extraction validation ---------- */
  const qualityIssues = validateInvoiceExtraction(invoiceData)

  return {
    invoiceData,
    rawParse,
    rawExtract,
    model: 'landing-ai-ade',
    extracted: hasUsefulExtraction(invoiceData),
    warnings: rawExtract?.metadata?.warnings || [],
    schemaViolation: rawExtract?.metadata?.schema_violation_error || null,
    qualityIssues
  }
}

// ============================================================================
//   Step 1: /v1/ade/parse — with split=page and custom prompts
// ============================================================================

async function callParse({ buffer, mimetype, filename, apiKey, timeoutMs }) {
  const url = `${baseUrl()}/parse`
  const model = process.env.LANDING_AI_PARSE_MODEL || 'dpt-2-latest'

  return await withRetries(async () => {
    const form = new FormData()
    const blob = new Blob([buffer], { type: mimetype || 'application/octet-stream' })
    form.append('document', blob, filename)
    form.append('model', model)
    // page-level splits so we can pick the invoice page(s) out of a multi-
    // document upload (invoice + GRN + DC + packing slip).
    form.append('split', 'page')
    form.append('custom_prompts', JSON.stringify(CUSTOM_PROMPTS))

    return await fetchJson(url, apiKey, form, timeoutMs, 'parse')
  })
}

/**
 * Given a Parse response, return the markdown of the pages that actually
 * contain the tax invoice. Scored by Indian-invoice cues — we want this to
 * work even when the PDF has 5 pages (invoice on page 1, GRN on 2, packing
 * slip on 3, etc.).
 */
function selectInvoiceMarkdown(parseResponse) {
  const splits = Array.isArray(parseResponse?.splits) ? parseResponse.splits : []
  if (splits.length === 0) {
    // No split → fall back to whole markdown
    return parseResponse?.markdown || ''
  }
  if (splits.length === 1) {
    return splits[0].markdown || parseResponse?.markdown || ''
  }

  // Score each split; keep the top-scoring one PLUS any that also score
  // meaningfully (covers 2-page invoice continuations).
  const scored = splits.map((s) => ({
    split: s,
    score: scoreInvoicePage(s.markdown || '')
  }))
  scored.sort((a, b) => b.score - a.score)
  const topScore = scored[0].score

  // Keep all splits that are within 40% of the top score (usually just the
  // top one for standard invoices; allows 2-page invoices to keep both).
  const kept = scored.filter((s) => s.score > 0 && s.score >= topScore * 0.6)
  if (kept.length === 0) {
    // Nothing looked like an invoice — fall back to whole markdown so Extract
    // still has something to work with. User will edit in UI.
    return parseResponse?.markdown || ''
  }
  return kept.map((k) => k.split.markdown).filter(Boolean).join('\n\n---\n\n')
}

/** Heuristic score 0..100 for "does this page look like a tax invoice?" */
function scoreInvoicePage(md) {
  if (!md || md.length < 50) return 0
  let score = 0
  // Strong signal — the literal words "TAX INVOICE"
  if (/\btax\s*invoice\b/i.test(md)) score += 40
  // Supplier GSTIN pattern
  if (/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]{2}[A-Z\d]\b/.test(md)) score += 20
  // Invoice number label
  if (/\binvoice\s*(?:no\.?|number|#)\b/i.test(md)) score += 10
  // HSN / SAC header
  if (/\bhsn(?:\s*\/\s*sac|[ /]sac)?\b/i.test(md)) score += 10
  // Total amount labels
  if (/total\s*(?:invoice\s*)?(?:value|amount)/i.test(md)) score += 10
  // CGST/SGST/IGST
  if (/\b(?:c|s|i)gst\b/i.test(md)) score += 5
  // GRN page penalty — these look similar but aren't invoices
  if (/\bgoods\s*receipt\s*note\b/i.test(md)) score -= 50
  if (/\bdelivery\s*challan\b/i.test(md)) score -= 30
  if (/\bpacking\s*summary\b/i.test(md)) score -= 30
  if (/\basn\s*no\.?\b/i.test(md) && !/tax\s*invoice/i.test(md)) score -= 20
  return score
}

// ============================================================================
//   Step 2: /v1/ade/extract — with schema
// ============================================================================

async function callExtract({ markdown, apiKey, timeoutMs }) {
  const url = `${baseUrl()}/extract`
  const model = process.env.LANDING_AI_EXTRACT_MODEL || 'extract-latest'

  return await withRetries(async () => {
    const form = new FormData()
    const mdBlob = new Blob([markdown], { type: 'text/markdown' })
    form.append('markdown', mdBlob, 'invoice.md')
    form.append('schema', JSON.stringify(INVOICE_EXTRACTION_SCHEMA))
    form.append('model', model)
    // strict=false: prune unsupported fields instead of 422; we still log
    // `schema_violation_error` from the response for diagnostics.
    form.append('strict', 'false')
    return await fetchJson(url, apiKey, form, timeoutMs, 'extract')
  })
}

// ============================================================================
//   Shared HTTP helpers
// ============================================================================

async function fetchJson(url, apiKey, form, timeoutMs, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    })
    clearTimeout(timer)

    if (res.status === 429 || res.status >= 500) {
      const body = await res.text().catch(() => '')
      const err = new Error(
        `Landing AI ${label} returned ${res.status}${body ? `: ${body.slice(0, 400)}` : ''}`
      )
      err.retryable = true
      throw err
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Landing AI ${label} failed (HTTP ${res.status})${body ? `: ${body.slice(0, 400)}` : ''}`
      )
    }

    return await res.json()
  } catch (err) {
    clearTimeout(timer)
    if (err?.name === 'AbortError' || isTransient(err)) err.retryable = true
    throw err
  }
}

async function withRetries(op) {
  let lastError
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await op()
    } catch (err) {
      lastError = err
      if (!err?.retryable || attempt === MAX_RETRIES - 1) throw err
      await sleep(RETRY_DELAYS_MS[attempt] || 5_000)
    }
  }
  throw lastError || new Error('Landing AI call failed after retries')
}

function isTransient(err) {
  const code = err?.code || err?.cause?.code
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_SOCKET' || code === 'ENOTFOUND'
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function hasUsefulExtraction(invoice) {
  if (!invoice) return false
  return Boolean(
    invoice.invoiceNumber ||
      invoice.totalAmount ||
      invoice.supplierName ||
      (Array.isArray(invoice.items) && invoice.items.length > 0)
  )
}
