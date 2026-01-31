/**
 * One-off script to read headers and sample rows from PO, ASN, GRN, DC Excel files.
 * Run: node read-excel-headers.js
 */
import XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join } from 'path';

const downloads = 'c:\\Users\\kausi\\Downloads';
const files = [
  'PO_matched.xlsx',
  'DC_matched.xlsx',
  'GRN_matched.xlsx',
  'Pending ASN details-29-01-2026.xlsx'
];

for (const file of files) {
  const path = join(downloads, file);
  try {
    const buf = readFileSync(path);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const headers = data[0] || [];
    const sampleRows = data.slice(1, 4);
    console.log('\n===', file, '===');
    console.log('Headers:', JSON.stringify(headers));
    console.log('Sample rows:', JSON.stringify(sampleRows, null, 0));
  } catch (e) {
    console.error(file, e.message);
  }
}
