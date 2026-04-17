/**
 * Dev helper: use Landing AI's build-schema endpoint to see what fields
 * the model thinks it can extract from a sample invoice. Useful when we
 * get a weird new invoice format and want to check if our schema covers it.
 *
 * Usage:
 *   node src/scripts/landingaiBuildSchema.js path/to/sample_invoice.pdf
 *
 * Optional env: LANDING_AI_API_KEY, LANDING_AI_REGION, LANDING_AI_PARSE_MODEL.
 *
 * Output: prints the suggested JSON schema to stdout. Compare against
 * `INVOICE_EXTRACTION_SCHEMA` in invoiceSchema.js and merge improvements.
 */

import 'dotenv/config'
import fs from 'node:fs'

const API_KEY = process.env.LANDING_AI_API_KEY
if (!API_KEY) {
  console.error('LANDING_AI_API_KEY missing in environment')
  process.exit(1)
}

const REGION = (process.env.LANDING_AI_REGION || 'us').toLowerCase()
const BASE = REGION === 'eu'
  ? 'https://api.va.eu-west-1.landing.ai/v1/ade'
  : 'https://api.va.landing.ai/v1/ade'

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node src/scripts/landingaiBuildSchema.js <invoice.pdf>')
    process.exit(1)
  }
  const buffer = fs.readFileSync(file)
  const mime = file.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'

  // Step 1: Parse to get markdown
  console.error('[parse] sending to Landing AI...')
  const parseForm = new FormData()
  parseForm.append('document', new Blob([buffer], { type: mime }), file)
  parseForm.append('model', process.env.LANDING_AI_PARSE_MODEL || 'dpt-2-latest')
  const parseRes = await fetch(`${BASE}/parse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: parseForm
  })
  if (!parseRes.ok) {
    console.error('parse failed:', parseRes.status, await parseRes.text())
    process.exit(1)
  }
  const parsed = await parseRes.json()
  const markdown = parsed.markdown || ''
  console.error(`[parse] got ${markdown.length} chars of markdown`)

  // Step 2: Ask the model to generate a schema
  console.error('[build-schema] generating schema...')
  const buildForm = new FormData()
  buildForm.append('markdowns', new Blob([markdown], { type: 'text/markdown' }), 'invoice.md')
  buildForm.append(
    'prompt',
    'Generate a JSON schema to extract every field from this Indian GST tax invoice, ' +
      'including invoice number, invoice date, supplier details, GSTIN, PAN, buyer details, ' +
      'PO number, place of supply, and a table of line items with HSN code, quantity, rate, ' +
      'taxable value, CGST/SGST/IGST rates and amounts, and line total.'
  )
  buildForm.append('model', process.env.LANDING_AI_EXTRACT_MODEL || 'extract-latest')
  const buildRes = await fetch(`${BASE}/extract/build-schema`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: buildForm
  })
  if (!buildRes.ok) {
    console.error('build-schema failed:', buildRes.status, await buildRes.text())
    process.exit(1)
  }
  const built = await buildRes.json()
  // Pretty-print the generated schema so we can diff it against ours
  const schemaStr = built.extraction_schema || ''
  try {
    const obj = JSON.parse(schemaStr)
    console.log(JSON.stringify(obj, null, 2))
  } catch {
    console.log(schemaStr)
  }
}

main().catch((err) => {
  console.error('failed:', err)
  process.exit(1)
})
