// Resume routes: thin wrappers binding HTTP verbs to controller logic.
/**
 * Routes:
 *  GET /api/v1/resumes -> listResumeSummaries
 *  GET /api/v1/resumes/:id -> getResumeDetail (ownership enforced in controller/service)
 *  POST /api/v1/resumes (multipart/form-data with single 'file' field) -> uploadResume
 * Multer memory storage keeps uploads in RAM then streams to R2 via controller.
 */
const express = require("express");
const multer = require("multer");
const {
  uploadResume,
  listResumeSummaries,
  getResumeDetail,
} = require("../controllers/resume-controller");
// const { getTempDir } = require('../utils/storage'); // no longer needed with R2

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get("/", listResumeSummaries);
router.get("/:id", getResumeDetail);
router.post("/", upload.single("file"), uploadResume); // Accepts multipart uploads only.

module.exports = router;
