const axios = require("axios");
const fs = require("fs");
const { query } = require("./db");
const config = require("./config");
const { log, error } = require("./utils/logger");
const { getObjectBytes } = require("./utils/r2-storage");
const {
  updateResumeStatus,
  replaceResumeSkills,
} = require("./services/resume-service");
const {
  updateJobStatus,
  replaceJobRequirements,
} = require("./services/job-service");
const {
  updateMatchJobStatus,
  insertMatchResult,
  attachResult,
} = require("./services/match-service");

/**
 * MATCH_THRESHOLD
 * Similarity cutoff (0..1). A requirement with similarity >= threshold is considered matched.
 * Must remain consistent with Python match engine configuration.
 */
const MATCH_THRESHOLD = 0.5; // Keep in sync with python worker default.

/**
 * extractTopLines
 * @param {string} sectionText Raw multi-line section text
 * @param {number} [maxItems=3] Max lines to keep
 * @returns {string[]} First N trimmed non-empty lines (stable order)
 */
function extractTopLines(sectionText, maxItems = 3) {
  if (!sectionText) return [];
  return sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * buildCandidateSummary
 * Consolidates parsed resume summary + DB skill rows into a normalized candidate summary object.
 * @param {object|null} parsedSummary Parsed summary JSON (from resumes.parsed_summary)
 * @param {Array<{skill:string}>} skillsRows Candidate skill rows
 * @returns {object} Candidate summary with name, skills (deduped sorted), experience_years, degrees, certifications, summary
 */
function buildCandidateSummary(parsedSummary, skillsRows) {
  const sections = parsedSummary?.sections || {};
  const profile = parsedSummary?.profile || {};
  return {
    name: profile.name || null,
    skills: Array.from(
      new Set((skillsRows || []).map((row) => row.skill))
    ).sort(),
    experience_years: profile.total_experience_years || null,
    degrees: extractTopLines(sections.EDUCATION),
    certifications: extractTopLines(sections.CERTIFICATIONS),
    summary: profile.summary || null,
  };
}

/**
 * formatRequirements
 * Transforms Python match detail rows into enriched requirement objects adding comments and boolean flags.
 * @param {Array} details Raw detail objects from Python service (fields: requirement, similarity, importance, matched_skill, inferred)
 * @returns {Array} Enriched requirement objects for API consumption
 */
function formatRequirements(details) {
  return (details || []).map((detail) => {
    const matched = detail.similarity >= MATCH_THRESHOLD;
    const matchedSkill = detail.matched_skill;
    const comment = matched
      ? matchedSkill
        ? `Matched via ${matchedSkill} (similarity ${detail.similarity})`
        : `Matched with similarity ${detail.similarity}`
      : "No close match found";
    return {
      skill: detail.requirement,
      importance: detail.importance,
      candidate_has_experience: matched,
      similarity: detail.similarity,
      matched_skill: matchedSkill,
      inferred: detail.inferred || false,
      comments: comment,
    };
  });
}

/**
 * summarizeStrengths
 * @param {Array} strengths Python strengths array
 * @returns {string[]} Human-readable strength strings
 */
function summarizeStrengths(strengths) {
  return (strengths || []).map(
    (item) => `${item.requirement} (similarity ${item.similarity})`
  );
}

/**
 * summarizeWeaknesses
 * @param {Array} gaps Python gaps array
 * @returns {string[]} Human-readable gap strings
 */
function summarizeWeaknesses(gaps) {
  return (gaps || []).map(
    (item) => `${item.requirement} (importance ${item.importance})`
  );
}

/**
 * processParseResume
 * BullMQ processor for 'parseResume'.
 * Input job.data: { resumeId, storagePath, filename, mimeType, userId }
 * Steps: mark processing -> fetch bytes -> call Python /parse/resume -> persist skills & summary -> mark ready
 * On failure: mark error and rethrow to have BullMQ record failure.
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processParseResume(job) {
  const { resumeId, storagePath, filename, mimeType, userId } = job.data;
  log("Processing resume", resumeId); // Helpful for tracing job progress during debugging.
  await updateResumeStatus(resumeId, "processing"); // Mark job early so API shows running status.
  const fileBytes = await getObjectBytes(storagePath); // Read from R2
  const payload = {
    filename,
    mime_type: mimeType,
    content_b64: fileBytes.toString("base64"),
  };

  try {
    const resp = await axios.post(
      `${config.pythonServiceUrl}/parse/resume`,
      payload
    ); // FastAPI returns structured sections + skills.
    const data = resp.data || {};
    const skills = data.skills || [];
    const summary = {
      sections: data.sections || (data.summary && data.summary.sections) || {},
      profile: data.profile || (data.summary && data.summary.profile) || {},
      statistics:
        data.statistics || (data.summary && data.summary.statistics) || {},
    };
    await replaceResumeSkills(resumeId, skills); // Replace instead of append to keep parse idempotent.
    await updateResumeStatus(resumeId, "ready", summary);
  } catch (err) {
    error("Failed to parse resume", err);
    await updateResumeStatus(resumeId, "error", { message: err.message }); // Surface failure reason to API consumers.
    throw err;
  }
}

/**
 * processParseJob
 * BullMQ processor for 'parseJob'.
 * Input job.data: { jobId, source:"file"|"text", storagePath?, filename?, mimeType, rawText?, userId }
 * Steps: mark processing -> build payload -> call Python /parse/job -> persist requirements & summary -> mark ready
 * Failure path marks status 'error'.
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processParseJob(job) {
  const { jobId, source, storagePath, filename, mimeType, rawText } = job.data;
  log("Processing job description", jobId);
  await updateJobStatus(jobId, "processing"); // Keeps UI aware parsing is underway.
  let payload;
  if (source === "file") {
    const fileBytes = await getObjectBytes(storagePath); // Read from R2
    payload = {
      filename,
      mime_type: mimeType,
      content_b64: fileBytes.toString("base64"),
    };
  } else {
    payload = { text: rawText || "" }; // Text submissions skip file IO.
  }

  try {
    const resp = await axios.post(
      `${config.pythonServiceUrl}/parse/job`,
      payload
    );
    const data = resp.data || {};
    const requirements = data.requirements || [];
    const summary = {
      highlights: data.highlights || null,
      overview: data.summary || (data.details && data.details.summary) || null,
      onet: data.onet || null,
    };
    await replaceJobRequirements(jobId, requirements); // Overwrite previous requirements for deterministic results.
    await updateJobStatus(jobId, "ready", summary);
  } catch (err) {
    error("Failed to parse job", err);
    await updateJobStatus(jobId, "error", { message: err.message }); // Allows front-end to display validation guidance.
    throw err;
  }
}

/**
 * processComputeMatch
 * BullMQ processor for 'computeMatch'.
 * Input job.data: { matchJobId, resumeId, jobId, userId }
 * Steps: mark running -> fetch resume/job summaries + skills/requirements -> POST /match -> build match summary -> insert result -> attach
 * Failure: update match job status to 'failed'.
 * @param {import('bullmq').Job} job
 * @returns {Promise<void>}
 */
async function processComputeMatch(job) {
  const { matchJobId, resumeId, jobId, userId } = job.data;
  log("Computing match", matchJobId);
  await updateMatchJobStatus(matchJobId, "running");
  try {
    const resumeSummaryRes = await query(
      "SELECT parsed_summary FROM resumes WHERE id = $1",
      [resumeId]
    );
    const jobSummaryRes = await query(
      "SELECT parsed_summary FROM job_descriptions WHERE id = $1",
      [jobId]
    );
    const skillsRes = await query(
      "SELECT skill, experience_years, proficiency FROM candidate_skills WHERE resume_id = $1",
      [resumeId]
    );
    const reqRes = await query(
      "SELECT skill, importance, inferred FROM requirements WHERE job_id = $1",
      [jobId]
    );

    const resumeSummaryJson = resumeSummaryRes.rows[0]?.parsed_summary
      ? JSON.parse(resumeSummaryRes.rows[0].parsed_summary)
      : null;
    const jobSummaryJson = jobSummaryRes.rows[0]?.parsed_summary
      ? JSON.parse(jobSummaryRes.rows[0].parsed_summary)
      : null;

    const payload = {
      candidate_skills: skillsRes.rows,
      requirements: reqRes.rows.map((row) => ({
        ...row,
        importance:
          row.importance !== null && row.importance !== undefined
            ? Number(row.importance)
            : null,
        inferred: !!row.inferred,
      })),
    };
    const resp = await axios.post(`${config.pythonServiceUrl}/match`, payload); // Python worker returns weighted similarity data.
    const data = resp.data || {};
    const pythonSummary = data.summary || {};
    const details = pythonSummary.details || [];

    const candidate = buildCandidateSummary(resumeSummaryJson, skillsRes.rows);
    const requirements = formatRequirements(details);
    const strengths = summarizeStrengths(pythonSummary.strengths);
    const weaknesses = summarizeWeaknesses(pythonSummary.gaps);

    const matchSummary = {
      overall_match_score:
        data.score !== undefined
          ? data.score
          : pythonSummary.overall_match_score,
      candidate,
      requirements,
      strengths,
      weaknesses,
      job_highlights: jobSummaryJson?.highlights || null,
      raw_details: details,
    };

    const score = matchSummary.overall_match_score || 0;

    const matchId = await insertMatchResult({
      userId,
      resumeId,
      jobId,
      score,
      summary: matchSummary,
    });
    await attachResult(matchJobId, matchId); // Match job now points at persisted result row.
  } catch (err) {
    error("Match computation failed", err);
    await updateMatchJobStatus(matchJobId, "failed", err.message);
    throw err;
  }
}

module.exports = { processParseResume, processParseJob, processComputeMatch };
