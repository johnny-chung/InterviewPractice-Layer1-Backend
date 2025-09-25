// Centralised runtime configuration shared across API, workers, and queues.
/**
 * Loads environment variables (via dotenv) and exports a typed configuration object.
 * Fields:
 *  - port {number}: HTTP server listen port (default 4000)
 *  - authDisabled {boolean}: When true, auth middleware injects a dev user instead of validating JWTs.
 *  - auth0 {object}: Domain/audience/issuer settings for Auth0 JWT validation.
 *  - db {object}: Azure SQL connection settings; 'encrypt' & 'trustServerCertificate' control TLS behavior.
 *  - redisUrl {string}: Connection string consumed by BullMQ / ioredis.
 *  - pythonServiceUrl {string}: Base URL for the Python parsing + match microservice.
 *  - r2 {object}: Cloudflare R2 (S3-compatible) credentials & bucket info used by object-storage util.
 */
const dotenv = require("dotenv");

dotenv.config();

const config = {
  port: parseInt(process.env.PORT || "4000", 10),
  authDisabled: (process.env.AUTH_DISABLED || "false").toLowerCase() === "true",
  auth0: {
    domain: process.env.AUTH0_DOMAIN,
    audience: process.env.AUTH0_AUDIENCE,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
  },
  db: {
    server: process.env.AZURE_SQL_SERVER,
    database: process.env.AZURE_SQL_DATABASE,
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    encrypt: (process.env.AZURE_SQL_ENCRYPT || "true").toLowerCase() === "true",
    trustServerCertificate:
      (process.env.AZURE_SQL_TRUST_SERVER_CERT || "false").toLowerCase() ===
      "true",
  },
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  pythonServiceUrl: process.env.PYTHON_SERVICE_URL || "http://localhost:8000",
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    endpoint:
      process.env.R2_ENDPOINT ||
      (process.env.R2_ACCOUNT_ID
        ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : undefined),
  },
};

module.exports = config;
