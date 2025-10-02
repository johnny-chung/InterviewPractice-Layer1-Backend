# Layer1 Backend

What's included

- Node.js/Express API with optional Auth0 middleware
- SQL Server (Azure SQL compatible) via `mssql` with bootstrap SQL (`db/schema.sql`)
- Redis + BullMQ background jobs wired to the AI worker
- Python FastAPI microservice in `../python-worker` for parsing and matching
- Docker Compose for SQL Server, Redis, and the Python service

Quick start (see root README for detailed env setup)

1. Ensure `backend/.env` exists (copy from `.env.example`) and `python-worker/.env` contains any worker secrets (e.g., O\*NET credentials).
2. Populate Cloudflare R2 vars (see Object storage section) or leave empty if not using uploads.
3. Start infra: `docker compose up -d sqlserver redis python_service`
4. Install Node dependencies: `npm install`
5. Initialise the database: `npm run db:init`
6. Start the API: `npm run dev`

API surface (all under `/api/v1`)

- `POST /resumes` (multipart `file`) - queues resume parsing
- `GET /resumes` - list current user's resumes
- `GET /resumes/:id` - parsed resume data + extracted skills
- `POST /jobs` (JSON `{ title, text }` or multipart `file`) - queues job parsing
- `GET /jobs` / `GET /jobs/:id` - parsed requirements
- `POST /matches` JSON `{ resumeId, jobId }` - queues matching job, returns job id
- `GET /matches` / `GET /matches/:id` - job status and completed match summary

Auth

- Set `AUTH_DISABLED=true` for local dev (bypasses Auth0).
- For Auth0, populate `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_ISSUER_BASE_URL`.

## Object storage (Cloudflare R2)

File uploads (resumes + job description files) are stored in Cloudflare R2 instead of local disk.

Required environment variables:

- R2_ACCOUNT_ID (your Cloudflare account ID)
- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY
- R2_BUCKET (e.g. interview-files)
  Optional:
- R2_ENDPOINT (defaults to `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` if omitted)

Upload flow:

- Multer uses memory storage (no temp files on disk).
- Controller validates size/MIME, writes object directly to R2 with key pattern:
  - resumes/<uuid>.<ext>
  - jobs/<uuid>.<ext>
- Background workers fetch object bytes from R2 when parsing.

Local disk paths & fs.rename were removed; `storage_path` in DB now stores the object key.

If you need to purge old local data from pre-migration runs, you can safely delete `backend/storage` directories after ensuring no legacy records reference them.

Next steps

- Harden upload validation and add malware scanning.
- Add RBAC / quota limits per plan.
- Expand automated tests (unit + integration) per the design doc.
- Replace bootstrap SQL with real migrations.

## Database connectivity & reliability (SQL Server)

This service connects to SQL Server using the `mssql` driver. For Azure SQL or the local `sqlserver` container, ensure the following env vars are set in `backend/.env` (copy from `.env.example`).

Required:

- AZURE_SQL_SERVER (e.g. `your-sql-server.database.windows.net` or `localhost` when using Docker)
- AZURE_SQL_DATABASE (e.g. `layer1`)
- AZURE_SQL_USER
- AZURE_SQL_PASSWORD
- AZURE_SQL_ENCRYPT (Azure SQL requires `true`)
- AZURE_SQL_TRUST_SERVER_CERT (use `false` for Azure; can be `true` locally with self-signed certs)

Optional (reliability/timeouts):

- SQL_CONNECT_TIMEOUT_MS (default 30000) — time to establish a connection before failing
- SQL_REQUEST_TIMEOUT_MS (default 60000) — per-statement timeout
- SQL_POOL_MAX (default 10) — maximum connections in the pool
- SQL_RETRY_ATTEMPTS (default 5) — transient connect retries on ETIMEOUT/ESOCKET/etc.
- SQL_RETRY_BACKOFF_MS (default 3000) — base backoff between retries (linear: base \* attempt)
- DB_VERBOSE (unset) — set to `1` for additional connection logs

If you see intermittent `ETIMEOUT` on startup, raise `SQL_CONNECT_TIMEOUT_MS` and enable transient retries via `SQL_RETRY_ATTEMPTS`/`SQL_RETRY_BACKOFF_MS`. Also verify your current public IP is allowed in Azure SQL Server firewall rules.

## Usage Limits (Free vs Pro)

The backend enforces a rolling 365-day quota for match requests for free users.

On each `POST /matches`:

1. For non-Pro users, if `annual_usage_count >= annual_limit` the API returns HTTP 402 with `error: upgrade_required`.
2. Otherwise the system checks `annual_period_start`:

- If NULL or more than 365 days old, it resets the window: sets `annual_period_start = now`, `annual_usage_count = 1`.
- Else it increments `annual_usage_count` by 1.

User table fields:

| Column              | Purpose                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| annual_limit        | Max allowed free match requests per rolling 365-day window (default 100)     |
| annual_usage_count  | Current count within the active rolling window                               |
| annual_period_start | UTC timestamp marking the start of the current 365-day usage tracking window |

Admin Reset Script:

Run `node scripts/reset-usage.js <auth0_sub_or_user_id>` to zero the count and set a fresh `annual_period_start` timestamp.

Pro Detection (Temporary):

Currently the backend checks an `x-pro-member: 1` header as a placeholder. Frontend relies on Auth0 `app_metadata.proMember`. Implement Stripe webhooks to update a persisted subscription status (e.g., add `plan_tier` column) and replace this header mechanism.

Error Contract Example:

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{"error":"upgrade_required","message":"Annual free match limit reached. Upgrade to Pro for unlimited matches."}
```

Future Work:

- Conditional UPDATE to avoid rare race increments when two requests arrive simultaneously.
- Persist Stripe subscription state & renewal dates.
- Add per-plan limits for other resources (resume uploads, job descriptions) if needed.
