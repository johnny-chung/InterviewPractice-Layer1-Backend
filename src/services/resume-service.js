// Resume service: encapsulates SQL for resume lifecycle and associated skills.
// Tables touched:
//   resumes          -> core metadata + parsed_summary JSON + lifecycle status
//   candidate_skills -> derived atomic skill rows linked via resume_id
// NOTE: This module is intentionally thin; controllers & workers call these helpers to keep DB logic centralized.
const { v4: uuidv4 } = require("uuid");
const { query } = require("../db");

/**
 * createResume
 * Inserts a new resumes row (status 'queued') if id not present (idempotent for retries).
 * Columns set: id,user_id,filename,mime_type,storage_path,status,created_at,updated_at
 * @returns {Promise<{id:string,status:string}>}
 */
async function createResume({ id, userId, filename, mimeType, storagePath }) {
  const resumeId = id || uuidv4();
  await query(
    `IF NOT EXISTS (SELECT 1 FROM resumes WHERE id = $1)
     INSERT INTO resumes (id, user_id, filename, mime_type, storage_path, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'queued',SYSUTCDATETIME(),SYSUTCDATETIME())`,
    [resumeId, userId || null, filename, mimeType || null, storagePath]
  );
  return { id: resumeId, status: "queued" };
}

/**
 * updateResumeStoragePath
 * Simple UPDATE of resumes.storage_path (legacy helper; rarely needed once initial insert stores path).
 */
async function updateResumeStoragePath(resumeId, storagePath) {
  await query(
    "UPDATE resumes SET storage_path = $1, updated_at = SYSUTCDATETIME() WHERE id = $2",
    [storagePath, resumeId]
  );
}

/**
 * updateResumeStatus
 * UPDATE resumes.status + parsed_summary JSON blob (stringified) during parsing lifecycle transitions.
 */
async function updateResumeStatus(resumeId, status, parsedSummary) {
  await query(
    "UPDATE resumes SET status = $1, parsed_summary = $2, updated_at = SYSUTCDATETIME() WHERE id = $3",
    [status, parsedSummary ? JSON.stringify(parsedSummary) : null, resumeId]
  );
}

/**
 * getResumeForUser
 * SELECT single resumes row (ownership enforced) + related candidate_skills ordered oldest->newest.
 */
async function getResumeForUser(resumeId, userId) {
  const resumeRes = await query(
    `SELECT id, user_id, filename, mime_type, status, parsed_summary, created_at, updated_at
       FROM resumes
      WHERE id = $1 AND user_id = $2`,
    [resumeId, userId]
  );
  if (resumeRes.rows.length === 0) return null;

  const resumeRow = resumeRes.rows[0];
  resumeRow.parsed_summary = resumeRow.parsed_summary
    ? JSON.parse(resumeRow.parsed_summary)
    : null;

  const skillsRes = await query(
    `SELECT id, skill, experience_years, proficiency, created_at
       FROM candidate_skills
      WHERE resume_id = $1
      ORDER BY created_at ASC`,
    [resumeId]
  );

  return { ...resumeRow, skills: skillsRes.rows };
}

/**
 * listResumes
 * SELECT summary columns for user resumes ordered newest-first for dashboard listing.
 */
async function listResumes(userId) {
  const result = await query(
    `SELECT id, filename, mime_type, status, created_at, updated_at
       FROM resumes
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * replaceResumeSkills
 * DELETE + INSERT pattern to fully refresh derived candidate_skills for deterministic parse ingestion.
 */
async function replaceResumeSkills(resumeId, skills) {
  await query("DELETE FROM candidate_skills WHERE resume_id = $1", [resumeId]);
  for (const skill of skills) {
    await query(
      `INSERT INTO candidate_skills (id, resume_id, skill, experience_years, proficiency, created_at)
       VALUES ($1,$2,$3,$4,$5,SYSUTCDATETIME())`,
      [
        uuidv4(),
        resumeId,
        skill.skill || skill.name,
        skill.experience_years !== undefined
          ? skill.experience_years
          : skill.years || null,
        skill.proficiency || null,
      ]
    );
  }
}

module.exports = {
  createResume,
  updateResumeStoragePath,
  updateResumeStatus,
  getResumeForUser,
  listResumes,
  replaceResumeSkills,
};
