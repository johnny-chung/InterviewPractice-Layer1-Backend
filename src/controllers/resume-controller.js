// Resume controller: handles uploads/list/detail and queues parsing jobs.
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mime = require("mime-types");
const { ensureUser, getUserId } = require("../services/user-service");
const {
  createResume,
  // updateResumeStoragePath, // no longer needed for R2 direct write
  getResumeForUser,
  listResumes,
} = require("../services/resume-service");
const { queues } = require("../queues");
const { getAuthContext } = require("../utils/request-context");
const { log, error: logError } = require("../utils/logger");
const { putObject } = require("../utils/object-storage");

// Mirror python worker capabilities; adjust when new parsers are added.
/**
 * Allowed MIME types accepted for resume uploads. Must align with the Python parsing service
 * to avoid queueing unsupported content.
 * @type {Set<string>}
 */
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

/**
 * Handle a single resume file upload.
 * Expectations:
 *  - req.file populated by Multer memoryStorage (fields: originalname, mimetype, size, buffer)
 *  - Auth context present (getAuthContext attaches { sub, email })
 *  - File size <= 10MB and mimetype in ALLOWED_MIME_TYPES
 * Side effects:
 *  - Ensures (or creates) a user row via ensureUser
 *  - Persists a resume metadata row via createResume (status initially queued/processing depending on service impl)
 *  - Uploads binary bytes to object storage (R2) using putObject(key, buffer, mimeType)
 *  - Enqueues a BullMQ job (queue: parseResume) with payload needed by worker to parse
 * Response codes:
 *  - 401 when unauthenticated
 *  - 400 when file missing
 *  - 413 when file too large
 *  - 415 when unsupported MIME type
 *  - 500 when storage upload fails
 *  - 202 Accepted when queued successfully (body: { id, status: 'queued' })
 * Returns: void (writes HTTP response). Errors are passed to next(err) for global handler.
 */
async function uploadResume(req, res, next) {
  try {
    const auth = getAuthContext(req); // Populated earlier in middleware; carries { sub, email } JWT claims.
    log("uploadResume request received", {
      user: auth ? auth.sub : null,
      filename: req.file ? req.file.originalname : null,
      size: req.file ? req.file.size : null,
    });
    if (!auth) return res.status(401).json({ error: "unauthorized" });

    // Multer (memory storage) populates req.file with in-memory Buffer + metadata.
    const file = req.file;
    if (!file) return res.status(400).json({ error: "file is required" });
    if (file.size > 10 * 1024 * 1024) {
      return res.status(413).json({ error: "file too large (max 10MB)" });
    }
    if (file.mimetype && !ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return res.status(415).json({ error: "unsupported file type" });
    }

    const user = await ensureUser(auth.sub, auth.email); // ensureUser => upsert/select users table row for external subject.
    const resumeId = uuidv4(); // Primary key for resume row & basis for storage key.

    // Determine an extension preference order: original filename ext -> inferred from mimetype -> fallback.
    const ext =
      path.extname(file.originalname || "") ||
      mime.extension(file.mimetype || "") ||
      ".bin";
    // Normalize to .ext format (mime.extension might omit leading dot).
    const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;

    // Object storage key (namespaced). Using stable ID avoids collisions and leaking user filename.
    const key = `resumes/${resumeId}${normalizedExt}`;

    await createResume({
      // createResume => INSERT INTO resumes (status 'queued') storing storagePath for worker retrieval.
      id: resumeId,
      userId: user.id,
      filename: file.originalname,
      mimeType: file.mimetype,
      storagePath: key, // Persist the object key for later retrieval by worker.
    });

    try {
      await putObject(key, file.buffer, file.mimetype); // putObject => write bytes to object storage (R2 bucket) under deterministic key.
    } catch (e) {
      logError("R2 upload failed", e);
      return res.status(500).json({ error: "storage_write_failed" });
    }

    // Enqueue parsing job providing identifiers & metadata for worker to fetch and parse the file.
    await queues.parseResume.add("parseResume", {
      // BullMQ enqueue: python/Node worker consumes message, downloads file from object storage, parses & updates resumes row + skills table.
      resumeId,
      storagePath: key,
      filename: file.originalname,
      mimeType: file.mimetype,
      userId: user.id,
    });

    log("uploadResume queued parse job", { resumeId, userId: user.id });
    res.status(202).json({ id: resumeId, status: "queued" });
  } catch (err) {
    logError("uploadResume failed", err);
    next(err); // Delegate to global error handler.
  }
}

/**
 * List summaries for all resumes owned by the authenticated user.
 * Expects: valid auth context; no body params.
 * Returns: JSON array (possibly empty) of resume summary objects (shape defined by service layer)
 * HTTP 401 when unauthenticated.
 */
async function listResumeSummaries(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub); // Maps external auth subject -> internal user id.
    if (!userId) return res.json([]); // User record might not exist yet.
    const items = await listResumes(userId); // listResumes => SELECT summary fields FROM resumes WHERE user_id = ? ORDER BY created_at DESC.
    res.json(items);
  } catch (err) {
    next(err);
  }
}

/**
 * Fetch a single resume (with parsed data & skills) ensuring ownership.
 * Path param: :id (resume UUID)
 * Auth: required.
 * Returns: 404 if user or resume not found; otherwise normalized object with camelCase fields.
 */
async function getResumeDetail(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub);
    if (!userId) return res.status(404).json({ error: "not_found" });
    const resume = await getResumeForUser(req.params.id, userId); // getResumeForUser => SELECT * FROM resumes WHERE id = ? AND user_id = ? plus joined/aggregated skills.
    if (!resume) return res.status(404).json({ error: "not_found" });
    res.json({
      id: resume.id,
      status: resume.status,
      filename: resume.filename,
      mimeType: resume.mime_type,
      parsedData: resume.parsed_summary || {},
      skills: resume.skills || [],
      createdAt: resume.created_at,
      updatedAt: resume.updated_at,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadResume,
  listResumeSummaries,
  getResumeDetail,
};
