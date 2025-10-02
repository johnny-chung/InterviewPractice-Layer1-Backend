// Match controller: validates ownership, enqueues similarity jobs, and exposes status APIs.
/**
 * requestMatch
 * Purpose: Accept a resumeId + jobId pair, verify ownership & readiness, create a match job row, enqueue background computation.
 * Inputs (req.body): { resumeId: string, jobId: string }
 * Auth: Required (401 if missing).
 * Validation / Error responses:
 *  - 400 resumeId_and_jobId_required when either id missing
 *  - 404 resume_not_found / job_not_found if resources do not belong to user or absent
 *  - 409 resume_not_ready / job_not_ready when parsing still in progress or errored
 * Success: 202 { id: <matchJobId>, status: <initialStatus> }
 * Side effects: createMatchJob DB insert, enqueue computeMatch job.
 */
const {
  ensureUser,
  getUserId,
  incrementAnnualUsage,
} = require("../services/user-service");
const { getResumeForUser } = require("../services/resume-service");
const { getJobForUser } = require("../services/job-service");
const {
  createMatchJob,
  getMatchJobForUser,
  listMatchJobs,
} = require("../services/match-service");
const { queues } = require("../queues");
const { getAuthContext } = require("../utils/request-context");

async function requestMatch(req, res, next) {
  try {
    const auth = getAuthContext(req); // getAuthContext => extracts validated auth claims ({ sub, email }) from request context.
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const { resumeId, jobId } = req.body || {}; // Expect resumeId/jobId referencing ready resources.
    if (!resumeId || !jobId) {
      return res.status(400).json({ error: "resumeId_and_jobId_required" });
    }

    const user = await ensureUser(auth.sub, auth.email); // ensureUser => upsert/select from users table; guarantees local PK for ownership checks.

    // Basic pro check placeholder: if request includes header x-pro-member=1 treat as pro (until Stripe webhook integration populates DB or token claim).
    const isPro = req.headers["x-pro-member"] === "1"; // Future: derive from persisted subscription state.

    // Enforce annual usage for non-pro users BEFORE creating match job.
    if (!isPro) {
      // Ensure user object has usage fields (ensureUser returns them). Block if already at or over limit.
      if (
        typeof user.annual_usage_count === "number" &&
        typeof user.annual_limit === "number" &&
        user.annual_usage_count >= user.annual_limit
      ) {
        return res.status(402).json({
          error: "upgrade_required",
          message:
            "Annual free match limit reached. Upgrade to Pro for unlimited matches.",
        });
      }
      // Under limit -> increment usage atomically.
      await incrementAnnualUsage(user.id);
    }
    const resume = await getResumeForUser(resumeId, user.id); // getResumeForUser => SELECT resumes row (joined skills) WHERE id & user_id match.
    if (!resume) return res.status(404).json({ error: "resume_not_found" });
    if (resume.status !== "ready") {
      return res.status(409).json({ error: "resume_not_ready" }); // Prevents computing against unparsed/errored resume.
    }
    const job = await getJobForUser(jobId, user.id); // getJobForUser => SELECT job_descriptions + requirements WHERE id & user_id.
    if (!job) return res.status(404).json({ error: "job_not_found" });
    if (job.status !== "ready") {
      return res.status(409).json({ error: "job_not_ready" }); // Job must have finished parsing & requirement extraction.
    }

    const { id: matchJobId, status } = await createMatchJob({
      // createMatchJob => INSERT INTO match_jobs (status 'queued') linking user,resume,job; distinct from final matches result row.
      userId: user.id,
      resumeId,
      jobId,
    });

    await queues.computeMatch.add("computeMatch", {
      // BullMQ enqueue: worker will fetch resume + job embeddings/parsed data, compute similarity, and update match_jobs + create matches row.
      matchJobId,
      resumeId,
      jobId,
      userId: user.id,
    }); // Worker will create final matches row when complete.

    res.status(202).json({ id: matchJobId, status });
  } catch (err) {
    next(err);
  }
}

/**
 * listMatchStatuses
 * Purpose: Return all match job status rows for current user (newest first as defined in service layer).
 * Auth: Required (401 otherwise). Returns [] if user not provisioned yet.
 */
async function listMatchStatuses(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub); // getUserId => quick users table lookup (external sub -> internal id) without create.
    if (!userId) return res.json([]);
    const matches = await listMatchJobs(userId); // listMatchJobs => SELECT * FROM match_jobs WHERE user_id ORDER BY created_at DESC.
    res.json(matches);
  } catch (err) {
    next(err);
  }
}

/**
 * getMatchDetail
 * Purpose: Fetch a single match job + (when completed) embedded match summary row.
 * Path param: :id (match job id)
 * Auth: Required (401 if missing).
 * Errors: 404 not_found if either user or job not present / unauthorized.
 * Success: 200 JSON { id, status, resumeId, jobId, error?, match? }
 */
async function getMatchDetail(req, res, next) {
  try {
    const auth = getAuthContext(req);
    if (!auth) return res.status(401).json({ error: "unauthorized" });
    const userId = await getUserId(auth.sub);
    if (!userId) return res.status(404).json({ error: "not_found" });
    const matchJob = await getMatchJobForUser(req.params.id, userId); // getMatchJobForUser => SELECT match_jobs + joined matches summary restricted to owner.
    if (!matchJob) return res.status(404).json({ error: "not_found" });
    const response = {
      id: matchJob.id,
      status: matchJob.status,
      resumeId: matchJob.resume_id,
      jobId: matchJob.job_id,
      error: matchJob.error_message || null,
    };
    if (matchJob.status === "completed" && matchJob.result_id) {
      response.match = {
        id: matchJob.result_id,
        score: matchJob.score, // similarity/confidence produced by worker's model.
        summary: matchJob.summary, // short textual explanation stored in matches table.
        completedAt: matchJob.match_created_at,
      };
    }
    res.json(response);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requestMatch,
  listMatchStatuses,
  getMatchDetail,
};
