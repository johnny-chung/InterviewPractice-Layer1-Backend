const express = require('express');
const cors = require('cors');
const { optionalAuth0 } = require('./middleware/auth');
const resumeRoutes = require('./routes/resumes');
const jobRoutes = require('./routes/jobs');
const matchRoutes = require('./routes/matches');
const { error: logError } = require('./utils/logger');

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use(optionalAuth0());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  const api = express.Router();
  api.use('/resumes', resumeRoutes);
  api.use('/jobs', jobRoutes);
  api.use('/matches', matchRoutes);
  app.use('/api/v1', api);

  app.use((err, req, res, next) => {
    logError('Unhandled error', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { buildApp };
