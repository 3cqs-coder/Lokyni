'use strict';
// A single-instance lock on the DATA DIRECTORY, so two copies of the app do not run against the same data
// on the same machine at once and corrupt shared state — the tamper-evident audit log's sealed chain,
// saved sessions, and the index caches — through interleaved writes.
//
// The port bind (EADDRINUSE) only stops a second instance on the SAME port; two instances on the same data
// directory but different ports, a service plus a manual run, or a shutdown/startup race would all slip
// past it and write the same files concurrently. The desktop app has its own single-instance guard and
// stdin-EOF sidecar teardown; this covers the standalone and service paths too, uniformly.
//
// Scope and limits: this protects the same-MACHINE case, which is what actually corrupts in practice. A
// holder recorded on a DIFFERENT host cannot be liveness-checked from here (a data directory shared over a
// network mount, or two containers with different hostnames on one volume), so such a lock is taken over
// with a logged warning rather than blocking forever on a possibly-crashed remote holder. Do not run two
// instances against one shared network data directory.
//
// Design: cross-platform (no native deps), stale-tolerant (a crashed instance's lock is taken over, never a
// permanent block — including a lock left by a pre-reboot instance whose pid a live process now happens to
// reuse), and fail-open (any unexpected lock error lets startup proceed; the only hard stop is a
// definitively-live holder on this machine).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Is a pid a live process on THIS machine? Signal 0 checks existence without sending anything: no error
// means alive; ESRCH means gone; EPERM means alive but owned by another user (still "alive").
const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
};

// After an ungraceful crash + reboot, a stale lock's pid may be REUSED by an unrelated live process, which
// would make a live-pid check refuse startup forever. Distinguish "our original process" from "some reused
// pid" WITHOUT any wall-clock/boot-time estimate (a forward clock step — VM resume, NTP jump — corrupts a
// boot-time estimate and could make a genuinely-live holder look stale, letting a second instance take over
// and corrupt the data: worse than a refusal). On Linux we can read the process's own command line from
// /proc and tell whether the pid is actually a Node/Lokyni process; if it is clearly NOT, the lock is stale.
// Elsewhere (or if we can't read it) we cannot cheaply verify, so we conservatively assume it MIGHT be ours
// and treat a live same-host pid as a conflict — fail-safe (a spurious refusal is recoverable via a clear
// message and --no-instance-lock; silent double-run corruption is not).
const looksLikeOurProcess = (pid) => {
  try {
    if (process.platform !== 'linux') return true;   // can't verify cheaply — assume it might be ours (safe)
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return /node|lokyni/i.test(cmdline);
  } catch { return true; }   // /proc unreadable — assume it might be ours (safe)
};

// One create-and-judge attempt. Returns { got, release } on success, { conflict, holder } for a live
// same-host holder, { degraded } when the lock can't be used, or null to retry (a stale lock was cleared).
// `warn` collects a message when a remote lock is taken over.
const tryOnce = (lockPath, payload, warn) => {
  // Build the lock file fully-formed via a temp file + hard link, never as an empty create-then-write. A
  // plain openSync('wx') leaves a zero-byte file visible between the create and the write; a racing starter
  // that read it during that gap would parse empty JSON, judge it "torn/stale", delete it, and BOTH would
  // proceed — the exact corruption this lock prevents. linkSync gives the same atomic "fails if it exists"
  // guarantee as 'wx', but the name only appears once its content is already there.
  const tmpPath = `${lockPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    try {
      fs.writeFileSync(tmpPath, payload);
    } catch (e) {
      // Can't write the temp (unwritable dir) — proceed without a lock rather than wedge startup.
      return { degraded: true, error: e && e.message };
    }
    try {
      fs.linkSync(tmpPath, lockPath);   // atomic: throws EEXIST if the lock already exists
      return { got: true, release: () => release(lockPath) };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return { degraded: true, error: e && e.message };   // odd filesystem / permissions — fail open
      }
      // The lock exists and is fully-formed (see above). Read the holder and decide.
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); } catch { /* genuinely torn — treat as stale */ }
      const sameHost = holder && holder.host === os.hostname();
      if (sameHost && isAlive(holder.pid) && looksLikeOurProcess(holder.pid)) {
        return { conflict: true, holder };   // a real, live, same-host Lokyni holder — refuse
      }
      if (holder && !sameHost) {
        // A holder on another machine (shared network volume) — can't verify; take over but make it visible.
        warn.push(`taking over a data-directory lock held by a process on another host (${holder.host}); do not run two instances against one shared data directory`);
      }
      // Stale (dead pid, a reused pid that is not a Lokyni process, unreadable, or unverifiable remote) —
      // clear it and retry the create.
      try { fs.rmSync(lockPath, { force: true }); } catch { /* another racer may have removed it */ }
      return null;
    }
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort temp cleanup (covers a partial write too) */ }
  }
};

// Try to take the data-directory lock. Returns:
//   { ok: true, release }              — acquired (release() frees it; also fire it on exit)
//   { ok: true, release, degraded }    — could not use a lock (e.g. unwritable dir); startup proceeds
//   { ok: false, holder }              — a live instance on this machine already holds it
// A live holder is re-checked for up to waitMs before giving up, so a graceful RESTART (where the previous
// instance frees the port early but releases this lock last, at the end of its shutdown, up to the shutdown
// hard cap) hands off cleanly instead of the new instance spuriously refusing. Never throws.
const acquire = async (dataDir, opts = {}) => {
  // Default the wait to comfortably exceed the graceful-shutdown hard cap, so a slow teardown of the
  // previous instance still hands off. Callers can pass an explicit waitMs derived from that cap.
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 12000;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 200;
  const log = typeof opts.log === 'function' ? opts.log : (m) => { try { console.warn(`⚠️  ${m}`); } catch {} };
  const lockPath = path.join(dataDir, '.lock');
  const noop = () => {};
  let payload;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    payload = JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() });
  } catch (e) {
    return { ok: true, release: noop, degraded: true, error: e && e.message };
  }

  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const warn = [];
    // Two internal tries so a stale-lock takeover (clear then re-create) resolves in one pass.
    let r = tryOnce(lockPath, payload, warn);
    if (r === null) r = tryOnce(lockPath, payload, warn);
    for (const w of warn) log(w);
    if (r && r.got) return { ok: true, release: r.release };
    if (r && r.degraded) return { ok: true, release: noop, degraded: true, error: r.error };
    if (r && r.conflict) {
      if (Date.now() >= deadline) return { ok: false, holder: r.holder };
      await new Promise((res) => setTimeout(res, pollMs));   // the holder may be shutting down; re-check
      continue;
    }
    return { ok: true, release: noop, degraded: true };   // lost the create race with no verdict — proceed
  }
};

// Release the lock, but only if it is still OURS — never delete a lock a newer instance took over. Match
// BOTH pid AND host: pids collide across machines, so on a shared data directory a bare pid match could
// delete another host's live lock. Idempotent: safe to call more than once and from an exit handler.
const release = (lockPath) => {
  try {
    const h = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (h && h.pid === process.pid && h.host === os.hostname()) fs.rmSync(lockPath, { force: true });
  } catch { /* gone or unreadable — nothing to release */ }
};

module.exports = { acquire, isAlive };
