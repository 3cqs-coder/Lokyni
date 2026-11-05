'use strict';
// Unit-test runner: runs every *.test.js in this directory, each in its own child process (a test file is a
// standalone script that sets its own cwd and exits with a status), and fails if any fails. Auto-discovers new
// tests, so adding a `*.test.js` file is enough.
//
// Runs files in PARALLEL with a bounded worker pool. Each test is already isolated — its own process, its own
// cwd, a unique mkdtemp working directory, and no fixed network port — so there is nothing to collide on, and the
// wall-clock drops from minutes (serial) to seconds on a multi-core machine. The pool is capped well below the
// core count so a test that itself spawns a child or two cannot oversubscribe the machine. Each file's output is
// buffered and printed as one contiguous block when it finishes, so parallel output never interleaves. Set
// TEST_CONCURRENCY=1 to force the old serial behavior when debugging a specific ordering issue.
//
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

const envConc = parseInt(process.env.TEST_CONCURRENCY, 10);
const CONCURRENCY = Number.isInteger(envConc) && envConc > 0
  ? envConc
  : Math.max(1, Math.min(8, ((os.cpus() || []).length || 2) - 1));

// Per-file hard timeout. A test that never exits — a leaked server/worker/handle, or a platform-specific hang —
// must NOT stall the whole suite until the CI job's multi-hour limit. The timer kills the child and records the
// file as a failure, so the run fails fast and NAMES the offender instead of hanging silently. Generous by
// default so a slow machine never trips it; override with TEST_FILE_TIMEOUT_MS.
const envTimeout = parseInt(process.env.TEST_FILE_TIMEOUT_MS, 10);
const FILE_TIMEOUT_MS = Number.isInteger(envTimeout) && envTimeout > 0 ? envTimeout : 180000;

const failures = [];

function runOne(file) {
  return new Promise((resolve) => {
    let out = '', settled = false, timer = null;
    const child = spawn(process.execPath, [path.join(dir, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const done = (code, extra) => {
      if (settled) return;   // a child can emit both 'error' and 'close' — count and print each file exactly once
      settled = true;
      if (timer) clearTimeout(timer);
      if (extra) out += extra;
      process.stdout.write(`\n── ${file} ──\n${out}`);
      if (code !== 0) failures.push(file);
      resolve();
    };
    child.on('close', done);
    child.on('error', (e) => done(1, `\n[runner] failed to spawn: ${e && e.message}\n`));
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }   // SIGKILL: uncatchable, so no orphan survives
      done(1, `\n[runner] ✗ TIMED OUT after ${FILE_TIMEOUT_MS}ms — the test never exited ` +
        `(a leaked server/worker/open handle, or a platform-specific hang). Killed.\n`);
    }, FILE_TIMEOUT_MS);
  });
}

(async () => {
  let next = 0;
  const worker = async () => { while (next < files.length) { await runOne(files[next++]); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  console.log(`\n════════\n${files.length - failures.length}/${files.length} unit test file(s) passed`);
  if (failures.length) console.error(`\nFailed:\n  ${failures.sort().join('\n  ')}`);
  process.exit(failures.length ? 1 : 0);
})();
