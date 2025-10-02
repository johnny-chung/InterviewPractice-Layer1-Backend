// Thin wrapper delegating to the reusable startServer() implementation.
// All initialization (DB bootstrap, workers, Socket.IO, realtime listeners) lives in start.js.
// This file remains the npm script entrypoint (see package.json) to keep existing tooling/Docker unchanged.
const { startServer } = require("./start");

startServer().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("Fatal", e);
  process.exit(1);
});
