/**
 * Run all 3 sample invoices in one go and print a consolidated accuracy
 * table. Expects sample PDFs in ./test-samples/ with exact names:
 *   test-samples/precision_wires.pdf
 *   test-samples/king_cotton.pdf
 *   test-samples/bhandari_metal.pdf
 *
 * Usage:  node src/scripts/testInvoiceExtractionAll.js
 *
 * Customise the sample paths via env: TEST_SAMPLES_DIR=/some/path
 */

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const dir = process.env.TEST_SAMPLES_DIR || path.resolve('test-samples')
const cases = [
  { file: 'precision_wires.pdf', expect: 'precision_wires' },
  { file: 'king_cotton.pdf',     expect: 'king_cotton' },
  { file: 'bhandari_metal.pdf',  expect: 'bhandari_metal' }
]

console.log(`Looking for samples in: ${dir}`)
console.log('')

for (const c of cases) {
  const fp = path.join(dir, c.file)
  if (!fs.existsSync(fp)) {
    console.error(`✗ Missing: ${fp}`)
    continue
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Running ${c.expect}...`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  try {
    execSync(
      `node src/scripts/testInvoiceExtraction.js "${fp}" --expect=${c.expect}`,
      { stdio: 'inherit', cwd: path.resolve('.') }
    )
  } catch (err) {
    console.error(`Test failed for ${c.expect}:`, err.message)
  }
  console.log('')
}
