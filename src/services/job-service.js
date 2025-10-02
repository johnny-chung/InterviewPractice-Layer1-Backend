// Job service: holds SQL helpers for job descriptions and derived requirements.
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");
const { bus } = require("../events/bus");

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
  // Emit after DB write so consumers rely on committed state.
  try {
    // Debug: trace lifecycle transition emission (can be filtered in logger).
    // NOTE: If you find this too chatty later, gate behind env flag VERBOSE_REALTIME_LOGS.
    // eslint-disable-next-line no-console
    console.debug(
      `[realtime][bus] Emitting job.status.changed for jobId=${jobId} status=${status}`
    );
    bus.emit("job.status.changed", { jobId, status, ts: Date.now() });
  } catch (e) {
    // Swallow to avoid breaking worker path.
  }
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
      WHERE id = $1 AND user_id = $2 AND is_deleted = 0`,
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

  // DB: Load soft skills (display-only, not used in matching) ordered by value desc.
  let softSkills = [];
  try {
    const softRes = await query(
      `IF OBJECT_ID('job_soft_skills', 'U') IS NOT NULL
       SELECT id, skill, value AS importance, created_at FROM job_soft_skills WHERE job_id = $1 ORDER BY value DESC, created_at DESC`,
      [jobId]
    );
    softSkills = softRes.rows || [];
  } catch (e) {
    // ignore if table absent (backwards compatibility during rollout)
  }

  return {
    ...jobRow,
    requirements: requirementsRes.rows,
    soft_skills: softSkills,
  };
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
      WHERE user_id = $1 AND is_deleted = 0
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * softDeleteJob
 * Marks a job as deleted (soft delete) setting is_deleted=1 and deleted_at timestamp.
 * Ownership enforcement should happen at controller layer prior to calling.
 * @param {string} jobId
 * @param {string} userId
 */
async function softDeleteJob(jobId, userId) {
  await query(
    `UPDATE job_descriptions
        SET is_deleted = 1, deleted_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
      WHERE id = $1 AND user_id = $2 AND is_deleted = 0`,
    [jobId, userId]
  );
  try {
    bus.emit("job.status.changed", {
      jobId,
      status: "deleted",
      ts: Date.now(),
    });
  } catch (_) {}
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

/**
 * replaceJobSoftSkills
 * Replaces all soft skills (display only) for a job. Safe no-op if table missing.
 * @param {string} jobId
 * @param {Array<{skill:string, value:number}>} softSkills
 */
async function replaceJobSoftSkills(jobId, softSkills) {
  if (!Array.isArray(softSkills)) return;
  try {
    await query("DELETE FROM job_soft_skills WHERE job_id = $1", [jobId]);
    for (const s of softSkills) {
      if (!s.skill) continue;
      await query(
        `INSERT INTO job_soft_skills (id, job_id, skill, value, created_at)
         VALUES ($1,$2,$3,$4,SYSUTCDATETIME())`,
        [uuidv4(), jobId, s.skill, s.value !== undefined ? s.value : null]
      );
    }
  } catch (e) {
    // Table might not exist yet; swallow to avoid breaking core flow.
  }
}

module.exports = {
  createJobRecord,
  updateJobStoragePath,
  updateJobStatus,
  getJobForUser,
  listJobs,
  replaceJobRequirements,
  replaceJobSoftSkills,
  softDeleteJob,
};
