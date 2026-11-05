'use strict';
// Guards the data-directory single-instance lock (lib/instancelock.js). Two copies of the app running
// against the same data directory corrupt shared state — the tamper-evident audit log's sealed chain,
// saved sessions, and the index caches — through interleaved writes. The port bind only stops a second
// copy on the SAME port; this lock covers the same-data-dir / different-port / restart-race cases too.
// The lock must be stale-tolerant (a crashed instance never blocks a restart) and fail-open (a lock error
// never wedges startup — only a definitively-live same-host holder is refused). Run: `npm run test:unit`.

const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const il = require(path.join(PROJECT, 'lib', 'instancelock'));

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const eq = (a, b, m) => { checks++; assert.strictEqual(a, b, m); };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lok-ilock-'));
  const lockPath = path.join(tmp, '.lock');
  const cleanup = (code) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(code); };
  try {
    // ── Fresh acquire succeeds and writes a lock naming this process ──
    const a = await il.acquire(tmp, { waitMs: 300, pollMs: 50 });
    ok(a.ok && typeof a.release === 'function' && !a.degraded, 'a fresh data dir is locked cleanly');
    ok(fs.existsSync(lockPath), 'the lock file is created');
    // The lock file is always fully-formed — never an empty create-then-write window a racer could
    // misread as torn and delete (which would let both instances run).
    let held;
    ok((() => { try { held = JSON.parse(fs.readFileSync(lockPath, 'utf-8')); return true; } catch { return false; } })(), 'the lock file is valid JSON (written atomically, never empty)');
    eq(held.pid, process.pid, 'the lock records this process id');
    eq(held.host, os.hostname(), 'the lock records this host');
    ok(Number.isFinite(held.started), 'the lock records a start timestamp');
    ok(!fs.existsSync(lockPath + '.' + process.pid + '.' + Number(held.started).toString(36) + '.tmp'), 'the temp file used for the atomic create is cleaned up');

    // ── A second acquire while THIS (live) process holds it is refused — after the bounded retry ──
    const t0 = Date.now();
    const b = await il.acquire(tmp, { waitMs: 300, pollMs: 50 });
    ok(!b.ok && b.holder && b.holder.pid === process.pid, 'a live same-host holder is refused, and the holder is reported');
    ok(Date.now() - t0 >= 250, 'the refusal waits out the retry window first (so a graceful restart can hand off)');

    // ── Release, then re-acquire succeeds ──
    a.release();
    ok(!fs.existsSync(lockPath), 'release removes the lock (it was ours)');
    const c = await il.acquire(tmp, { waitMs: 300, pollMs: 50 });
    ok(c.ok, 'the lock can be re-acquired after release');
    c.release();

    // ── A STALE lock (a dead pid) is taken over, never a permanent block ──
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, host: os.hostname(), started: Date.now() }));
    ok(!il.isAlive(2147483646), 'the fabricated pid is not alive (precondition)');
    const d = await il.acquire(tmp, { waitMs: 300, pollMs: 50 });
    ok(d.ok, 'a stale lock (dead holder) is taken over');
    eq(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid, process.pid, 'the stale lock is replaced with ours');
    d.release();

    // ── A reused pid (a live process that is NOT a Lokyni process) is detected as stale on Linux ──
    // A stale lock left by a crash can have its pid reused by an unrelated live process. On Linux we read
    // /proc/<pid>/cmdline to tell it apart from a real Lokyni holder; elsewhere we can't cheaply verify, so
    // a live same-host pid is conservatively treated as a conflict (fail-safe). This detection is
    // deliberately NOT based on a wall-clock/boot-time estimate, which a forward clock step could corrupt
    // into taking over a genuinely-live holder.
    if (process.platform === 'linux') {
      // pid 1 (init/tini) is alive and definitely not a Lokyni process → the lock must be taken over.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, host: os.hostname(), started: Date.now() }));
      const reused = await il.acquire(tmp, { waitMs: 300, pollMs: 50 });
      ok(reused.ok, 'a live non-Lokyni reused pid is treated as stale and taken over (Linux /proc check)');
      reused.release();
    }
    // A live same-host pid we cannot rule out as ours is a conflict (this very process, verified earlier).
    // That guarantees two real instances never both run — the property that matters most.

    // ── A lock held by a process on ANOTHER host is taken over WITH a warning (can't verify remotely) ──
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 12345, host: 'some-other-host', started: Date.now() }));
    let warned = null;
    const rr = await il.acquire(tmp, { waitMs: 300, pollMs: 50, log: (m) => { warned = m; } });
    ok(rr.ok, 'a remote-host lock is taken over rather than blocking forever');
    ok(warned && /another host/i.test(warned), 'taking over a remote-host lock logs a warning');
    rr.release();

    // ── An unreadable/torn lock file is treated as stale, not a block ──
    fs.writeFileSync(lockPath, 'not json {{{');
    const e = await il.acquire(tmp, { waitMs: 300, pollMs: 50 });
    ok(e.ok, 'a torn lock file does not block startup');
    e.release();

    // ── Fail-open: an unwritable data dir yields a degraded pass, never a throw or a hard stop ──
    const f = await il.acquire(path.join('/proc', 'definitely-not-writable-lok'), { waitMs: 100, pollMs: 50 });
    ok(f.ok, 'an unusable data dir fails OPEN (startup proceeds) rather than blocking');

    // ── isAlive: current process is alive; an impossible pid is not ──
    ok(il.isAlive(process.pid) === true, 'isAlive is true for this process');
    ok(il.isAlive(0) === false && il.isAlive(-1) === false, 'isAlive rejects non-process ids');

    // ── Source guard: boot acquires the lock before writing state, releases it on exit, honors the flag ──
    const boot = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');
    ok(/require\('\.\/lib\/instancelock'\)\.acquire\(require\('\.\/lib\/config'\)\.DATA_DIR, \{ waitMs: shutdown\.HARD_TIMEOUT_MS \+ 4000 \}\)/.test(boot),
      'boot acquires the data-dir lock, waiting a bit longer than the shutdown hard cap for a handoff');
    ok(boot.indexOf('instancelock') < boot.indexOf('writePidFile()'), 'the lock is acquired before the pid file / server start');
    ok(/shutdown\.onExitKill\(\(\) => \{ try \{ lock\.release\(\); \} catch/.test(boot),
      'the lock is released via onExitKill, so it frees on every exit path (including a timed-out shutdown)');
    ok(/--no-instance-lock/.test(boot), 'there is an escape hatch flag for the rare intentional case');
    const sd = require(path.join(PROJECT, 'lib', 'shutdown'));
    ok(Number.isFinite(sd.HARD_TIMEOUT_MS), 'shutdown exports HARD_TIMEOUT_MS for the lock to key its wait off');

    console.log('✓ instance-lock: acquire/refuse/stale-takeover/release/fail-open all correct; wired into boot');
    console.log(`\nALL INSTANCE-LOCK UNIT TESTS PASSED (${checks} checks)`);
    cleanup(0);
  } catch (err) {
    console.error('\n✗ INSTANCE-LOCK UNIT TEST FAILED:', err && err.message);
    cleanup(1);
  }
})();
