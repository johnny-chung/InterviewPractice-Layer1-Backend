// Job routes: multiplex file uploads and raw text submission to shared controller.
/**
 * Routes:
 *  GET /api/v1/jobs -> listJobSummaries
 *  GET /api/v1/jobs/:id -> getJobDetail (ownership enforced in controller/service)
 *  POST /api/v1/jobs -> createJob
 *    Accepts EITHER:
 *      - multipart/form-data with single 'file' field (parsed by multer)
 *      - application/json with { text: string, title?: string }
 *  The router inspects Content-Type to decide whether to invoke multer before controller.
 */
const express = require("express");
const multer = require("multer");
const {
  createJob,
  listJobSummaries,
  getJobDetail,
} = require("../controllers/job-controller");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}); // memory storage now

router.get("/", listJobSummaries);
router.get("/:id", getJobDetail);
router.post("/", (req, res, next) => {
  const contentType = req.headers["content-type"] || ""; // Allow JSON or multipart on same endpoint.
  if (contentType.includes("multipart/form-data")) {
    upload.single("file")(req, res, (err) => {
      // Multer parses file -> req.file (memory). On error (size limit / mime) forward to error handler.
      if (err) return next(err);
      // Delegate to controller which:
      //  - ensures user (users table)
      //  - inserts job row (job_descriptions table) via createJobRecord
      //  - uploads bytes to object storage (R2) when file present
      //  - enqueues parseJob (BullMQ) for async parsing & requirements extraction
      return createJob(req, res, next);
    });
  } else {
    // JSON body path (raw text). Controller will treat body.text/description_text as source and still enqueue parse.
    createJob(req, res, next);
  }
});

module.exports = router;
