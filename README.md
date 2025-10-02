<div align="center">

# Layer1 Backend (Resume ⇄ Job AI Matching API)

Semantic skill & requirement extraction, asynchronous parsing, and weighted AI matching delivered through a real‑time capable Node.js API.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express.js-API-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Redis](https://img.shields.io/badge/Redis-Queue-dd2222?logo=redis&logoColor=white)](https://redis.io/)
[![BullMQ](https://img.shields.io/badge/BullMQ-Jobs-ee0000)](https://docs.bullmq.io/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-010101?logo=socketdotio&logoColor=white)](https://socket.io/)
[![Python](https://img.shields.io/badge/Python-Worker-3776AB?logo=python&logoColor=white)](../python-worker)
[![FastAPI](https://img.shields.io/badge/FastAPI-NLP%20Microservice-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![spaCy](https://img.shields.io/badge/spaCy-NLP-09A3D5)](https://spacy.io/)
[![SentenceTransformers](https://img.shields.io/badge/SBERT-Embeddings-1B1F23)](https://www.sbert.net/)
[![O*NET](https://img.shields.io/badge/O*NET-Skills%20Inference-005A9C)](https://www.onetcenter.org/)
[![Auth0](https://img.shields.io/badge/Auth0-Auth-F46A35?logo=auth0&logoColor=white)](https://auth0.com/)
[![Cloudflare R2](https://img.shields.io/badge/Cloudflare-R2%20Storage-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/r2/)
[![SQL Server](https://img.shields.io/badge/SQL%20Server/Azure%20SQL-Database-CC2927?logo=microsoftsqlserver&logoColor=white)](https://learn.microsoft.com/azure/azure-sql/)

</div>

## Overview

This service accepts resume & job inputs, offloads parsing + enrichment to a Python FastAPI worker, stores structured results, and computes a weighted semantic match. Progress & completion events stream to clients via Socket.IO rooms (`user:<sub>`).

Core responsibilities:

- Upload & asynchronous parsing (files or raw text)
- Skill & requirement extraction (dictionary + O\*NET + optional Gemini / LLM augmentation in worker)
- Embedding generation (SBERT) + match scoring with optional inferred requirement weighting
- Usage quota (free vs pro) & auth integration
- Realtime job / resume / match status notifications

See `../layer1_backend_and_ai_design.md` for deep design rationale.

## Architecture Snapshot

```
Client
  │ REST /api/v1 (Express)
  │ WebSocket (Socket.IO)
  ▼
Domain Events ──> Realtime Bridge ──> Socket.IO Rooms
  │
  │ enqueue
  ▼
BullMQ (Redis) ──> Workers (Node) ──HTTP─> Python FastAPI (Parsing, O*NET, SBERT)
  │
  ├─ SQL Server / Azure SQL (metadata, parsed data, matches)
  └─ Cloudflare R2 (binary objects)
```

## Tech / Libraries / Services

| Category    | Stack                                          |
| ----------- | ---------------------------------------------- |
| Runtime     | Node.js 18+, Python 3.11 (worker)              |
| API         | Express.js, Socket.IO                          |
| Auth        | Auth0 JWT (dev bypass flag)                    |
| Queue       | BullMQ + Redis                                 |
| Storage     | Cloudflare R2 (S3 compatible)                  |
| Database    | SQL Server / Azure SQL via `mssql` driver      |
| NLP         | spaCy, pdfminer.six, python-docx               |
| Embeddings  | sentence-transformers (SBERT) w/ hash fallback |
| Inference   | O\*NET Web Services (skill importance)         |
| Optional AI | Gemini (technology extraction), LLM (future)   |
| Realtime    | Socket.IO + domain event bus                   |

## Clone & Run (Docker Compose)

```bash
git clone <repo-url>
cd interview-practice/layer1/backend

# 1. Backend env
cp .env.example .env   # edit values (Auth0, SQL, R2)

# 2. Python worker env
cd ../python-worker && cp .env.example .env || echo "(worker env: create manually)" && cd ../backend

# 3. Build + start services (backend, python_worker, redis, caddy)
docker compose up -d --build

# 4. (Optional) local node workflow outside container
npm install

# 5. Initialise DB schema (runs bootstrap SQL)
npm run db:init

# 6. Tail backend logs
docker compose logs -f backend
```

Backend available at: http://localhost:4000

### Adding Local SQL Server (if not using Azure SQL)

Add a service to `docker-compose.yml` (or separate compose override):

```yaml
sqlserver:
  image: mcr.microsoft.com/mssql/server:2022-latest
  environment:
    ACCEPT_EULA: "Y"
    SA_PASSWORD: "Your_password123"
  ports:
    - "1433:1433"
```

Then set in `backend/.env`:

```
AZURE_SQL_SERVER=localhost
AZURE_SQL_DATABASE=layer1
AZURE_SQL_USER=sa
AZURE_SQL_PASSWORD=Your_password123
AZURE_SQL_ENCRYPT=false
AZURE_SQL_TRUST_SERVER_CERT=true
```

Run `npm run db:init` after the container is healthy.

### Minimal Local Dev Without Docker

1. Start Redis locally (`redis-server`).
2. Ensure SQL Server/Azure SQL reachable & env vars set.
3. Start Python worker: `uvicorn app:app --port 8000 --reload` (in `../python-worker`).
4. Start backend: `npm install && npm run dev`.

## Selected Environment Variables

| Name                                                                              | Purpose                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| AUTH_DISABLED                                                                     | Disable Auth0 verification for local dev                   |
| AUTH0_DOMAIN / AUTH0_AUDIENCE / AUTH0_ISSUER_BASE_URL                             | Auth0 JWT validation config                                |
| REDIS_URL                                                                         | Redis connection for BullMQ + pub/sub                      |
| PYTHON_SERVICE_URL                                                                | Base URL for Python FastAPI worker                         |
| R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_ENDPOINT | Cloudflare R2 uploads                                      |
| AZURE*SQL*\*                                                                      | SQL Server / Azure SQL connectivity & encryption           |
| SQL_CONNECT_TIMEOUT_MS / SQL_REQUEST_TIMEOUT_MS                                   | Connection + query timeouts                                |
| USE_INFERRED_REQUIREMENTS                                                         | Include inferred (O\*NET) requirements in scoring (capped) |

## API Summary (All under `/api/v1`)

| Method | Path         | Purpose                                 |
| ------ | ------------ | --------------------------------------- |
| POST   | /resumes     | Upload resume (multipart) → queue parse |
| GET    | /resumes     | List resumes                            |
| GET    | /resumes/:id | Parsed resume / status                  |
| POST   | /jobs        | Create job (JSON or file) → queue parse |
| GET    | /jobs        | List jobs                               |
| GET    | /jobs/:id    | Parsed requirements                     |
| POST   | /matches     | Queue match job                         |
| GET    | /matches     | List matches / jobs                     |
| GET    | /matches/:id | Match status or completed summary       |

## Authentication

- Dev: set `AUTH_DISABLED=true` to bypass verification.
- Prod: supply `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `AUTH0_ISSUER_BASE_URL`.

---

## Original Detailed Sections (Preserved)

The following content is the original README (kept verbatim for context and in-place links):

---

# Original: Layer1 Backend

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

---

_Augmented 2025-10-02: Added architecture, badges, compose workflow. Original content retained above._
