'use strict';

// A tiny in-process concurrency gate.
//
// The same shape appears wherever a burst of requests would each grab an expensive resource
// at once — a throwaway headless browser (each ~150-300 MB), or a local model generation that
// saturates the single Ollama process. Without a cap, a script firing many requests in
// parallel spawns dozens of those at once and drives the process into swap or an out-of-memory
// crash, or stalls every other caller behind a saturated model. This centralizes that gate so
// each site declares only its limits, not the queueing logic.
//
// A semaphore allows up to `max` holders at once. Beyond that, callers wait in a bounded FIFO
// queue; when the queue is full, `acquire()` rejects immediately so excess work fails fast with
// backpressure rather than piling up unbounded. A freed slot is handed straight to the next
// waiter, so throughput stays at the cap without a scheduling gap.
//
//   const gate = createSemaphore({ max: 2, queueMax: 24, message: 'Too busy — retry shortly' });
//   await gate.acquire(); try { /* work */ } finally { gate.release(); }
//   // or, self-balancing:
//   await gate.run(async () => { /* work */ });   // always releases, even on throw

// Create a semaphore. `max` is the number of concurrent holders (clamped to >= 1). `queueMax`
// bounds the wait queue (default 0 means unbounded — every caller waits its turn, none is
// rejected). `message` is the Error text used when the queue is saturated.
function createSemaphore({ max = 1, queueMax = 0, message } = {}) {
  const limit = Math.max(1, Math.floor(max) || 1);
  const qMax = Math.max(0, Math.floor(queueMax) || 0);
  const msg = message || 'Too many requests in progress — try again shortly';
  let slots = limit;
  const waiters = [];

  // Take a slot. Resolves when one is free; rejects immediately when the wait queue is full
  // (only when queueMax > 0). Never throws synchronously — always returns a promise.
  const acquire = () => new Promise((resolve, reject) => {
    if (slots > 0) { slots -= 1; resolve(); return; }
    // Tag the queue-full rejection so a caller can tell transient backpressure apart from a real error
    // (e.g. to record it as "skipped/busy" rather than a failure). Existing catch-all handlers ignore it.
    if (qMax > 0 && waiters.length >= qMax) { const err = new Error(msg); err.backpressure = true; reject(err); return; }
    waiters.push(resolve);
  });

  // Return a slot. Hands it straight to the next waiter if any, otherwise restores it.
  // Guards against over-release (more releases than acquires) so a double-release can't push
  // the live count above the limit.
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else if (slots < limit) slots += 1;
  };

  // Run `fn` while holding a slot, releasing it no matter how `fn` settles. Returns fn's result.
  const run = async (fn) => {
    await acquire();
    try { return await fn(); }
    finally { release(); }
  };

  // A read-only snapshot, for diagnostics/tests.
  const stats = () => ({ limit, available: slots, waiting: waiters.length });

  return { acquire, release, run, stats };
}

module.exports = { createSemaphore };
