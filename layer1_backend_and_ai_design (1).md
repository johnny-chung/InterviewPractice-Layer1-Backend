# Self‑Interview AI – Layer 1: Backend & AI Design

This document provides a detailed technical design for **Layer 1** of the self‑interview AI. Layer 1 handles everything up to delivering a structured candidate–job match summary to downstream layers. It includes resume/job ingestion, requirement inference, skill profile extraction, similarity analysis, and a REST API to expose these capabilities. The document is intended for developers and architects. It should be used alongside the separate front‑end design document.

## Table of Contents

- [1. Scope](#1-scope)
- [2. Architecture Overview](#2-architecture-overview)
  - [2.1 Modular Monolithic Approach](#21-modular-monolithic-approach)
  - [2.2 Microservice Approach](#22-microservice-approach)
  - [2.3 Decision & Recommendation](#23-decision--recommendation)
- [3. Technology Stack](#3-technology-stack)
- [4. Data Model](#4-data-model)
  - [4.1 Tables](#41-tables)
  - [4.2 JSON structure for match summary](#42-json-structure-for-match-summary)
- [5. REST API Design](#5-rest-api-design)
- [6. AI Pipeline](#6-ai-pipeline)
- [7. Security & Permissions](#7-security--permissions)
- [8. Scalability & Performance Considerations](#8-scalability--performance-considerations)
- [9. Client decisions & clarifications](#9-client-decisions--clarifications)
- [10. Detailed implementation design](#10-detailed-implementation-design)
  - [10.1 Database schema extensions](#101-database-schema-extensions)
  - [10.2 Module structure and responsibilities](#102-module-structure-and-responsibilities)
    - [10.2.1 Controllers](#1021-controllers)
    - [10.2.2 Python worker modules](#1022-python-worker-modules)
    - [10.2.3 Common modules (Node)](#1023-common-modules-node)
  - [10.3 REST API handler specifications](#103-rest-api-handler-specifications)
  - [10.4 Processing workflow pseudocode](#104-processing-workflow-pseudocode)
- [11. Python worker: parsing & NLP details](#11-python-worker-parsing--nlp-details)
  - [11.1 PDF & DOCX extraction](#111-pdf--docx-extraction)
  - [11.2 Resume & job parsing details](#112-resume--job-parsing-details)
    - [11.2.1 Normalization and text preprocessing](#1121-normalization-and-text-preprocessing)
    - [11.2.2 Section identification using patterns](#1122-section-identification-using-patterns)
    - [11.2.3 Identifying sections & patterns](#1123-identifying-sections--patterns)
    - [11.2.4 Extracting skills & experience from resumes](#1124-extracting-skills--experience-from-resumes)
    - [11.2.5 O*NET integration & skills inference](#1125-onet-integration--skills-inference)
    - [11.2.6 Sentence‑BERT for embeddings](#1126-sentence‑bert-for-embeddings)
  - [11.3 Matching engine details](#113-matching-engine-details)
  - [11.4 LLM integration (optional)](#114-llm-integration-optional)
  - [11.5 High‑level pseudocode for core modules](#115-high‑level-pseudocode-for-core-modules)
    - [Additional helper functions and controllers (pseudocode)](#additional-helper-functions-and-controllers-pseudocode)
  - [11.6 Security and privacy considerations](#116-security-and-privacy-considerations)
  - [11.7 Extensibility](#117-extensibility)
  - [12. Testing & quality assurance](#12-testing--quality-assurance)
  - [12.1 Unit tests (Python worker)](#121-unit-tests-python-worker)
  - [12.2 Integration tests (Node API)](#122-integration-tests-node-api)
  - [12.3 Queue and concurrency tests](#123-queue-and-concurrency-tests)
  - [12.4 Database tests](#124-database-tests)
  - [12.5 Test data](#125-test-data)
- [13. Project structure, naming conventions & examples](#13-project-structure-naming-conventions--examples)
  - [13.1 Recommended directory layout](#131-recommended-directory-layout)
  - [13.2 Naming conventions & code style](#132-naming-conventions--code-style)
  - [13.3 Integration flow between modules](#133-integration-flow-between-modules)
  - [13.4 SBERT comparison example](#134-sbert-comparison-example)
  - [14. Deployment & environment configuration](#14-deployment--environment-configuration)
    - [14.1 Running the project with Docker & Compose](#141-running-the-project-with-docker--compose)
    - [14.2 Environment variables and credentials](#142-environment-variables-and-credentials)
    - [14.3 Running the project locally](#143-running-the-project-locally)
    - [14.4 Using Azure SQL Database](#144-using-azure-sql-database)

## 1. Scope

Layer 1’s responsibilities include:

1. **File ingestion and parsing.** Accept and parse resumes (PDF, DOCX) and job descriptions (text, PDF) into structured text.
2. **Normalization & pre‑processing.** Clean and normalize text (remove headers/footers, bullet characters, etc.).
3. **Skill & requirement extraction.** Use NLP and knowledge sources to extract skills, experiences, and other job requirements from the job description. Use the O*NET database to infer implicit requirements and assign importance scores.
4. **Candidate profiling.** Extract the candidate’s skills, experience years, degrees, certifications, and other relevant attributes from the resume.
5. **Matching & weakness analysis.** Compute similarity scores between candidate skills and job requirements, highlight strengths and weaknesses, and generate a structured summary.
6. **Expose the functionality via RESTful API** for consumption by the front end and other layers.

## 2. Architecture Overview

Layer 1 can be implemented either as a **modular monolithic service** or as a **set of microservices**. The choice affects deployment and scalability.

### 2.1 Modular Monolithic Approach

- A single backend application contains modules for parsing, NLP/AI processing, data persistence, and API endpoints.
- **Pros:** simpler development and deployment; easier local development; fewer network boundaries.
- **Cons:** scaling specific modules independently is harder; AI processing may block other requests if not carefully isolated.
- Suggested for early MVP; can be refactored into microservices later.

### 2.2 Microservice Approach

Separate services for distinct responsibilities:

- **API Gateway:** exposes unified REST/GraphQL API; handles authentication (Auth0 integration).
- **Resume Parsing Service:** written in Python; uses spaCy to parse resumes; returns structured JSON.
- **Job Analysis Service:** similar to resume parsing; extracts job requirements and infers missing ones using O*NET.
- **Matching Service:** computes embeddings (e.g., Sentence‑BERT) and similarity scores; returns candidate–job match report.
- **Database Service:** stores resumes, jobs, extracted data, and match results (PostgreSQL or MongoDB).
- **Message broker (optional):** RabbitMQ or Kafka for asynchronous processing (useful if parsing is expensive).

- **Pros:** each service can scale independently; AI services can be implemented in Python while the API gateway remains in Node.js; easier to replace/upgrade individual components.
- **Cons:** increased complexity in orchestration; network latency; more infrastructure (service discovery, monitoring).

### 2.3 Decision & Recommendation

For an initial product, we recommend a **modular monolithic backend** using **Node.js (Express)** with integrated **Python microservice** for heavy NLP tasks via a local HTTP bridge. This offers the simplicity of a monolith while isolating AI workload into a Python process. You can transition to full microservices when scaling demands increase.

## 3. Technology Stack

The following stack reflects the final choices made for Layer 1.  Alternatives from earlier drafts are noted but not used in this version.

- **Backend Framework – Express.js.**  We standardise on **Node.js with Express.js**.  Express is the most popular Node framework and integrates well with middleware and the broader Node ecosystem【628677264707409†L310-L329】.
- **AI Processing:** A dedicated Python microservice implements the NLP pipeline using:
  - **spaCy** for résumé and job parsing, part‑of‑speech tagging and named‑entity recognition【846342845091625†L88-L100】【846342845091625†L136-L159】.
  - **Sentence‑BERT (SBERT)** for generating dense embeddings.  SBERT modifies BERT with siamese/triplet networks to produce semantically meaningful sentence vectors【270124505968547†L19-L27】.  The Universal Sentence Encoder remains an alternative but is not part of the primary stack.
  - **Hugging Face transformers** for classification tasks, such as determining experience level.
  - **O*NET database** for inferring skills and requirements that are not explicitly mentioned in job postings【907131220775107†L63-L72】.
  - **OpenAI/Anthropic API (optional)** for summarisation or inference.  Calls to external LLMs are configurable and disabled by default to control cost.
- **Database – PostgreSQL.**  We use a relational **PostgreSQL** database for structured data.  MongoDB is no longer considered in the primary design.

- **Alternative: Azure SQL Database.**  Teams that prefer to host their data on the Microsoft cloud can use **Azure SQL Database** instead of a self‑hosted PostgreSQL instance.  Azure SQL Database is a fully managed PaaS offering.  Microsoft’s free tier provides up to 10 serverless databases with 100 000 vCore‑seconds of compute and 32 GB of data and backup storage per month【997155405869227†L297-L326】.  Because it exposes a standard SQL interface, your schema and queries remain unchanged.  To connect from Node, install the [`mssql`](https://www.npmjs.com/package/mssql) package (with the `tedious` driver) or an ORM that supports SQL Server, and set an `AZURE_SQL_CONNECTION_STRING` environment variable (e.g. `Server=tcp:<server>.database.windows.net,1433;Database=<db>;User ID=<user>;Password=<password>;Encrypt=true;`).  In Python, use the `pyodbc` or `mssql-django` package to connect.  See Section 14 for deployment details.
- **Authentication & Authorization – Auth0.**  Auth0 handles user registration, login, and plan‑based access control.  The backend validates JWTs on every request.
- **File Storage – local disk.**  For the MVP we store uploaded résumés and job descriptions on the application server’s file system.  File metadata (path, size) is stored in the database.  The design leaves room to swap in cloud object storage (S3/GCS/MinIO) later without changing business logic.
- **Queue – BullMQ on Redis.**  We implement an internal message queue using **BullMQ**, a Node.js library built on Redis that provides exactly‑once semantics and high throughput【603502897783475†L194-L209】.  RabbitMQ or AWS SQS are no longer part of the core plan.

## 4. Data Model

Below is a suggested relational schema (PostgreSQL). If MongoDB is used, translate the tables to collections:

### 4.1 Tables

- **users**
  - `id` (UUID, PK)
  - `auth0_id` (string, unique) – maps to Auth0 user id
  - `email` (string)
  - `subscription_plan` (enum: `free`, `pro`, etc.)
  - `created_at`, `updated_at` (timestamps)

- **resumes**
  - `id` (UUID, PK)
  - `user_id` (FK → users.id)
  - `file_url` (string)
  - `parsed_data` (JSONB) – structured output from the resume parser
  - `uploaded_at` (timestamp)

- **job_descriptions**
  - `id` (UUID, PK)
  - `user_id` (FK → users.id)
  - `title` (string)
  - `description_text` (TEXT)
  - `parsed_data` (JSONB) – structured requirements extracted
  - `created_at` (timestamp)

- **matches**
  - `id` (UUID, PK)
  - `resume_id` (FK → resumes.id)
  - `job_id` (FK → job_descriptions.id)
  - `match_score` (float)
  - `summary` (JSONB) – detailed match summary (strengths, weaknesses)
  - `created_at` (timestamp)

### 4.2 JSON structure for match summary

```json
{
  "candidate": {
    "name": "…", 
    "skills": ["Python", "SQL", …],
    "experience_years": 5,
    "degrees": ["BSc Computer Science"],
    "certifications": ["AWS Solutions Architect"],
    "summary": "Concise candidate summary"
  },
  "requirements": [
    {
      "skill": "Data Analysis",
      "importance": 0.9,
      "candidate_has_experience": true,
      "comments": "Candidate has 4 years working with pandas and NumPy"
    },
    {
      "skill": "Cloud Architecture",
      "importance": 0.75,
      "candidate_has_experience": false,
      "comments": "Missing hands‑on AWS or Azure experience"
    }
    // … more requirement entries
  ],
  "overall_match_score": 0.76,
  "strengths": ["Strong programming skills", "Analytical mindset"],
  "weaknesses": ["No devops experience", "Limited cloud exposure"]
}
```

## 5. REST API Design

All endpoints are prefixed with `/api/v1`. Authentication via Auth0 JWT is required for protected routes. Response bodies use JSON. Errors return standard HTTP codes with `{ error: "…" }` body.

| Endpoint | Method | Description | Request Body | Response |
| --- | --- | --- | --- | --- |
| `/auth/callback` | `GET` | Auth0 callback – handled by Auth0 SDK; no custom body | — | redirects to front end |
| `/resumes` | `POST` | Upload a resume file. | `multipart/form-data` with file | `{ id, status: "processing" }` |
| `/resumes/:id` | `GET` | Get parsed resume data. | — | `parsed_data` (JSON) and file metadata |
| `/jobs` | `POST` | Create a job description. | `{ title, description_text }` | `{ id, status: "processing" }` |
| `/jobs/:id` | `GET` | Retrieve parsed job requirements. | — | `parsed_data` (JSON) |
| `/matches` | `POST` | Compute match between a resume and job description. | `{ resume_id, job_id }` | `match_summary` (JSON) |
| `/matches/:id` | `GET` | Retrieve stored match result. | — | `match_summary` (JSON) |

Additional administrative endpoints (e.g., list user’s resumes or jobs) can be added. For asynchronous processing, the `status` field can be `processing`, `completed`, or `error`. The front end should poll until results are ready or subscribe to WebSockets for notifications.

## 6. AI Pipeline

1. **Upload/ingestion:** Resume and job files are uploaded and stored in a file system or S3 bucket. The backend records metadata.
2. **Parsing (Python microservice):** When a file is uploaded, the Node.js backend sends a request to the Python service (e.g., via REST). The service extracts plain text and returns structured data (experience sections, skills, education). Use [spaCy’s resume parser](https://spacy.io/) or a custom pipeline.
3. **Requirement extraction:** For job descriptions, identify explicit skills (e.g., through a dictionary of common technical terms) and use the O*NET database to infer additional skills and assign importance scores. Importance can be heuristically derived from frequency in similar job postings or O*NET’s importance ratings.
4. **Embedding & similarity:** Convert candidate skill list and job requirement list into sentence embeddings. Compute similarity using cosine similarity. Rank requirements by importance and candidate match.
5. **Weakness analysis:** Mark requirements where the candidate lacks direct experience. For each unmet requirement, store comments and optionally suggestions for improvement.
6. **Match summary generation:** Format the result as the JSON structure above and store it in the database.

## 7. Security & Permissions

- Integrate Auth0; verify JWTs in middleware. Only authenticated users can upload or view resumes, job descriptions, and matches tied to their user ID.
- Use RBAC (role‑based access control) to differentiate between free and pro users (e.g., limit number of matches for free users).
- Sanitize uploaded file names; restrict file types and sizes; scan for malware.
- Use HTTPS for all communication.

## 8. Scalability & Performance Considerations

* Use asynchronous job queues for parsing and AI processing to avoid blocking API responses. Provide status polling or WebSocket updates.
* Cache embeddings and match results to avoid recomputation for the same résumé/job combination.
* Use horizontal scaling for the Node.js server and separate scaling for the Python microservice.

<!--
Removed the Firebase/NoSQL considerations section per user request.  PostgreSQL remains the primary datastore for Layer 1, and NoSQL options like Cloud Firestore or Realtime Database are deferred for future exploration.
-->

## 9. Client decisions & clarifications

After reviewing the initial design proposals, we agreed on several key decisions that shape Layer 1:

1. **Architecture:** Start with a *monolithic Node.js/Express* backend, using a relational **PostgreSQL** database.  A separate Python service will handle NLP workloads but will be invoked via an internal HTTP endpoint or queue, keeping the API surface within a single Node application.
   Text extraction for PDFs will use **pdfminer.six**, and Word documents will be parsed with **python‑docx**; embeddings will be computed locally using **Sentence‑BERT**.
2. **Asynchronous processing:** Use a **BullMQ** queue backed by Redis to offload heavy NLP and matching tasks.  The queue stores background jobs (resume parsing, job parsing, embedding generation, match calculation) so that API responses remain fast.  It is internal to the backend and is *not* used to route client requests.  RabbitMQ and other brokers are no longer part of the primary design.
3. **LLM usage:** When local models (spaCy, Sentence‑BERT) fall short, the Python microservice can call OpenAI’s GPT API to summarise job descriptions, infer implicit requirements, or generate embeddings.  These calls are optional and toggled via environment variables to control cost and privacy.
4. **Authentication & plans:** Integrate **Auth0** for user management.  The backend will validate JWTs and enforce plan‑based limits (e.g., number of matches per month) using environment variables.

The following sections provide deeper technical details: database schema extensions, module structure, API handler signatures and a sample processing workflow.

## 10. Detailed implementation design

### 10.1 Database schema extensions

In addition to the tables defined earlier (users, resumes, job_descriptions, matches), Layer 1 needs tables to store extracted skills/requirements and to track background jobs.  Each table uses a UUID primary key and includes `created_at` and `updated_at` timestamps.

- **requirements** – requirements inferred or extracted from each job description:
  - `id` (UUID, PK)
  - `job_id` (FK → job_descriptions.id)
  - `skill` (text, not null)
  - `importance` (numeric, 0–1)
  - `inferred` (boolean) – whether the skill was inferred via O*NET or LLM
  - `created_at` timestamp

- **candidate_skills** – skills extracted from each resume:
  - `id` (UUID, PK)
  - `resume_id` (FK → resumes.id)
  - `skill` (text)
  - `experience_years` (integer, nullable)
  - `proficiency` (numeric, nullable) – optional rating if classification is available
  - `created_at`

- **match_jobs** – queue of pending match calculations:
  - `id` (UUID, PK)
  - `resume_id` (FK → resumes.id)
  - `job_id` (FK → job_descriptions.id)
  - `status` (`queued`, `running`, `completed`, `failed`)
  - `result_id` (FK → matches.id, nullable) – filled when the job is completed
  - `error_message` (text, nullable)
  - `created_at`, `updated_at`

Example SQL to create the `requirements` table:

```sql
CREATE TABLE requirements (
  id UUID PRIMARY KEY,
  job_id UUID REFERENCES job_descriptions(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  importance NUMERIC(3,2) NOT NULL,
  inferred BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
```

### 10.2 Module structure and responsibilities

Organise the backend into discrete modules with clear responsibilities.  Example TypeScript‑style signatures are shown for clarity.

#### 10.2.1 Controllers

**FileUploadController**

- `uploadResume(req: Request, res: Response): Promise<{ id: string, status: string }>`
    - Validates the uploaded resume (file size, MIME type).  
    - Stores the file in the configured storage (local disk or S3).  
    - Inserts a new row into the `resumes` table with status `uploaded`.  
    - Enqueues a `parseResume` job via `QueueModule`.  
    - Returns the new resume ID and status to the client.

- `uploadJob(req: Request, res: Response): Promise<{ id: string, status: string }>`
    - Validates the job description payload (either text or file).  
    - Inserts a new row into the `job_descriptions` table.  
    - Enqueues a `parseJob` job.  
    - Returns the job ID and initial status.

**MatchController**

- `requestMatch(req: Request, res: Response): Promise<{ id: string, status: string }>`
    - Validates that both resume and job belong to the current user and are ready.  
    - Inserts a row into `match_jobs` with status `queued`.  
    - Enqueues a `match` job in the queue.  
    - Returns the match job ID and status to the client.

- `getMatch(req: Request, res: Response): Promise<MatchSummary | { status: string }>`
    - Fetches the match job by ID.  
    - If status is `completed`, returns the `matches` record.  
    - Otherwise returns the current status (`queued` or `running`).

#### 10.2.2 Python worker modules

**ParserWorker**

- `parse_resume(resume_id: str) -> None`
    - Loads the resume file, extracts text using **spaCy** and domain patterns.  
    - Identifies sections (education, experience, skills) and populates `candidate_skills`.  
    - Updates the `resumes` record status to `ready` or `error`.

- `parse_job(job_id: str) -> None`
    - Extracts text from the job description.  
    - Uses heuristics and regex to identify explicit skills.  
    - Calls `infer_requirements` to augment the list with related skills from O*NET.  
    - Populates the `requirements` table and updates the `job_descriptions` status.

- `infer_requirements(text: str) -> List[Requirement]`
    - Uses the O*NET database to find related skills and typical importance values.  
    - Optionally calls `LLMService.infer_implicit_skills` to suggest missing skills.

**EmbeddingModule**

- `generate_embeddings(sentences: List[str]) -> List[Vector]`
    - Uses **Sentence‑BERT** via Hugging Face to compute dense vector representations.  
    - Falls back to OpenAI’s embeddings API when enabled in configuration.

**MatchEngine**

- `calculate_match(resume_id: str, job_id: str) -> MatchSummary`
    - Fetches extracted candidate skills and job requirements.  
    - Generates embeddings for skills and requirements lists.  
    - Computes pairwise cosine similarity weighted by requirement importance.  
    - Applies a configurable similarity threshold (default 0.5) to determine whether a requirement is matched.  
    - Identifies strengths and weaknesses and compiles a structured summary JSON containing per‑requirement scores.  
    - Inserts a row into `matches` and updates the `match_jobs` record.  The threshold and weighting parameters can be passed as optional arguments or read from configuration.

**LLMService** (optional)

- `summarize_job(text: str) -> str` – calls the OpenAI Chat Completion endpoint with a summarisation prompt.  
- `infer_implicit_skills(text: str) -> List[str]` – uses GPT to suggest additional skills common to the role.

#### 10.2.3 Common modules (Node)

**AuthMiddleware**

- `verifyJwt(req, res, next)` – middleware that verifies Auth0 JWTs and attaches the user object to `req` or returns 401.

**QueueModule**

- `enqueueJob(type: 'parseResume' | 'parseJob' | 'match', payload: any): string` – pushes a job to the message queue and returns a job ID.  
- `onJobCompleted(jobId: string, callback)` – optional callback to emit WebSocket notifications or update job status.

### 10.3 REST API handler specifications

Below are expanded descriptions of key endpoints with expected inputs and outputs.  All responses are JSON.

- **POST `/resumes`**
  - *Body:* `multipart/form‑data` containing a single file under field name `file`.
  - *Action:* Calls `uploadResume`.  The server stores the file, inserts a `resumes` record and enqueues a `parseResume` job.  
  - *Response:* HTTP 202 with `{ id: resumeId, status: 'queued' }`.  The client should poll `GET /resumes/{id}` until `status` is `ready` or `error`.

- **GET `/resumes/{id}`**
  - *Response when ready:* `{ id, status: 'ready', parsed_data: { sections }, skills: [ … ] }`.  
  - *Response when processing:* `{ id, status: 'queued' }` or `running`.  
  - *Errors:* 404 if not found; 403 if the resume does not belong to the user.

- **POST `/jobs`**
  - *Body:* JSON with `title` and `description_text` or `multipart/form‑data` with a file.  
  - *Action:* Calls `uploadJob`; inserts a job record and enqueues a `parseJob` job.
  - *Response:* `{ id: jobId, status: 'queued' }`.

- **GET `/jobs/{id}`**
  - *Response when ready:* `{ id, status: 'ready', requirements: [ { skill, importance, inferred } ] }`.  
  - *Response when processing:* `{ id, status }` as above.

- **POST `/matches`**
  - *Body:* JSON with `resume_id` and `job_id`.  
  - *Action:* Calls `requestMatch`; inserts a match job row and enqueues a `match` job.  
  - *Response:* `{ id: matchJobId, status: 'queued' }`.

- **GET `/matches/{id}`**
  - *Response when ready:* `{ id, status: 'completed', match_summary: { … } }` with the structured match summary (see section 4.2).  
  - *Response when not ready:* `{ id, status: 'queued' }` or `running`.  
  - *Errors:* 404 if not found; 403 if not owned by the user.

### 10.4 Processing workflow pseudocode

Below is a high‑level illustration of the match flow.  This omits error handling and database transactions but demonstrates the sequence.

```pseudo
function requestMatch(resumeId, jobId, userId):
    assert userOwns(resumeId, userId) and userOwns(jobId, userId)
    matchJobId = db.insert('match_jobs', { resumeId, jobId, status: 'queued' })
    enqueueJob('match', { matchJobId, resumeId, jobId })
    return { id: matchJobId, status: 'queued' }

// Worker side
function processMatchJob(matchJobId, resumeId, jobId):
    db.update('match_jobs', matchJobId, { status: 'running' })
    skills     = db.select('candidate_skills', where resume_id = resumeId)
    reqs       = db.select('requirements', where job_id = jobId)
    candEmbeds = generate_embeddings(skills.map(s => s.skill))
    reqEmbeds  = generate_embeddings(reqs.map(r => r.skill))
    result     = compute_similarity(candEmbeds, reqEmbeds, reqs.map(r => r.importance))
    summary    = buildMatchSummary(skills, reqs, result)
    matchId    = db.insert('matches', { resumeId, jobId, matchScore: result.score, summary })
    db.update('match_jobs', matchJobId, { status: 'completed', resultId: matchId })
```

The `compute_similarity` function calculates a weighted cosine similarity and returns an overall score along with comments for each requirement.  The `buildMatchSummary` function assembles the JSON output described in section 4.2, including strengths and weaknesses lists.

## 11. Detailed module algorithms and integration

The high–level design above outlines the components and their responsibilities.  This section dives deeper into how each module should be implemented, the libraries involved, and how they interact with the queue and database.  It also explains the underlying NLP techniques, including spaCy, Sentence‑BERT and O*NET, with concrete examples and guidance for developers.

### 11.1 Queue configuration and control

Layer 1 uses **BullMQ** running on Redis as the internal message queue.  BullMQ is a Node.js library that provides fast, robust job queues with exactly‑once semantics and high throughput【603502897783475†L194-L214】.  We recommend creating a separate module (`QueueModule`) to encapsulate queue setup and job management.

1. **Installation and setup**
   ```bash
   # Install BullMQ and Redis client
   npm install bullmq ioredis
   # Install Redis locally (or use a hosted Redis service)
   # For local development, you can run `redis-server` on default port 6379.
   ```
   Inside `QueueModule`, configure a single Redis connection and export a `Queue` object for each job type.  Example (TypeScript):
   ```ts
   import { Queue, QueueScheduler, Worker, Job } from 'bullmq';
   import { connection } from './redisConnection';

   export const parseResumeQueue = new Queue('parseResume', { connection });
   export const parseJobQueue    = new Queue('parseJob',    { connection });
   export const matchQueue       = new Queue('match',       { connection });

   // Optional: ensure stalled jobs are retried by running queue schedulers
   new QueueScheduler('parseResume', { connection });
   new QueueScheduler('parseJob',    { connection });
   new QueueScheduler('match',       { connection });
   ```

2. **Enqueuing jobs**
   Each controller should call the queue module instead of performing long‑running tasks synchronously.  For example, in `uploadResume`, call:
   ```ts
   const job = await parseResumeQueue.add('parseResume', { resumeId });
   ```
   Jobs can include additional options such as retries, backoff strategy and delays.  BullMQ supports priorities, delayed jobs and repeatable jobs【603502897783475†L224-L241】.

3. **Workers and concurrency**
   A worker listens for jobs and processes them.  For the Python parser, we use Node workers that spawn Python scripts or call the Python microservice.  Example for the match worker:
   ```ts
   import { Worker } from 'bullmq';
   import { processMatchJob } from './matchEngine';

   const matchWorker = new Worker('match', async (job: Job) => {
     await processMatchJob(job.data.matchJobId, job.data.resumeId, job.data.jobId);
   }, { connection, concurrency: 2 });
   ```
   You can adjust `concurrency` to control how many jobs run in parallel.  The worker should update the `match_jobs` table status to `running`, `completed` or `failed`.

4. **Queue control**
   BullMQ allows pausing and resuming queues, cleaning completed jobs, and handling events.  Expose functions in `QueueModule` to pause or drain queues, which can be invoked from an admin dashboard.  For example:
   ```ts
   export async function pauseQueue(queueName: string) {
     const q = getQueueByName(queueName);
     await q.pause();
   }
   export async function resumeQueue(queueName: string) {
     const q = getQueueByName(queueName);
     await q.resume();
   }
   ```
   Use BullMQ events (`completed`, `failed`) to send WebSocket notifications or update database status.

### 11.2 Python worker: parsing resumes and jobs

Heavy NLP processing occurs in a Python worker because Python has a richer NLP ecosystem.  The worker exposes endpoints (e.g., `/parse-resume`) or executes tasks when triggered by the queue.

#### 11.2.1 Installing and using spaCy

**spaCy** is an open‑source library for industrial‑strength natural language processing【846342845091625†L88-L100】.  It provides tokenization, part‑of‑speech tagging, dependency parsing, lemmatization, named entity recognition and rule‑based matching【846342845091625†L136-L159】.  To include spaCy in your Python project:

```bash
pip install spacy
python -m spacy download en_core_web_sm  # download the English model
```

Import spaCy and load the model:

```python
import spacy
nlp = spacy.load('en_core_web_sm')
```

#### 11.2.2 Text extraction

For résumé files, extract plain text before passing it to spaCy.  We standardise on **pdfminer.six** for PDF extraction because it provides detailed text and layout analysis【783169575006563†L226-L246】, and we use **python-docx** for Word documents.  Alternative libraries such as PyPDF2 or pdfplumber can still be substituted if future requirements change.  After extraction, convert the text into a spaCy `Doc` object.  Example:

```python
from pdfminer.high_level import extract_text
text = extract_text(resume_file_path)
doc  = nlp(text)
```

#### 11.2.3 Identifying sections and domain patterns

Resumes typically include sections such as **Summary/Objective**, **Work Experience**, **Education**, **Skills**, **Projects**, **Certifications** and **Contact information**.  To identify these sections, search for keywords using simple heuristics or spaCy’s rule‑based matcher.  The `Matcher` and `PhraseMatcher` let you specify patterns over tokens【723354687305467†L93-L104】.  For example:

```python
from spacy.matcher import Matcher
matcher = Matcher(nlp.vocab)

experience_patterns = [
    [{'LOWER': 'experience'}],
    [{'LOWER': 'work'}, {'LOWER': 'history'}],
    [{'LOWER': 'professional'}, {'LOWER': 'experience'}]
]
matcher.add('EXPERIENCE_SECTION', experience_patterns)

matches = matcher(doc)
sections = {}
for match_id, start, end in matches:
    section_name = nlp.vocab.strings[match_id]
    sections[section_name] = doc[start:].text  # capture text until next section heading heuristically
```

You can extend the patterns dictionary for other sections (`EDUCATION`, `SKILLS`, `PROJECTS`, etc.) and use headings preceded by line breaks or uppercase formatting as hints.  Another approach is to split the document on heading keywords and store offsets.

##### Common résumé sections and patterns

The following table lists common résumé sections and example pattern keywords you can include in the matcher.  All patterns should be defined in lowercase and matched using spaCy’s token attributes such as `LOWER`【723354687305467†L93-L104】.  You can expand or adjust the list based on your domain.

| Section             | Example keywords/patterns |
|---------------------|---------------------------|
| **Summary / Objective** | `objective`, `professional summary`, `profile`, `about me`, `overview` |
| **Work Experience** | `experience`, `work experience`, `professional experience`, `employment history`, `career history`, `work history` |
| **Education**       | `education`, `educational background`, `academic background`, `academic history`, `academics` |
| **Skills**          | `skills`, `technical skills`, `core competencies`, `key skills`, `technical proficiencies` |
| **Projects**        | `projects`, `selected projects`, `project experience`, `relevant projects` |
| **Certifications**  | `certifications`, `certificates`, `licenses`, `licenses & certifications` |
| **Awards / Honors** | `awards`, `honors`, `achievements`, `accolades` |
| **Publications**    | `publications`, `papers`, `research`, `journal articles`, `conference presentations` |
| **Volunteer / Community** | `volunteer`, `community service`, `volunteer experience`, `extracurricular activities`, `community involvement` |
| **References**      | `references`, `referees`, `recommendations` |

When constructing the matcher, create a list of patterns for each section.  For example, the `SKILLS` section might include patterns for tokens `skills`, `technical skills`, and `core competencies`.  Use the `Matcher.add()` method to associate these patterns with section labels.  At runtime, iterate through the matches and record the text between section headings as that section’s content.  This dictionary can then be passed to the skill extraction heuristics.

#### 11.2.4 Skill extraction heuristics

Once sections are identified, extract explicit skills by scanning for known skill terms.  Two approaches:

1. **Dictionary + PhraseMatcher.**  Build a comprehensive list of skills (e.g., programming languages, tools, frameworks) and feed it to `PhraseMatcher`.  Instead of hard‑coding this list in code, populate it from an authoritative source such as the **O*NET “Skills” file**.  O*NET’s downloadable database includes a **Skills** file and competency frameworks that list basic and cross‑functional skills for each occupation【733615138004015†L744-L770】.  You can import this file into your database during setup and use the combined vocabulary as the dictionary.  The phrase matcher then finds exact matches and returns spans.  Example:
   ```python
   from spacy.matcher import PhraseMatcher
   skills = ['python', 'java', 'c++', 'machine learning', 'data analysis']
   patterns = [nlp.make_doc(skill) for skill in skills]
   matcher = PhraseMatcher(nlp.vocab, attr='LOWER')
   matcher.add('SKILL', patterns)
   for match_id, start, end in matcher(doc):
       extracted_skill = doc[start:end].text
       # store or update count/experience
   ```

2. **Regular expressions and heuristics.**  Use regex to capture versions or synonyms: `r'(?i)python(\s*\d(\.\d+)*)?'` matches “Python”, “Python 3”, “Python 3.8”.  For years of experience, search for patterns like `r'(\d+)\s+years?\s+of\s+(experience|exp.)\s+(with\s+)?(\w+)'` and map them to skills.  Rule‑based approaches are helpful because they handle finite patterns and can be applied when training data is scarce【723354687305467†L60-L84】.  You can later replace heuristics with a machine‑learning model.

For each extracted skill, insert a row into `candidate_skills` with optional experience years.  The `resume_sections` table (if created) can store the raw text for auditing.

If the résumé does not include a clearly defined **Skills** section, the system falls back to scanning all sections for skill terms.  The phrase matcher and regex patterns are run across the entire résumé text—not just the `SKILLS` section—to pick up technologies embedded within work experience or project descriptions.  For example, the sentence “Implemented a REST API using Node.js and Express” in an Experience section will still trigger extractions for “Node.js” and “Express”.  To reduce noise, you can intersect the extracted terms with the list of requirements derived from the job description and O*NET; any candidate skill that appears in the job requirements is considered relevant.  Additional heuristics include:

* **Synonym expansion.**  Maintain a mapping of common skill synonyms (e.g., “JS” → “JavaScript”, “ML” → “machine learning”) and normalise extracted terms accordingly.
* **Context windows.**  When scanning experience sections, prioritise nouns or noun phrases that immediately follow verbs like “used”, “implemented”, “developed”, “built”, or “experience with”.  This captures skills embedded within sentences.
* **Frequency counts.**  Give higher weight to terms that appear multiple times across the résumé.  Terms mentioned only once may be less important or accidental.

These heuristics make the extraction more adaptive and reduce the dependency on a dedicated skills section.

#### 11.2.5 Using O*NET for requirement inference

To enrich the list of requirements from a job description, call the **O*NET Web Services API**.  The API is free but access is limited to registered developers【833929447485810†L64-L68】.  Sign up on the O*NET website to obtain a username and password.  The API is RESTful and uses `GET` requests; responses default to XML but can be requested in JSON by sending `Accept: application/json`【833929447485810†L92-L99】.

Typical steps to populate the `requirements` table:

1. **Identify the O*NET occupation code.**  For a given job title, call the `Search careers` service to find the closest O*NET‑SOC codes.  Example: `https://services.onetcenter.org/ws/online/search?keyword=Software%20Developer&start=1&limit=1` with Basic authentication.  Parse the results to select the most relevant occupation code.

2. **Retrieve skill ratings.**  Once you have the O*NET code (e.g., `15-1252.00` for Software Developers), call the skills endpoint: `https://services.onetcenter.org/ws/online/skills/{code}`.  Add the header `Accept: application/json`.  The response contains a list of skills with fields like `name`, `importance`, and `level`.  Insert each skill into the `requirements` table with the `importance` value.

3. **Error handling.**  If the API returns a 422 or 404 error, handle it gracefully and fallback to heuristics or LLM inference.  O*NET responses include a JSON error message if parameters are missing or invalid【833929447485810†L116-L124】.

You can optionally cache O*NET responses in the database to avoid repeated calls and improve performance.

#### 11.2.6 Sentence‑BERT for embeddings

**Sentence‑BERT (SBERT)** modifies the BERT architecture by adding siamese and triplet networks to derive semantically meaningful sentence embeddings【270124505968547†L19-L27】.  It drastically reduces the complexity of similarity search: BERT requires comparing every pair of sentences via cross‑attention, while SBERT produces fixed‑size vectors that can be compared with cosine similarity【270124505968547†L74-L86】.  Pre‑trained SBERT models achieve state‑of‑the‑art results on semantic textual similarity tasks and can be used for clustering or ranking【270124505968547†L89-L99】.

To use SBERT in the Python worker:

```bash
pip install sentence-transformers
```

```python
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('all-mpnet-base-v2')  # or 'paraphrase-MiniLM-L6-v2'

def generate_embeddings(texts: list[str]) -> list[list[float]]:
    return model.encode(texts, convert_to_tensor=True).tolist()
```

The output is a list of 768‑dimensional vectors (depending on the model).  These vectors can be stored temporarily or persisted in a `candidate_embeddings` table if you plan to reuse them.  There is no need to train your own SBERT model unless you have large domain‑specific data; training requires GPU resources and labelled sentence pairs.  If you opt for an API (e.g., OpenAI’s `text-embedding-3-small` endpoint), send an array of sentences in the request and receive a JSON response with embeddings.  Using an external API introduces latency and cost but reduces local dependencies.

##### Inputs, outputs and similarity computation

The embedding module accepts a list of text strings—each representing a candidate skill or a job requirement—and returns a list of embedding vectors of equal length.  Each vector encodes the semantic meaning of its corresponding phrase.  To compare a requirement with a candidate skill, compute the cosine similarity of their embeddings:

```text
cos(u, v) = \frac{u \cdot v}{\|u\| \times \|v\|}
```

where `u` and `v` are embedding vectors and `·` denotes the dot product.  In practice you can use the `sentence_transformers.util.cos_sim()` function to get a similarity score between −1 and 1.  A higher value indicates greater semantic similarity.  The matching engine uses these similarity scores as described in Section 11.3 to determine whether a requirement is met.

Here is a small example illustrating how to generate embeddings and compute similarity between a requirement and a candidate phrase:

```python
from sentence_transformers import SentenceTransformer, util

# Initialisation (done once at startup)
model = SentenceTransformer('all-mpnet-base-v2')

def embed_texts(texts):
    """Return a list of embedding vectors for a list of input strings."""
    return model.encode(texts, convert_to_tensor=True)

def compare_skills(req_text, cand_text, threshold=0.5):
    """Return cosine similarity and whether it exceeds threshold."""
    emb_req, emb_cand = embed_texts([req_text, cand_text])
    similarity = util.cos_sim(emb_req, emb_cand).item()
    return similarity, similarity >= threshold

# Example usage
sim, matched = compare_skills(
    "software development",
    "built web applications using Express and Node.js",
)
print(f"Similarity: {sim:.2f}, matched: {matched}")
```

This function can be extended to handle lists of candidate skills and requirements by computing a similarity matrix and selecting the maximum similarity for each requirement.

##### Relationship to requirement extraction

After extracting skills from the résumé and requirements from the job description (including those inferred via O*NET), the embedding module encodes each term into a fixed‑length vector.  By comparing these vectors with cosine similarity, the system can identify semantic matches even when the candidate uses different terminology than the job description.  For example, O*NET may list “software development” as a skill with high importance, while the candidate’s résumé mentions “built web applications using Express and Node.js”.  SBERT embeddings enable the system to recognise that these phrases are semantically related, resulting in a higher similarity score.  This approach reduces false negatives when skills are phrased differently and allows the matching engine to leverage O*NET’s canonical skill names as anchors.

### 11.3 Matching engine details

The `MatchEngine` module calculates similarity between extracted candidate skills and job requirements and generates a match summary.  Key considerations:

1. **Weighted cosine similarity.**  For each requirement `r` with importance weight `w_r`, compute the cosine similarity between its embedding vector `e_r` and each candidate skill embedding `e_s`.  Define `m_r` as the maximum similarity across all candidate skills:

   ```text
   m_r = max_s cos(e_r, e_s)
   ```

      The contribution of requirement `r` to the overall score is `w_r × m_r`.  Requirements where no candidate skill achieves a similarity above a configurable threshold (e.g., 0.5) are considered **weaknesses** and contribute zero or a negative penalty.  The threshold can be exposed via environment variables or a configuration file and tuned based on user feedback.

2. **Requirement importance values.**  For requirements derived from O*NET, the `importance` field returned by the O*NET API (scaled 0–100) is normalised to a 0–1 range and used as `w_r`.  For explicit skills extracted directly from the job description, assign a default importance (e.g., 0.7) or estimate importance based on frequency and position in the posting.  Administrators can override these defaults via configuration.

3. **Strengths and weaknesses lists.**  A requirement `r` is considered a **strength** if `m_r ≥ threshold`.  It is considered a **weakness** if `m_r < threshold`.  Sort strengths by `m_r` descending and weaknesses by `w_r` descending so that the most important unmet requirements appear first in the weaknesses list.

4. **Overall match score.**  Compute the overall match score as the weighted average of similarities:

   ```text
   match_score = \frac{\sum_r w_r × m_r}{\sum_r w_r}
   ```

   The resulting value ranges from 0 to 1.  You can adjust the weighting or apply nonlinear transforms (e.g., exponentiation) to emphasise high‑importance requirements.

5. **Tunable parameters.**  The matching engine exposes configurable parameters for the similarity threshold, default importance for explicit skills, and weighting scheme.  Store these parameters in a `settings` table or configuration file so they can be updated without code changes.

6. **Store intermediate data.**  Save the embeddings or similarity matrix to speed up repeated matches.  A separate table (`match_details`) can store per‑requirement scores, similarity values and comments.  This table can be used to explain match decisions to users (e.g., “0.83 similarity to ‘software development’ due to mention of ‘building web apps’ in your résumé”).

##### Pseudocode sketch for `calculate_match`

The following high‑level pseudocode illustrates how the `calculate_match` function might be implemented.  It demonstrates how to retrieve skills and requirements, compute similarities and build a match summary:

```python
def calculate_match(resume_id: str, job_id: str, threshold: float = 0.5) -> dict:
    """
    Compute match score between a résumé and a job description.
    Returns a dictionary with match_score, strengths and weaknesses.
    """
    # 1. Load candidate skills and requirements from the database
    candidate_skills = db.select('candidate_skills', where={'resume_id': resume_id})
    requirements     = db.select('requirements', where={'job_id': job_id})

    # 2. Generate embeddings for all skills and requirements
    skill_texts      = [skill['skill'] for skill in candidate_skills]
    req_texts        = [req['skill'] for req in requirements]
    skill_embeds     = embedding_module.generate_embeddings(skill_texts)
    req_embeds       = embedding_module.generate_embeddings(req_texts)

    # 3. Compute similarity matrix
    # similarity_matrix[i][j] = cosine similarity between requirement i and skill j
    similarity_matrix = [
        [cosine_similarity(req_embeds[i], skill_embeds[j]) for j in range(len(skill_embeds))]
        for i in range(len(req_embeds))
    ]

    # 4. For each requirement, pick the maximum similarity across all skills
    strengths = []
    weaknesses = []  # list of unmet requirements
    weighted_sims = []

    for i, req in enumerate(requirements):
        m_r = max(similarity_matrix[i]) if similarity_matrix[i] else 0.0
        importance = req['importance']  # already normalised 0–1
        if m_r >= threshold:
            strengths.append({
                'requirement': req['skill'],
                'similarity': m_r,
                'importance': importance
            })
            weighted_sims.append(importance * m_r)
        else:
            weaknesses.append({
                'requirement': req['skill'],
                'similarity': m_r,
                'importance': importance
            })
            # optionally penalise weaknesses by adding zero or negative weight
            weighted_sims.append(0.0)

    # 5. Compute overall match score
    total_importance = sum(req['importance'] for req in requirements)
    match_score = sum(weighted_sims) / total_importance if total_importance else 0.0

    # 6. Sort strengths and weaknesses (optional)
    strengths.sort(key=lambda x: x['similarity'], reverse=True)
    weaknesses.sort(key=lambda x: x['importance'], reverse=True)

    return {
        'match_score': match_score,
        'strengths': strengths,
        'weaknesses': weaknesses
    }
```

This sketch omits error handling, caching and database transaction management but illustrates the core algorithm.  Developers should replace `cosine_similarity()` with a call to the embedding library’s `util.cos_sim` function or an equivalent implementation.

### 11.4 LLM integration (optional)

If you choose to incorporate an external LLM like OpenAI’s GPT for summarisation or requirement inference, implement a wrapper in `LLMService`.  For example:

```python
import os
import openai

openai.api_key = os.environ['OPENAI_API_KEY']

def summarize_job(text: str) -> str:
    response = openai.ChatCompletion.create(
        model='gpt-4o',
        messages=[{ 'role': 'system', 'content': 'You are a job summarization assistant.' },
                  { 'role': 'user', 'content': text }],
        max_tokens=200,
        temperature=0.3
    )
    return response['choices'][0]['message']['content'].strip()
```

Wrap these calls in try/except blocks and cache results to minimise cost.  Provide fallback logic if the API is unavailable or disabled via environment variables.

### 11.5 High‑level pseudocode for core modules

For completeness, the following pseudocode sketches show how individual modules might be implemented.  They are not complete implementations but outline the inputs, outputs and major steps.  Developers can fill in details based on the specific language and framework used.

#### ParserWorker.parse_resume

```python
def parse_resume(resume_id: str) -> None:
    """
    Extract sections and skills from a résumé.
    Inputs: resume_id (UUID)
    Side effects: updates the `resumes` and `candidate_skills` tables.
    """
    # 1. Retrieve file path from the database
    file_path = db.get_resume_file_path(resume_id)

    # 2. Extract text using pdfminer.six or python-docx
    text = extract_text(file_path)

    # 3. Parse with spaCy to get a Doc object
    doc = nlp(text)

    # 4. Identify sections using Matcher patterns (see 11.2.3)
    sections = identify_sections(doc)

    # 5. Extract skills and experience using phrase matcher and regex
    skills = extract_skills(doc, sections)

    # 6. Insert extracted skills into candidate_skills table
    for skill in skills:
        db.insert('candidate_skills', {
            'resume_id': resume_id,
            'skill': skill['name'],
            'experience_years': skill.get('years')
        })

    # 7. Update resume status to 'ready' or 'error'
    db.update('resumes', resume_id, { 'status': 'ready' })
```

#### ParserWorker.parse_job

```python
def parse_job(job_id: str) -> None:
    """
    Extract explicit and inferred requirements from a job description.
    Inputs: job_id (UUID)
    Side effects: updates the `job_descriptions` and `requirements` tables.
    """
    # 1. Retrieve job title and description from the database
    job = db.get_job(job_id)
    text = job['description_text']

    # 2. Extract explicit skill terms using phrase matcher and heuristics
    explicit_skills = extract_skill_terms(text)

    # 3. Infer additional requirements via O*NET
    onet_code = search_onet_code(job['title'])
    inferred_skills = []
    if onet_code:
        inferred_skills = call_onet_skills_api(onet_code)  # returns list of {name, importance}

    # 4. Merge explicit and inferred skills, assign importance
    requirements = []
    for name in explicit_skills:
        requirements.append({ 'skill': name, 'importance': DEFAULT_EXPLICIT_IMPORTANCE, 'inferred': False })
    for item in inferred_skills:
        requirements.append({ 'skill': item['name'], 'importance': item['importance']/100.0, 'inferred': True })

    # 5. Insert into requirements table
    for req in requirements:
        db.insert('requirements', { 'job_id': job_id, **req })

    # 6. Update job status
    db.update('job_descriptions', job_id, { 'status': 'ready' })
```

#### EmbeddingModule.generate_embeddings

```python
def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """
    Generate SBERT embeddings for a list of input texts.
    Returns: list of vectors (same length as input).
    """
    return model.encode(texts, convert_to_tensor=True).tolist()
```

#### MatchEngine.calculate_match

See Section 11.3 for the detailed algorithm.  A simplified outline is:

```python
def calculate_match(resume_id: str, job_id: str, threshold: float=0.5) -> dict:
    # 1. Fetch skills and requirements
    skills = db.select('candidate_skills', resume_id)
    reqs   = db.select('requirements', job_id)

    # 2. Get embeddings
    skill_embeds = generate_embeddings([s['skill'] for s in skills])
    req_embeds   = generate_embeddings([r['skill'] for r in reqs])

    # 3. Compute similarity matrix and derive per‑requirement scores
    # ... (see full pseudocode in 11.3)

    # 4. Aggregate weighted scores and return summary
    return summary
```

#### LLMService (optional)

```python
def summarize_job(text: str) -> str:
    """Use OpenAI GPT to summarise a job description."""
    # Prepare prompt and call the API
    response = openai.ChatCompletion.create(
        model='gpt-4o',
        messages=[{'role': 'system', 'content': 'You are a job summarization assistant.'},
                  {'role': 'user', 'content': text}],
        max_tokens=200,
        temperature=0.3,
    )
    return response['choices'][0]['message']['content'].strip()

def infer_implicit_skills(text: str) -> list[str]:
    """Call an LLM to suggest skills not explicitly mentioned."""
    prompt = f"Identify five additional skills implied by the following job description: {text}"
    response = openai.ChatCompletion.create(
        model='gpt-4o',
        messages=[{'role': 'system', 'content': 'You infer skills.'},
                  {'role': 'user', 'content': prompt}],
        max_tokens=100,
    )
    return parse_skills_from_response(response)
```

These sketches help junior developers understand the shape of each module and where to implement the details (database queries, error handling, etc.).

#### Additional helper functions and controllers (pseudocode)

The previous pseudocode focused on the core worker functions.  To make the design even more actionable, the following sketches illustrate how lower‑level helper functions and Express controllers might be implemented.  These examples are intentionally high level and should be adapted to the chosen libraries and coding conventions.

##### `extract_text(file_path: str) -> str`

This helper extracts plain text from a file given its path.  Use **pdfminer.six** for PDF documents and `python-docx` for Word files.  The function should detect the file type based on the extension and call the appropriate extractor.  It can reside in `python-worker/utils/extraction.py`.

```python
import os
from pdfminer.high_level import extract_text as pdfminer_extract_text
import docx  # python-docx

def extract_text(file_path: str) -> str:
    """Return the full text content of a PDF or DOCX file."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext == '.pdf':
        try:
            return pdfminer_extract_text(file_path)
        except Exception as e:
            # handle parse errors (log and re‑raise or return empty string)
            raise RuntimeError(f"PDF extraction failed: {e}")
    elif ext in ('.doc', '.docx'):
        doc = docx.Document(file_path)
        return '\n'.join(paragraph.text for paragraph in doc.paragraphs)
    else:
        raise ValueError(f"Unsupported file type: {ext}")
```

##### `identify_sections(doc: spacy.tokens.Doc) -> dict[str, list[str]]`

This function scans a spaCy `Doc` object and returns a mapping of section names to the tokens contained in each section.  It uses the `Matcher` patterns defined in Section 11.2.3 to locate headings (e.g., “experience”, “education”, “skills”) and slices the document accordingly.

```python
from spacy.matcher import Matcher

def identify_sections(doc) -> dict:
    """
    Given a spaCy Doc, return a dict {section_name: text}.
    If a section is not found, it may be omitted.
    """
    matcher = Matcher(doc.vocab)
    # Patterns defined elsewhere (see 11.2.3): e.g., [{'LOWER': 'experience'}]
    for name, pattern in SECTION_PATTERNS.items():
        matcher.add(name, [pattern])
    matches = matcher(doc)
    # Sort matches by start index
    matches = sorted(matches, key=lambda m: m[1])
    sections = {}
    for i, (match_id, start, end) in enumerate(matches):
        section_name = doc.vocab.strings[match_id]
        # Determine the span for this section (until the next heading or end of doc)
        next_start = matches[i + 1][1] if i + 1 < len(matches) else len(doc)
        section_span = doc[start:next_start]
        sections[section_name] = section_span.text
    return sections
```

##### `extract_skills(doc: spacy.tokens.Doc, sections: dict) -> list[dict]`

This function extracts explicit skills and experience years from the résumé.  It uses a **PhraseMatcher** with a predefined vocabulary of skills (e.g., programming languages, frameworks) and regular expressions to capture phrases like “5 years of experience”.  The returned list contains dictionaries with the skill name and optional years of experience.

```python
import re
from spacy.matcher import PhraseMatcher

SKILL_TERMS = ["python", "java", "data analysis", "project management", ...]  # built from O*NET + domain knowledge
skill_patterns = [nlp.make_doc(term) for term in SKILL_TERMS]

def extract_skills(doc, sections) -> list:
    """
    Find occurrences of known skills in the document and extract years of experience when present.
    Returns a list of {'name': skill, 'years': Optional[int]} dictionaries.
    """
    matcher = PhraseMatcher(doc.vocab, attr="LOWER")
    matcher.add("SKILLS", skill_patterns)
    skills_found = {}
    for match_id, start, end in matcher(doc):
        term = doc[start:end].text.lower()
        skills_found.setdefault(term, 0)
        # Check neighbouring tokens for years of experience (simple regex)
        context = doc[max(0, start - 5):min(len(doc), end + 5)].text
        years = None
        match = re.search(r"(\d+)\s+years?", context)
        if match:
            years = int(match.group(1))
        # Keep the maximum years seen for this skill
        skills_found[term] = max(skills_found[term], years or 0)
    return [{'name': name, 'years': (yrs if yrs > 0 else None)} for name, yrs in skills_found.items()]
```

##### `search_onet_code(job_title: str) -> str | None`

Use the O*NET Web Services search endpoint to find the most relevant occupation code given a job title.  The API requires Basic authentication (an email and password obtained when you register).  See the [O*NET API documentation](https://services.onetcenter.org/reference/) for details.  A simplified example:

```python
import requests

def search_onet_code(job_title: str) -> str | None:
    """Return the best matching O*NET SOC code for a job title or None if not found."""
    user = os.environ['ONET_USER']
    password = os.environ['ONET_PASSWORD']
    params = {'keyword': job_title, 'end': 1}  # return the single best match
    resp = requests.get(
        'https://services.onetcenter.org/ws/online/search',
        params=params,
        auth=(user, password)
    )
    data = resp.json()
    if data.get('occupation'):  # list of matches
        return data['occupation'][0]['code']  # e.g., '15-1252.00'
    return None
```

##### `call_onet_skills_api(code: str) -> list[dict]`

Given a SOC code, call the O*NET skills endpoint to retrieve skills and their importance scores.  The API returns a list of skills with `element_name` (skill name) and `importance` (0–100)【907131220775107†L63-L72】.

```python
def call_onet_skills_api(code: str) -> list[dict]:
    """Return a list of skills with importance scores for a given SOC code."""
    user = os.environ['ONET_USER']
    password = os.environ['ONET_PASSWORD']
    resp = requests.get(
        f'https://services.onetcenter.org/ws/online/occupations/{code}/skills',
        auth=(user, password)
    )
    skills = []
    for elem in resp.json().get('skills', []):
        skills.append({'name': elem['element_name'], 'importance': float(elem['importance'])})
    return skills
```

##### Express controllers pseudocode (Node/TypeScript)

Controllers orchestrate requests, call services, and handle responses.  The following sketches show the shape of the major route handlers defined in Section 9.  They should be implemented in the `controllers/` directory.

```ts
// FileUploadController.ts
import { Request, Response } from 'express';
import { queue } from '../queue/QueueModule';
import { db } from '../models/db';

export async function uploadResume(req: Request, res: Response) {
  // Validate multipart/form‑data and save the uploaded file to local storage
  const file = req.file; // provided by multer middleware
  const resumeId = uuidv4();
  const filePath = `/uploads/${resumeId}${path.extname(file.originalname)}`;
  await fs.promises.rename(file.path, filePath);
  // Insert metadata into DB
  await db.insert('resumes', { id: resumeId, file_path: filePath, status: 'queued', user_id: req.user.id });
  // Enqueue parsing job
  await queue.add('parseResume', { resume_id: resumeId });
  res.status(201).json({ id: resumeId, status: 'queued' });
}

export async function uploadJob(req: Request, res: Response) {
  const { title, description } = req.body;
  const jobId = uuidv4();
  await db.insert('job_descriptions', { id: jobId, title, description_text: description, status: 'queued', user_id: req.user.id });
  await queue.add('parseJob', { job_id: jobId });
  res.status(201).json({ id: jobId, status: 'queued' });
}

// MatchController.ts
export async function createMatch(req: Request, res: Response) {
  const { resume_id, job_id } = req.body;
  const matchId = uuidv4();
  await db.insert('match_jobs', { id: matchId, resume_id, job_id, status: 'queued', user_id: req.user.id });
  await queue.add('match', { match_id: matchId, resume_id, job_id });
  res.status(201).json({ id: matchId, status: 'queued' });
}

export async function getMatch(req: Request, res: Response) {
  const match = await db.get('matches', req.params.id);
  if (!match) return res.status(404).json({ error: 'not found' });
  res.json(match);
}
```

##### QueueModule configuration and worker pseudocode

The queue module abstracts BullMQ configuration and job processing.  Define job processors and connect them to the Python worker or internal functions.

```ts
// queue/QueueModule.ts
import { Queue, Worker } from 'bullmq';

export const queue = new Queue('jobs', { connection: { host: 'localhost', port: 6379 } });

// Worker definitions (runs in separate process)
const parseResumeWorker = new Worker('jobs', async job => {
  if (job.name === 'parseResume') {
    const { resume_id } = job.data;
    // Call Python worker via HTTP or direct function call
    await pythonWorker.parseResume(resume_id);
    await db.update('resumes', resume_id, { status: 'ready' });
  }
  if (job.name === 'parseJob') {
    const { job_id } = job.data;
    await pythonWorker.parseJob(job_id);
    await db.update('job_descriptions', job_id, { status: 'ready' });
  }
  if (job.name === 'match') {
    const { match_id, resume_id, job_id } = job.data;
    const summary = await matchEngine.calculateMatch(resume_id, job_id);
    await db.insert('matches', { id: match_id, ...summary, status: 'completed' });
  }
}, { concurrency: 5 });

// Error handling and retries are configured via Worker options
```

These additional sketches, along with the main pseudocode in Section 11.5, provide junior developers with clear starting points for implementing each module.  When combined with unit and integration tests (Section 12), they enable iterative development and help ensure that the behaviour of each component matches the overall design.


### 11.6 Security and privacy considerations

NLP processing can involve sensitive data.  Follow best practices:

1. **Data minimization.**  Only store necessary fields (e.g., extracted skills and anonymised sections).  Avoid persisting full resume content unless required.
2. **Encryption.**  Use TLS for all network communication; encrypt sensitive fields at rest.
3. **Access control.**  Ensure each user can only access their own resumes, jobs and match results.  Use Auth0 roles to restrict admin functions (like queue control).
4. **Audit logging.**  Log key actions (uploads, matches, queue operations) for security audits.  Do not log sensitive content.

### 11.7 Extensibility

To adapt Layer 1 for future features (e.g., additional languages, different resume formats), design modules to be pluggable.  For instance, you can add new heuristics for languages other than English by loading a different spaCy model or customizing the `Matcher` patterns.  Similarly, you could introduce a `GraphQL` interface alongside REST without changing the core logic.

## 12. Testing & quality assurance

Robust testing ensures that the backend behaves correctly as features evolve.  Tests should cover individual modules, API endpoints, and the end‑to‑end matching pipeline.  The following plan outlines how to test Layer 1 and provides sample test data.

### 12.1 Unit tests (Python worker)

Use **pytest** as the test runner for the Python modules.  Install it via `pip install pytest` and run tests with `pytest -q`.  Combine it with mocking libraries such as **pytest‑mock** or **responses** to simulate external services (e.g., O*NET API or OpenAI) and database interactions.

1. **PDF extraction with pdfminer.six.**  Provide sample PDF résumés (e.g., `resume_simple.pdf`) containing sections labelled “Experience”, “Education”, “Skills” and “Projects”.  Write a test that runs `extract_text()` and verifies that key phrases (“Experience”, “Python”, “BSc Computer Science”) are present in the extracted string.
2. **Section identification.**  For a given résumé text string, ensure that `ParserWorker.parse_resume()` correctly identifies sections.  For example, assert that the `EXPERIENCE_SECTION` key exists in the returned dictionary and contains the expected substring (“Software Engineer at Acme Corp”).
3. **Skill extraction heuristics.**  Create test sentences that contain explicit skills, e.g., “Proficient in Python 3.8 and JavaScript with 5 years of experience in data analysis.”  Assert that the `PhraseMatcher` returns `['python', 'javascript', 'data analysis']` and that regex captures `{'python': 5}` for years of experience.
4. **O*NET integration.**  Mock the O*NET API to return a fixed set of skills for a job code (e.g., `15-1252.00`).  Verify that `infer_requirements()` inserts the correct number of skills into the `requirements` table and sets `inferred=True`.
5. **SBERT embeddings.**  Pass a list of sentences to `EmbeddingModule.generate_embeddings()` and assert that the output is a list of vectors of consistent length (e.g., 768 dimensions).  For deterministic tests, stub the model to return known vectors.
6. **Match engine.**  Provide known candidate skills and requirements with weights.  Compute the match score via `MatchEngine.calculate_match()` and assert the expected numeric score and the list of **weaknesses**.

### 12.2 Integration tests (Node API)

Use **Jest** as the test runner and **SuperTest** to make HTTP assertions against the Express API.  Install them via `npm install --save-dev jest supertest` and configure Jest with a separate test database and Redis instance.  The test suite should:

1. **Resume upload flow.**  POST `/resumes` with a small PDF file and assert that the response contains a job ID and `status: 'queued'`.  Poll `GET /resumes/{id}` until it returns `status: 'ready'` and verify the parsed data includes expected skills.
2. **Job description creation.**  POST `/jobs` with a JSON body containing a job title and description.  Assert that the `requirements` list in `GET /jobs/{id}` includes both explicit and inferred skills.
3. **Match creation and retrieval.**  POST `/matches` with valid `resume_id` and `job_id`.  Ensure the match job is enqueued and processed.  When `GET /matches/{id}` returns `status: 'completed'`, check that `match_summary.overall_match_score` is within the expected range and that strengths/weaknesses align with the test data.
4. **Authentication & authorization.**  Attempt to access endpoints without an Auth0 token and assert that the response status is 401.  Test that users cannot access resources they don’t own (expect 403).

### 12.3 Queue and concurrency tests

1. **Job processing order.**  Enqueue multiple `parseResume` and `parseJob` tasks and verify that each is processed exactly once by the worker.  Use the `match_jobs` status transitions (`queued` → `running` → `completed`) to assert correct behaviour.
2. **Concurrency limits.**  Configure the BullMQ worker with a concurrency of 2 and enqueue more than two jobs.  Assert that no more than two jobs are marked as `running` simultaneously.
3. **Failure handling.**  Force a job to throw an exception (e.g., invalid PDF format).  Ensure that the job’s `status` is updated to `failed`, `error_message` is recorded, and retries occur if configured.

### 12.4 Database tests

1. **Schema constraints.**  Write tests that attempt to insert invalid foreign keys or violate `NOT NULL` constraints and assert that the database raises an error.
2. **Cascading deletes.**  Delete a `resume` record and assert that associated `candidate_skills` and `matches` rows are automatically removed.
3. **Index performance.**  For large datasets (simulate by inserting thousands of skills and requirements), measure query times on the `matches` view to ensure indexes are used.

### 12.5 Test data

Developers should maintain a folder `/tests/data` with sample résumés and job descriptions:

- `resume_simple.pdf` – a short résumé containing a clear Skills section with a handful of technologies and years of experience.
- `resume_complex.pdf` – a résumé with multiple pages and varied layouts (tables, columns) to challenge the parser.
- `job_basic.json` – a job description listing explicit requirements for “Data Analyst” (e.g., SQL, Python, Data Visualisation).  The expected requirements list should include these explicit skills.
- `job_infer.json` – a job description missing some skills; test the O*NET integration by checking that inferred skills (e.g., problem solving, critical thinking) appear in the `requirements` table.
    - `match_expected.json` – a sample output structure for a known résumé/job pair.  Use this to assert that `MatchEngine.calculate_match()` returns the correct `overall_match_score`, strengths and weaknesses.

Comprehensive testing helps catch regressions as the project evolves and provides confidence that the system works correctly under real‑world conditions.

## 13. Project structure, naming conventions & examples

Although this document focuses on architecture and algorithms, a junior developer will benefit from guidance on how to organise the codebase, adhere to consistent naming patterns, and understand how modules interoperate.  The following recommendations can be used when creating the repository for Layer 1.

### 13.1 Recommended directory layout

A modular monolithic repository might be organised as follows:

```
root/
│
├── backend/                    # Node.js code
│   ├── src/
│   │   ├── controllers/        # API controllers (FileUploadController, MatchController)
│   │   ├── services/           # Business logic (MatchEngine, QueueModule, AuthMiddleware)
│   │   ├── models/             # Database access layer (SQL queries, ORMs)
│   │   ├── routes/             # Express route definitions
│   │   ├── queue/              # Queue configuration and job definitions
│   │   └── config/             # Environment and application configuration
│   └── tests/                  # API integration tests
│
├── python-worker/             # Python microservice
│   ├── app.py                 # Entry point exposing a REST API or CLI
│   ├── parsers/
│   │   ├── resume_parser.py    # spaCy-based resume parsing
│   │   └── job_parser.py       # Job description parsing and requirement inference
│   ├── embeddings.py          # SBERT wrapper for generating embeddings
│   ├── match_engine.py        # Matching logic (if implemented in Python)
│   ├── utils/                 # Utility functions (O*NET API client, regex helpers)
│   └── tests/                 # Unit tests for Python modules
│
└── docs/                      # Documentation, ADRs, diagrams
    └── layer1_backend_and_ai_design.md
```

This structure separates concerns (controllers, services, models, queue definitions) and makes it easy to locate code related to a given module.  You can adjust names or add directories (e.g., `scripts/` for database migrations) as the project grows.

### 13.2 Naming conventions & code style

- **Python:** Use `snake_case` for variables and functions, and `PascalCase` for class names.  Follow the [PEP 8](https://peps.python.org/pep-0008/) style guide.  Group imports into standard library, third‑party, and local modules.
- **Node.js/TypeScript:** Use `camelCase` for variables and functions, `PascalCase` for classes, and hyphen‑separated names for file names (e.g., `match-engine.ts`).  Use [Prettier](https://prettier.io/) and [ESLint](https://eslint.org/) with a shared configuration to enforce formatting and linting rules.
- **Database:** Use lowercase snake_case for table names and column names (e.g., `job_descriptions`, `created_at`).  Use singular names for tables representing a single entity (e.g., `resume`, `job_description`) or plural names consistently.

Agreeing on conventions early makes the code easier to review and maintain, especially when multiple developers contribute.

### 13.3 Integration flow between modules

Here is a typical end‑to‑end flow illustrating which module calls which:

1. **Upload** – A client calls `POST /resumes` or `POST /jobs`.  The **FileUploadController** validates the request, stores the file on the local filesystem and metadata in the database, and enqueues a parsing job via **QueueModule**.
2. **Parsing** – A **BullMQ** worker listens for `parseResume` and `parseJob` jobs.  When a job arrives, it invokes the **Python worker**’s `/parse-resume` or `/parse-job` endpoint (or runs a Python function directly).  The Python worker uses **spaCy** and heuristics to extract sections and skills, stores the results in the `candidate_skills` and `requirements` tables, and updates the record status.
3. **Match request** – Once both the résumé and job are ready, the client calls `POST /matches`.  The **MatchController** inserts a record into `match_jobs` and enqueues a `match` job.
4. **Matching** – A worker listening on the `match` queue invokes the **MatchEngine**.  It fetches the extracted skills and requirements, calls the **EmbeddingModule** to generate SBERT embeddings, computes weighted cosine similarity (see section 11.3), builds the match summary, writes it to the `matches` table, and marks the job as `completed`.
5. **Result retrieval** – The client polls `GET /matches/{id}` or subscribes to a WebSocket to receive the final match summary.

This sequence clarifies how the controllers, queue, Python worker, embedding service and matching engine interact.  Additional modules (e.g., LLMService) can be integrated at the appropriate step (e.g., during requirement inference).

### 13.4 SBERT comparison example

To illustrate how SBERT can be used to compare a candidate skill phrase with a job requirement, here is a simple Python example using the [sentence-transformers](https://www.sbert.net/) library.  It compares the similarity between “built web applications using Express and Node.js” and “software development”:

```python
from sentence_transformers import SentenceTransformer, util

# Load a pre-trained SBERT model
model = SentenceTransformer('all-mpnet-base-v2')

# Candidate phrase (extracted from résumé) and job requirement
candidate_phrase = "built web applications using Express and Node.js"
requirement     = "software development"

# Generate embeddings
emb_candidate = model.encode(candidate_phrase, convert_to_tensor=True)
emb_requirement = model.encode(requirement, convert_to_tensor=True)

# Compute cosine similarity
similarity = util.cos_sim(emb_candidate, emb_requirement).item()
print(f"Cosine similarity: {similarity:.2f}")

# If similarity >= 0.5 (threshold) then consider the requirement satisfied
if similarity >= 0.5:
    print("Requirement matched")
else:
    print("Gap detected")
```

In this example, SBERT produces high similarity because the phrases are semantically related.  This mechanism allows the matching engine to handle synonyms and varying wording between résumés and job descriptions.  You can experiment with different thresholds and phrases to see how SBERT behaves.

Including code snippets like this throughout the documentation helps junior developers understand not only the high‑level design but also how to implement and test specific components.

## 14. Deployment & environment configuration

This section explains how to containerise the project and configure it via environment variables.  Docker provides reproducible builds for both the Node API and the Python worker, while Docker Compose orchestrates all services (API, worker, database and Redis) in one command.

### 14.1 Running the project with Docker & Compose

Create separate **Dockerfile** files for the backend and the Python worker:

```Dockerfile
# backend/Dockerfile
FROM node:20-alpine AS build
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

```Dockerfile
# python-worker/Dockerfile
FROM python:3.11-slim
WORKDIR /usr/src/app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "app.py"]
```

Add a **docker-compose.yml** at the repository root to define all services:

```yaml
version: "3.9"
services:
  api:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/ai
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - AUTH0_DOMAIN=${AUTH0_DOMAIN}
      - AUTH0_CLIENT_ID=${AUTH0_CLIENT_ID}
      - AUTH0_CLIENT_SECRET=${AUTH0_CLIENT_SECRET}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - DEFAULT_SIMILARITY_THRESHOLD=0.5
    depends_on:
      - db
      - redis
      - worker

  worker:
    build: ./python-worker
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/ai
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - ONET_USERNAME=${ONET_USERNAME}
      - ONET_PASSWORD=${ONET_PASSWORD}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - db
      - redis

  db:
    image: postgres:15
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=ai
    volumes:
      - db_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  # If you plan to use Azure SQL Database instead of a local Postgres container, you can remove
  # the `db` service entirely and point the API and worker to a remote Azure database.  The
  # `DATABASE_URL` (or `AZURE_SQL_CONNECTION_STRING`) environment variables should contain
  # the full connection string as provided by the Azure portal.  No ports need to be exposed
  # for a remote database.

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  db_data:
```

Use `docker-compose up --build` to start all services.  The API will be reachable at `http://localhost:3000`, and the Python worker at `http://localhost:8000` (provided it exposes a port).  PostgreSQL and Redis run inside containers but are accessible on their default ports.

### 14.2 Environment variables and credentials

Place all sensitive settings into a `.env` file (not committed to version control) and load them at runtime.  Use [dotenv](https://www.npmjs.com/package/dotenv) in Node and [python-dotenv](https://pypi.org/project/python-dotenv/) in Python to read the file.  Common variables include:

- `DATABASE_URL` – PostgreSQL connection string (e.g., `postgresql://user:pass@host:port/db`).
- `AZURE_SQL_CONNECTION_STRING` – connection string for Azure SQL Database (e.g., `Server=tcp:<server>.database.windows.net,1433;Database=<db>;User ID=<user>;Password=<password>;Encrypt=true;`).  Set this if you are using Azure SQL Database instead of PostgreSQL.
- `REDIS_HOST` and `REDIS_PORT` – location of the Redis instance used by BullMQ.
- `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` – Auth0 credentials.
- `ONET_USERNAME`, `ONET_PASSWORD` – O*NET Web Services credentials.
- `OPENAI_API_KEY` – API key for OpenAI (if external LLM integration is enabled).
- `DEFAULT_SIMILARITY_THRESHOLD` – default similarity threshold for the matching engine (e.g., `0.5`).
- `DEFAULT_EXPLICIT_IMPORTANCE` – default importance score for explicit job skills.

When using Docker Compose, environment variables defined in the `.env` file are automatically substituted into the `docker-compose.yml` via `${VAR_NAME}` syntax.  For production deployments, store secrets in a cloud secrets manager and inject them at runtime.

### 14.3 Running the project locally

1. **Clone the repository** and navigate into it.
2. **Create a `.env` file** with the variables mentioned above.  Request O*NET credentials by signing up for the Web Services.  Add your Auth0 tenant details and OpenAI key if necessary.
3. **Build and start services**:

   ```bash
   docker-compose up --build
   ```

4. **Initialize the database** using migration scripts or an ORM (e.g., Knex).  You can also copy the SQL schema from Section 4 into a migration file and run it inside the `db` container.

### 14.4 Using Azure SQL Database

To deploy Layer 1 against an Azure SQL Database instead of a local Postgres container:

1. **Create an Azure SQL Database.**  Log in to the Azure portal and create a serverless SQL database.  If you use the free tier, each subscription can include up to 10 databases with monthly limits of 100 000 vCore‑seconds and 32 GB of storage【997155405869227†L297-L326】.  Note the server name (e.g., `myserver.database.windows.net`), database name, user name and password.
2. **Obtain the connection string.**  In the Azure portal, open the database overview and copy the ADO.NET connection string.  It will look like:

   ```
   Server=tcp:myserver.database.windows.net,1433;Database=mydb;User ID=myuser;Password=VeryStrongPassword;Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;
   ```

3. **Update environment variables.**  Add an `AZURE_SQL_CONNECTION_STRING` entry in your `.env` file with the copied string.  Remove or leave empty the `DATABASE_URL` variable.  In `docker-compose.yml`, remove the `db` service and update the `api` and `worker` services to reference `AZURE_SQL_CONNECTION_STRING` instead of `DATABASE_URL`.
4. **Install appropriate drivers.**  In the Node API, install the `mssql` package (and optionally an ORM like `knex` configured with the `mssql` dialect).  In Python, install `pyodbc` together with the Microsoft ODBC driver for SQL Server (or use an ORM that supports SQL Server).  Update your database module to initialise connections based on the presence of `AZURE_SQL_CONNECTION_STRING`.
5. **Run migrations.**  Because Azure SQL Database uses Transact‑SQL (T‑SQL) syntax, verify that your schema definitions (Section 4) are compatible.  Adjust data types as necessary (e.g., use `VARCHAR` instead of `TEXT`) and execute the migration scripts against the remote database.
6. **Start the application.**  Launch the API and worker containers (`docker-compose up api worker redis`) without the `db` service.  The application will connect to Azure SQL Database using the connection string from the environment.

Azure SQL Database is a fully managed PaaS offering with automatic backups, patching and scaling.  It can simplify operations if your organisation is already invested in Azure.
5. **Run tests** in each service:
   - In `backend`, run `npm test` to execute Jest and SuperTest integration tests.
   - In `python-worker`, run `pytest` to execute unit tests.  Provide the sample files from `test_data` as fixtures.

By following these steps, a developer can spin up a full local environment with minimal effort.  When deploying to staging or production, adapt the Compose file into Kubernetes manifests or a PaaS deployment configuration (e.g., Heroku, Fly.io).

<!--
### 11.5 High‑level pseudocode for core modules

For completeness, the following pseudocode sketches show how individual modules might be implemented.  They are not complete implementations but outline the inputs, outputs and major steps.  Developers can fill in details based on the specific language and framework used.

#### ParserWorker.parse_resume

```python
def parse_resume(resume_id: str) -> None:
    """
    Extract sections and skills from a résumé.
    Inputs: resume_id (UUID)
    Side effects: updates the `resumes` and `candidate_skills` tables.
    """
    # 1. Retrieve file path from the database
    file_path = db.get_resume_file_path(resume_id)

    # 2. Extract text using pdfminer.six or python-docx
    text = extract_text(file_path)

    # 3. Parse with spaCy to get a Doc object
    doc = nlp(text)

    # 4. Identify sections using Matcher patterns (see 11.2.3)
    sections = identify_sections(doc)

    # 5. Extract skills and experience using phrase matcher and regex
    skills = extract_skills(doc, sections)

    # 6. Insert extracted skills into candidate_skills table
    for skill in skills:
        db.insert('candidate_skills', {
            'resume_id': resume_id,
            'skill': skill['name'],
            'experience_years': skill.get('years')
        })

    # 7. Update resume status to 'ready' or 'error'
    db.update('resumes', resume_id, { 'status': 'ready' })
```

#### ParserWorker.parse_job

```python
def parse_job(job_id: str) -> None:
    """
    Extract explicit and inferred requirements from a job description.
    Inputs: job_id (UUID)
    Side effects: updates the `job_descriptions` and `requirements` tables.
    """
    # 1. Retrieve job title and description from the database
    job = db.get_job(job_id)
    text = job['description_text']

    # 2. Extract explicit skill terms using phrase matcher and heuristics
    explicit_skills = extract_skill_terms(text)

    # 3. Infer additional requirements via O*NET
    onet_code = search_onet_code(job['title'])
    inferred_skills = []
    if onet_code:
        inferred_skills = call_onet_skills_api(onet_code)  # returns list of {name, importance}

    # 4. Merge explicit and inferred skills, assign importance
    requirements = []
    for name in explicit_skills:
        requirements.append({ 'skill': name, 'importance': DEFAULT_EXPLICIT_IMPORTANCE, 'inferred': False })
    for item in inferred_skills:
        requirements.append({ 'skill': item['name'], 'importance': item['importance']/100.0, 'inferred': True })

    # 5. Insert into requirements table
    for req in requirements:
        db.insert('requirements', { 'job_id': job_id, **req })

    # 6. Update job status
    db.update('job_descriptions', job_id, { 'status': 'ready' })
```

#### EmbeddingModule.generate_embeddings

```python
def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """
    Generate SBERT embeddings for a list of input texts.
    Returns: list of vectors (same length as input).
    """
    return model.encode(texts, convert_to_tensor=True).tolist()
```

#### MatchEngine.calculate_match

See Section 11.3 for the detailed algorithm.  A simplified outline is:

```python
def calculate_match(resume_id: str, job_id: str, threshold: float=0.5) -> dict:
    # 1. Fetch skills and requirements
    skills = db.select('candidate_skills', resume_id)
    reqs   = db.select('requirements', job_id)

    # 2. Get embeddings
    skill_embeds = generate_embeddings([s['skill'] for s in skills])
    req_embeds   = generate_embeddings([r['skill'] for r in reqs])

    # 3. Compute similarity matrix and derive per‑requirement scores
    # ... (see full pseudocode in 11.3)

    # 4. Aggregate weighted scores and return summary
    return summary
```

#### LLMService (optional)

```python
def summarize_job(text: str) -> str:
    """Use OpenAI GPT to summarise a job description."""
    # Prepare prompt and call the API
    response = openai.ChatCompletion.create(
        model='gpt-4o',
        messages=[{'role': 'system', 'content': 'You are a job summarization assistant.'},
                  {'role': 'user', 'content': text}],
        max_tokens=200,
        temperature=0.3,
    )
    return response['choices'][0]['message']['content'].strip()

def infer_implicit_skills(text: str) -> list[str]:
    """Call an LLM to suggest skills not explicitly mentioned."""
    prompt = f"Identify five additional skills implied by the following job description: {text}"
    response = openai.ChatCompletion.create(
        model='gpt-4o',
        messages=[{'role': 'system', 'content': 'You infer skills.'},
                  {'role': 'user', 'content': prompt}],
        max_tokens=100,
    )
    return parse_skills_from_response(response)
```

These sketches help junior developers understand the shape of each module and where to implement the details (database queries, error handling, etc.).

#### Additional helper functions and controllers (pseudocode)

The previous pseudocode focused on the core worker functions.  To make the design even more actionable, the following sketches illustrate how lower‑level helper functions and Express controllers might be implemented.  These examples are intentionally high level and should be adapted to the chosen libraries and coding conventions.

##### `extract_text(file_path: str) -> str`

This helper extracts plain text from a file given its path.  Use **pdfminer.six** for PDF documents and `python-docx` for Word files.  The function should detect the file type based on the extension and call the appropriate extractor.  It can reside in `python-worker/utils/extraction.py`.

```python
import os
from pdfminer.high_level import extract_text as pdfminer_extract_text
import docx  # python-docx

def extract_text(file_path: str) -> str:
    """Return the full text content of a PDF or DOCX file."""
    ext = os.path.splitext(file_path)[1].lower()
    if ext == '.pdf':
        try:
            return pdfminer_extract_text(file_path)
        except Exception as e:
            # handle parse errors (log and re‑raise or return empty string)
            raise RuntimeError(f"PDF extraction failed: {e}")
    elif ext in ('.doc', '.docx'):
        doc = docx.Document(file_path)
        return '\n'.join(paragraph.text for paragraph in doc.paragraphs)
    else:
        raise ValueError(f"Unsupported file type: {ext}")
```

##### `identify_sections(doc: spacy.tokens.Doc) -> dict[str, list[str]]`

This function scans a spaCy `Doc` object and returns a mapping of section names to the tokens contained in each section.  It uses the `Matcher` patterns defined in Section 11.2.3 to locate headings (e.g., “experience”, “education”, “skills”) and slices the document accordingly.

```python
from spacy.matcher import Matcher

def identify_sections(doc) -> dict:
    """
    Given a spaCy Doc, return a dict {section_name: text}.
    If a section is not found, it may be omitted.
    """
    matcher = Matcher(doc.vocab)
    # Patterns defined elsewhere (see 11.2.3): e.g., [{'LOWER': 'experience'}]
    for name, pattern in SECTION_PATTERNS.items():
        matcher.add(name, [pattern])
    matches = matcher(doc)
    # Sort matches by start index
    matches = sorted(matches, key=lambda m: m[1])
    sections = {}
    for i, (match_id, start, end) in enumerate(matches):
        section_name = doc.vocab.strings[match_id]
        # Determine the span for this section (until the next heading or end of doc)
        next_start = matches[i + 1][1] if i + 1 < len(matches) else len(doc)
        section_span = doc[start:next_start]
        sections[section_name] = section_span.text
    return sections
```

##### `extract_skills(doc: spacy.tokens.Doc, sections: dict) -> list[dict]`

This function extracts explicit skills and experience years from the résumé.  It uses a **PhraseMatcher** with a predefined vocabulary of skills (e.g., programming languages, frameworks) and regular expressions to capture phrases like “5 years of experience”.  The returned list contains dictionaries with the skill name and optional years of experience.

```python
import re
from spacy.matcher import PhraseMatcher

SKILL_TERMS = ["python", "java", "data analysis", "project management", ...]  # built from O*NET + domain knowledge
skill_patterns = [nlp.make_doc(term) for term in SKILL_TERMS]

def extract_skills(doc, sections) -> list:
    """
    Find occurrences of known skills in the document and extract years of experience when present.
    Returns a list of {'name': skill, 'years': Optional[int]} dictionaries.
    """
    matcher = PhraseMatcher(doc.vocab, attr="LOWER")
    matcher.add("SKILLS", skill_patterns)
    skills_found = {}
    for match_id, start, end in matcher(doc):
        term = doc[start:end].text.lower()
        skills_found.setdefault(term, 0)
        # Check neighbouring tokens for years of experience (simple regex)
        context = doc[max(0, start - 5):min(len(doc), end + 5)].text
        years = None
        match = re.search(r"(\d+)\s+years?", context)
        if match:
            years = int(match.group(1))
        # Keep the maximum years seen for this skill
        skills_found[term] = max(skills_found[term], years or 0)
    return [{'name': name, 'years': (yrs if yrs > 0 else None)} for name, yrs in skills_found.items()]
```

##### `search_onet_code(job_title: str) -> str | None`

Use the O*NET Web Services search endpoint to find the most relevant occupation code given a job title.  The API requires Basic authentication (an email and password obtained when you register).  See the [O*NET API documentation](https://services.onetcenter.org/reference/) for details.  A simplified example:

```python
import requests

def search_onet_code(job_title: str) -> str | None:
    """Return the best matching O*NET SOC code for a job title or None if not found."""
    user = os.environ['ONET_USER']
    password = os.environ['ONET_PASSWORD']
    params = {'keyword': job_title, 'end': 1}  # return the single best match
    resp = requests.get(
        'https://services.onetcenter.org/ws/online/search',
        params=params,
        auth=(user, password)
    )
    data = resp.json()
    if data.get('occupation'):  # list of matches
        return data['occupation'][0]['code']  # e.g., '15-1252.00'
    return None
```

##### `call_onet_skills_api(code: str) -> list[dict]`

Given a SOC code, call the O*NET skills endpoint to retrieve skills and their importance scores.  The API returns a list of skills with `element_name` (skill name) and `importance` (0–100)【907131220775107†L63-L72】.

```python
def call_onet_skills_api(code: str) -> list[dict]:
    """Return a list of skills with importance scores for a given SOC code."""
    user = os.environ['ONET_USER']
    password = os.environ['ONET_PASSWORD']
    resp = requests.get(
        f'https://services.onetcenter.org/ws/online/occupations/{code}/skills',
        auth=(user, password)
    )
    skills = []
    for elem in resp.json().get('skills', []):
        skills.append({'name': elem['element_name'], 'importance': float(elem['importance'])})
    return skills
```

##### Express controllers pseudocode (Node/TypeScript)

Controllers orchestrate requests, call services, and handle responses.  The following sketches show the shape of the major route handlers defined in Section 9.  They should be implemented in the `controllers/` directory.

```ts
// FileUploadController.ts
import { Request, Response } from 'express';
import { queue } from '../queue/QueueModule';
import { db } from '../models/db';

export async function uploadResume(req: Request, res: Response) {
  // Validate multipart/form‑data and save the uploaded file to local storage
  const file = req.file; // provided by multer middleware
  const resumeId = uuidv4();
  const filePath = `/uploads/${resumeId}${path.extname(file.originalname)}`;
  await fs.promises.rename(file.path, filePath);
  // Insert metadata into DB
  await db.insert('resumes', { id: resumeId, file_path: filePath, status: 'queued', user_id: req.user.id });
  // Enqueue parsing job
  await queue.add('parseResume', { resume_id: resumeId });
  res.status(201).json({ id: resumeId, status: 'queued' });
}

export async function uploadJob(req: Request, res: Response) {
  const { title, description } = req.body;
  const jobId = uuidv4();
  await db.insert('job_descriptions', { id: jobId, title, description_text: description, status: 'queued', user_id: req.user.id });
  await queue.add('parseJob', { job_id: jobId });
  res.status(201).json({ id: jobId, status: 'queued' });
}

// MatchController.ts
export async function createMatch(req: Request, res: Response) {
  const { resume_id, job_id } = req.body;
  const matchId = uuidv4();
  await db.insert('match_jobs', { id: matchId, resume_id, job_id, status: 'queued', user_id: req.user.id });
  await queue.add('match', { match_id: matchId, resume_id, job_id });
  res.status(201).json({ id: matchId, status: 'queued' });
}

export async function getMatch(req: Request, res: Response) {
  const match = await db.get('matches', req.params.id);
  if (!match) return res.status(404).json({ error: 'not found' });
  res.json(match);
}
```

##### QueueModule configuration and worker pseudocode

The queue module abstracts BullMQ configuration and job processing.  Define job processors and connect them to the Python worker or internal functions.

```ts
// queue/QueueModule.ts
import { Queue, Worker } from 'bullmq';

export const queue = new Queue('jobs', { connection: { host: 'localhost', port: 6379 } });

// Worker definitions (runs in separate process)
const parseResumeWorker = new Worker('jobs', async job => {
  if (job.name === 'parseResume') {
    const { resume_id } = job.data;
    // Call Python worker via HTTP or direct function call
    await pythonWorker.parseResume(resume_id);
    await db.update('resumes', resume_id, { status: 'ready' });
  }
  if (job.name === 'parseJob') {
    const { job_id } = job.data;
    await pythonWorker.parseJob(job_id);
    await db.update('job_descriptions', job_id, { status: 'ready' });
  }
  if (job.name === 'match') {
    const { match_id, resume_id, job_id } = job.data;
    const summary = await matchEngine.calculateMatch(resume_id, job_id);
    await db.insert('matches', { id: match_id, ...summary, status: 'completed' });
  }
}, { concurrency: 5 });

// Error handling and retries are configured via Worker options
```

These additional sketches, along with the main pseudocode in Section 11.5, provide junior developers with clear starting points for implementing each module.  When combined with unit and integration tests (Section 12), they enable iterative development and help ensure that the behaviour of each component matches the overall design.

-->

