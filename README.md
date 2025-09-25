# Layer1 Backend

What's included

- Node.js/Express API with optional Auth0 middleware
- PostgreSQL via `pg` with bootstrap SQL (`db/schema.sql`)
- Redis + BullMQ background jobs wired to the AI worker
- Python FastAPI microservice in `../python-worker` for parsing and matching
- Docker Compose for Postgres, Redis, and the Python service

Quick start (see root README for detailed env setup)

1. Ensure `backend/.env` exists (copy from `.env.example`) and `python-worker/.env` contains any worker secrets (e.g., O\*NET credentials).
2. Populate Cloudflare R2 vars (see Object storage section) or leave empty if not using uploads.
3. Start infra: `docker compose up -d postgres redis python_service`
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
