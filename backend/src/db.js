import pkg from 'pg'

const { Pool } = pkg

// Prefer DATABASE_URL; otherwise fall back to discrete PG* env vars
const baseConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    }

// RDS and most cloud Postgres require SSL. Enable when PGSSL=true or when host looks like RDS.
const needSsl = process.env.PGSSL?.toLowerCase() === 'true' ||
  (process.env.PGHOST && process.env.PGHOST.includes('rds.amazonaws.com'))
const sslOption = needSsl ? { rejectUnauthorized: false } : false

const pool = new Pool({
  ...baseConfig,
  ssl: sslOption,
  max: process.env.PGPOOL_MAX ? Number(process.env.PGPOOL_MAX) : 10,
  idleTimeoutMillis: process.env.PG_IDLE ? Number(process.env.PG_IDLE) : 30000,
})

export { pool }
