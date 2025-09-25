// Job service: holds SQL helpers for job descriptions and derived requirements.
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");

// NOTE: All functions in this module interact directly with the following tables:
//   job_descriptions (primary job posting metadata + parsed_summary JSON + status lifecycle)
//   requirements     (derived / parsed requirement rows linked by job_id)
// They are intentionally thin so controllers stay focused on HTTP concerns.

/**
 * createJobRecord
 * Inserts a job_descriptions row if id does not exist (idempotent on id), sets initial status 'queued'.
 * @param {Object} opts
 * @param {string} opts.id Optional pre-generated UUID
 * @param {string} opts.userId Owning user id
 * @param {string} opts.title Optional title text
 * @param {('file'|'text')} opts.source Origin of content
 * @param {string} opts.filename Original filename (when file source)
 * @param {string} opts.mimeType MIME type
 * @param {string|null} opts.storagePath Object storage key (null for text source)
 * @param {string|null} opts.rawText Raw textual description (when text source)
 * @returns {Promise<{id:string,status:string}>}
 */
async function createJobRecord({
  id,
  userId,
  title,
  source,
  filename,
  mimeType,
  storagePath,
  rawText,
}) {
  const jobId = id || uuidv4();
  // DB: Conditional insert (IF NOT EXISTS) into job_descriptions. Prevents duplicate creation when retried.
  await query(
    `IF NOT EXISTS (SELECT 1 FROM job_descriptions WHERE id = $1)
     INSERT INTO job_descriptions (id, user_id, title, source, filename, mime_type, storage_path, raw_text, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',SYSUTCDATETIME(),SYSUTCDATETIME())`,
    [
      jobId,
      userId || null,
      title || null,
      source,
      filename || null,
      mimeType || null,
      storagePath || null,
      rawText || null,
    ]
  );
  return { id: jobId, status: "queued" };
}

/**
 * updateJobStoragePath
 * Updates storage path for existing job record.
 * @param {string} jobId
 * @param {string} storagePath
 */
async function updateJobStoragePath(jobId, storagePath) {
  // DB: Simple UPDATE of storage_path for existing job_descriptions row.
  await query(
    "UPDATE job_descriptions SET storage_path = $1, updated_at = SYSUTCDATETIME() WHERE id = $2",
    [storagePath, jobId]
  );
}

/**
 * updateJobStatus
 * Persists new status and parsed summary JSON.
 * @param {string} jobId
 * @param {string} status queued|processing|ready|error
 * @param {object|null} parsedSummary
 */
async function updateJobStatus(jobId, status, parsedSummary) {
  // DB: UPDATE job_descriptions.status + parsed_summary (stored as JSON string) for lifecycle transitions.
  await query(
    "UPDATE job_descriptions SET status = $1, parsed_summary = $2, updated_at = SYSUTCDATETIME() WHERE id = $3",
    [status, parsedSummary ? JSON.stringify(parsedSummary) : null, jobId]
  );
}

/**
 * getJobForUser
 * Fetch full job row + requirements ensuring ownership.
 * @param {string} jobId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getJobForUser(jobId, userId) {
  // DB: Select single job_descriptions row restricted by id + user ownership.
  const jobRes = await query(
    `SELECT id, user_id, title, source, filename, mime_type, raw_text, status, parsed_summary, created_at, updated_at
       FROM job_descriptions
      WHERE id = $1 AND user_id = $2`,
    [jobId, userId]
  );
  if (jobRes.rows.length === 0) return null;

  const jobRow = jobRes.rows[0];
  jobRow.parsed_summary = jobRow.parsed_summary
    ? JSON.parse(jobRow.parsed_summary)
    : null;

  // DB: Load all related requirements (ordered by importance DESC then recency).
  const requirementsRes = await query(
    `SELECT id, skill, importance, inferred, created_at
       FROM requirements
      WHERE job_id = $1
      ORDER BY importance DESC, created_at DESC`,
    [jobId]
  );

  return { ...jobRow, requirements: requirementsRes.rows };
}

/**
 * listJobs
 * List summary job rows for user (newest first).
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function listJobs(userId) {
  // DB: Retrieve minimal columns for job list view, ordered newest first.
  const result = await query(
    `SELECT id, title, source, status, created_at, updated_at
       FROM job_descriptions
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * replaceJobRequirements
 * Replaces all requirements for a job with provided list (idempotent parse ingestion).
 * @param {string} jobId
 * @param {Array<Object>} requirements Array of requirement objects with skill/name, importance/weight, inferred flag.
 */
async function replaceJobRequirements(jobId, requirements) {
  // DB: Clear existing derived requirements for fresh parse ingestion (transactional simplicity).
  await query("DELETE FROM requirements WHERE job_id = $1", [jobId]);
  for (const req of requirements) {
    // DB: Insert each parsed requirement with generated UUID primary key.
    await query(
      `INSERT INTO requirements (id, job_id, skill, importance, inferred, created_at)
       VALUES ($1,$2,$3,$4,$5,SYSUTCDATETIME())`,
      [
        uuidv4(),
        jobId,
        req.skill || req.name,
        req.importance !== undefined ? req.importance : req.weight || null,
        req.inferred === undefined ? 0 : req.inferred ? 1 : 0,
      ]
    );
  }
}

module.exports = {
  createJobRecord,
  updateJobStoragePath,
  updateJobStatus,
  getJobForUser,
  listJobs,
  replaceJobRequirements,
};
