// Simple global event bus used to decouple DB status updates from realtime transport.
const { EventEmitter } = require("events");

// Singleton emitter instance.
const bus = new EventEmitter();

module.exports = { bus };
