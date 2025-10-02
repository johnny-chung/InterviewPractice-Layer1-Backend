// Realtime bridge unit tests: verify that registerJobStatusListener listens to bus and emits via io

const { bus } = require("../src/events/bus");
const { registerJobStatusListener } = require("../src/realtime");
const { query } = require("../src/db");

function createFakeIo() {
  const emits = [];
  return {
    to: (room) => ({
      emit: (event, payload) => emits.push({ room, event, payload }),
    }),
    _emits: emits,
  };
}

describe("registerJobStatusListener", () => {
  afterEach(() => {
    bus.removeAllListeners("job.status.changed");
    jest.clearAllMocks();
  });

  it("emits job:update with DB row to user room", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: "job-123",
          user_id: "user-1",
          auth0_sub: "dev|user",
          title: "Engineer",
          status: "processing",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:05:00Z",
        },
      ],
    });
    const io = createFakeIo();
    registerJobStatusListener(io);
    bus.emit("job.status.changed", { jobId: "job-123" });
    await Promise.resolve();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM job_descriptions"),
      ["job-123"]
    );
    expect(io._emits).toHaveLength(1);
    expect(io._emits[0]).toMatchObject({
      room: "user:dev|user",
      event: "job:update",
      payload: { id: "job-123", status: "processing" },
    });
  });

  it("is idempotent when called multiple times (single emit)", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: "job-123",
          user_id: "user-1",
          auth0_sub: "dev|user",
          title: "Engineer",
          status: "processing",
        },
      ],
    });
    const io = createFakeIo();
    registerJobStatusListener(io);
    registerJobStatusListener(io);
    bus.emit("job.status.changed", { jobId: "job-123" });
    await Promise.resolve();
    expect(io._emits).toHaveLength(1);
  });
});
