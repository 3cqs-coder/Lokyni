'use strict';
// One process-wide concurrency gate for MODEL-BACKED work (retrieval + reranking + generation), shared by
// every network entry point that can trigger it — the HTTP API and the MCP server. There is a single
// local model behind all of them, so the cap has to be global: without a shared gate, one surface (say a
// script hammering MCP tools) could open unbounded concurrent generations and saturate the model, stalling
// every other caller including the browser UI. Import this singleton wherever such work is dispatched and
// wrap the call in acquire()/release() (or run()). The UI socket path is intentionally not gated here — it
// serializes its own turns per connection.
const { createSemaphore } = require('./semaphore');

// max: how many generations may run at once. queueMax: how many may wait before excess requests fail fast
// with backpressure rather than piling up. Kept modest because the work is heavy and single-model-bound.
module.exports = createSemaphore({ max: 4, queueMax: 32, message: 'The server is busy — please try again shortly.' });
