// BullMQ queue wiring: defines shared connection and worker bootstrap logic.
const IORedis = require("ioredis");
const { Queue, Worker, QueueEvents } = require("bullmq");
const config = require("./config");
const { log, error } = require("./utils/logger");
const {
  processParseResume,
  processParseJob,
  processComputeMatch,
} = require("./workers");

/**
 * Shared IORedis connection instance passed to all BullMQ primitives to avoid multiple TCP sockets.
 * maxRetriesPerRequest set to null per BullMQ recommendation for blocking commands.
 */
const connection = new IORedis(config.redisUrl, {
  // BullMQ requires blocking connections to opt-out of command retries.
  maxRetriesPerRequest: null,
});

const queues = {
  // Exported so controllers can enqueue jobs without new connections.
  // parseResume: accepts { resumeId, storagePath, filename, mimeType, userId }
  // parseJob: accepts { jobId, source, storagePath?, filename?, mimeType, rawText?, userId }
  // computeMatch: accepts { matchJobId, resumeId, jobId, userId }
  // Each processor defined in workers.js updates DB status rows.
  parseResume: new Queue("parseResume", { connection }),
  parseJob: new Queue("parseJob", { connection }),
  computeMatch: new Queue("computeMatch", { connection }),
};

function wireQueueEvents(queueName) {
  /**
   * wireQueueEvents
   * Subscribes to queue-level events for diagnostics (failed, stalled, error).
   * @param {string} queueName BullMQ queue name
   * @returns {QueueEvents}
   */
  const events = new QueueEvents(queueName, { connection });
  events.on("failed", ({ jobId, failedReason }) => {
    error(`Queue ${queueName} job ${jobId} failed`, failedReason);
  });
  events.on("stalled", ({ jobId }) => {
    log(
      `Queue ${queueName} job ${jobId} stalled; BullMQ will retry automatically`
    );
  });
  events.on("error", (err) => error(`QueueEvents error for ${queueName}`, err));
  return events;
}

function startWorkers() {
  // Called during boot to ensure background processors attach immediately.
  /**
   * startWorkers
   * Instantiates Worker instances binding queue names to processor functions (see workers.js).
   * Side effects: begins consuming jobs immediately; logs startup.
   */
  wireQueueEvents("parseResume");
  wireQueueEvents("parseJob");
  wireQueueEvents("computeMatch");

  new Worker("parseResume", processParseResume, { connection }); // Resume parser invokes FastAPI to populate candidate skills.
  new Worker("parseJob", processParseJob, { connection }); // Job parser extracts requirements then stores them.
  new Worker("computeMatch", processComputeMatch, { connection }); // Match engine consolidates results into matches + match_jobs tables.

  log("BullMQ workers started");
}

module.exports = { queues, startWorkers };
