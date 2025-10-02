const request = require("supertest");
const { buildApp } = require("../src/app");

describe("GET /health", () => {
  test("returns ok without auth when auth disabled", async () => {
    process.env.AUTH_DISABLED = "true";
    const app = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("returns ok without auth even when auth enabled (public route)", async () => {
    process.env.AUTH_DISABLED = "false";
    const app = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
