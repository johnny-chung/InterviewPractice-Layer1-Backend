// Layer1 API entrypoint: wires HTTP handlers to background workers and shared config.
const config = require('./config');
const { bootstrapDatabase } = require('./db');
const { startWorkers } = require('./queues');
const { ensureStorageStructure } = require('./utils/storage');
const { log, error } = require('./utils/logger');
const { buildApp } = require('./app');

async function main() {
  await bootstrapDatabase(); // Runs schema bootstrap so tables exist on cold start.
  ensureStorageStructure(); // Creates deterministic disk layout for uploads.
  startWorkers(); // Kick BullMQ workers before API to avoid queue backlog on first requests.

  const app = buildApp();

  app.listen(config.port, () => log(`Server listening on :${config.port}`));
}

main().catch((e) => {
  error('Fatal', e);
  process.exit(1);
});
