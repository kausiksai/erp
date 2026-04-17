/**
 * End-to-end Landing AI OCR accuracy test.
 *
 * Usage:
 *   node src/scripts/testInvoiceExtraction.js path/to/invoice.pdf
 *   node src/scripts/testInvoiceExtraction.js path/to/invoice.pdf --expect=precision_wires
 *   node src/scripts/testInvoiceExtraction.js path/to/invoice.pdf --expect=king_cotton
 *   node src/scripts/testInvoiceExtraction.js path/to/invoice.pdf --expect=bhandari_metal
 *
 * What it does:
 *   1. Calls extractInvoiceWithLandingAI()
 *   2. Prints timing for Parse + Extract
 *   3. If --expect is given, compares every field against ground truth
 *      and prints a field-by-field PASS/FAIL + an overall accuracy %
 *
 * The ground-truth records below are derived by hand from the invoice PDFs
 * the user attached to the chat (Precision Wires, King Cotton, Bhandari).
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { extractInvoiceWithLandingAI } from '../landingAI.js'

// ============================================================================
//   Ground truth — derived by hand from the 3 sample invoices
// ============================================================================

const GROUND_TRUTH = {
  precision_wires: {
    label: 'Precision Wires India Ltd (printed e-invoice)',
    invoiceNumber: 'TN/GS/2526/03893',
    invoiceDate: '2025-12-13',
    supplierName: 'PRECISION WIRES INDIA LIMITED',
    supplierGstin: '33AAACP7551L1Z5',
    supplierPan: 'AAACP7551L',
    billTo: 'SRIMUKHA PRECISION TECHNOLOGIES PVT LTD',
    buyerGstin: '33ABNCS1862K1ZZ',
    poNumber: 'PO2251311',
    subtotal: 95753.00,
    cgst: 8617.77,
    sgst: 8617.77,
    igst: 0.00,
    totalAmount: 112988.54,
    items: [
      {
        itemName: 'Polyester Imide Gr-1',
        hsnSac: '85441110',
        quantity: 80.375,
        uom: 'kg',
        unitPrice: 1191.33,
        taxableValue: 95753.00,
        cgstRate: 9,
        cgstAmount: 8617.77,
        sgstRate: 9,
        sgstAmount: 8617.77,
        lineTotal: 112988.54
      }
    ]
  },
  king_cotton: {
    label: 'King Cotton Waste Co (HANDWRITTEN on pre-printed form)',
    invoiceNumber: '1537',
    invoiceDate: '2025-11-08',
    supplierName: 'KING COTTON WASTE CO.',
    supplierGstin: '33AOOPM6924R1Z3',
    supplierPan: 'AOOPM6924R',
    billTo: 'SRIMUKHA PRECISION TECHNOLOGIES PVT LTD',
    buyerGstin: '33ABNCS1862K1ZZ',
    poNumber: 'SS2/SS225.0583',
    subtotal: 7400.00,
    cgst: 185.00,
    sgst: 185.00,
    igst: 0.00,
    totalAmount: 7770.00,
    items: [
      {
        itemName: 'Colour Bannian Housery Cloth',
        hsnSac: '5202',
        quantity: 200,
        uom: 'kgs',
        unitPrice: 37.00,
        taxableValue: 7400.00,
        cgstRate: 2.5,
        cgstAmount: 185.00,
        sgstRate: 2.5,
        sgstAmount: 185.00,
        lineTotal: 7770.00
      }
    ]
  },
  bhandari_metal: {
    label: 'Bhandari Metal Enterprises (printed e-invoice, 2 lines incl. freight)',
    invoiceNumber: 'BME/25-26/246',
    invoiceDate: '2025-08-11',
    supplierName: 'Bhandari Metal Enterprises',
    supplierGstin: '33AALPP7410Q1Z7',
    supplierPan: 'AALPP7410Q',
    billTo: 'SRIMUKHA PRECISION TECHNOLOGIES PRIVATE LIMITED',
    buyerGstin: '33ABNCS1862K1ZZ',
    poNumber: 'PO9250648/2025-26',
    subtotal: 57361.00,
    cgst: 5162.49,
    sgst: 5162.49,
    igst: 0.00,
    totalAmount: 67686.00,
    items: [
      {
        itemName: 'Pipe',
        hsnSac: '73064000',
        quantity: 240.700,
        uom: 'Kgs',
        unitPrice: 230.00,
        taxableValue: 55361.00,
        cgstRate: 9,
        cgstAmount: null, // not individually shown per line
        sgstRate: 9,
        sgstAmount: null,
        lineTotal: 55361.00
      },
      {
        itemName: 'Delivery Charges',
        hsnSac: '996813',
        quantity: null,
        uom: null,
        unitPrice: null,
        taxableValue: 2000.00,
        cgstRate: null,
        cgstAmount: null,
        sgstRate: null,
        sgstAmount: null,
        lineTotal: 2000.00
      }
    ]
  }
}

// ============================================================================
//   Field comparison
// ============================================================================

const NUMERIC_TOLERANCE_RS = 1
const NUMERIC_TOLERANCE_PCT = 0.01

function compareField(label, actual, expected) {
  if (expected == null) return { label, status: 'skip' }
  if (actual == null || actual === '') {
    return { label, status: 'miss', expected, actual }
  }
  // Numeric comparison with tolerance
  if (typeof expected === 'number') {
    const diff = Math.abs(Number(actual) - expected)
    const within =
      diff <= NUMERIC_TOLERANCE_RS || diff <= Math.abs(expected) * NUMERIC_TOLERANCE_PCT
    return {
      label,
      status: within ? 'pass' : 'fail',
      expected,
      actual,
      diff: within ? null : diff
    }
  }
  // String comparison — case-insensitive, trimmed, ignore multiple whitespace
  const normalize = (s) => String(s).trim().replace(/\s+/g, ' ').toUpperCase()
  const a = normalize(actual)
  const e = normalize(expected)
  const exact = a === e
  // Soft match — extracted contains expected OR vice versa (handles extra suffixes like "— U2")
  const soft = !exact && (a.includes(e) || e.includes(a))
  return {
    label,
    status: exact ? 'pass' : soft ? 'soft' : 'fail',
    expected,
    actual
  }
}

function compareItem(idx, actualItem, expectedItem) {
  const results = []
  const push = (field) => {
    results.push(compareField(`items[${idx}].${field}`, actualItem?.[field], expectedItem[field]))
  }
  for (const field of [
    'itemName', 'hsnSac', 'quantity', 'uom', 'unitPrice', 'taxableValue',
    'cgstRate', 'cgstAmount', 'sgstRate', 'sgstAmount', 'lineTotal'
  ]) push(field)
  return results
}

function compareInvoice(actual, expected) {
  const results = []
  for (const field of [
    'invoiceNumber', 'invoiceDate', 'supplierName', 'supplierGstin', 'supplierPan',
    'billTo', 'buyerGstin', 'poNumber',
    'subtotal', 'cgst', 'sgst', 'igst', 'totalAmount'
  ]) {
    results.push(compareField(field, actual?.[field], expected[field]))
  }

  const actualItems = Array.isArray(actual?.items) ? actual.items : []
  const expectedItems = Array.isArray(expected.items) ? expected.items : []

  results.push({
    label: '_lineItemCount',
    status: actualItems.length === expectedItems.length ? 'pass' : 'fail',
    expected: expectedItems.length,
    actual: actualItems.length
  })

  for (let i = 0; i < Math.max(actualItems.length, expectedItems.length); i++) {
    if (!expectedItems[i]) continue
    const lineResults = compareItem(i, actualItems[i], expectedItems[i])
    results.push(...lineResults)
  }

  return results
}

// ============================================================================
//   Printing
// ============================================================================

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
}

function statusLabel(s) {
  switch (s) {
    case 'pass': return `${C.green}PASS${C.reset}`
    case 'soft': return `${C.cyan}SOFT${C.reset}`
    case 'miss': return `${C.yellow}MISS${C.reset}`
    case 'fail': return `${C.red}FAIL${C.reset}`
    case 'skip': return `${C.gray}SKIP${C.reset}`
    default: return s
  }
}

function printReport(fileName, expectKey, extraction, results) {
  console.log('')
  console.log(`${C.bold}${C.cyan}━━━ Extraction Report ━━━${C.reset}`)
  console.log(`${C.gray}File:${C.reset}   ${fileName}`)
  if (expectKey) console.log(`${C.gray}Expect:${C.reset} ${GROUND_TRUTH[expectKey].label}`)
  console.log('')

  console.log(`${C.bold}Extracted (raw):${C.reset}`)
  console.log(JSON.stringify(extraction.invoiceData, null, 2))
  console.log('')

  if (extraction.warnings?.length) {
    console.log(`${C.yellow}Landing AI warnings:${C.reset} ${JSON.stringify(extraction.warnings)}`)
  }
  if (extraction.schemaViolation) {
    console.log(`${C.yellow}Schema violation:${C.reset} ${extraction.schemaViolation}`)
  }
  if (extraction.qualityIssues?.length) {
    console.log(`${C.yellow}Quality issues:${C.reset}`)
    for (const q of extraction.qualityIssues) console.log(`  - ${q}`)
  }

  if (!results) return

  console.log('')
  console.log(`${C.bold}Field-by-field accuracy:${C.reset}`)
  for (const r of results) {
    const val = r.status === 'skip'
      ? ''
      : ` ${C.gray}expected:${C.reset} ${JSON.stringify(r.expected)} ${C.gray}got:${C.reset} ${JSON.stringify(r.actual)}`
    console.log(`  ${statusLabel(r.status)}  ${r.label.padEnd(32)} ${val}`)
  }

  const scored = results.filter((r) => r.status !== 'skip')
  const pass = scored.filter((r) => r.status === 'pass').length
  const soft = scored.filter((r) => r.status === 'soft').length
  const fail = scored.filter((r) => r.status === 'fail').length
  const miss = scored.filter((r) => r.status === 'miss').length
  const total = scored.length
  const accuracy = total > 0 ? ((pass + soft * 0.75) / total) * 100 : 0

  console.log('')
  console.log(`${C.bold}Summary:${C.reset}`)
  console.log(`  PASS:  ${pass}/${total}`)
  console.log(`  SOFT:  ${soft}/${total}  ${C.gray}(partial match, counts 0.75)${C.reset}`)
  console.log(`  MISS:  ${miss}/${total}  ${C.gray}(expected but not returned)${C.reset}`)
  console.log(`  FAIL:  ${fail}/${total}  ${C.gray}(returned wrong value)${C.reset}`)
  console.log('')
  const color = accuracy >= 95 ? C.green : accuracy >= 80 ? C.yellow : C.red
  console.log(`  ${C.bold}Accuracy: ${color}${accuracy.toFixed(1)}%${C.reset}`)
  console.log('')
}

// ============================================================================
//   Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: node src/scripts/testInvoiceExtraction.js <invoice.pdf> [--expect=precision_wires|king_cotton|bhandari_metal]')
    console.error('')
    console.error('Available ground truths:')
    for (const [k, v] of Object.entries(GROUND_TRUTH)) console.error(`  ${k.padEnd(20)} — ${v.label}`)
    process.exit(1)
  }

  const filePath = args[0]
  const expectArg = args.find((a) => a.startsWith('--expect='))
  const expectKey = expectArg ? expectArg.slice('--expect='.length) : null

  if (expectKey && !GROUND_TRUTH[expectKey]) {
    console.error(`Unknown ground truth "${expectKey}". Available: ${Object.keys(GROUND_TRUTH).join(', ')}`)
    process.exit(1)
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const buffer = fs.readFileSync(filePath)
  const mime = filePath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'
  const fileName = path.basename(filePath)

  console.log(`${C.dim}Uploading ${fileName} (${(buffer.length / 1024).toFixed(1)} KB) to Landing AI ADE...${C.reset}`)
  const t0 = Date.now()
  const result = await extractInvoiceWithLandingAI(buffer, mime, fileName)
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
  console.log(`${C.dim}Completed in ${elapsed}s (${result.rawParse?.metadata?.duration_ms || '?'}ms Parse + ${result.rawExtract?.metadata?.duration_ms || '?'}ms Extract)${C.reset}`)

  const results = expectKey ? compareInvoice(result.invoiceData, GROUND_TRUTH[expectKey]) : null
  printReport(fileName, expectKey, result, results)
}

main().catch((err) => {
  console.error(`${C.red}Test failed:${C.reset}`, err.message)
  process.exit(1)
})
