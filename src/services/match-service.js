// Match service: manages match_jobs lifecycle and persisted match summaries.
// Tables touched:
//   match_jobs -> async computation tracking (status, error_message, result_id FK)
//   matches    -> final match result (score + summary JSON)
// NOTE: Functions are intentionally granular so workers/controllers stay concise.
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");
const { bus } = require("../events/bus");

/**
 * createMatchJob
 * INSERT new match_jobs row with status 'queued'.
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string} opts.resumeId
 * @param {string} opts.jobId
 * @returns {Promise<{id:string,status:string,created_at:Date}>}
 */
async function createMatchJob({ userId, resumeId, jobId }) {
  const matchJobId = uuidv4();
  await query(
    `INSERT INTO match_jobs (id, user_id, resume_id, job_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'queued',SYSUTCDATETIME(),SYSUTCDATETIME())`,
    [matchJobId, userId || null, resumeId, jobId]
  );
  const created = await query(
    "SELECT id, status, created_at FROM match_jobs WHERE id = $1",
    [matchJobId]
  );
  try {
    bus.emit("match.status.changed", {
      id: matchJobId,
      status: "queued",
      ts: Date.now(),
    });
  } catch (_) {}
  return created.rows[0];
}

/**
 * updateMatchJobStatus
 * UPDATE match_jobs status + optional error_message.
 * @param {string} matchJobId
 * @param {string} status
 * @param {string} [errorMessage]
 */
async function updateMatchJobStatus(matchJobId, status, errorMessage) {
  await query(
    `UPDATE match_jobs
        SET status = $1,
            error_message = $2,
            updated_at = SYSUTCDATETIME()
      WHERE id = $3`,
    [status, errorMessage || null, matchJobId]
  );
  try {
    bus.emit("match.status.changed", {
      id: matchJobId,
      status,
      ts: Date.now(),
      error: errorMessage || null,
    });
  } catch (_) {}
}

/**
 * attachResult
 * UPDATE match_jobs to mark completed and set result_id FK to matches row.
 * @param {string} matchJobId
 * @param {string} matchId
 */
async function attachResult(matchJobId, matchId) {
  await query(
    `UPDATE match_jobs
        SET status = 'completed',
            result_id = $1,
            updated_at = SYSUTCDATETIME()
      WHERE id = $2`,
    [matchId, matchJobId]
  );
  try {
    bus.emit("match.status.changed", {
      id: matchJobId,
      status: "completed",
      ts: Date.now(),
      resultId: matchId,
    });
  } catch (_) {}
}

/**
 * getMatchJobForUser
 * SELECT match_jobs (ownership enforced) LEFT JOIN matches to hydrate result fields.
 * @param {string} matchJobId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getMatchJobForUser(matchJobId, userId) {
  const result = await query(
    `SELECT mj.id,
            mj.user_id,
            mj.resume_id,
            mj.job_id,
            mj.status,
            mj.error_message,
            mj.created_at,
            mj.updated_at,
            mj.result_id,
            m.score,
            m.summary,
            m.created_at AS match_created_at
       FROM match_jobs mj
  LEFT JOIN matches m ON m.id = mj.result_id
      WHERE mj.id = $1 AND mj.user_id = $2`,
    [matchJobId, userId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  row.summary = row.summary ? JSON.parse(row.summary) : null; // Stored as JSON string in matches.summary.
  return row;
}

/**
 * listMatchJobs
 * SELECT summary columns for all match_jobs belonging to user (newest first).
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function listMatchJobs(userId) {
  const result = await query(
    `SELECT id, resume_id, job_id, status, result_id, created_at, updated_at, error_message
       FROM match_jobs
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * insertMatchResult
 * INSERT matches row with summary JSON + numeric score; returns new match id.
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string} opts.resumeId
 * @param {string} opts.jobId
 * @param {number} opts.score
 * @param {object} opts.summary
 * @returns {Promise<string>} match id
 */
async function insertMatchResult({ userId, resumeId, jobId, score, summary }) {
  const matchId = uuidv4();
  await query(
    `INSERT INTO matches (id, user_id, resume_id, job_id, status, score, summary, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'completed',$5,$6,SYSUTCDATETIME(),SYSUTCDATETIME())`,
    [
      matchId,
      userId || null,
      resumeId,
      jobId,
      score,
      summary ? JSON.stringify(summary) : null,
    ]
  );
  return matchId;
}

module.exports = {
  createMatchJob,
  updateMatchJobStatus,
  attachResult,
  getMatchJobForUser,
  listMatchJobs,
  insertMatchResult,
};
