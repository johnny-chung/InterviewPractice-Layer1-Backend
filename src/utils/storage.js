// Storage helper: centralises disk layout used by uploads and workers.\n
const fs = require('fs');
const path = require('path');

const storageRoot = path.join(process.cwd(), 'storage');
const tempDir = path.join(storageRoot, 'tmp');
const resumesDir = path.join(storageRoot, 'resumes');
const jobsDir = path.join(storageRoot, 'jobs');

function ensureStorageStructure() { // Create directories lazily so local dev has zero setup.
  [storageRoot, tempDir, resumesDir, jobsDir].forEach((dirPath) => {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  });
}

function getResumePath(resumeId, ext) { // Used by uploads + workers to derive permanent storage paths.
  return path.join(resumesDir, `${resumeId}${ext}`);
}

function getJobPath(jobId, ext) { // Mirrors resume storage for job descriptions.
  return path.join(jobsDir, `${jobId}${ext}`);
}

function getTempDir() { // Multer temp directory; ensure structure exists before returning.
  ensureStorageStructure();
  return tempDir;
}

module.exports = {
  ensureStorageStructure,
  getResumePath,
  getJobPath,
  getTempDir,
};

