'use strict';
// Parent side of the isolated document parser (see extractchild.js). Forks a child that reads
// and extracts one file under hard caps, and resolves with its result or rejects. The child
// process gives complete memory isolation: its RSS (native + off-heap, which a worker thread
// shares with the server and the OS may not even reclaim) is bounded and fully returned to the
// OS when it exits. Cross-platform — child_process.fork works the same on macOS, Windows, and
// Linux.
//
// fork runs `process.execPath <childFile>`, which requires execPath to be a real Node binary.
// That holds for a normal install and for the desktop app (its bundled runtime is a copy of
// Node). If Lokyni were ever repackaged as a single self-contained executable, this would need
// to pass the app entry plus a mode flag instead of a bare script path.

const path = require('path');
const os   = require('os');

const CHILD_FILE   = path.join(__dirname, 'extractchild.js');

// Every live parse child, so shutdown can SIGKILL them even on a force-exit. The child has its own JS-based
// self-guards (disconnect, RSS, timeout), but all of those are blocked while it is inside a long SYNCHRONOUS
// native parse — exactly the pathological case the fork exists to contain. If the parent then force-exits (a
// PID-only SIGTERM, or the shutdown hard-timeout), its per-document kill never runs and the sync-wedged child
// would outlive it. This registry + the onExitKill backstop below close that window, mirroring the unconditional
// browser kill backstop — upholding the never-orphan rule on every exit path.
const _liveChildren = new Set();
const killAllChildrenSync = () => {
  for (const c of _liveChildren) { try { c.kill('SIGKILL'); } catch (_) { /* already gone */ } }
  _liveChildren.clear();
};
const DEFAULT_MAX_MS = 120 * 1000;   // parent hard-kill deadline for one document
const MIN_RSS_MB     = 1024;         // floor for the child self-RSS budget (off-heap growth included)
const MAX_RSS_MB     = 4096;         // ceiling, so a huge-RAM host doesn't hand one child an unbounded budget
const HEAP_MB        = require('../constants').PARSE_WORKER_HEAP_MB;   // child V8 old-space cap (shared with the parse worker), via execArgv

// Size the child's memory ceiling to the host: a conservative quarter of total RAM, clamped. This lets OCR
// run more workers where there is RAM to spare and stay to a single worker on a small NAS, so a large or
// high-resolution scan is read within budget instead of overrunning it and being dropped. Kept in step with
// ocr.recommendedWorkers (~800 MB per worker), so the budget accommodates the workers that will run.
const dynamicRssMb = () => {
  let totalMb = 0; try { totalMb = Math.floor(os.totalmem() / (1024 * 1024)); } catch { /* unknown — use the floor */ }
  if (!totalMb) return MIN_RSS_MB;
  return Math.max(MIN_RSS_MB, Math.min(MAX_RSS_MB, Math.floor(totalMb * 0.25)));
};

// Only locale/tmp/PATH essentials reach the child, so a parsed document can never read the
// server's secrets (provider keys, tokens) out of the environment.
const ENV_KEEP = new Set(['path', 'home', 'tmpdir', 'temp', 'tmp', 'lang', 'lc_all', 'lc_ctype',
  'lc_messages', 'lc_numeric', 'tz', 'systemroot', 'windir', 'comspec', 'pathext', 'userprofile',
  'homedrive', 'homepath', 'appdata', 'localappdata', 'node_extra_ca_certs']);
function minimalEnv() {
  const out = {};
  for (const k of Object.keys(process.env)) { if (ENV_KEEP.has(k.toLowerCase())) out[k] = process.env[k]; }
  return out;
}

// Extract one file in an isolated child. Resolves to { kind, text, pages? } or rejects. A
// rejection from a failure to even start the child carries `forkFailed = true`, so the caller
// can fall back to an inline parse in that case (an environment without fork) while treating a
// child that started and then died/timed out as "this file is too heavy — index it by name",
// which preserves the out-of-memory guarantee.
function extractInChild(filePath, ext, opts = {}) {
  const maxMs = opts.maxMs || DEFAULT_MAX_MS;
  // Tell the child which workspace it is indexing, so any OCR result it caches lands in that
  // workspace's cache directory. A fresh child's state defaults to the default workspace, so
  // without this the cache is written to (and later read from) the wrong place — a permanent
  // read-miss that re-OCRs large scans on every warm start.
  let workspaceId = opts.workspaceId;
  if (!workspaceId) { try { workspaceId = require('../state').workspaceId; } catch { workspaceId = null; } }
  const job = {
    op: 'extract',
    args: { filePath, ext },
    workspaceId,
    ocr: opts.ocr !== false,   // a retry after a failed parse can disable OCR to capture the text layer cheaply
    // A retry can also force a smaller OCR pool (e.g. a single worker) to fit memory that a first, wider
    // attempt overran — a more robust escalation than immediately giving up on the document's content.
    ocrMaxWorkers: Number.isInteger(opts.ocrMaxWorkers) && opts.ocrMaxWorkers > 0 ? opts.ocrMaxWorkers : null,
    rssLimitMb: opts.rssLimitMb || dynamicRssMb(),
    selfTimeoutMs: maxMs,
  };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = require('child_process').fork(CHILD_FILE, [], {
        execArgv: [`--max-old-space-size=${HEAP_MB}`],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        env: minimalEnv(),
      });
    } catch (e) {
      e.forkFailed = true;
      reject(e);
      return;
    }
    // Track for the shutdown backstop; drop as soon as it exits or errors (whichever comes first).
    _liveChildren.add(child);
    const drop = () => _liveChildren.delete(child);
    child.once('exit', drop);
    child.once('error', drop);
    let settled = false, timer = null, spawned = false;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const finish = (fn, val) => {
      if (settled) return; settled = true; clear(); fn(val);
      try { child.kill(); } catch (_) {}
      // Escalate to SIGKILL if a wedged child (e.g. stuck in a synchronous native parse that ignores or
      // outlives SIGTERM) does not exit, so a pathological document can never leave an orphaned parser
      // process. Cleared on 'exit'; unref'd so it can't by itself keep the parent alive.
      try {
        const k = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
        if (k.unref) k.unref();
        child.once('exit', () => { try { clearTimeout(k); } catch (_) {} });
      } catch (_) {}
    };
    timer = setTimeout(() => finish(reject, new Error(`document parse did not finish within ${Math.round(maxMs / 1000)}s and was stopped`)), maxMs);
    if (timer.unref) timer.unref();
    child.on('spawn', () => { spawned = true; });
    child.on('message', (msg) => {
      if (!msg) return;
      if (msg.ok) {
        // Attach the child's truncation notes (if any) onto the result so the caller can merge them into the
        // parent's run summary. Non-enumerable-ish `_skips` keeps the {kind,text,pages} shape callers read.
        const r = msg.result || {};
        if (msg.skips) r._skips = msg.skips;
        finish(resolve, r);
      } else finish(reject, new Error(msg.error || 'the parse helper reported an error'));
    });
    // Only a failure to START the child means "this environment can't fork" (forkFailed → inline parse).
    // An error AFTER a successful spawn (e.g. the IPC channel breaking mid-parse) is a child failure: it
    // must take the escalation path, NOT fall back to parsing a possibly-huge file inline on the main
    // process, which is exactly the out-of-memory hang the isolation exists to prevent.
    child.on('error', (e) => { e.forkFailed = !spawned; finish(reject, e); });
    child.on('exit', (code, signal) => {
      if (!settled) { settled = true; clear(); reject(new Error(`the parse helper stopped (exit ${code}${signal ? ', ' + signal : ''})`)); }
    });
    try { child.send(job); } catch (e) { finish(reject, e); }
  });
}

module.exports = { extractInChild, killAllChildrenSync, DEFAULT_MAX_MS, dynamicRssMb, MIN_RSS_MB, MAX_RSS_MB, HEAP_MB };
