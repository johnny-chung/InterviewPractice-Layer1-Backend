// Azure SQL connectivity helpers shared by Express handlers and workers.
/**
 * poolPromise
 *  A singleton promise resolving to an mssql ConnectionPool. Await this before issuing queries.
 *  Using a shared pool prevents exhausting connection limits.
 */
const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const config = require("./config");

const poolPromise = sql.connect({
  server: config.db.server,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  options: {
    encrypt: config.db.encrypt,
    trustServerCertificate: config.db.trustServerCertificate,
  },
});

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
