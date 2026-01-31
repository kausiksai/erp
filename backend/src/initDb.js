import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Schema and data are run manually in your DB client.
// 1. Run backend/src/schema.sql to create tables and indexes.
// 2. Run backend/src/data.sql to load seed and test data.
console.log('Run schema.sql and data.sql manually in your DB client.')
console.log('  schema:', path.join(__dirname, 'schema.sql'))
console.log('  data:  ', path.join(__dirname, 'data.sql'))
process.exit(0)
