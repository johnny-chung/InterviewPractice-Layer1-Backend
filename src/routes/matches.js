// Match routes: expose create/list/detail endpoints for async matching jobs.
/**
 * Routes:
 *  GET /api/v1/matches -> listMatchStatuses (returns match_jobs rows for user)
 *  GET /api/v1/matches/:id -> getMatchDetail (includes embedded match result when completed)
 *  POST /api/v1/matches -> requestMatch { resumeId, jobId } (queues computeMatch job after validation)
 */
const express = require("express");
const {
  requestMatch,
  listMatchStatuses,
  getMatchDetail,
} = require("../controllers/match-controller");

const router = express.Router();

router.get("/", listMatchStatuses);
router.get("/:id", getMatchDetail);
router.post("/", requestMatch); // Controllers validate ownership and queue work.

module.exports = router;
