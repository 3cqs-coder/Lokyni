'use strict';

// ── workerrpc — one supervisor for every long-lived worker_thread ────────────
//
// A CPU-heavy task that runs on the main thread stalls everything else the process is
// doing at that moment — the socket status stream, other in-flight queries, the MCP
// endpoint. The fix is to run it in a worker_thread, but a persistent worker that is
// reused across many requests needs a careful lifecycle that is easy to get subtly
// wrong, so it lives here ONCE and cannot drift between callers:
//
//   • an identity guard: a dead worker's late error/exit is ignored unless it is still
//     the current worker, so it can neither reset a successor a concurrent call already
//     spawned nor double-count a single crash;
//   • crash counting with a cap and cooldown — a worker that keeps dying pauses
//     spawning for a while so callers fall back to inline work (or skip the feature)
//     instead of respawning on every request, and any successful reply clears the streak;
//   • request/reply correlation by id with a per-request timeout;
//   • unref() so neither the worker nor a pending request's timeout timer keeps the
//     process alive on its own; a shutdown() rejects any in-flight calls and terminates
//     the worker (relied on for orderly teardown, since nothing else holds them open);
//   • an optional availability gate and message/reset hooks.
//
// What VARIES stays with the caller: the worker code and its options, and how a failure
// is surfaced. request() REJECTS on timeout / worker death / unavailability and RESOLVES
// with the worker's raw message (which may itself carry an { error }); the caller decides
// what that means for its feature. Messages with no matching pending id — e.g. a
// background init reply — are handed to the optional onMessage hook.
//
// Cross-platform: worker_threads works the same on macOS, Linux, and Windows.

const { Worker } = require('worker_threads');

class WorkerRpc {
  // opts:
  //   name           label used in error messages
  //   code           worker source string (run with eval: true)
  //   workerData()   function returning fresh workerData for each spawn (so paths are
  //                  resolved at spawn time, not module-load time)
  //   resourceLimits Worker resourceLimits (e.g. a heap cap)
  //   maxFails       consecutive deaths before the cooldown (default 3)
  //   cooldownMs     spawn pause after maxFails (default 60s)
  //   timeoutMs      default per-request timeout (default 8s)
  //   available      optional () => bool gate; when it returns false, ensure() yields null
  //   onMessage      optional (m) => void for messages with no waiting request
  //   onReset        optional (reason) => void run whenever the worker is dropped, so a
  //                  caller can clear its own per-worker latches (e.g. a "model ready" flag)
  constructor({ name, code, workerData = () => ({}), resourceLimits, maxFails = 3, cooldownMs = 60000, timeoutMs = 8000, available = null, onMessage = null, onReset = null } = {}) {
    this.name            = name || 'worker';
    this._code           = code;
    this._workerData     = workerData;
    this._resourceLimits = resourceLimits;
    this._maxFails       = maxFails;
    this._cooldownMs     = cooldownMs;
    this._timeoutMs      = timeoutMs;
    this._available      = available;
    this._onMessage      = onMessage;
    this._onReset        = onReset;
    this._worker         = null;
    this._seq            = 0;
    this._failCount      = 0;
    this._disabledUntil  = 0;
    this._pending        = new Map(); // id -> { resolve, reject, timer }
  }

  alive() { return !!this._worker; }

  // True while any request is in flight. Lets an idle-release timer defer teardown rather than reject a
  // request mid-work (a model release must never cancel a synthesis/transcription that is already running).
  hasPending() { return this._pending.size > 0; }

  _reset(reason) {
    this._worker = null;
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this._pending.clear();
    if (this._onReset) { try { this._onReset(reason); } catch (_) {} }
  }

  _onDead(reason) {
    this._reset(reason);
    if (++this._failCount >= this._maxFails) this._disabledUntil = Date.now() + this._cooldownMs;
  }

  // Return the live worker, spawning one if needed. Yields null when the availability
  // gate says no, or while the post-crash cooldown is in effect, so callers degrade
  // instead of hammering a broken worker.
  ensure() {
    if (this._worker) return this._worker;
    if (this._available && !this._available()) return null;
    if (Date.now() < this._disabledUntil) return null;
    try {
      const w = new Worker(this._code, { eval: true, workerData: this._workerData(), resourceLimits: this._resourceLimits });
      w.on('message', (m) => {
        // A healthy reply from the CURRENT worker clears the failure streak; a late reply
        // from an already-replaced worker must not reset the successor's streak.
        if (m && !m.error && this._worker === w) this._failCount = 0;
        const p = m ? this._pending.get(m.id) : undefined;
        if (!p) { if (this._onMessage) { try { this._onMessage(m); } catch (_) {} } return; }
        this._pending.delete(m.id); clearTimeout(p.timer);
        p.resolve(m);
      });
      // A crash emits 'error' and then 'exit'. Count the death on whichever fires first
      // for THIS worker (via _onDead, which nulls _worker); the identity guard then makes
      // the second event a no-op, so a single crash is counted exactly once — and a normal
      // shutdown (which nulls _worker before terminate) is not counted at all.
      w.on('error', () => { if (this._worker === w) this._onDead(`${this.name} worker error`); });
      w.on('exit',  () => { if (this._worker === w) this._onDead(`${this.name} worker exited`); });
      w.unref();
      this._worker = w;
    } catch (_) {
      // A spawn-time failure is a death too: count it and apply the cooldown once the cap
      // is hit, so a broken worker path can't be retried on every single request.
      this._worker = null;
      if (++this._failCount >= this._maxFails) this._disabledUntil = Date.now() + this._cooldownMs;
    }
    return this._worker;
  }

  // Fire-and-forget message to an EXISTING worker (never spawns one). Returns true if
  // it was posted.
  post(msg) {
    if (!this._worker) return false;
    try { this._worker.postMessage(msg); return true; } catch (_) { return false; }
  }

  // Request/reply. Resolves with the worker's message; rejects on timeout (error has
  // .timeout = true), worker death, or the worker being unavailable. An `id` is added
  // to the posted payload for correlation — do not set one yourself.
  request(payload, { timeoutMs = this._timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const w = this.ensure();
      // Tagged so a caller can tell "no worker was available to take the job" (where running the work inline
      // is the correct fallback) apart from a timeout or a worker DEATH on a job that WAS dispatched (where
      // re-running inline could repeat the same stall or OOM crash on the main thread).
      if (!w) return reject(Object.assign(new Error(`${this.name} worker unavailable`), { unavailable: true }));
      const id = ++this._seq;
      const timer = setTimeout(() => {
        const p = this._pending.get(id);
        if (!p) return;
        this._pending.delete(id);
        reject(Object.assign(new Error(`${this.name} timeout`), { timeout: true }));
        // A blown deadline means the worker is hung (not merely slow to reply): terminate it so a
        // genuinely stuck worker is replaced and enters the post-failure cooldown, instead of every
        // later request paying the full timeout against the same wedged worker. _onDead nulls the
        // worker and rejects any other in-flight calls; the identity-guarded exit handler then
        // no-ops, so the death is counted once.
        const w = this._worker;
        if (w) { this._onDead(`${this.name} worker timed out`); try { w.terminate(); } catch (_) {} }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      try { w.postMessage({ id, ...payload }); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  // Reject any in-flight calls and terminate the worker. Safe to call more than once.
  shutdown(reason) {
    const w = this._worker;
    this._reset(reason || `${this.name} shutdown`);
    if (w) { try { w.terminate(); } catch (_) {} }
  }
}

module.exports = { WorkerRpc };
