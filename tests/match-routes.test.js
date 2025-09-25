const request = require('supertest');

jest.mock('../src/services/user-service', () => ({
  ensureUser: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock('../src/services/resume-service', () => ({
  getResumeForUser: jest.fn(),
}));

jest.mock('../src/services/job-service', () => ({
  getJobForUser: jest.fn(),
}));

jest.mock('../src/services/match-service', () => ({
  createMatchJob: jest.fn(),
  getMatchJobForUser: jest.fn(),
  listMatchJobs: jest.fn(),
}));

const { buildApp } = require('../src/app');
const { queues } = require('../src/queues');
const userService = require('../src/services/user-service');
const resumeService = require('../src/services/resume-service');
const jobService = require('../src/services/job-service');
const matchService = require('../src/services/match-service');

describe('Match routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    userService.ensureUser.mockResolvedValue({ id: 'user-1' });
    userService.getUserId.mockResolvedValue('user-1');
  });

  it('returns 409 when resume not ready', async () => {
    resumeService.getResumeForUser.mockResolvedValue({ status: 'processing' });
    jobService.getJobForUser.mockResolvedValue({ status: 'ready' });

    const res = await request(app)
      .post('/api/v1/matches')
      .send({ resumeId: 'r1', jobId: 'j1' });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error', 'resume_not_ready');
  });

  it('queues match job when inputs ready', async () => {
    resumeService.getResumeForUser.mockResolvedValue({ status: 'ready' });
    jobService.getJobForUser.mockResolvedValue({ status: 'ready' });
    matchService.createMatchJob.mockResolvedValue({ id: 'match-job-1', status: 'queued' });

    const res = await request(app)
      .post('/api/v1/matches')
      .send({ resumeId: 'r1', jobId: 'j1' });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('id', 'match-job-1');
    expect(queues.computeMatch.add).toHaveBeenCalledWith(
      'computeMatch',
      expect.objectContaining({ matchJobId: 'match-job-1', resumeId: 'r1', jobId: 'j1' })
    );
  });
});
