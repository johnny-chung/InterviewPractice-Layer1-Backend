const request = require("supertest");

jest.mock("fs/promises", () => ({
  rename: jest.fn().mockResolvedValue(),
}));

jest.mock("../src/services/user-service", () => ({
  ensureUser: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock("../src/services/resume-service", () => ({
  createResume: jest.fn(),
  updateResumeStoragePath: jest.fn(),
  updateResumeStatus: jest.fn(),
  getResumeForUser: jest.fn(),
  listResumes: jest.fn(),
  replaceResumeSkills: jest.fn(),
}));

jest.mock("../src/utils/object-storage", () => ({
  putObject: jest.fn().mockResolvedValue(),
  getObjectBytes: jest.fn(),
}));

const { buildApp } = require("../src/app");
const { queues } = require("../src/queues");
const userService = require("../src/services/user-service");
const resumeService = require("../src/services/resume-service");
const fs = require("fs/promises");

describe("Resume routes", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    userService.ensureUser.mockResolvedValue({ id: "user-1" });
    userService.getUserId.mockResolvedValue("user-1");
    resumeService.createResume.mockResolvedValue({
      id: "resume-1",
      status: "queued",
    });
    resumeService.updateResumeStoragePath.mockResolvedValue();
    resumeService.updateResumeStatus.mockResolvedValue();
  });

  it("returns 400 when file is missing", async () => {
    const res = await request(app).post("/api/v1/resumes");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "file is required");
  });

  it("queues resume parsing job on successful upload", async () => {
    const res = await request(app)
      .post("/api/v1/resumes")
      .attach("file", Buffer.from("Sample resume"), "resume.txt");

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("id");
    expect(typeof res.body.id).toBe("string");
    expect(res.body).toHaveProperty("status", "queued");
    // expect putObject called (R2 upload)
    const { putObject } = require("../src/utils/object-storage");
    expect(putObject).toHaveBeenCalled();
    expect(queues.parseResume.add).toHaveBeenCalledWith(
      "parseResume",
      expect.objectContaining({ resumeId: expect.any(String) })
    );
  });
});
