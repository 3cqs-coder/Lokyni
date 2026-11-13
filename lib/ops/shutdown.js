'use strict';

// Centralized graceful shutdown.
//
// On Ctrl-C / kill / crash, Node exits but the long-lived resources this process
// holds do NOT tear down on their own: the tesseract OCR worker pool (child
// processes each holding a WASM instance + language data), the chokidar file
// watchers, and any puppeteer browsers spawned for URL ingestion. Left behind they
// orphan — stale processes eating RAM, file handles held, a port still bound under a
// process manager that restarts on SIGTERM. This module tears everything down on the
// way out, from every exit path, exactly once.
//
// Design (mirrors a proven pattern): one re-entrancy-guarded runner, an ordered
// teardown (stop taking new work first, then kill workers, then browsers, then flush
// caches to disk), wired to SIGINT, SIGTERM, uncaughtException, and — as a last-ditch
// synchronous sweep — 'exit'. Each step is independently wrapped so one failure can't
// prevent the rest.

let _shuttingDown = false;
let _handlersInstalled = false;
let _exiting = false;   // set by the first gracefulExit; later calls are no-ops so they can't force-exit early

// The hard cap on how long a graceful teardown may run before the process is force-exited. Exported so
// callers that must outlast a graceful shutdown (e.g. the data-directory lock's handoff wait) can key off
// it rather than guessing a literal that could drift from this value.
const HARD_TIMEOUT_MS = 8000;

// Each task: a label (for logging) and an async fn. Ordered — earlier tasks run
// first. Kept data-driven so a future resource is one push, not another edit to the
// signal wiring below.
const asyncTasks = [];
// Synchronous best-effort versions for the 'exit' path (async work can't run there).
const syncTasks = [];
// Synchronous, idempotent force-kills of owned child PROCESSES. Unlike syncTasks these run
// UNCONDITIONALLY on the 'exit' event — even when a graceful shutdown already ran or timed out — so a
// spawned process that does not die with the parent (a Chromium) can never be orphaned on ANY exit
// path. They must be safe to run more than once (killing an already-dead process is a no-op).
const exitKills = [];

// Register a resource to tear down. `fn` may be async. `syncFn` is an optional
// synchronous best-effort fallback used only on the 'exit' event, where the event
// loop is already stopping and promises won't resolve.
function register(label, fn, syncFn) {
  if (typeof fn === 'function') asyncTasks.push({ label, fn });
  if (typeof syncFn === 'function') syncTasks.push({ label, fn: syncFn });
}

// Register a synchronous, idempotent child-process kill that ALWAYS runs on 'exit' (the guaranteed
// no-orphan backstop). Use this for a spawned process that would outlive an unexpected parent exit.
function onExitKill(fn) { if (typeof fn === 'function') exitKills.push(fn); }
function runExitKills() {
  for (const fn of exitKills) {
    try { fn(); } catch (e) { try { console.error(`  ⚠️  exit-kill failed: ${e && e.message ? e.message : e}`); } catch { /* ignore */ } }
  }
}

// Run the full ordered teardown once. Safe to call from a signal handler or directly.
// Returns a promise that resolves when every task has settled (each is individually
// guarded, so one rejection never blocks the others).
async function shutdownAll(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;

  try { console.log(`\n🛑 Lokyni shutting down (${reason})…`); } catch { /* stdout may be gone */ }

  for (const { label, fn } of asyncTasks) {
    try {
      await fn();
    } catch (e) {
      try { console.error(`  ⚠️  shutdown step "${label}" failed: ${e && e.message ? e.message : e}`); } catch { /* ignore */ }
    }
  }
}

// Synchronous last-ditch sweep for the 'exit' event. Only runs tasks that registered
// a sync fallback; async-only resources were already handled on the signal path in
// normal shutdowns. This exists for the abnormal path (a process.exit() elsewhere)
// where no signal handler ran first.
function shutdownAllSync() {
  if (_shuttingDown) {
    // A normal shutdown already ran (or is running) the async tasks; the sync sweep
    // would double-run them. Only worth doing when nothing has run yet.
    return;
  }
  _shuttingDown = true;
  for (const { label, fn } of syncTasks) {
    try { fn(); } catch (e) {
      try { console.error(`  ⚠️  sync shutdown step "${label}" failed: ${e && e.message ? e.message : e}`); } catch { /* ignore */ }
    }
  }
}

function gracefulExit(reason, code) {
  // Idempotent: only the FIRST call drives the exit. The desktop shell sends two stop channels on
  // Unix (a "quit" line AND SIGTERM), and an impatient user can double Ctrl-C — each would call
  // this again. Without this guard the second call's shutdownAll() returns immediately (it sees
  // _shuttingDown already set) and its .finally() would process.exit() before the first call's
  // async teardown — the cache flushes and worker cleanup — had a chance to finish.
  if (_exiting) return;
  _exiting = true;
  // Signals give us a tick to do async cleanup before exiting. Guard with a hard
  // timeout so a hung teardown (e.g. a wedged child) can't leave the process stuck —
  // we'd rather exit slightly dirty than never exit. (HARD_TIMEOUT_MS is module-scoped and exported.)
  let exited = false;
  const doExit = () => { if (!exited) { exited = true; process.exit(code); } };

  const timer = setTimeout(() => {
    try { console.error('  ⚠️  shutdown timed out — forcing exit'); } catch { /* ignore */ }
    doExit();
  }, HARD_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  shutdownAll(reason).finally(() => { clearTimeout(timer); doExit(); });
}

// Wire the handlers exactly once. Idempotent so multiple requires / a re-init can't
// stack duplicate listeners.
function install() {
  if (_handlersInstalled) return;
  _handlersInstalled = true;

  process.on('SIGINT',  () => gracefulExit('SIGINT', 130));
  process.on('SIGTERM', () => gracefulExit('SIGTERM', 143));
  // Under a process manager that signals shutdown over IPC rather than a POSIX signal
  // (pm2 on Windows sends a 'shutdown' message), tear down gracefully too.
  process.on('message', (msg) => { if (msg === 'shutdown') gracefulExit('shutdown message', 143); });

  // Last-ditch synchronous sweep for any other exit route (a process.exit() elsewhere) where no
  // signal handler ran, followed by the UNCONDITIONAL child-process kills. The exit-kills run on
  // every exit path — including after a graceful shutdown or a shutdown that hit its hard timeout
  // mid-close — so an owned child process (a Chromium) can never be orphaned. They are idempotent,
  // so running them after a clean close is harmless.
  process.on('exit', () => { shutdownAllSync(); runExitKills(); });

  // A stray uncaught exception or unhandled rejection in ANY subsystem — a background
  // automation, URL ingestion, OCR, a socket handler — must NOT take the whole server
  // down: the web UI, open conversations, and in-flight indexing all keep working. So
  // both are logged and the process KEEPS RUNNING. This is safe here because every store
  // is written atomically and the index self-heals, so continuing can't corrupt data,
  // and a genuinely bad condition still surfaces in the logs and the boot/periodic
  // watchdog. (Ctrl-C, kill, and a manager's stop still tear down cleanly, above.)
  process.on('uncaughtException', (err) => {
    try { console.error('⚠️  Uncaught exception (logged; server continues):', err && err.stack ? err.stack : err); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { console.error('⚠️  Unhandled promise rejection (logged; server continues):', (reason && reason.stack) || reason); } catch { /* ignore */ }
  });
}

module.exports = { register, onExitKill, install, shutdownAll, gracefulExit, HARD_TIMEOUT_MS };
