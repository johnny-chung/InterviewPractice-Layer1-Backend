const request = require('supertest');

jest.mock('../src/services/user-service', () => ({
  ensureUser: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock('../src/services/job-service', () => ({
  createJobRecord: jest.fn(),
  updateJobStoragePath: jest.fn(),
  updateJobStatus: jest.fn(),
  getJobForUser: jest.fn(),
  listJobs: jest.fn(),
  deleteJobRequirements: jest.fn(),
}));

const { buildApp } = require('../src/app');
const { queues } = require('../src/queues');
const userService = require('../src/services/user-service');
const jobService = require('../src/services/job-service');

describe('Job routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    userService.ensureUser.mockResolvedValue({ id: 'user-1' });
    userService.getUserId.mockResolvedValue('user-1');
    jobService.createJobRecord.mockResolvedValue({ id: 'job-1', status: 'queued' });
    jobService.updateJobStatus.mockResolvedValue();
  });

  it('returns 400 when no file or text provided', async () => {
    const res = await request(app).post('/api/v1/jobs');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'file_or_text_required');
  });

  it('queues job parsing when text is provided', async () => {
    const res = await request(app)
      .post('/api/v1/jobs')
      .send({ title: 'Engineer', text: 'Looking for Python skills' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('id');
    expect(typeof res.body.id).toBe('string');
    expect(queues.parseJob.add).toHaveBeenCalledWith(
      'parseJob',
      expect.objectContaining({ jobId: expect.any(String), source: 'text' })
    );
  });
});
