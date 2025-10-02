const request = require("supertest");

jest.mock("../src/services/user-service", () => ({
  ensureUser: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock("../src/services/job-service", () => ({
  createJobRecord: jest.fn(),
  updateJobStatus: jest.fn(),
  getJobForUser: jest.fn(),
  listJobs: jest.fn(),
  softDeleteJob: jest.fn(),
}));

jest.mock("../src/services/resume-service", () => ({
  createResume: jest.fn(),
  updateResumeStatus: jest.fn(),
  getResumeForUser: jest.fn(),
  listResumes: jest.fn(),
  softDeleteResume: jest.fn(),
}));

const { buildApp } = require("../src/app");
const userService = require("../src/services/user-service");
const jobService = require("../src/services/job-service");
const resumeService = require("../src/services/resume-service");

describe("Soft delete behavior", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    userService.getUserId.mockResolvedValue("user-1");
    userService.ensureUser.mockResolvedValue({ id: "user-1" });
  });

  describe("Jobs", () => {
    it("DELETE /jobs/:id invokes soft delete service and returns 204", async () => {
      jobService.getJobForUser.mockResolvedValue({
        id: "job-123",
        user_id: "user-1",
      });
      const res = await request(app).delete("/api/v1/jobs/job-123");
      expect(res.status).toBe(204);
      expect(jobService.softDeleteJob).toHaveBeenCalledWith(
        "job-123",
        "user-1"
      );
    });

    it("List excludes deleted items (service already filtered)", async () => {
      jobService.listJobs.mockResolvedValue([
        {
          id: "active-job",
          title: "Active",
          status: "ready",
          source: "text",
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      ]);
      const res = await request(app).get("/api/v1/jobs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("active-job");
    });
  });

  describe("Resumes", () => {
    it("DELETE /resumes/:id invokes soft delete service and returns 204", async () => {
      resumeService.getResumeForUser.mockResolvedValue({
        id: "resume-123",
        user_id: "user-1",
      });
      const res = await request(app).delete("/api/v1/resumes/resume-123");
      expect(res.status).toBe(204);
      expect(resumeService.softDeleteResume).toHaveBeenCalledWith(
        "resume-123",
        "user-1"
      );
    });

    it("List excludes deleted items (service already filtered)", async () => {
      resumeService.listResumes.mockResolvedValue([
        {
          id: "active-resume",
          filename: "cv.pdf",
          mime_type: "application/pdf",
          status: "ready",
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
        },
      ]);
      const res = await request(app).get("/api/v1/resumes");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("active-resume");
    });
  });
});
