'use strict';
// Guards a few service/index lifecycle safety properties that are easy to regress and painful in the
// field. Source-level checks (exercising them for real would write to the user's live ~/.lokyni pid file
// or drive OS service managers), so they assert the guarding code stays in place:
//   • the pid file is owned — a failed second start (which loses the port bind and exits) must not
//     overwrite or delete the running instance's pid file;
//   • the debounced delta re-checks the warm-start/rebuild gate at fire time, and a rebuild cancels a
//     pending watcher delta, so a file change can't start a delta over a half-built cache;
//   • a Linux uninstall undoes the enable-linger it set at install, leaving no system-level residue.
// Run: `npm run test:unit`.

const fs = require('fs'), path = require('path'), assert = require('assert');
const PROJECT = path.resolve(__dirname, '..', '..', '..');
const service = fs.readFileSync(path.join(PROJECT, 'lib', 'service.js'), 'utf-8');
const init = fs.readFileSync(path.join(PROJECT, 'lib', 'indexing', 'init.js'), 'utf-8');
const server = fs.readFileSync(path.join(PROJECT, 'lib', 'server.js'), 'utf-8');
const entry = fs.readFileSync(path.join(PROJECT, 'lokyni.js'), 'utf-8');

let checks = 0;
const ok = (c, m) => { checks++; assert.ok(c, m); };
const between = (s, a, b) => { const i = s.indexOf(a); const j = i === -1 ? -1 : s.indexOf(b, i + 1); return i === -1 || j === -1 ? '' : s.slice(i, j); };

try {
  // ── pid-file ownership ──
  const removeFn = between(service, 'const removePidFile', '};');
  ok(/readPid\(\)\s*===\s*process\.pid/.test(removeFn), 'removePidFile unlinks only when the file records this process');
  const writeFn = between(service, 'const writePidFile', 'process.on(\'exit\'');
  ok(/isRunning\(existing\)/.test(writeFn) && /existing\s*!==\s*process\.pid/.test(writeFn),
    'writePidFile refuses to clobber a different, still-running instance\'s pid');
  ok(/process\.on\('exit',\s*\(\)\s*=>\s*\{[^}]*removePidFile\(\)/.test(service), 'the exit hook uses the ownership-checked remover, registered once at module load');
  // The pid file is written atomically (temp + rename) so a crash mid-write can't leave a torn pid.
  ok(/writeFileAtomic\(PID_PATH, String\(process\.pid\)\)/.test(writeFn), 'writePidFile writes the pid atomically');
  console.log('✓ service-safety: the pid file is owned and written atomically (a failed second start cannot delete/overwrite it)');

  // ── debounced delta re-checks the gate; rebuild cancels a pending delta ──
  const debounce = between(init, 'debounceTimer = setTimeout', '}, DEBOUNCE_TIME)');
  ok(/if\s*\(switching\s*\|\|\s*initializing\)[^\n]*return;/.test(debounce),
    'the debounce timer re-checks the switching/initializing gate at fire time');
  const force = between(init, 'const _forceReindexInner', 'console.log(\'✅ Rebuild complete');
  ok(/initializing\s*=\s*true/.test(force) && /clearTimeout\(debounceTimer\)/.test(force),
    'forceReindex sets the gate and cancels any pending watcher delta before wiping');
  // Any clearTimeout(debounceTimer) that cancels a pending timer OUTSIDE the timer's own callback must
  // also reset debounceScheduled, or the flag strands at true and every future debounced index is
  // silently blocked. forceReindex and stopWatchers both cancel-and-clear.
  const stop = between(init, 'const stopWatchers', '_watchers = [];');
  ok(/clearTimeout\(debounceTimer\);\s*debounceScheduled\s*=\s*false/.test(force),
    'forceReindex clears the debounce schedule flag when it cancels the pending timer');
  ok(/clearTimeout\(debounceTimer\);\s*debounceScheduled\s*=\s*false/.test(stop),
    'stopWatchers clears the debounce schedule flag when it cancels the pending timer');
  console.log('✓ service-safety: cancelling a pending debounce always resets its schedule flag');

  // ── restore-over-active-workspace quiesces in the safe order ──
  // A backup restore over the ACTIVE workspace must stop real-time indexing so no delta writes into the
  // directory during the destructive swap. The ordering is the whole point: the switch gate must be set
  // BEFORE the in-flight delta is awaited, otherwise a watched-folder change during that wait re-arms a
  // debounce that fires into the swap. beginQuiesce enforces: switching=true → stopWatchers() → await
  // indexPromise. Regressing to "await the delta first, then stop watchers" reopens index corruption.
  const begin = between(init, 'const beginQuiesce', '};');
  const iSwitch = begin.indexOf('switching = true');
  const iStop   = begin.indexOf('stopWatchers');
  const iAwait  = begin.indexOf('indexPromise');
  ok(iSwitch !== -1 && iStop !== -1 && iAwait !== -1 && iSwitch < iStop && iStop < iAwait,
    'beginQuiesce sets the switch gate, then stops watchers, then awaits the in-flight delta — in that order');
  const end = between(init, 'const endQuiesce', '};');
  ok(end.indexOf('switching = false') !== -1 && end.indexOf('switching = false') < end.indexOf('startWatcher'),
    'endQuiesce clears the gate before re-arming watchers, so a startWatcher throw cannot strand the gate on');
  // The restore route must USE the helper (not an ad-hoc await-then-stop), and re-arm via endQuiesce.
  const restore = between(server, "app.post('/api/backup/restore'", '\napp.');
  ok(/beforeSwap[\s\S]*?beginQuiesce\(/.test(restore), 'the restore route quiesces the active workspace via beginQuiesce');
  ok(/quiescedActive\)\s*\{[\s\S]*?endQuiesce\(/.test(restore), 'a failed restore re-arms indexing via endQuiesce');
  console.log('✓ service-safety: a restore over the active workspace quiesces indexing in the corruption-safe order');

  // ── boot never leaves an orphaned instance: it exits when its launcher goes away ──
  // A supervised or background start must shut down when its parent closes stdin (EOF), so it can't be
  // left orphaned holding the port and data directory. lokyni.js must arm the stdin watch via the
  // supervise predicate (which excludes TTYs, pm2/fork IPC, and /dev/null services), and that watch must
  // trigger the real graceful teardown — armed BEFORE the index build so a stalled rebuild can't strip it.
  ok(/supervise\.exitsWithParent\(\{[^}]*hasIpc: Boolean\(process\.send\)[^}]*kind: supervise\.stdinKind\(\)/.test(entry),
    'boot decides exit-with-parent via supervise.exitsWithParent, keyed on the IPC channel and stdin kind');
  ok(/--no-exit-with-parent/.test(entry), 'there is an opt-out flag for an unusual launch that trips the heuristic');
  const armIdx = entry.indexOf('exitWithParent');
  const initIdx = entry.indexOf('initIndex({');   // the real call takes an options object; the comment says initIndex()
  ok(armIdx !== -1 && initIdx !== -1 && armIdx < initIdx, 'the stdin watch is armed before the index build (a stalled rebuild cannot skip it)');
  ok(/process\.stdin\.on\('end',\s*stop\)/.test(entry) && /gracefulExit\('desktop stop'/.test(entry),
    'an stdin EOF runs the real graceful teardown, not a bare exit');
  console.log('✓ service-safety: a supervised/background boot exits with its launcher and is never orphaned');

  // ── Linux linger handling ──
  ok(/execFileSync\('loginctl', \['enable-linger'/.test(service), 'install enables linger (the service needs it to run headless)');
  // Uninstall must NOT disable-linger: it is a per-USER setting, not per-service, so turning it off would break
  // any OTHER systemd user service the user runs headless. Leaving it on is harmless.
  ok(!/\['disable-linger'/.test(service), 'uninstall does NOT disable linger (per-user setting; would break other user services)');
  console.log('✓ service-safety: install enables linger; uninstall leaves the per-user linger setting alone');

  // ── Windows service stop kills the whole process TREE (no orphaned Chromium) ──
  // On Windows process.kill maps SIGTERM to TerminateProcess (no graceful handler, so the onExitKill backstop
  // never reaps the browser). stopRunning must use taskkill /T on Windows to terminate the process tree.
  ok(/process\.platform === 'win32'/.test(service) && /taskkill['"],\s*\['\/PID',\s*String\(pid\),\s*'\/T',\s*'\/F'\]/.test(service),
    'stopRunning uses taskkill /PID <pid> /T /F on Windows (kills the tree, so Chromium is not orphaned)');
  // POSIX keeps the graceful SIGTERM→wait→SIGKILL path.
  ok(/process\.kill\(pid, 'SIGTERM'\)/.test(service) && /process\.kill\(pid, 'SIGKILL'\)/.test(service),
    'stopRunning keeps the graceful SIGTERM→SIGKILL path on POSIX');
  console.log('✓ service-safety: Windows stop kills the process tree (no orphan); POSIX stays graceful');

  // ── Linux systemd append: log paths are NOT quoted (systemd does not unquote append:, so quotes break it) ──
  ok(/StandardOutput=append:\$\{LOG_PATH\}/.test(service) && /StandardError=append:\$\{ERR_PATH\}/.test(service),
    'systemd append: log paths are unquoted so file logging actually works on Linux');
  ok(!/append:"\$\{/.test(service), 'no quoted append: path remains (the quoted form is silently ignored by systemd)');
  console.log('✓ service-safety: the systemd unit writes log files (unquoted append: paths)');

  // ── Linux WorkingDirectory is unquoted (systemd takes a single-value setting verbatim, so quotes break CHDIR) ──
  ok(/WorkingDirectory=\$\{info\.installDir\}/.test(service) && !/WorkingDirectory="/.test(service),
    'the systemd WorkingDirectory is unquoted (a quoted path fails CHDIR into a restart loop)');
  console.log('✓ service-safety: the systemd WorkingDirectory is unquoted (service can actually chdir)');

  // ── the state dir (pid/logs) is pinned via --state-dir so a service run under a different identity than the
  //    installing user (e.g. a Windows admin onstart task as SYSTEM) does not drift its pid/log paths and
  //    orphan the server on uninstall. All three service commands embed it; the running process honors it. ──
  ok(/const STATE_DIR\s*=\s*_stateDirArg\s*\|\|\s*path\.join\(os\.homedir\(\)/.test(service),
    'STATE_DIR honors an explicit --state-dir, else falls back to ~/.lokyni (user CLI and service agree)');
  // Pinned to STATE_DIR (the installing user's ~/.lokyni, resolved at install time), NOT info.installDir —
  // otherwise an in-place install (install dir = source checkout) would write pid/logs where the CLI, which
  // falls back to ~/.lokyni, can't find them, orphaning the server. STATE_DIR also matches the unit's own
  // LOG_PATH/ERR_PATH, so both halves of the unit agree.
  ok(/<string>--state-dir<\/string>\s*<string>\$\{xe\(STATE_DIR\)\}<\/string>/.test(service),
    'the macOS plist pins --state-dir to STATE_DIR (the installer home, matching the CLI and log paths)');
  ok(/ExecStart=[^\n]*--state-dir "\$\{STATE_DIR\}"/.test(service),
    'the Linux unit pins --state-dir to STATE_DIR');
  ok(/--state-dir ""\$\{STATE_DIR\}""/.test(service),
    'the Windows launcher pins --state-dir to STATE_DIR');
  ok(!/--state-dir[^\n]*info\.installDir/.test(service),
    'no service command pins --state-dir to the install dir (would orphan an in-place install)');
  console.log('✓ service-safety: pid/log state dir is pinned to the installer home (no orphan, in-place-safe)');

  // ── No shell string-interpolation in command execution (defense-in-depth) ──
  // Every service-manager command runs through execFileSync with an argv array, so a path or name with a
  // space or a shell metacharacter can never be mis-parsed or injected by the shell. These are install-time,
  // CLI-only commands with no request-reachable input, but eliminating shell string-building removes the whole
  // class. A template-literal execSync with ${...} would reintroduce it, so fail if one ever appears.
  ok(!/execSync\(`[^`]*\$\{/.test(service), 'no execSync builds a shell command string by interpolation');
  // The one remaining execSync is the fixed-string pm2 probe (pm2 is pm2.cmd on Windows, so it needs a shell);
  // it interpolates nothing.
  const execSyncCalls = service.match(/execSync\(/g) || [];
  ok(execSyncCalls.length <= 1, 'at most one execSync remains (the fixed-string pm2 probe)');
  ok(/execSync\('pm2 jlist'/.test(service), 'the only execSync is the fixed pm2 jlist probe (no interpolation)');
  // The service-manager verbs run via execFileSync with argv arrays.
  for (const bin of ['launchctl', 'systemctl', 'schtasks', 'reg', 'loginctl']) {
    ok(new RegExp(`execFileSync\\('${bin}'`).test(service), `${bin} is invoked via execFileSync with an argv array`);
  }
  console.log('✓ service-safety: service-manager commands use execFileSync argv (no shell string interpolation)');

  console.log(`\nALL SERVICE-SAFETY UNIT TESTS PASSED (${checks} checks)`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n✗ SERVICE-SAFETY UNIT TEST FAILED:', e && e.message);
  process.exitCode = 1;
}
