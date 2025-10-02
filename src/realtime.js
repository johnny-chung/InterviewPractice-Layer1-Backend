const { bus } = require("./events/bus");
const { query } = require("./db");
const { error, log } = require("./utils/logger");
const config = require("./config");

/**
 * registerJobStatusListener
 * Bridges internal domain events -> outward websocket notifications.
 *
 * Event flow:
 *   Worker/API logic -> bus.emit('job.status.changed', { jobId })
 *   -> This listener fetches the authoritative row from DB (ensures latest status fields)
 *   -> Emits 'job:update' to the room for the owning user (user:<user_id>)
 *
 * Idempotency:
 *   To avoid accidental double registration (e.g., startServer() called twice in tests) we
 *   mark the handler with a private flag __rtListener and bail if one already exists.
 *
 * Room choice rationale:
 *   Users can have multiple browser tabs. Emitting to the per-user room ensures all open
 *   sessions update consistently without broadcasting to unrelated users.
 *
 * Error handling:
 *   - If jobId no longer exists (race/deletion) we silently ignore.
 *   - Failures (DB/network) are logged but do not throw to avoid crashing the process.
 *
 * Payload contract (job:update):
 *   {
 *     id: string,
 *     title: string,
 *     status: 'queued' | 'processing' | 'ready' | etc,
 *     createdAt: Date,
 *     updatedAt: Date
 *   }
 * Frontend should treat unknown status values defensively (feature flags / future states).
 */
function registerJobStatusListener(io) {
  const existing = bus
    .listeners("job.status.changed")
    .find((l) => l.__rtListener);
  if (existing) {
    if (config.verboseRealtimeLogs) {
      log(
        "[realtime] job.status.changed listener already registered (skipping duplicate)"
      );
    }
    return; // Already registered.
  }

  const handler = async ({ jobId }) => {
    if (config.verboseRealtimeLogs) {
      log(`[realtime] bus event job.status.changed received jobId=${jobId}`);
    }
    try {
      // Fetch job row plus user auth identity. We prefer broadcasting to a room keyed by the Auth0 subject
      // because the websocket auth middleware stores socket.data.userId = <auth0 sub>. The previous implementation
      // used the internal users.id (UUID) which meant sockets joined user:<auth0_sub> but we emitted to user:<uuid>,
      // resulting in the frontend never receiving job:update events.
      const res = await query(
        `SELECT j.id, j.user_id, j.title, j.status, j.created_at, j.updated_at, u.auth0_sub
         FROM job_descriptions j
         LEFT JOIN users u ON u.id = j.user_id
         WHERE j.id = $1`,
        [jobId]
      );
      if (!res.rows.length) return; // Nothing to broadcast.
      const row = res.rows[0];
      const payload = {
        id: row.id,
        title: row.title,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      // Determine room strictly from auth0_sub (JWT sub). If absent, skip emit—data model should ensure presence.
      if (!row.auth0_sub) {
        if (config.verboseRealtimeLogs) {
          log(
            `[realtime] SKIP emit job:update jobId=${row.id} (missing auth0_sub; ensure user row populated)`
          );
        }
        return;
      }
      if (config.verboseRealtimeLogs) {
        log(
          `[realtime] emitting job:update to room user:${row.auth0_sub} status=${row.status}`
        );
      }
      io.to(`user:${row.auth0_sub}`).emit("job:update", payload);
    } catch (e) {
      error("Realtime emit failed", e);
    }
  };
  handler.__rtListener = true; // Flag so we can detect duplicates later.
  bus.on("job.status.changed", handler);
  if (config.verboseRealtimeLogs) {
    log(
      "[realtime] Registered job.status.changed -> job:update bridge listener"
    );
  }
}

/**
 * Generic helper to register a status listener for a table with a given event & emit name.
 * We intentionally keep this simple (no duplicate suppression beyond __rtListener flag).
 */
function registerSimpleStatusListener({
  io,
  busEvent,
  emitEvent,
  selectSQL,
  idField = "id",
  listenerFlag,
  verboseLabel,
}) {
  const existing = bus
    .listeners(busEvent)
    .find((l) => l.__rtListener === listenerFlag);
  if (existing) {
    if (config.verboseRealtimeLogs) {
      log(
        `[realtime] ${busEvent} listener already registered (skipping duplicate)`
      );
    }
    return;
  }
  const handler = async (payload) => {
    const entityId = payload[idField];
    try {
      const res = await query(selectSQL, [entityId]);
      if (!res.rows.length) return;
      const row = res.rows[0];
      if (!row.auth0_sub) return;
      const emitPayload = {
        id: row.id,
        status: row.status,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
      };
      if (row.title) emitPayload.title = row.title; // jobs compatibility
      const room = `user:${row.auth0_sub}`;
      if (config.verboseRealtimeLogs) {
        log(
          `[realtime] preparing emit ${emitEvent} ${
            verboseLabel || ""
          } room=${room} id=${row.id} status=${row.status}`
        );
      }
      io.to(room).emit(emitEvent, emitPayload);
      if (config.verboseRealtimeLogs) {
        log(
          `[realtime] emitted ${emitEvent} ${
            verboseLabel || ""
          } room=${room} id=${row.id} status=${row.status}`
        );
      }
    } catch (e) {
      error(`Realtime emit failed for ${busEvent}`, e);
    }
  };
  handler.__rtListener = listenerFlag;
  bus.on(busEvent, handler);
  if (config.verboseRealtimeLogs) {
    log(`[realtime] Registered ${busEvent} -> ${emitEvent} bridge listener`);
  }
}

function registerResumeStatusListener(io) {
  registerSimpleStatusListener({
    io,
    busEvent: "resume.status.changed",
    emitEvent: "resume:update",
    listenerFlag: "resume",
    verboseLabel: "resume",
    selectSQL: `SELECT r.id, r.status, r.created_at, r.updated_at, u.auth0_sub
                FROM resumes r
                LEFT JOIN users u ON u.id = r.user_id
                WHERE r.id = $1`,
  });
}

function registerMatchStatusListener(io) {
  registerSimpleStatusListener({
    io,
    busEvent: "match.status.changed",
    emitEvent: "match:update",
    listenerFlag: "match",
    verboseLabel: "match",
    // Use match_jobs for status progression (queued -> processing -> completed) and join users for auth0_sub.
    selectSQL: `SELECT mj.id, mj.status, mj.created_at, mj.updated_at, u.auth0_sub
                FROM match_jobs mj
                LEFT JOIN users u ON u.id = mj.user_id
                WHERE mj.id = $1`,
  });
}

module.exports = {
  registerJobStatusListener,
  registerResumeStatusListener,
  registerMatchStatusListener,
};
