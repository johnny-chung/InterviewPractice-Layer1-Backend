const request = require("supertest");

jest.mock("../src/services/user-service", () => ({
  ensureUser: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock("../src/services/job-service", () => ({
  getJobForUser: jest.fn(),
}));

const { buildApp } = require("../src/app");
const userService = require("../src/services/user-service");
const jobService = require("../src/services/job-service");

describe("Job detail soft skills + inferred filter", () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    userService.getUserId.mockResolvedValue("user-1");
  });

  it("includes soft_skills array and returns requirements already filtered", async () => {
    // Provide job with mixed inferred requirements (some below threshold) - backend worker should have filtered already.
    jobService.getJobForUser.mockResolvedValue({
      id: "job-1",
      status: "ready",
      title: "Engineer",
      source: "text",
      parsed_summary: { highlights: [], overview: null },
      requirements: [
        {
          id: "r1",
          skill: "python",
          importance: 0.9,
          inferred: 0,
          created_at: new Date().toISOString(),
        },
        {
          id: "r2",
          skill: "kubernetes",
          importance: 0.8,
          inferred: 1,
          created_at: new Date().toISOString(),
        },
      ],
      soft_skills: [
        {
          id: "s1",
          skill: "communication",
          importance: 0.9,
          created_at: new Date().toISOString(),
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const res = await request(app).get("/api/v1/jobs/job-1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("soft_skills");
    expect(Array.isArray(res.body.soft_skills)).toBe(true);
    expect(res.body.soft_skills.length).toBe(1);
    expect(res.body.soft_skills[0].skill).toBe("communication");
    // Ensure requirements passed through unchanged by controller (worker already filtered low ones)
    expect(res.body.requirements.length).toBe(2);
  });
});
