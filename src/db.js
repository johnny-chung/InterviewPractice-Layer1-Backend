// Azure SQL connectivity helpers shared by Express handlers and workers.
/**
 * Enhancements added:
 *  - Explicit pool + connection timeout & request timeout (env configurable)
 *  - Retry logic for initial pool acquisition to smooth transient Azure SQL hiccups
 *  - Deterministic named parameters transformation retained
 *  - Lazy shared pool promise export (same external contract)
 */
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const config = require("./config");

const CONNECT_TIMEOUT = parseInt(
  process.env.SQL_CONNECT_TIMEOUT_MS || "30000",
  10
); // ms
const REQUEST_TIMEOUT = parseInt(
  process.env.SQL_REQUEST_TIMEOUT_MS || "60000",
  10
); // ms
const POOL_MAX = parseInt(process.env.SQL_POOL_MAX || "10", 10);
const RETRY_ATTEMPTS = parseInt(process.env.SQL_RETRY_ATTEMPTS || "5", 10);
const RETRY_BACKOFF_MS = parseInt(
  process.env.SQL_RETRY_BACKOFF_MS || "3000",
  10
); // base backoff

const baseConfig = {
  server: config.db.server,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  connectionTimeout: CONNECT_TIMEOUT,
  requestTimeout: REQUEST_TIMEOUT,
  pool: {
    max: POOL_MAX,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  options: {
    encrypt: config.db.encrypt,
    trustServerCertificate: config.db.trustServerCertificate,
    enableArithAbort: true,
  },
};

async function createPoolWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const pool = await sql.connect(baseConfig);
      if (attempt > 1 && process.env.NODE_ENV !== "test") {
        // eslint-disable-next-line no-console
        console.warn(
          `[db] Connected after retry attempt ${attempt} in ${
            Date.now() - started
          }ms`
        );
      } else if (process.env.DB_VERBOSE === "1") {
        // eslint-disable-next-line no-console
        console.log(
          `[db] Connected in ${Date.now() - started}ms (attempt ${attempt})`
        );
      }
      return pool;
    } catch (err) {
      lastErr = err;
      const transient =
        err &&
        err.code &&
        ["ETIMEOUT", "ESOCKET", "ELOGIN", "ECONNRESET"].includes(err.code);
      if (!transient) break; // Non-transient: abort early.
      if (attempt === RETRY_ATTEMPTS) break;
      const delay = RETRY_BACKOFF_MS * attempt; // linear backoff (sufficient here)
      if (process.env.DB_VERBOSE === "1") {
        // eslint-disable-next-line no-console
        console.warn(
          `[db] Attempt ${attempt} failed (${
            err.code || err.message
          }); retrying in ${delay}ms`
        );
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Lazily created singleton promise; consumers await this before queries.
const poolPromise = createPoolWithRetry();

function transformQuery(text, paramCount) {
  /**
   * transformQuery
   * Purpose: Convert Postgres-style positional parameters ($1,$2,...) into
   * mssql named parameters (@p0,@p1,...). Ensures boundary correctness so $1 does not
   * partially replace $10 etc. Runs a deterministic loop up to paramCount.
   * @param {string} text Raw SQL containing $-style placeholders.
   * @param {number} paramCount Number of parameters provided (used to build regex per slot).
   * @returns {string} Transformed SQL string compatible with mssql driver.
   */
  let transformed = text;
  for (let i = 1; i <= paramCount; i += 1) {
    const regex = new RegExp(`\\$${i}(?=\\D|$)`, "g");
    transformed = transformed.replace(regex, `@p${i - 1}`);
  }
  return transformed;
}

async function query(text, params = []) {
  /**
   * query
   * Lightweight abstraction mimicking node-postgres signature returning { rows }.
   * @param {string} text SQL with $1..$n placeholders.
   * @param {any[]} params Positional parameter values.
   * @returns {Promise<{ rows: any[] }>} recordset wrapped for portability.
   */
  const pool = await poolPromise;
  const request = pool.request();
  params.forEach((value, index) => {
    request.input(`p${index}`, value);
  });
  const transformed = transformQuery(text, params.length);
  const result = await request.query(transformed);
  return { rows: result.recordset };
}

async function bootstrapDatabase() {
  /**
   * bootstrapDatabase
   * Loads and executes the schema.sql script using a single batch call. Idempotence is assumed
   * in the SQL (CREATE TABLE IF NOT EXISTS semantics or guarded operations). Use on cold start.
   */
  const sqlScript = fs.readFileSync(
    path.join(__dirname, "../db/schema.sql"),
    "utf8"
  );
  const pool = await poolPromise;
  await pool.request().batch(sqlScript);
}

module.exports = {
  query,
  bootstrapDatabase,
  poolPromise,
  sql,
};
