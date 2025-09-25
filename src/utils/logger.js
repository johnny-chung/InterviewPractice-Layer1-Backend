// Minimal logger wrapper: timestamps console output for easier job tracing.
function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function error(...args) {
  console.error(new Date().toISOString(), '-', ...args);
}

module.exports = { log, error };
