'use strict';

// lib/queue.js — concurrency-limited async queue.
//
// Tasks are enqueued as functions returning a Promise. At most `concurrency`
// tasks run at once; the rest wait their turn. Each task's own Promise resolves
// or rejects independently — a failed task never blocks the queue from draining.
//
// Lokyni has no job queue today: indexing and connector syncs run ad-hoc. As
// connectors multiply, running several syncs at once would spawn several MCP
// servers simultaneously and hammer the machine. A shared queue with
// concurrency 1–2 serializes that work without blocking the event loop.
//
//   const q = create({ concurrency: 1 });
//   const result = await q.enqueue(() => syncConnector(ws, id));
//   q.pending()  -> tasks waiting + running
//
// A small, dependency-free async concurrency queue; logs via console.
//
// A note on cancellation: a WAITING task can be removed with cancel(cancelKey). A
// task that has already STARTED can't be pulled out here — stop those
// cooperatively (e.g. by closing the connection or killing the process it spawned).

function create({ concurrency = 1 } = {}) {
  const limit = Math.max(1, concurrency);
  let active = 0;
  const waiting = [];

  function next() {
    if (active >= limit || waiting.length === 0) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(
        (result) => resolve(result),
        (err) => {
          // Log real failures but keep the queue draining. A cancellation is
          // expected, not an error — don't log it.
          if (!(err && err.canceled)) {
            try { console.error('[queue] task error:', (err && err.message) || String(err)); } catch (_) {}
          }
          reject(err);
        }
      )
      .finally(() => { active--; next(); });
  }

  // Enqueue a task. Optional cancelKey lets a still-WAITING task be removed before
  // it starts (see cancel()).
  const enqueue = (fn, cancelKey) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject, cancelKey });
    next();
  });

  // Cancel a WAITING task by its cancelKey: remove it and reject its promise with
  // a cancellation error. Returns true if a waiting task was found. No effect on a
  // task already running.
  const cancel = (cancelKey) => {
    if (cancelKey == null) return false;
    const idx = waiting.findIndex(w => w.cancelKey === cancelKey);
    if (idx === -1) return false;
    const { reject } = waiting.splice(idx, 1)[0];
    const err = new Error('Canceled'); err.canceled = true;
    reject(err);
    return true;
  };

  const pending = () => active + waiting.length;   // running + waiting
  const queued  = () => waiting.length;            // waiting only
  const running = () => active;

  return { enqueue, cancel, pending, queued, running };
}

module.exports = { create };
