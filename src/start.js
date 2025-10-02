const config = require("./config");
const { bootstrapDatabase } = require("./db");
const { startWorkers } = require("./queues");
const { ensureStorageStructure } = require("./utils/storage");
const { log, error } = require("./utils/logger");
const { buildApp } = require("./app");
const http = require("http");
const { Server } = require("socket.io");
const { bus } = require("./events/bus");
const { query } = require("./db");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const {
  registerJobStatusListener,
  registerResumeStatusListener,
  registerMatchStatusListener,
} = require("./realtime");

/**
 * startServer
 * Bootstraps the HTTP + Socket.IO server and background infrastructure.
 * Structure (order matters):
 *  1. Bootstrap DB / storage / workers so application state is ready before clients connect.
 *  2. Build Express app (REST API) and wrap it in a Node HTTP server.
 *  3. Attach a Socket.IO server to the same HTTP server (shares port; ws endpoint at /socket.io).
 *  4. Configure authentication for websocket handshakes using Auth0-issued JWT (unless disabled for dev).
 *  5. On each connection, join the user to a private room (user:<userId>) so we can target events.
 *  6. Register domain-event -> realtime bridge (job.status.changed -> job:update) once (idempotent).
 *
 * About rooms:
 *  - Socket.IO lets you broadcast to groups of sockets; we create a stable room name per user.
 *  - Emitting with io.to(`user:${userId}`).emit('job:update', payload) sends only to that user's active tabs.
 *
 * Auth flow (simplified):
 *  - Client includes token in `socket.handshake.auth.token` (set in frontend getSocket())
 *  - On handshake, we verify signature & claims (issuer + audience) using remote JWKS from Auth0.
 *  - If valid, we stash the subject (sub) as socket.data.userId and proceed; else connection errors.
 *  - When AUTH_DISABLED=true we bypass verification and use a deterministic dev user id.
 *
 * Job status broadcasting pipeline:
 *  - Some worker or API logic emits an in-process event bus message: bus.emit('job.status.changed', { jobId })
 *  - registerJobStatusListener() listens once for that event, queries DB for the latest job row, and emits 'job:update'.
 *  - Frontend listens for 'job:update' to update UI / show progress.
 *
 * Error handling notes:
 *  - If auth fails, client sees a 'connect_error'. We do not crash the server—only handshake is rejected.
 *  - If DB lookup for jobId returns nothing (deleted or race) we silently ignore.
 *
 * @param {object} opts
 * @param {number} [opts.port] Optional override port (useful in tests / ephemeral instances)
 * @returns {Promise<{server: import('http').Server, io: import('socket.io').Server, port:number}>}
 */
async function startServer(opts = {}) {
  const listenPort = typeof opts.port === "number" ? opts.port : config.port;

  await bootstrapDatabase();
  ensureStorageStructure();
  startWorkers();

  const app = buildApp();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  // JWKS (JSON Web Key Set) cached instance for verifying RS256 signed JWTs from Auth0.
  // We load this lazily at startup so every websocket handshake reuses it (internal caching done by jose helper).
  let jwks = null;
  if (!config.authDisabled) {
    const issuer = config.auth0.issuerBaseURL?.replace(/\/$/, "");
    if (issuer) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    }
  }

  // Socket.IO middleware: runs before the 'connection' event. We treat this like Express auth middleware.
  // It extracts the bearer token from either the auth payload (preferred) or Authorization header.
  io.use(async (socket, next) => {
    try {
      if (config.authDisabled) {
        socket.data.userId = "dev|user";
        return next();
      }
      const authToken =
        socket.handshake.auth?.token ||
        (socket.handshake.headers["authorization"] || "").replace(
          /^Bearer\s+/i,
          ""
        );
      if (!authToken) return next(new Error("missing_token"));
      if (!jwks) return next(new Error("jwks_unavailable"));
      const { payload } = await jwtVerify(authToken, jwks, {
        issuer: config.auth0.issuerBaseURL,
        audience: config.auth0.audience,
      });
      const sub = payload.sub;
      if (!sub) return next(new Error("invalid_token"));
      socket.data.userId = sub;
      next();
    } catch (e) {
      next(new Error("auth_failed"));
    }
  });

  // Per-socket post-auth setup: place socket in its user-specific room for targeted emits.
  io.on("connection", (socket) => {
    const userRoom = `user:${socket.data.userId}`;
    socket.join(userRoom);
    if (config.verboseRealtimeLogs) {
      log(
        `[realtime] socket connected id=${socket.id} user=${socket.data.userId} joined=${userRoom}`
      );
    }
    socket.on("disconnect", (reason) => {
      if (config.verboseRealtimeLogs) {
        log(`[realtime] socket disconnected id=${socket.id} reason=${reason}`);
      }
    });
  });

  // Register realtime domain-event -> socket bridge (idempotent) so duplicate server startups in tests
  // do not register multiple listeners that would cause double emits.
  registerJobStatusListener(io);
  registerResumeStatusListener(io);
  registerMatchStatusListener(io);
  if (config.verboseRealtimeLogs) {
    log("[realtime] All status listeners registered (jobs,resumes,matches)");
  }

  await new Promise((resolve) => {
    server.listen(listenPort, () => {
      const actualPort = server.address().port;
      log(`Server listening on :${actualPort}`);
      resolve();
    });
  });

  return { server, io, port: server.address().port };
}

module.exports = { startServer };
