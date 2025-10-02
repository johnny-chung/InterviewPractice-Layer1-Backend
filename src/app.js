const express = require("express");
const cors = require("cors");
const { optionalAuth0 } = require("./middleware/auth");
const resumeRoutes = require("./routes/resumes");
const jobRoutes = require("./routes/jobs");
const matchRoutes = require("./routes/matches");
const usageRoutes = require("./routes/usage");
const { error: logError } = require("./utils/logger");

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));
  // Public health check should not require authentication (load balancers / uptime checks).
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Attach Auth0 (or dev bypass) after public endpoints so /health is always reachable.
  app.use(optionalAuth0());
  const api = express.Router();
  api.use("/resumes", resumeRoutes);
  api.use("/jobs", jobRoutes);
  api.use("/matches", matchRoutes);
  api.use("/usage", usageRoutes);
  app.use("/api/v1", api);

  app.use((err, req, res, next) => {
    logError("Unhandled error", err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

module.exports = { buildApp };
