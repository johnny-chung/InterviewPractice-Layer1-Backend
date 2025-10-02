// Job controller: ingests postings, queues parsing, and exposes listing/detail APIs.
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mime = require("mime-types");
const { ensureUser, getUserId } = require("../services/user-service");
const {
  createJobRecord,
  // updateJobStoragePath, // no longer needed
  getJobForUser,
  listJobs,
  softDeleteJob,
} = require("../services/job-service");
const { queues } = require("../queues");
const { getAuthContext } = require("../utils/request-context");
const { putObject } = require("../utils/r2-storage");

// Keep in sync with python worker job parser support.
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

/**
 * Create a job description record from either an uploaded file or raw text.
 * Inputs (req):
 *  - Auth context (required) via getAuthContext(req)
 *  - Optional file (req.file) when multipart upload; otherwise body.text / body.description_text
 *  - Body.title optional title override.
 * Validation:
 *  - Requires at least one of (file, narrative text)
 *  - File size <= 10MB & MIME type in ALLOWED_MIME_TYPES
 * Side effects:
 *  - ensureUser() upserts user
 *  - createJobRecord() persists metadata (status queued/processing later updated by worker)
 *  - Uploads file to object storage if provided
 *  - Enqueues parseJob BullMQ job with required parsing metadata
 * Responses:
 *  - 401 unauthorized
 *  - 400 file_or_text_required
 *  - 413 file too large
 *  - 415 unsupported type
 *  - 500 storage write error
 *  - 202 Accepted { id, status: 'queued' }
 */
async function createJob(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });

    const file = req.file; // Provided by multer when multipart form-data is used.
    const { title, description_text: descriptionText, text } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title_required" });
    }
    const narrativeText = descriptionText || text;

    if (!file && !narrativeText) {
      return res.status(400).json({ error: "file_or_text_required" });
    }

    const user = await ensureUser(auth.sub, auth.email); // ensureUser => upsert into users table; returns local user row.
    const jobId = uuidv4();

    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        return res.status(413).json({ error: "file too large (max 10MB)" });
      }
      if (file.mimetype && !ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return res.status(415).json({ error: "unsupported file type" });
      }
    }

    const source = file ? "file" : "text";
    const ext = file
      ? path.extname(file.originalname || "") ||
        mime.extension(file.mimetype || "") ||
        ".bin"
      : ".txt";
    const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;

    const key = file ? `jobs/${jobId}${normalizedExt}` : null; // Object storage key (R2) when file upload.

    await createJobRecord({
      // createJobRecord => INSERT into job_descriptions (status 'queued') if id absent.
      id: jobId,
      userId: user.id,
      title: title || null,
      source,
      filename: file ? file.originalname : null,
      mimeType: file ? file.mimetype : "text/plain",
      storagePath: key,
      rawText: file ? null : narrativeText,
    });

    if (file) {
      try {
        await putObject(key, file.buffer, file.mimetype); // putObject => write bytes to object storage bucket (e.g. Cloudflare R2) for later parsing.
      } catch (e) {
        return res.status(500).json({ error: "storage_write_failed" });
      }
    }

    await queues.parseJob.add("parseJob", {
      // Enqueue BullMQ job: worker will read either rawText or fetch file from storage then update job_descriptions + requirements tables.
      jobId,
      source,
      filename: file ? file.originalname : null,
      mimeType: file ? file.mimetype : "text/plain",
      storagePath: key,
      rawText: file ? null : narrativeText,
      userId: user.id,
      title: title || null,
    });

    res.status(202).json({ id: jobId, status: "queued" });
  } catch (err) {
    next(err);
  }
}

/**
 * List job summaries for authenticated user.
 * Returns array (maybe empty). 401 if unauthorized.
 */
async function listJobSummaries(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub);
    if (!userId) return res.json([]);
    const items = await listJobs(userId); // listJobs => SELECT summary columns from job_descriptions for user.
    res.json(items);
  } catch (err) {
    next(err);
  }
}

/**
 * Get full job detail (parsed summary + requirements) ensuring ownership.
 * Path param: :id
 * Returns 404 if not found / unauthorized ownership.
 */
async function getJobDetail(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub);
    if (!userId) return res.status(404).json({ error: "not_found" });
    const job = await getJobForUser(req.params.id, userId); // getJobForUser => SELECT job_descriptions + related requirements rows.
    if (!job) return res.status(404).json({ error: "not_found" });
    res.json({
      id: job.id,
      status: job.status,
      title: job.title,
      source: job.source,
      parsedData: job.parsed_summary || {},
      requirements: job.requirements || [],
      // Surface soft skills (display-only, not used in matching). Field name kept snake_case to stay
      // consistent with other backend response shapes expected by the frontend types (soft_skills?).
      soft_skills: job.soft_skills || [],
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createJob,
  listJobSummaries,
  getJobDetail,
  deleteJob,
};

/**
 * Soft delete a job description (sets is_deleted flag) ensuring ownership.
 * Returns 204 on success, 404 if not found or not owned, 401 if unauthorized.
 */
async function deleteJob(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub);
    if (!userId) return res.status(404).json({ error: "not_found" });
    // Verify exists & ownership and not already deleted
    const job = await getJobForUser(req.params.id, userId);
    if (!job) return res.status(404).json({ error: "not_found" });
    await softDeleteJob(req.params.id, userId);
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
}
