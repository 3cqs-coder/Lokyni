'use strict';
// Guards the "no spawned process can ever be orphaned" behavior. Worker threads and the isolated
// fork child die with the parent on their own (the fork child also self-exits on IPC disconnect), but
// a Chromium spawned for URL ingestion is a separate process that does NOT — so the shutdown module
// force-kills it on EVERY exit path, including an abnormal exit or a graceful shutdown that timed out
// mid-close. This test both source-guards the wiring and proves at runtime that a registered
// exit-kill reaps a real child when the process exits. Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const { spawnSync, execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

try {
  // ── Source guards ──
  const shutdownSrc = read('lib/shutdown.js');
  ok(/function onExitKill\(/.test(shutdownSrc), 'shutdown exposes onExitKill for owned child processes');
  // The exit-kills run on 'exit' UNCONDITIONALLY (not gated by the shutting-down flag), so they fire
  // even after a graceful shutdown or one that hit its hard timeout.
  ok(/process\.on\('exit'[\s\S]*runExitKills\(\)/.test(shutdownSrc), "the 'exit' handler runs the exit-kills");
  ok(/function runExitKills\(\)/.test(shutdownSrc) && !/_shuttingDown[\s\S]{0,80}runExitKills/.test(shutdownSrc), 'exit-kills are not gated behind the shutting-down guard');

  const urlfetchSrc = read('lib/urlfetch.js');
  ok(/const killAllBrowsersSync = /.test(urlfetchSrc), 'urlfetch has a synchronous browser kill');
  ok(/killAllBrowsersSync[\s\S]*proc\.kill\('SIGKILL'\)/.test(urlfetchSrc), 'the sync kill SIGKILLs each tracked browser process');
  ok(/module\.exports = \{[^}]*killAllBrowsersSync/.test(urlfetchSrc), 'killAllBrowsersSync is exported');

  ok(/onExitKill\([\s\S]*killAllBrowsersSync\(\)/.test(read('lokyni.js')), 'lokyni wires the browser kill as an unconditional exit-kill');

  // A connector (MCP) server is an untrusted spawned process, so it has the same exit-kill backstop as a
  // browser: the per-call finally in connectors.js covers the normal path, but an abrupt exit needs a sync kill.
  const mcpClientSrc = read('lib/mcp/client.js');
  ok(/const killAllConnectorsSync = /.test(mcpClientSrc), 'the MCP client has a synchronous connector kill');
  // A connector is spawned WITHOUT detachment, so it is not its own group leader — the sync kill must take down
  // the whole SUBTREE (not just the direct child) or an `npx`-forked grandchild is orphaned on Unix. It delegates
  // to the shared killProcessTreeSync, which walks descendants on POSIX and uses taskkill /T on Windows.
  ok(/killAllConnectorsSync[\s\S]*killProcessTreeSync\(transport\.pid\)/.test(mcpClientSrc), 'the sync kill tree-kills each tracked connector (descendants included)');
  const killtreeSrc = read('lib/killtree.js');
  ok(/process\.kill\([^,]+, 'SIGKILL'\)/.test(killtreeSrc) && /taskkill[\s\S]*'\/T'/.test(killtreeSrc), 'killProcessTreeSync SIGKILLs the subtree on POSIX and tree-kills on Windows');
  ok(/module\.exports = \{[^}]*killAllConnectorsSync/.test(mcpClientSrc), 'killAllConnectorsSync is exported');
  ok(/onExitKill\([\s\S]*killAllConnectorsSync\(\)/.test(read('lokyni.js')), 'lokyni wires the connector kill as an unconditional exit-kill');

  // The desktop sidecar arms a stdin-EOF never-orphan guard at the VERY TOP (before the heavy startup requires),
  // so a launcher crash during the startup window (macOS/Windows have no parent-death signal) can't orphan a
  // half-started sidecar; the full graceful handler later removes it and takes over.
  {
    const lok = read('lokyni.js');
    ok(/let _earlyStdinBail = null;[\s\S]*?args\.includes\('--desktop'\) && !process\.stdin\.isTTY/.test(lok),
      'lokyni arms an early stdin-EOF orphan guard for the desktop sidecar, before heavy startup');
    ok(/_earlyStdinBail[\s\S]*?process\.stdin\.on\('end', _earlyStdinBail\)/.test(lok) && /process\.stdin\.resume\(\)/.test(lok),
      'the early guard exits on the launcher pipe closing');
    ok(/removeListener\('end', _earlyStdinBail\)[\s\S]*?removeListener\('close', _earlyStdinBail\)/.test(lok),
      'the full graceful handler removes the early guard and takes over');
  }

  // The isolated fork child self-exits when the parent's IPC channel closes (parent died), so it
  // can't orphan even without a parent-side kill.
  ok(/process\.once\('disconnect', \(\) => \{[^}]*process\.exit/.test(read('lib/indexing/extractchild.js')), 'the extraction fork child exits on parent disconnect');

  // ── Runtime proof: a registered exit-kill actually reaps a child on process exit ──
  // A helper process spawns a long-lived child, registers an exit-kill that kills it, installs the
  // handlers, prints the child PID, and exits normally. The child must then be gone.
  const helper = `
    const shutdown = require(${JSON.stringify(path.join(ROOT, 'lib', 'shutdown.js'))});
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' });
    shutdown.onExitKill(() => { try { child.kill('SIGKILL'); } catch (e) {} });
    shutdown.install();
    process.stdout.write(String(child.pid));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['-e', helper], { encoding: 'utf-8', timeout: 15000 });
  const childPid = parseInt((res.stdout || '').trim(), 10);
  ok(Number.isInteger(childPid) && childPid > 0, `the helper spawned a child and exited (pid ${childPid})`);

  // Give the OS a moment to reap the killed child, then confirm it is gone (signal 0 => ESRCH).
  const deadline = Date.now() + 3000;
  let alive = true;
  while (Date.now() < deadline) {
    try { process.kill(childPid, 0); } catch (e) { if (e.code === 'ESRCH') { alive = false; break; } }
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},80)']);   // ~80ms pause without a sleep dependency
  }
  if (alive) { try { process.kill(childPid, 'SIGKILL'); } catch (e) { /* clean up a leaked child */ } }
  ok(!alive, 'the child was killed when its parent exited (no orphan)');

  console.log(`\nALL ORPHAN-PREVENTION UNIT TESTS PASSED (${checks} checks)`);
  process.exit(0);
} catch (e) {
  console.error('\n✗ ORPHAN-PREVENTION UNIT TEST FAILED:', e.message);
  process.exit(1);
}
